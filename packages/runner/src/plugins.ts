import { execFile } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type {
  PluginRefresh,
  PluginRefreshStep,
  PluginVersion,
} from "@sky/shared";

const exec = promisify(execFile);

/** Overall budget for the refresh; a slow or unreachable marketplace costs a session this at most. */
export const PLUGIN_REFRESH_TIMEOUT_MS = 30_000;

/**
 * What one `claude` command of the refresh may take. A command that stalls on the network (measured
 * on a sprite: a marketplace update 2.8 s, any other command 0.6 s) is cut here and counted as a
 * failed update, so the commands after it still run inside the overall budget instead of being starved.
 */
export const PLUGIN_STEP_TIMEOUT_MS = 10_000;

type Exec = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; signal: AbortSignal; cwd?: string },
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
 * and then saw the lock released doesn't run `task`, since the holder just ran it: it takes the lock,
 * runs `afterHolder` and resolves to "after-holder", or, given none, resolves to "done-by-holder"
 * having run nothing. A live holder that takes the lock again first is waited out the same way, for
 * as long as `signal` allows. A lock whose holder is gone is taken over and `task` runs. Resolves to
 * "aborted", having run nothing, when `signal` aborts while it waits; a lock that can't be made at
 * all runs `task` unlocked.
 */
export async function withRefreshLock(
  lockFile: string,
  signal: AbortSignal,
  task: () => Promise<void>,
  afterHolder?: () => Promise<void>,
): Promise<"ran" | "after-holder" | "done-by-holder" | "aborted"> {
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
      const next = waitedOnLiveHolder ? afterHolder : task;
      if (!next) {
        closeSync(fd);
        return "done-by-holder";
      }
      writeSync(fd, String(process.pid));
      closeSync(fd);
      await next();
      return waitedOnLiveHolder ? "after-holder" : "ran";
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

/** `PluginRefresh`'s bounds in `@sky/shared`: a record past them is dropped from the `run.started` post. */
const REASON_MAX = 300;
const PLUGINS_MAX = 100;
const STEPS_MAX = 50;

const idOf = (plugin: PluginVersion) =>
  plugin.marketplace === null
    ? plugin.name
    : `${plugin.name}@${plugin.marketplace}`;

type Listing = {
  /** The user-scope plugins, each once, its `name@marketplace` id split. */
  plugins: PluginVersion[];
  /**
   * The ids of user-scope plugins that also have a project-scope record for `projectDir`. Claude Code
   * writes one when a session opens a project whose settings enable a plugin installed for the user,
   * pinned to the version installed then, and `plugin update --scope user` never moves it.
   */
  pinnedHere: string[];
};

/** The plugins of a `claude plugin list --json`; `projectDir` picks which project-scope records count. */
function readListing(stdout: string, projectDir?: string): Listing {
  const installed = JSON.parse(stdout) as {
    id: string;
    scope: string;
    version?: unknown;
    projectPath?: unknown;
  }[];
  const seen = new Set<string>();
  const plugins: PluginVersion[] = [];
  const projectIds = new Set<string>();
  for (const { id, scope, version, projectPath } of installed) {
    if (
      scope === "project" &&
      projectDir !== undefined &&
      typeof projectPath === "string" &&
      sameDir(projectPath, projectDir)
    )
      projectIds.add(id);
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
  return {
    plugins,
    pinnedHere: plugins.map(idOf).filter((id) => projectIds.has(id)),
  };
}

/** Whether two paths name one directory, links resolved when they exist. */
function sameDir(a: string, b: string): boolean {
  const real = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  return real(a) === real(b);
}

/**
 * Refreshes the plugin marketplaces and updates the user-scope plugins installed in them, so a
 * sandbox doesn't keep the versions its env setup installed. A project-scope record of one of them
 * for `projectDir` (the worktree) is updated too, from that directory: Claude Code makes one the
 * first time a session opens a project whose settings enable the plugin, pinned to the version then
 * installed, and a session can load it over the user's. The repo's own files are never touched.
 * The marketplaces are reached the way
 * provisioning added them, by the same `claude` and env. A run that waited out another run's
 * refresh on the sprite skips the marketplace and user-scope updates, since that run just made them,
 * but takes the lock after it to update its own worktree's project-scope records the same way, which
 * that run's refresh didn't touch; with none to update, or no `projectDir`, it records `skipped`, and
 * either way says so on `warn`. Best effort: one overall timeout, the wait included, a
 * failure is one line on `warn`, and the session carries on with the cached versions. `signal` is
 * the run's stop: aborting it ends the refresh at once, and an already-aborted one spawns nothing.
 * Resolves to the record of what it did: the user-scope plugins before and after (null for a list
 * it never read; a waiting run with nothing to update has its one listing as both), the outcome
 * code (`refreshed`, `timed_out`, `failed` or `skipped`), the reason for a `failed` or `skipped`
 * one, how long it took and how long each command did (`steps`). A command is also cut at
 * `stepTimeoutMs`: a marketplace update cut there is a failed update, and the plugin updates after it
 * still run from the cached marketplace. Never throws.
 */
export async function refreshPlugins(options: {
  env: NodeJS.ProcessEnv;
  warn: (line: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** How long one `claude` command of the refresh may take; `PLUGIN_STEP_TIMEOUT_MS` when absent. */
  stepTimeoutMs?: number;
  /** How long the read-back after a refresh that ended early may take; `LIST_TIMEOUT_MS` when absent. */
  listTimeoutMs?: number;
  claude?: string;
  /** The agent's worktree, whose project-scope plugin records are updated too; none are when absent. */
  projectDir?: string;
  /** The sprite-wide lock file a refresh holds while it runs; in the temp dir when absent. */
  lockFile?: string;
  run?: Exec;
  now?: () => number;
  /** The clock the commands' durations are read from, in ms; `performance.now` when absent. */
  stepNow?: () => number;
}): Promise<PluginRefreshRecord> {
  const { env, warn, signal: stop } = options;
  const now = options.now ?? Date.now;
  const started = now();
  // null until the list is read: a read that found no plugins is `[]`
  let before: PluginVersion[] | null = null;
  let after: PluginVersion[] | null = null;
  // its own clock, so timing the commands doesn't add reads to `now`
  const stepNow = options.stepNow ?? (() => performance.now());
  // each command's duration, in the order they ran, kept to `STEPS_MAX`
  const steps: PluginRefreshStep[] = [];
  const timed = async <T>(name: string, task: () => Promise<T>): Promise<T> => {
    const began = stepNow();
    try {
      return await task();
    } finally {
      // a command a timeout cut short is counted up to the cut
      if (steps.length < STEPS_MAX)
        steps.push({
          name: name.slice(0, 100),
          ms: Math.max(0, Math.round(stepNow() - began)),
        });
    }
  };
  const record = (
    outcome: PluginRefreshRecord["outcome"],
    reason?: string,
  ): PluginRefreshRecord => ({
    outcome,
    ...(reason !== undefined && {
      reason:
        reason.length > REASON_MAX
          ? `${reason.slice(0, REASON_MAX - 1)}…`
          : reason,
    }),
    durationMs: Math.max(0, Math.round(now() - started)),
    before: before?.slice(0, PLUGINS_MAX) ?? null,
    after: after?.slice(0, PLUGINS_MAX) ?? null,
    ...(steps.length > 0 && { steps: [...steps] }),
  });
  if (stop?.aborted) {
    warn("runner: plugin refresh skipped (stopped)");
    return record("skipped", "stopped");
  }
  const run = options.run ?? exec;
  const claude = options.claude ?? claudeBinary(env);
  const timeout = AbortSignal.timeout(
    options.timeoutMs ?? PLUGIN_REFRESH_TIMEOUT_MS,
  );
  const signal = stop ? AbortSignal.any([stop, timeout]) : timeout;
  const lockFile =
    options.lockFile ?? join(tmpdir(), "sky-plugin-refresh.lock");
  const stepMs = options.stepTimeoutMs ?? PLUGIN_STEP_TIMEOUT_MS;
  const list = async (name: string, within: AbortSignal) =>
    readListing(
      (
        await timed(name, () =>
          run(claude, ["plugin", "list", "--json"], { env, signal: within }),
        )
      ).stdout,
      options.projectDir,
    );
  /** One command, cut at `stepMs` as well as at the refresh's end; the cut is an error that says so. */
  const claudeRun = async (name: string, args: string[], cwd?: string) => {
    const own = AbortSignal.timeout(stepMs);
    try {
      await timed(name, () =>
        run(claude, args, {
          env,
          signal: AbortSignal.any([signal, own]),
          ...(cwd !== undefined && { cwd }),
        }),
      );
    } catch (error) {
      if (!signal.aborted && own.aborted)
        throw new Error(`timed out after ${seconds(stepMs)}s`);
      throw error;
    }
  };
  let failedUpdates = "";
  // set by a waiting run whose own pass found no record of its worktree to update
  let nothingPinnedHere = false;
  /** One pass under the lock: the whole refresh, or, after another run's, this worktree's records only. */
  const pass = (whole: boolean) => async () => {
    const read = await list("list before", signal);
    before = read.plugins;
    if (!whole && read.pinnedHere.length === 0) {
      // no command ran since the listing, so it is the state either side
      after = before;
      nothingPinnedHere = true;
      return;
    }
    const updated: string[] = [];
    const failed: string[] = [];
    if (before.length === 0) {
      // nothing installed, so nothing for the refresh to change
      after = [];
    } else {
      try {
        if (whole) {
          try {
            await claudeRun("marketplace update", [
              "plugin",
              "marketplace",
              "update",
            ]);
          } catch (error) {
            // a stalled marketplace is not the whole refresh: the updates after it still run, from what is cached
            if (signal.aborted || !/^timed out/.test(firstLine(error)))
              throw error;
            failed.push(`marketplace (${firstLine(error)})`);
          }
          for (const plugin of before.map(idOf)) {
            try {
              await claudeRun(`update ${plugin}`, [
                "plugin",
                "update",
                plugin,
                "--scope",
                "user",
              ]);
              updated.push(plugin);
            } catch (error) {
              if (signal.aborted) throw error;
              failed.push(`${plugin} (${firstLine(error)})`);
            }
          }
        }
        // the worktree's own record of a plugin, which the user-scope update leaves where it was
        for (const plugin of read.pinnedHere) {
          try {
            await claudeRun(
              `update ${plugin} (project)`,
              ["plugin", "update", plugin, "--scope", "project"],
              options.projectDir,
            );
            updated.push(`${plugin} (project)`);
          } catch (error) {
            if (signal.aborted) throw error;
            failed.push(`${plugin} project scope (${firstLine(error)})`);
          }
        }
        after = (await list("list after", signal)).plugins;
      } catch (error) {
        // still under the lock, read back what is installed now: an update that landed before the cut may have changed it
        if (!stop?.aborted) {
          // its own timeout, since the refresh's is spent by now, but still ended by a stop
          const listTimeout = AbortSignal.timeout(
            options.listTimeoutMs ?? LIST_TIMEOUT_MS,
          );
          try {
            after = (
              await list(
                "list after (cut short)",
                stop ? AbortSignal.any([stop, listTimeout]) : listTimeout,
              )
            ).plugins;
          } catch {}
        }
        throw error;
      }
    }
    failedUpdates =
      failed.length > 0 ? `update failed for ${failed.join(", ")}` : "";
    const failures = failedUpdates === "" ? "" : `; ${failedUpdates}`;
    const took = seconds(now() - started);
    const what =
      updated.join(", ") ||
      (before.length > 0 ? "none updated" : "none installed");
    warn(
      whole
        ? `runner: plugins refreshed in ${took}s (${what})${failures}`
        : `runner: another run refreshed the plugins; this worktree's records updated in ${took}s (${what})${failures}`,
    );
  };
  try {
    // the wait for another run's refresh counts against this one's budget; ending it skips ours.
    // That run updated only its own worktree's project-scope records, so this one still updates its own.
    const outcome = await withRefreshLock(
      lockFile,
      signal,
      pass(true),
      options.projectDir === undefined ? undefined : pass(false),
    );
    if (
      outcome === "done-by-holder" ||
      (outcome === "after-holder" && nothingPinnedHere)
    ) {
      warn(
        `runner: plugin refresh skipped, another run refreshed the plugins (waited ${seconds(now() - started)}s)`,
      );
      // `before` and `after` are null unless this run listed the plugins under the lock itself
      return record("skipped", "another run refreshed the plugins");
    }
    // ended while another run held the lock
    if (outcome === "aborted")
      throw new Error("waiting for another run's refresh");
    return failedUpdates === ""
      ? record("refreshed")
      : record("failed", failedUpdates);
  } catch (error) {
    if (stop?.aborted) {
      warn(`runner: plugin refresh stopped after ${seconds(now() - started)}s`);
      return record("skipped", "stopped");
    }
    const why = timeout.aborted
      ? `timed out after ${seconds(now() - started)}s`
      : firstLine(error);
    warn(
      `runner: plugin refresh failed (${why}); continuing with the installed versions`,
    );
    return timeout.aborted ? record("timed_out") : record("failed", why);
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
