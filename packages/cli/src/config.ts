import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

export type Env = Record<string, string | undefined>;

export interface Config {
  url: string;
  apiKey: string;
  /** Where the key came from, for the message when the API rejects it. */
  apiKeySource: string;
}

export interface ConfigFlags {
  url?: string;
  apiKeyEnv?: string;
}

export type ConfigResult =
  | { ok: true; config: Config }
  | { ok: false; error: string };

const ConfigFile = z.object({
  url: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional(),
});

/** `$XDG_CONFIG_HOME/sky/config.json`, else `~/.config/sky/config.json` — on macOS too. */
export function configPath(env: Env, home: string): string {
  const xdg = env.XDG_CONFIG_HOME;
  // the XDG spec ignores an empty or relative value
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, ".config");
  return join(base, "sky", "config.json");
}

const nonEmpty = (v: string | undefined) => (v ? v : undefined);

/** flags > env (`SKY_URL`, `SKY_API_KEY`) > the user config file. */
export function resolveConfig(
  flags: ConfigFlags,
  env: Env,
  home: string,
): ConfigResult {
  let flagKey: string | undefined;
  if (flags.apiKeyEnv !== undefined) {
    flagKey = nonEmpty(env[flags.apiKeyEnv]);
    if (flagKey === undefined) {
      return {
        ok: false,
        error: `--api-key-env names ${flags.apiKeyEnv}, which is not set`,
      };
    }
  }
  const path = configPath(env, home);
  let url =
    sourced(nonEmpty(flags.url), "--url") ??
    sourced(nonEmpty(env.SKY_URL), "SKY_URL");
  let apiKey =
    flags.apiKeyEnv !== undefined
      ? sourced(flagKey, `${flags.apiKeyEnv} (--api-key-env)`)
      : sourced(nonEmpty(env.SKY_API_KEY), "SKY_API_KEY");
  if (url === undefined || apiKey === undefined) {
    const file = readConfigFile(path);
    if (!file.ok) return file;
    url ??= sourced(file.value.url, `url in ${path}`);
    apiKey ??= sourced(file.value.apiKey, `apiKey in ${path}`);
  }
  if (url === undefined) {
    return {
      ok: false,
      error: `no API URL: pass --url, set SKY_URL, or add "url" to ${path}`,
    };
  }
  if (apiKey === undefined) {
    return {
      ok: false,
      error: `no API key: set SKY_API_KEY, pass --api-key-env=<VAR>, or add "apiKey" to ${path}`,
    };
  }
  const urlError = checkUrl(url.value);
  if (urlError !== undefined) {
    return { ok: false, error: `${url.source} "${url.value}" ${urlError}` };
  }
  if (!fitsHeader(apiKey.value)) {
    // never the value: unlike the URL, it is a secret
    return {
      ok: false,
      error: `${apiKey.source} has a line break or NUL that a header can't carry`,
    };
  }
  return {
    ok: true,
    config: {
      url: url.value.replace(/\/+$/, ""),
      apiKey: apiKey.value,
      apiKeySource: apiKey.source,
    },
  };
}

const sourced = (value: string | undefined, source: string) =>
  value === undefined ? undefined : { value, source };

const localHosts = new Set(["localhost", "127.0.0.1"]);

/** A reason the URL is unusable, or undefined; plain http only reaches a local dev server. */
function checkUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "is not a URL; expected https://<host>, e.g. https://sky-api.fly.dev";
  }
  if (url.protocol === "https:") return undefined;
  if (url.protocol === "http:" && localHosts.has(url.hostname))
    return undefined;
  return "must use https (http only for localhost)";
}

/** Whether fetch takes `Bearer <key>`: it trims trailing HTTP whitespace, then refuses CR, LF and NUL with an error that quotes the value. */
function fitsHeader(key: string): boolean {
  const sent = key.replace(/[\t\n\r ]+$/, "");
  return !["\r", "\n", "\0"].some((char) => sent.includes(char));
}

function readConfigFile(
  path: string,
):
  | { ok: true; value: z.infer<typeof ConfigFile> }
  | { ok: false; error: string } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, value: {} };
    }
    throw err;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: `${path}: not valid JSON` };
  }
  const parsed = ConfigFile.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      error: `${path}: expected {"url": string, "apiKey": string}`,
    };
  }
  return { ok: true, value: parsed.data };
}
