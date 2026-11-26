import { Runtime } from "@sky/shared";

/** The env-secret (or run envVar) a runtime the environment doesn't store is read from. */
export const RUNTIME_VARIABLE = "SKY_RUNTIME";

/**
 * The runtime a launch runs on: the environment's stored one, else the `SKY_RUNTIME` its secrets or
 * the run's envVars set, else Claude Code. A value that names no runtime counts as unset; the runner
 * would refuse it anyway.
 */
export function effectiveRuntime(
  stored: Runtime | null,
  variable: string | undefined,
): Runtime {
  if (stored) return stored;
  const parsed = Runtime.safeParse(variable);
  return parsed.success ? parsed.data : "claude-code";
}

const RUNTIME_NAMES: Record<Runtime, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

export const runtimeName = (runtime: Runtime) => RUNTIME_NAMES[runtime];

/** The shell word for an environment name, quoted when it holds anything but a plain name's characters. */
const shellWord = (word: string) =>
  /^[A-Za-z0-9._@%+=:,/-]+$/.test(word)
    ? word
    : `'${word.replaceAll("'", "'\\''")}'`;

/** The command that moves the environment to `to`. */
export const switchCommand = (envName: string, to: Runtime) =>
  `sky env set-runtime ${shellWord(envName)} ${to}`;

/** `message` with the command that moves its environment to `to` appended. */
export const withSwitch = (message: string, envName: string, to: Runtime) =>
  `${message}; to run this environment on ${runtimeName(to)} instead: ${switchCommand(envName, to)}`;

/** The code a Claude run that can't run on any credential fails with. */
export const CLAUDE_UNAVAILABLE = "claude_unavailable:";
/**
 * The code a Codex run fails with when the AI Gateway refused it for credit, quota or rate limit
 * (the runner's wording), or when its environment has no gateway key.
 */
export const CODEX_UNAVAILABLE = "codex_unavailable:";

/**
 * The prompt of a follow-up whose agent's last session ran on the other runtime, which can't resume
 * it: a short note, then the task.
 */
export function crossRuntimePrompt(input: {
  prompt: string;
  from: Runtime;
  to: Runtime;
  branch: string;
  summary: string | null;
}): string {
  const summary = input.summary?.trim()
    ? input.summary.trim()
    : "(the last run recorded no summary)";
  return [
    `Note from Sky: this agent's earlier work ran on ${runtimeName(input.from)}, and this environment now runs on ${runtimeName(input.to)}, so that session can't be resumed and this is a fresh one. The branch \`${input.branch}\` you are on holds the earlier work's commits; read its log and diff for what is done. The last run's summary:`,
    "",
    summary,
    "",
    "---",
    "",
    input.prompt,
  ].join("\n");
}
