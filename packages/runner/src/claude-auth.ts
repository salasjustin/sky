import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";

/** Which credential the run's Claude session authenticates with, as the API chose it. */
export type ClaudeAuth = "oauth" | "api-key";

// what Claude Code authenticates with, in the order it prefers them; only the credential the API
// chose may be left in the session's env
const AUTH_VARIABLES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
];

// what sends Claude Code's requests, credential included, somewhere other than the Anthropic API: the
// endpoint override, and the provider switches that outrank every credential
// (code.claude.com/docs/en/env-vars, code.claude.com/docs/en/authentication#authentication-precedence)
const ROUTING_VARIABLES = [
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_MANTLE",
];

// the rest of what changes where Claude Code sends its requests or with what it signs them: other
// providers' endpoints and credentials, extra request headers, workload identity, and the proxies
// the requests go through (code.claude.com/docs/en/env-vars)
export const REDIRECT_ENV_VARIABLES = [
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_AWS_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_AWS_API_KEY",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_WORKSPACE_ID",
  "ANTHROPIC_PROFILE",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_SCOPES",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "https_proxy",
  "http_proxy",
  "all_proxy",
];

/**
 * Every environment variable that would redirect the Claude session or swap its credential, as a
 * name a settings file's `env` block could set; the session's own env and those blocks are held to
 * this one list.
 */
export const REDIRECT_VARIABLES = [
  ...AUTH_VARIABLES,
  ...ROUTING_VARIABLES,
  ...REDIRECT_ENV_VARIABLES,
];

// the names `claudeProcessEnv` drops whose values are the project's, handed back to its commands by
// `commandEnvScript`, and unset for a check's nested `claude`. The `CLAUDE_CODE_OAUTH_` names are a
// Claude login rather than a project value, so commands never get them back: CLAUDE_CODE_OAUTH_TOKEN
// is only ever the run's chosen token, which the API reserves
export const PROJECT_VARIABLES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  ...ROUTING_VARIABLES,
  ...REDIRECT_ENV_VARIABLES.filter(
    (name) => !name.startsWith("CLAUDE_CODE_OAUTH_"),
  ),
];

// Sky is the host choosing where the Claude process sends its requests and with what credential: in
// this mode Claude Code ignores the endpoint, provider and credential variables a settings file sets,
// mid-session edits included (code.claude.com/docs/en/env-vars)
export const HOST_MANAGED = "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST";

/**
 * The env of the Claude process itself, carrying exactly the chosen credential and sending it to the
 * Anthropic API. Claude Code prefers `ANTHROPIC_API_KEY` over the subscription token, so a project's
 * own key (an env secret, in the runner's env) must never reach a subscription run, and Sky's key
 * stands alone in an API-key run. A project's `ANTHROPIC_BASE_URL` or provider switch would send the
 * chosen credential to the project's gateway or cloud, so those go too. Sky's key arrives as
 * `SKY_CLAUDE_API_KEY` so it never shares a name with the project's. The credential is read from
 * `runnerEnv`, the env the API launched the runner with, so a profile's session env merged into
 * `env` can't swap it. Host-managed mode is always on, whatever the project or profile set it to.
 */
export function claudeProcessEnv(
  env: NodeJS.ProcessEnv,
  auth: ClaudeAuth,
  runnerEnv: NodeJS.ProcessEnv = env,
): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const name of [
    ...REDIRECT_VARIABLES,
    "SKY_CLAUDE_API_KEY",
    "SKY_CLAUDE_AUTH",
  ]) {
    delete out[name];
  }
  if (auth === "api-key") {
    if (runnerEnv.SKY_CLAUDE_API_KEY)
      out.ANTHROPIC_API_KEY = runnerEnv.SKY_CLAUDE_API_KEY;
  } else if (runnerEnv.CLAUDE_CODE_OAUTH_TOKEN) {
    out.CLAUDE_CODE_OAUTH_TOKEN = runnerEnv.CLAUDE_CODE_OAUTH_TOKEN;
  }
  out[HOST_MANAGED] = "1";
  return out;
}

// what the API launches the runner with to hand the session its credential: the subscription token, or
// Sky's API key under a name of its own
const CREDENTIAL_VARIABLES = ["SKY_CLAUDE_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"];

/**
 * Takes the run's Claude credential out of `env` and returns it, so the runner's own children, such as
 * the git commands that run a repo's hooks and config, never inherit it. Only the session's Claude
 * process gets it back, through `claudeProcessEnv`'s `runnerEnv`.
 */
export function withdrawCredential(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const held: NodeJS.ProcessEnv = {};
  for (const name of CREDENTIAL_VARIABLES) {
    const value = env[name];
    if (value === undefined) continue;
    held[name] = value;
    delete env[name];
  }
  return held;
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * Gives the session's Bash commands back the project's own values of what `claudeProcessEnv` drops
 * (`PROJECT_VARIABLES`: its API key, auth token, base URL, provider switches, proxies and the like,
 * read from `env`, the session's env before the credential is chosen), so its commands work as they
 * always did; and on an API-key run with no project key, unsets Sky's. A SessionStart hook has the
 * file Claude Code sources before each command source this in turn, which reaches the commands and not
 * Claude itself. Sky's key and the OAuth token, refresh token and scopes are never written here.
 * Undefined when there is nothing to say.
 */
export function commandEnvScript(
  auth: ClaudeAuth,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const lines = PROJECT_VARIABLES.flatMap((name) => {
    const value = env[name];
    return value ? [`export ${name}=${shellQuote(value)}`] : [];
  });
  if (auth === "api-key" && !env.ANTHROPIC_API_KEY)
    lines.unshift("unset ANTHROPIC_API_KEY");
  return lines.length > 0 ? `${lines.join("\n")}\n` : undefined;
}

type Settings = Exclude<Options["settings"], string | undefined>;

export type CommandEnv = {
  /** The `settings.hooks` that apply the script; undefined when there is no script. */
  hooks: Settings["hooks"];
  /** Deletes the script, which may hold the project's key and token. */
  remove: () => Promise<void>;
};

// every script `prepareCommandEnv` wrote that its `remove` hasn't deleted yet
const unremoved = new Set<string>();

/**
 * Deletes every command-env script still on disk, synchronously: for a process about to die by a
 * signal, which never reaches the session's own `remove`. Never throws, so the death goes ahead.
 */
export function removeCommandEnvNow(): void {
  for (const path of unremoved)
    try {
      rmSync(path, { force: true });
    } catch {}
  unremoved.clear();
}

/**
 * Writes `commandEnvScript` to a file only this user reads, and the SessionStart hook that appends
 * to `$CLAUDE_ENV_FILE` a line sourcing that file while it exists. The values live in that file
 * alone, never in argv, Claude's env or Claude Code's env file; once `remove` or
 * `removeCommandEnvNow` deletes it, the line sources nothing and still succeeds.
 */
export async function prepareCommandEnv(
  auth: ClaudeAuth,
  env: NodeJS.ProcessEnv,
  dir: string = tmpdir(),
): Promise<CommandEnv> {
  const script = commandEnvScript(auth, env);
  if (script === undefined) return { hooks: undefined, remove: async () => {} };
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `sky-command-env-${randomUUID()}.sh`);
  // before the write: a signal can land while it is in flight
  unremoved.add(path);
  await writeFile(path, script, { mode: 0o600, flag: "wx" });
  const quoted = shellQuote(path);
  const sourceWhileExists = `if [ -r ${quoted} ]; then . ${quoted}; fi`;
  const appendSourceLine = `printf '%s\\n' ${shellQuote(sourceWhileExists)} >> "$CLAUDE_ENV_FILE"`;
  return {
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: "command",
              command: appendSourceLine,
            },
          ],
        },
      ],
    },
    remove: () => {
      unremoved.delete(path);
      return rm(path, { force: true });
    },
  };
}
