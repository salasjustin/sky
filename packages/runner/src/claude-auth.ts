import { randomUUID } from "node:crypto";
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

// the names `claudeProcessEnv` drops whose values are the project's, handed back to its commands by
// `commandEnvScript`. CLAUDE_CODE_OAUTH_TOKEN is only ever the run's chosen token: the API reserves it
const PROJECT_VARIABLES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  ...ROUTING_VARIABLES,
];

/**
 * The env of the Claude process itself, carrying exactly the chosen credential and sending it to the
 * Anthropic API. Claude Code prefers `ANTHROPIC_API_KEY` over the subscription token, so a project's
 * own key (an env secret, in the runner's env) must never reach a subscription run, and Sky's key
 * stands alone in an API-key run. A project's `ANTHROPIC_BASE_URL` or provider switch would send the
 * chosen credential to the project's gateway or cloud, so those go too. Sky's key arrives as
 * `SKY_CLAUDE_API_KEY` so it never shares a name with the project's. The credential is read from
 * `runnerEnv`, the env the API launched the runner with, so a profile's session env merged into
 * `env` can't swap it.
 */
export function claudeProcessEnv(
  env: NodeJS.ProcessEnv,
  auth: ClaudeAuth,
  runnerEnv: NodeJS.ProcessEnv = env,
): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const name of [
    ...AUTH_VARIABLES,
    ...ROUTING_VARIABLES,
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
  return out;
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * Gives the session's Bash commands back the project's own values of what `claudeProcessEnv` drops
 * (its API key, auth token, base URL and provider switches, read from `env`, the session's env before
 * the credential is chosen), so its commands work as they always did; and on an API-key run with no
 * project key, unsets Sky's. A SessionStart hook appends this to the file Claude Code sources before
 * each command, which reaches the commands and not Claude itself. Sky's key and the subscription token
 * are never written here. Undefined when there is nothing to say.
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

/**
 * Writes `commandEnvScript` to a file only this user reads, and the SessionStart hook that appends
 * it to `$CLAUDE_ENV_FILE`. The values ride in the file, not in argv or Claude's env.
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
  await writeFile(path, script, { mode: 0o600, flag: "wx" });
  return {
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: "command",
              command: `cat ${shellQuote(path)} >> "$CLAUDE_ENV_FILE"`,
            },
          ],
        },
      ],
    },
    remove: () => rm(path, { force: true }),
  };
}
