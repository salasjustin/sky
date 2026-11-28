import type { BaseProfileMcpServer } from "@sky/shared";

/** A quote, backslash or control character: none can sit in a name or url written between TOML quotes. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const HOSTILE = /["\\\u0000-\u001f\u007f]/;

/**
 * The base profile's MCP servers as `[mcp_servers.<name>]` tables for Codex's `config.toml`, one
 * string of lines each. The file holds names only: an http header names the env var Codex reads its
 * value from at request time (`env_http_headers`), a stdio server names the env vars Codex passes
 * through (`env_vars`). Every server asks per tool call (`default_tools_approval_mode = "prompt"`),
 * so Sky's approval policy sees each call, as it does on Claude Code runs.
 *
 * A server whose secret isn't in `env` is left out and named in `unresolved`, as `sessionMcpServers`
 * does. One that can't be written safely is left out and named in `refused`: a name or url holding a
 * quote, backslash or control character, or a stdio server whose env var is passed under another name
 * than its secret's (Codex's `env_vars` can't rename).
 */
export function codexMcpTables(
  profile: Record<string, BaseProfileMcpServer>,
  env: NodeJS.ProcessEnv,
): {
  tables: string[][];
  unresolved: { server: string; secrets: string[] }[];
  refused: { server: string; why: string }[];
} {
  const tables: string[][] = [];
  const unresolved: { server: string; secrets: string[] }[] = [];
  const refused: { server: string; why: string }[] = [];
  for (const [name, server] of Object.entries(profile)) {
    const isStdio = "command" in server;
    const refs = isStdio ? server.env : server.headers;
    if (HOSTILE.test(name)) {
      refused.push({ server: JSON.stringify(name), why: "its name" });
      continue;
    }
    if (!isStdio && HOSTILE.test(server.url)) {
      refused.push({ server: name, why: "its url" });
      continue;
    }
    const names = Object.keys(refs);
    if (names.some((key) => HOSTILE.test(key))) {
      refused.push({ server: name, why: "a name it passes" });
      continue;
    }
    if (
      isStdio &&
      Object.entries(refs).some(([key, secret]) => key !== secret)
    ) {
      refused.push({
        server: name,
        why: "an env var it names under another name than its secret's",
      });
      continue;
    }
    const absent = [
      ...new Set(Object.values(refs).filter((secret) => !env[secret])),
    ];
    if (absent.length > 0) {
      unresolved.push({ server: name, secrets: absent });
      continue;
    }
    const head = [`[mcp_servers."${name}"]`];
    tables.push([
      ...head,
      ...(isStdio
        ? [
            `command = ${JSON.stringify(server.command)}`,
            `args = ${JSON.stringify(server.args)}`,
            ...(names.length > 0
              ? [`env_vars = ${JSON.stringify(Object.values(refs))}`]
              : []),
          ]
        : [
            `url = "${server.url}"`,
            ...(names.length > 0
              ? [
                  `env_http_headers = { ${Object.entries(refs)
                    .map(([header, secret]) => `"${header}" = "${secret}"`)
                    .join(", ")} }`,
                ]
              : []),
          ]),
      'default_tools_approval_mode = "prompt"',
      "",
    ]);
  }
  return { tables, unresolved, refused };
}

/** The warning for servers left out of Codex's config because a secret they name isn't in the run's env: names only. */
export const codexUnresolvedWarning = (
  unresolved: { server: string; secrets: string[] }[],
): string =>
  `base-profile MCP server${unresolved.length === 1 ? "" : "s"} not passed to this session, secret not set in this run: ${unresolved.map((u) => `${u.server} (${u.secrets.join(", ")})`).join("; ")}. Set each named secret on the environment with sky secret set.`;

/** The warning for servers left out of Codex's config because one of their names or their url can't be written safely. */
export const codexRefusedWarning = (
  refused: { server: string; why: string }[],
): string =>
  `base-profile MCP server${refused.length === 1 ? "" : "s"} not passed to this session, unsafe or unsupported for Codex: ${refused.map((r) => `${r.server} (${r.why})`).join("; ")}.`;
