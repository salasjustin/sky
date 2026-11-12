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

/**
 * The env of the Claude process itself, carrying exactly the chosen credential. Claude Code prefers
 * `ANTHROPIC_API_KEY` over the subscription token, so a project's own key (an env secret, in the
 * runner's env) must never reach a subscription run, and Sky's key stands alone in an API-key run.
 * Sky's key arrives as `SKY_CLAUDE_API_KEY` so it never shares a name with the project's.
 */
export function claudeProcessEnv(
  env: NodeJS.ProcessEnv,
  auth: ClaudeAuth,
): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const name of [
    ...AUTH_VARIABLES,
    "SKY_CLAUDE_API_KEY",
    "SKY_CLAUDE_AUTH",
  ]) {
    delete out[name];
  }
  if (auth === "api-key") {
    if (env.SKY_CLAUDE_API_KEY) out.ANTHROPIC_API_KEY = env.SKY_CLAUDE_API_KEY;
  } else if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    out.CLAUDE_CODE_OAUTH_TOKEN = env.CLAUDE_CODE_OAUTH_TOKEN;
  }
  return out;
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * What the session's Bash commands see of `ANTHROPIC_API_KEY`: the project's own key when it has
 * one, so its commands work as they always did, and never Sky's. A SessionStart hook appends this to
 * the file Claude Code sources before each command, which reaches the commands and not Claude itself.
 * Undefined when there is nothing to say: a subscription run whose project has no key.
 */
export function commandEnvScript(
  auth: ClaudeAuth,
  projectKey: string | undefined,
): string | undefined {
  if (projectKey) return `export ANTHROPIC_API_KEY=${shellQuote(projectKey)}\n`;
  return auth === "api-key" ? "unset ANTHROPIC_API_KEY\n" : undefined;
}

type Settings = Exclude<Options["settings"], string | undefined>;

export type CommandEnv = {
  /** The `settings.hooks` that apply the script; undefined when there is no script. */
  hooks: Settings["hooks"];
  /** Deletes the script, which may hold the project's key. */
  remove: () => Promise<void>;
};

/**
 * Writes `commandEnvScript` to a file only this user reads, and the SessionStart hook that appends
 * it to `$CLAUDE_ENV_FILE`. The key rides in the file, not in argv or Claude's env.
 */
export async function prepareCommandEnv(
  auth: ClaudeAuth,
  projectKey: string | undefined,
  dir: string = tmpdir(),
): Promise<CommandEnv> {
  const script = commandEnvScript(auth, projectKey);
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
