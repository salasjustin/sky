import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { REDIRECT_VARIABLES } from "./claude-auth.js";

// the settings keys that run a command for, restrict or reroute Claude Code's login, wherever the file
// sits (code.claude.com/docs/en/settings-reference): an `apiKeyHelper` hands over any credential it
// likes, the cloud refresh commands feed a provider's
export const REDIRECT_SETTINGS = [
  "apiKeyHelper",
  "awsAuthRefresh",
  "awsCredentialExport",
  "gcpAuthRefresh",
  "forceLoginMethod",
  "forceLoginGatewayUrl",
];

// a settings `env` entry that moves Claude Code's own config, and with it the credential it reads
export const REDIRECT_SETTINGS_ENV = [
  ...REDIRECT_VARIABLES,
  "CLAUDE_CONFIG_DIR",
];

/** Where Claude Code's managed settings live on Linux, a file and a drop-in directory. */
export const MANAGED_SETTINGS_DIR = "/etc/claude-code";

export type SettingsLocations = {
  /** The run's worktree, which Claude Code starts in. */
  cwd: string;
  /** The main checkout the worktree belongs to, where Claude Code keeps the project-local file. */
  repoDir: string;
  /** The session's env, for where the user-level settings are. */
  env: NodeJS.ProcessEnv;
  managedDir?: string;
};

type SettingsFile = { label: string; path: string };

function settingsFiles(where: SettingsLocations): SettingsFile[] {
  const files: SettingsFile[] = [
    {
      label: ".claude/settings.json",
      path: join(where.cwd, ".claude/settings.json"),
    },
    {
      label: ".claude/settings.local.json",
      path: join(where.cwd, ".claude/settings.local.json"),
    },
    {
      label: ".claude/settings.local.json in the main checkout",
      path: join(where.repoDir, ".claude/settings.local.json"),
    },
  ];
  const home = where.env.HOME || homedir();
  for (const dir of new Set(
    [where.env.CLAUDE_CONFIG_DIR, join(home, ".claude")].filter(Boolean),
  )) {
    const path = join(String(dir), "settings.json");
    files.push({ label: path, path });
  }
  const managed = where.managedDir ?? MANAGED_SETTINGS_DIR;
  files.push({
    label: join(managed, "managed-settings.json"),
    path: join(managed, "managed-settings.json"),
  });
  let dropIns: string[] = [];
  try {
    dropIns = readdirSync(join(managed, "managed-settings.d"))
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch {}
  for (const name of dropIns) {
    const path = join(managed, "managed-settings.d", name);
    files.push({ label: path, path });
  }
  return files;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const has = (object: Record<string, unknown>, key: string) =>
  Object.hasOwn(object, key) &&
  object[key] !== undefined &&
  object[key] !== null;

/** The keys of one settings document that redirect the session or swap its credential: names only. */
export function redirectingKeys(settings: unknown): string[] {
  if (!isObject(settings)) return [];
  const keys = REDIRECT_SETTINGS.filter((key) => has(settings, key));
  const env = settings.env;
  if (isObject(env))
    keys.push(
      ...REDIRECT_SETTINGS_ENV.filter((name) => has(env, name)).map(
        (name) => `env.${name}`,
      ),
    );
  return keys;
}

/**
 * What stops a run before Claude starts: every settings file the session would load (the project's,
 * the project-local one, the user-level ones in the sandbox and the managed ones) that sets a key
 * redirecting the session or swapping its credential. Each line names the file and the key, never the
 * value. A file that is missing or isn't JSON sets nothing: Claude Code skips it too.
 */
export function settingsRedirects(where: SettingsLocations): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const { label, path } of settingsFiles(where)) {
    if (seen.has(path)) continue;
    seen.add(path);
    let settings: unknown;
    try {
      settings = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    for (const key of redirectingKeys(settings))
      lines.push(
        `settings_redirect: ${label} sets ${key}; Sky runs Claude only with its own credential. Remove it to run on Sky.`,
      );
  }
  return lines;
}
