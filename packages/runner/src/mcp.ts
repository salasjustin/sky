import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BaseProfileMcpServer } from "@sky/shared";

/** The shape the SDK's `mcpServers` option takes for the two kinds a base profile declares. */
export type SessionMcpServer =
  | {
      type: "stdio";
      command: string;
      args: string[];
      env: Record<string, string>;
    }
  | { type: "http"; url: string; headers: Record<string, string> };

/**
 * `claude`'s user config, where provisioning registered the base profile's MCP servers. Concurrent
 * `claude` processes on one sprite rewrite it, and a write can lose an entry.
 */
export const userConfigFile = (env: NodeJS.ProcessEnv): string =>
  join(env.CLAUDE_CONFIG_DIR || env.HOME || homedir(), ".claude.json");

/** The names of the MCP servers the user config holds; none when it can't be read as JSON. */
export function userScopeServers(env: NodeJS.ProcessEnv): string[] {
  try {
    const config = JSON.parse(readFileSync(userConfigFile(env), "utf8")) as {
      mcpServers?: unknown;
    };
    const servers = config.mcpServers;
    return servers && typeof servers === "object" ? Object.keys(servers) : [];
  } catch {
    return [];
  }
}

/**
 * The base profile's MCP servers as the session takes them, so the session has them whatever
 * `~/.claude.json` holds. The profile names each secret by its bare env name (`DOOP_KEY`), and each
 * `env` (stdio) or `headers` (http) value is that name's value in the run's env. The values live
 * in this process and the session's launch arguments only, never in a file or event. A server whose
 * secret the run doesn't have is left out and named in `unresolved`, with the secret's name.
 */
export function sessionMcpServers(
  profile: Record<string, BaseProfileMcpServer>,
  env: NodeJS.ProcessEnv,
): {
  servers: Record<string, SessionMcpServer>;
  unresolved: { server: string; secrets: string[] }[];
} {
  const servers: Record<string, SessionMcpServer> = {};
  const unresolved: { server: string; secrets: string[] }[] = [];
  for (const [name, server] of Object.entries(profile)) {
    const refs = "command" in server ? server.env : server.headers;
    const absent = [
      ...new Set(Object.values(refs).filter((secret) => !env[secret])),
    ];
    if (absent.length > 0) {
      unresolved.push({ server: name, secrets: absent });
      continue;
    }
    const resolve = (named: Record<string, string>) =>
      Object.fromEntries(
        Object.entries(named).map(([key, secret]) => [key, env[secret] ?? ""]),
      );
    servers[name] =
      "command" in server
        ? {
            type: "stdio",
            command: server.command,
            args: server.args,
            env: resolve(server.env),
          }
        : { type: "http", url: server.url, headers: resolve(server.headers) };
  }
  return { servers, unresolved };
}

/** The warning for base-profile servers absent from the user config: names only. */
export const missingServersWarning = (missing: string[]): string =>
  `base-profile MCP server${missing.length === 1 ? "" : "s"} missing from the sprite's config: ${missing.join(", ")}; passed to this session directly. Reprovision the sprite to restore ${missing.length === 1 ? "it" : "them"}.`;

/**
 * The warning for servers left out because a secret they name isn't in the run's env: names only.
 * The sprite's own entry for such a server references the secret as `${NAME}`, and Claude Code loads
 * an unset one as that literal text, so the server can still start there with a credential that
 * doesn't work.
 */
export const unresolvedServersWarning = (
  unresolved: { server: string; secrets: string[] }[],
): string => {
  const one = unresolved.length === 1;
  return `base-profile MCP server${one ? "" : "s"} not passed to this session, secret not set in this run: ${unresolved.map((u) => `${u.server} (${u.secrets.join(", ")})`).join("; ")}. Set each named secret on the environment with sky secret set. If the sprite's config lists ${one ? "the server, the session still loads it" : "them, the session still loads them"} from there with ${one ? "a credential that doesn't" : "credentials that don't"} work.`;
};
