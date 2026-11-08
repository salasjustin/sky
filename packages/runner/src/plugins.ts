import { execFile } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Overall budget for the refresh; a slow or unreachable marketplace costs a session this at most. */
export const PLUGIN_REFRESH_TIMEOUT_MS = 30_000;

type Exec = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; signal: AbortSignal },
) => Promise<{ stdout: string }>;

/**
 * The `claude` that provisioning installed plugins with: `SKY_CLAUDE` when set, else the binary the
 * SDK bundles beside the runner, else whatever `claude` is on the PATH.
 */
export function claudeBinary(
  env: NodeJS.ProcessEnv,
  runnerPath: string = process.argv[1] ?? "",
): string {
  if (env.SKY_CLAUDE) return env.SKY_CLAUDE;
  const sdk = join(dirname(runnerPath), "node_modules/@anthropic-ai");
  try {
    for (const dir of readdirSync(sdk)) {
      const binary = join(sdk, dir, "claude");
      if (dir.startsWith("claude-agent-sdk-") && existsSync(binary))
        return binary;
    }
  } catch {
    // no SDK beside the runner (tests, local runs)
  }
  return "claude";
}

/** One refresh at a time per sprite: each `claude` it runs rewrites the shared `~/.claude.json`. */
const LOCK_POLL_MS = 200;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Runs `task` holding a lock file, so concurrent runs on a sprite refresh in turn rather than
 * together. A lock whose holder is gone is taken over. Resolves to false, without running `task`,
 * when `signal` aborts first; a lock that can't be made at all runs `task` unlocked.
 */
export async function withRefreshLock(
  lockFile: string,
  signal: AbortSignal,
  task: () => Promise<void>,
): Promise<boolean> {
  for (;;) {
    let fd: number;
    try {
      fd = openSync(lockFile, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        await task();
        return true;
      }
      let holder = NaN;
      try {
        holder = Number(readFileSync(lockFile, "utf8"));
      } catch {}
      // an empty file is a holder between creating the lock and writing its pid: not stale yet
      if (!Number.isNaN(holder) && holder > 0 && !alive(holder)) {
        try {
          unlinkSync(lockFile);
        } catch {}
        continue;
      }
      try {
        await sleep(LOCK_POLL_MS, undefined, { signal });
      } catch {
        return false;
      }
      continue;
    }
    try {
      writeSync(fd, String(process.pid));
      closeSync(fd);
      await task();
      return true;
    } finally {
      try {
        unlinkSync(lockFile);
      } catch {}
    }
  }
}

/**
 * Refreshes the plugin marketplaces and updates the user-scope plugins installed in them, so a
 * sandbox doesn't keep the versions its env setup installed. The marketplaces are reached the way
 * provisioning added them, by the same `claude` and env. Best effort: one overall timeout, a
 * failure is one line on `warn`, and the session carries on with the cached versions. `signal` is
 * the run's stop: aborting it ends the refresh at once, and an already-aborted one spawns nothing.
 * Never throws.
 */
export async function refreshPlugins(options: {
  env: NodeJS.ProcessEnv;
  warn: (line: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  claude?: string;
  /** The sprite-wide lock one refresh at a time holds; in the temp dir when absent. */
  lockFile?: string;
  run?: Exec;
  now?: () => number;
}): Promise<void> {
  const { env, warn, signal: stop } = options;
  if (stop?.aborted) {
    warn("runner: plugin refresh skipped (stopped)");
    return;
  }
  const run = options.run ?? exec;
  const now = options.now ?? Date.now;
  const claude = options.claude ?? claudeBinary(env);
  const timeout = AbortSignal.timeout(
    options.timeoutMs ?? PLUGIN_REFRESH_TIMEOUT_MS,
  );
  const signal = stop ? AbortSignal.any([stop, timeout]) : timeout;
  const started = now();
  // the wait for another run's refresh counts against this one's budget; ending it skips ours
  const lockFile =
    options.lockFile ?? join(tmpdir(), "sky-plugin-refresh.lock");
  try {
    const ran = await withRefreshLock(lockFile, signal, async () => {
      const claudeRun = (...args: string[]) =>
        run(claude, args, { env, signal });
      const { stdout } = await claudeRun("plugin", "list", "--json");
      const installed = JSON.parse(stdout) as { id: string; scope: string }[];
      const plugins = [
        ...new Set(
          installed.filter((p) => p.scope === "user").map((p) => p.id),
        ),
      ];
      const updated: string[] = [];
      const failed: string[] = [];
      if (plugins.length > 0) {
        await claudeRun("plugin", "marketplace", "update");
        for (const plugin of plugins) {
          try {
            await claudeRun("plugin", "update", plugin, "--scope", "user");
            updated.push(plugin);
          } catch (error) {
            if (signal.aborted) throw error;
            failed.push(`${plugin} (${firstLine(error)})`);
          }
        }
      }
      const failures =
        failed.length > 0 ? `; update failed for ${failed.join(", ")}` : "";
      warn(
        `runner: plugins refreshed in ${seconds(now() - started)}s (${updated.join(", ") || (plugins.length > 0 ? "none updated" : "none installed")})${failures}`,
      );
    });
    // ended while another run held the lock
    if (!ran) throw new Error("waiting for another run's refresh");
  } catch (error) {
    if (stop?.aborted) {
      warn(`runner: plugin refresh stopped after ${seconds(now() - started)}s`);
      return;
    }
    const why = timeout.aborted
      ? `timed out after ${seconds(now() - started)}s`
      : firstLine(error);
    warn(
      `runner: plugin refresh failed (${why}); continuing with the installed versions`,
    );
  }
}

const seconds = (ms: number) => (ms / 1000).toFixed(1);

const firstLine = (error: unknown) =>
  error instanceof Error ? error.message.split("\n")[0] : String(error);
