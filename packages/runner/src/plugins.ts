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
import type { PluginRefresh, PluginVersion } from "@sky/shared";

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

/** How often a run waiting on another run's refresh checks the lock again. */
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
 * Runs `task` holding a lock file, so concurrent runs on a sprite refresh one at a time: each
 * `claude` a refresh runs rewrites the shared `~/.claude.json`. A run that waited on a live holder
 * and then saw the lock released doesn't run `task`: the holder just ran the same refresh. A lock
 * whose holder is gone is taken over and `task` runs. Resolves to "aborted", without running `task`,
 * when `signal` aborts while it waits; a lock that can't be made at all runs `task` unlocked.
 */
export async function withRefreshLock(
  lockFile: string,
  signal: AbortSignal,
  task: () => Promise<void>,
): Promise<"ran" | "done-by-holder" | "aborted"> {
  let waitedOnLiveHolder = false;
  for (;;) {
    let fd: number;
    try {
      fd = openSync(lockFile, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        await task();
        return "ran";
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
        // a holder that died may not have finished its refresh
        waitedOnLiveHolder = false;
        continue;
      }
      waitedOnLiveHolder = true;
      try {
        await sleep(LOCK_POLL_MS, undefined, { signal });
      } catch {
        return "aborted";
      }
      continue;
    }
    try {
      if (waitedOnLiveHolder) {
        closeSync(fd);
        return "done-by-holder";
      }
      writeSync(fd, String(process.pid));
      closeSync(fd);
      await task();
      return "ran";
    } finally {
      try {
        unlinkSync(lockFile);
      } catch {}
    }
  }
}

/** What a refresh did, as the run's `run.started` carries it; the session adds what it loaded. */
export type PluginRefreshRecord = Omit<PluginRefresh, "loaded">;

/** Bounds the `claude plugin list` that reads the plugins back after a refresh that ended early. */
const LIST_TIMEOUT_MS = 5_000;

/** `PluginRefresh`'s bounds in `@sky/shared`: a record past them fails the `run.started` post. */
const OUTCOME_MAX = 300;
const PLUGINS_MAX = 100;

const idOf = (plugin: PluginVersion) =>
  plugin.marketplace === null
    ? plugin.name
    : `${plugin.name}@${plugin.marketplace}`;

/** The user-scope plugins of a `claude plugin list --json`, each once, its `name@marketplace` id split. */
function userPlugins(stdout: string): PluginVersion[] {
  const installed = JSON.parse(stdout) as {
    id: string;
    scope: string;
    version?: unknown;
  }[];
  const seen = new Set<string>();
  const plugins: PluginVersion[] = [];
  for (const { id, scope, version } of installed) {
    if (scope !== "user" || seen.has(id)) continue;
    seen.add(id);
    const at = id.lastIndexOf("@");
    plugins.push({
      name: (at > 0 ? id.slice(0, at) : id).slice(0, 100),
      marketplace: at > 0 ? id.slice(at + 1).slice(0, 100) : null,
      version:
        typeof version === "string" && version !== ""
          ? version.slice(0, 100)
          : "unknown",
    });
  }
  return plugins;
}

/**
 * Refreshes the plugin marketplaces and updates the user-scope plugins installed in them, so a
 * sandbox doesn't keep the versions its env setup installed. The marketplaces are reached the way
 * provisioning added them, by the same `claude` and env. A run that waited out another run's
 * refresh on the sprite skips its own and says so on `warn`. Best effort: one overall timeout, a
 * failure is one line on `warn`, and the session carries on with the cached versions. `signal` is
 * the run's stop: aborting it ends the refresh at once, and an already-aborted one spawns nothing.
 * Resolves to the record of what it did: the user-scope plugins before and after, the outcome
 * (`refreshed`, `timed_out`, `failed: <reason>` or `skipped: <reason>`) and how long it took.
 * Never throws.
 */
export async function refreshPlugins(options: {
  env: NodeJS.ProcessEnv;
  warn: (line: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** How long the read-back after a refresh that ended early may take; `LIST_TIMEOUT_MS` when absent. */
  listTimeoutMs?: number;
  claude?: string;
  /** The sprite-wide lock file a refresh holds while it runs; in the temp dir when absent. */
  lockFile?: string;
  run?: Exec;
  now?: () => number;
}): Promise<PluginRefreshRecord> {
  const { env, warn, signal: stop } = options;
  const now = options.now ?? Date.now;
  const started = now();
  let before: PluginVersion[] = [];
  let after: PluginVersion[] | undefined;
  const record = (outcome: string): PluginRefreshRecord => ({
    outcome:
      outcome.length > OUTCOME_MAX
        ? `${outcome.slice(0, OUTCOME_MAX - 1)}…`
        : outcome,
    durationMs: Math.max(0, Math.round(now() - started)),
    before: before.slice(0, PLUGINS_MAX),
    // empty, not `before`, when the refresh never read the list back
    after: (after ?? []).slice(0, PLUGINS_MAX),
  });
  if (stop?.aborted) {
    warn("runner: plugin refresh skipped (stopped)");
    return record("skipped: stopped");
  }
  const run = options.run ?? exec;
  const claude = options.claude ?? claudeBinary(env);
  const timeout = AbortSignal.timeout(
    options.timeoutMs ?? PLUGIN_REFRESH_TIMEOUT_MS,
  );
  const signal = stop ? AbortSignal.any([stop, timeout]) : timeout;
  const lockFile =
    options.lockFile ?? join(tmpdir(), "sky-plugin-refresh.lock");
  const list = async (within: AbortSignal) =>
    userPlugins(
      (await run(claude, ["plugin", "list", "--json"], { env, signal: within }))
        .stdout,
    );
  let failedUpdates = "";
  try {
    // the wait for another run's refresh counts against this one's budget; ending it skips ours
    const outcome = await withRefreshLock(lockFile, signal, async () => {
      const claudeRun = (...args: string[]) =>
        run(claude, args, { env, signal });
      before = await list(signal);
      const updated: string[] = [];
      const failed: string[] = [];
      if (before.length > 0) {
        try {
          await claudeRun("plugin", "marketplace", "update");
          for (const plugin of before.map(idOf)) {
            try {
              await claudeRun("plugin", "update", plugin, "--scope", "user");
              updated.push(plugin);
            } catch (error) {
              if (signal.aborted) throw error;
              failed.push(`${plugin} (${firstLine(error)})`);
            }
          }
          after = await list(signal);
        } catch (error) {
          // still under the lock, read back what the session will start with: an update that landed before the cut changed it
          if (!stop?.aborted) {
            // its own timeout, since the refresh's is spent by now, but still ended by a stop
            const listTimeout = AbortSignal.timeout(
              options.listTimeoutMs ?? LIST_TIMEOUT_MS,
            );
            try {
              after = await list(
                stop ? AbortSignal.any([stop, listTimeout]) : listTimeout,
              );
            } catch {}
          }
          throw error;
        }
      }
      failedUpdates =
        failed.length > 0 ? `update failed for ${failed.join(", ")}` : "";
      const failures = failedUpdates === "" ? "" : `; ${failedUpdates}`;
      warn(
        `runner: plugins refreshed in ${seconds(now() - started)}s (${updated.join(", ") || (before.length > 0 ? "none updated" : "none installed")})${failures}`,
      );
    });
    if (outcome === "done-by-holder") {
      warn(
        `runner: plugin refresh skipped, another run refreshed the plugins (waited ${seconds(now() - started)}s)`,
      );
      // no `claude` runs outside the lock, so this run records only what its session loaded
      return record("skipped: another run refreshed the plugins");
    }
    // ended while another run held the lock
    if (outcome === "aborted")
      throw new Error("waiting for another run's refresh");
    return record(
      failedUpdates === "" ? "refreshed" : `failed: ${failedUpdates}`,
    );
  } catch (error) {
    if (stop?.aborted) {
      warn(`runner: plugin refresh stopped after ${seconds(now() - started)}s`);
      return record("skipped: stopped");
    }
    const why = timeout.aborted
      ? `timed out after ${seconds(now() - started)}s`
      : firstLine(error);
    warn(
      `runner: plugin refresh failed (${why}); continuing with the installed versions`,
    );
    return record(timeout.aborted ? "timed_out" : `failed: ${why}`);
  }
}

/**
 * The plugins a session says it loaded, from its `init` message. Claude Code names a marketplace
 * plugin's directory `<plugins root>/cache/<marketplace>/<plugin>/<version>`, so the marketplace and
 * the version it resolved come from there; a plugin from anywhere else keeps the manifest's version.
 */
export function loadedPlugins(
  plugins: { name: string; path: string; version?: string }[] | undefined,
): PluginVersion[] {
  return (plugins ?? []).slice(0, 100).map(({ name, path, version }) => {
    const cached = /\/cache\/([^/]+)\/[^/]+\/([^/]+)\/?$/.exec(path);
    return {
      name: name.slice(0, 100) || "unknown",
      marketplace: cached?.[1]?.slice(0, 100) ?? null,
      version: (cached?.[2] ?? version ?? "unknown").slice(0, 100) || "unknown",
    };
  });
}

const seconds = (ms: number) => (ms / 1000).toFixed(1);

/**
 * The reason a failed refresh is recorded with: one line, short, never the command's whole output.
 * A failed `execFile` says `Command failed: <binary> <args>`, so its stderr names the cause instead.
 */
const firstLine = (error: unknown) => {
  const stderr =
    typeof error === "object" && error !== null && "stderr" in error
      ? error.stderr
      : undefined;
  const cause =
    typeof stderr === "string"
      ? stderr.split("\n").find((line) => line.trim() !== "")
      : undefined;
  const line =
    cause?.trim() ??
    (error instanceof Error ? error.message : String(error)).split("\n")[0] ??
    "";
  return line.slice(0, 200);
};
