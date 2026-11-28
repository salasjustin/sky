import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EnvRefresh } from "@sky/shared";
import { CREDENTIAL_VARIABLES } from "./claude-auth.js";
import { CODEX_KEY_ENV } from "./config.js";
import { withoutConnector } from "./connector.js";
import { runInGroup, withRefreshLock } from "./plugins.js";

/**
 * What the environment's `refresh` script may take when `SKY_REFRESH_TIMEOUT_SECONDS` doesn't say. It
 * runs in the launch path, before the Claude plugin refresh (71 s at most, `plugins.ts`) and the
 * session's start, and a launch that has not reported by `LAUNCH_DEADLINE_MINUTES` (15 by default) is
 * failed by the API. A `git pull` and a build is seconds to a minute on a sprite that has just woken;
 * 120 s leaves two such steps' worth of slack and, with the plugin refresh and the store sync, still
 * a launch's deadline of more than ten minutes for the worktree and the session's start.
 */
export const ENV_REFRESH_TIMEOUT_MS = 120_000;

/** The most a `SKY_REFRESH_TIMEOUT_SECONDS` can ask for: a script that needs more is a setup. */
export const ENV_REFRESH_MAX_TIMEOUT_MS = 300_000;

/** The budget, which includes the wait for another run's refresh, never over a quarter of what is left of the launch's deadline. */
export function envRefreshBudgetMs(
  requestedMs: number | undefined,
  launchDeadlineMs: number,
): number {
  return Math.max(
    1_000,
    Math.min(
      requestedMs ?? ENV_REFRESH_TIMEOUT_MS,
      ENV_REFRESH_MAX_TIMEOUT_MS,
      launchDeadlineMs / 4,
    ),
  );
}

/** How long a cut script's process group gets to exit on SIGTERM before it is sent SIGKILL. */
const KILL_GRACE_MS = 2_000;

/** The most of the log's end read for the record's tail. */
const TAIL_READ_BYTES = 8 * 1024;
/** The lines, and then the characters, of the output the record keeps. */
const TAIL_LINES = 8;
export const TAIL_MAX_CHARS = 1_000;
const REASON_MAX = 300;

/** A proxy token the runner mints for a model proxy of any runtime: `SKY_CODEX_GATEWAY_TOKEN`, and a pi one's. */
const PROXY_TOKEN = /^SKY_[A-Z0-9_]*GATEWAY_TOKEN$/;

/**
 * The env the script gets: the agent session's own (the runner's, once its credentials are taken out,
 * under the profile's `sessionEnv`), less what the session's commands don't hold either: the run's event token,
 * the Claude credential, the GitHub connector, the AI Gateway key and a model proxy's token. The script
 * runs from paths an earlier run's agent could have written, so it holds nothing the agent does not.
 */
export function refreshEnv(
  env: NodeJS.ProcessEnv,
  sessionEnv: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const kept = withoutConnector({ ...env, ...sessionEnv });
  for (const name of [
    ...CREDENTIAL_VARIABLES,
    CODEX_KEY_ENV,
    "AGENT_TOKEN",
    "SKY_CODEX_HOME",
    "SKY_REFRESH",
  ])
    delete kept[name];
  for (const name of Object.keys(kept))
    if (PROXY_TOKEN.test(name)) delete kept[name];
  return kept;
}

const SECRET_NAME = /(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i;
// shorter values would shred ordinary text wherever they happen to occur
const MIN_SECRET_LENGTH = 8;
const tokenPatterns = [
  /sk-ant-oat[0-9A-Za-z_-]+/g,
  /sk-[0-9A-Za-z_-]{16,}/g,
  /gh[pousr]_[0-9A-Za-z]{20,}/g,
  /github_pat_[0-9A-Za-z_]{20,}/g,
  /sky_[0-9A-Za-z_-]{20,}/g,
  /eyJ[0-9A-Za-z_-]+\.[0-9A-Za-z_-]+\.[0-9A-Za-z_-]+/g,
];

/** `text` with the env's secret-looking values, and token shapes, replaced: the API redacts again on its side. */
export function redactOutput(text: string, env: NodeJS.ProcessEnv): string {
  let out = text;
  const values = Object.entries(env)
    .filter(
      ([name, value]) =>
        SECRET_NAME.test(name) &&
        typeof value === "string" &&
        value.length >= MIN_SECRET_LENGTH,
    )
    .map(([, value]) => value as string)
    // the longest first, so a value holding another is scrubbed whole
    .sort((a, b) => b.length - a.length);
  for (const value of values) out = out.replaceAll(value, "[redacted]");
  for (const pattern of tokenPatterns) out = out.replace(pattern, "[redacted]");
  return out;
}

/** The last bytes of a file, or "" for one that can't be read. */
function readEnd(file: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_READ_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The last few lines of the script's output, printable, redacted and cut to `TAIL_MAX_CHARS` from the front. */
function tailOf(file: string, env: NodeJS.ProcessEnv): string {
  const text = redactOutput(readEnd(file), env)
    // control characters, an escape sequence's included, are not output a reader can use
    // biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  const lines = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "")
    .slice(-TAIL_LINES)
    .join("\n");
  return lines.length > TAIL_MAX_CHARS ? lines.slice(-TAIL_MAX_CHARS) : lines;
}

const seconds = (ms: number) => (ms / 1000).toFixed(1);

/** Runs `$2` with its output appended to the log `$1`; `exec` takes the redirect, so the script is the shell's own process. */
const WRAPPER = 'exec >>"$1" 2>&1 && eval "$2"';

/**
 * Runs the environment's `refresh` script (bash) before a run, on any runtime, and records what it
 * did. Best effort: it never throws, and a script that fails or is cut never fails the run.
 *
 * It runs with `env` as given, which the caller builds with `refreshEnv`: no more than the agent's
 * own, since the paths it runs were writable by an earlier run's agent. It leads its own process
 * group, which a cut (the budget's end or `signal`, the run's stop) sends SIGTERM and then SIGKILL, and
 * which is waited on, a few seconds at most, before this resolves; a script that ends by itself has
 * what it left running in the group sent SIGKILL, so nothing it started outlives it into the session
 * (a `setsid` child leaves the group, and escapes both). It holds `lockFile`, a sibling of the
 * plugin refresh's lock, so two runs on a sprite never run two scripts into one Codex home at once;
 * the wait counts against the budget, and a run that waited on another's script skips its own, the
 * holder having just run it: `skipped`. Its output goes to `logFile` only; the record's `tail`
 * is the end of it, redacted.
 */
export async function runEnvRefresh(options: {
  script: string;
  env: NodeJS.ProcessEnv;
  warn: (line: string) => void;
  signal?: AbortSignal;
  /** The overall budget in ms, the lock's wait included; `ENV_REFRESH_TIMEOUT_MS` when absent. */
  timeoutMs?: number;
  cwd?: string;
  lockFile?: string;
  /** Where the script's output goes; a file in the temp dir when absent. */
  logFile?: string;
  graceMs?: number;
  exec?: typeof runInGroup;
  now?: () => number;
}): Promise<EnvRefresh> {
  const { script, env, warn, signal: stop } = options;
  const now = options.now ?? Date.now;
  const started = now();
  const logFile =
    options.logFile ?? join(tmpdir(), `sky-env-refresh-${process.pid}.log`);
  const record = (
    outcome: EnvRefresh["outcome"],
    fields: { exitCode?: number; reason?: string; tail?: string } = {},
  ): EnvRefresh => ({
    outcome,
    ...(fields.exitCode !== undefined && { exitCode: fields.exitCode }),
    durationMs: Math.max(0, Math.round(now() - started)),
    ...(fields.reason !== undefined && {
      reason: fields.reason.slice(0, REASON_MAX),
    }),
    ...(fields.tail !== undefined &&
      fields.tail !== "" && { tail: fields.tail.slice(-TAIL_MAX_CHARS) }),
  });
  if (stop?.aborted) {
    warn("runner: env refresh skipped (stopped)");
    return record("skipped", { reason: "stopped" });
  }
  const budget = options.timeoutMs ?? ENV_REFRESH_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(budget);
  const signal = stop ? AbortSignal.any([stop, timeout]) : timeout;
  const exec = options.exec ?? runInGroup;
  const lockFile = options.lockFile ?? join(tmpdir(), "sky-env-refresh.lock");
  // what the script did, set by the task under the lock
  let result: EnvRefresh | undefined;
  const task = async () => {
    try {
      // the file is the runner's user's alone, made before the shell appends to it
      closeSync(openSync(logFile, "a", 0o600));
    } catch {}
    try {
      await exec(
        "bash",
        ["-c", WRAPPER, "bash", logFile, script],
        {
          env,
          signal,
          endGroup: true,
          ...(options.cwd !== undefined && { cwd: options.cwd }),
        },
        options.graceMs ?? KILL_GRACE_MS,
      );
      result = record("ran", { exitCode: 0, tail: tailOf(logFile, env) });
    } catch (error) {
      const tail = tailOf(logFile, env);
      if (stop?.aborted) {
        result = record("skipped", { reason: "stopped", tail });
      } else if (timeout.aborted) {
        result = record("timed_out", {
          reason: `timed out after ${seconds(budget)}s`,
          tail,
        });
      } else {
        const { code, message } = error as { code?: unknown; message: string };
        const exited = typeof code === "number";
        // a command that a signal ended is reported by `runInGroup` as `... (SIGKILL)`
        const bySignal = /\((SIG[A-Z0-9]+)\)$/.exec(message)?.[1];
        result = record("failed", {
          ...(exited && { exitCode: code }),
          reason: exited
            ? `exited with code ${code}`
            : bySignal
              ? `killed by ${bySignal}`
              : (message.split("\n")[0] ?? "failed"),
          tail,
        });
      }
    }
  };
  try {
    const outcome = await withRefreshLock(lockFile, signal, task);
    if (outcome === "done-by-holder") {
      warn(
        `runner: env refresh skipped, another run ran it (waited ${seconds(now() - started)}s)`,
      );
      return record("skipped", { reason: "another run refreshed" });
    }
    if (outcome === "aborted") {
      // ended while another run held the lock
      return stop?.aborted
        ? record("skipped", { reason: "stopped" })
        : record("timed_out", {
            reason: `timed out after ${seconds(budget)}s waiting for another run's refresh`,
          });
    }
  } catch (error) {
    return record("failed", {
      reason: error instanceof Error ? error.message.split("\n")[0] : "failed",
    });
  }
  const done = result ?? record("failed", { reason: "did not run" });
  warn(
    `runner: env refresh ${done.outcome}${done.exitCode !== undefined ? ` (exit ${done.exitCode})` : ""} in ${seconds(done.durationMs)}s; output in ${logFile}`,
  );
  return done;
}

/**
 * The `runner.warning` a refresh that didn't run to the end deserves: `env refresh failed (exit 1): <last line>`.
 * None for one that ran, or was skipped (for a stop, or for another run's refresh having just run).
 */
export function refreshWarning(refresh: EnvRefresh): string | undefined {
  if (refresh.outcome === "ran" || refresh.outcome === "skipped")
    return undefined;
  const what = refresh.outcome === "timed_out" ? "timed out" : "failed";
  const exit =
    refresh.exitCode === undefined ? "" : ` (exit ${refresh.exitCode})`;
  const last = refresh.tail?.split("\n").at(-1)?.trim();
  const why = last || refresh.reason;
  return `env refresh ${what}${exit}${why ? `: ${why}` : ""}`.slice(0, 500);
}
