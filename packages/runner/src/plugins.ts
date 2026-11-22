import { spawn } from "node:child_process";
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
import type {
  PluginRefresh,
  PluginRefreshStep,
  PluginVersion,
} from "@sky/shared";

/**
 * Overall budget for the refresh. Past it run only the stop of the command it cut (`KILL_GRACE_MS` and
 * `KILL_WAIT_MS`) and the read-back, under the listing cap and the same stop: 41 s in all at most.
 */
export const PLUGIN_REFRESH_TIMEOUT_MS = 30_000;

/**
 * What one marketplace update or one plugin update may take. An update that stalls on the network
 * (measured on a sprite: a marketplace update 2.8 s, any other command 0.6 s) is cut here and counted
 * as a failed update, so the updates after it still run for as long as the overall budget lasts.
 */
export const PLUGIN_STEP_TIMEOUT_MS = 10_000;

/**
 * What one `claude plugin list` may take. It reads local files only (measured on a sprite: 0.4 s warm,
 * 0.9 s cold, 0.8 s with six at once, the same with the network unreachable), so this is over five times
 * the slowest of them: one that stalls is cut and tried once more, not left to spend the overall budget.
 */
export const PLUGIN_LIST_TIMEOUT_MS = 5_000;

/** How long a cut command's process group gets to exit on SIGTERM before it is sent SIGKILL. */
export const KILL_GRACE_MS = 2_000;

/** How long after SIGKILL a command is waited on to close, and its group to be gone, before it is given up on. */
const KILL_WAIT_MS = 1_000;

/** How often a cut command's group is checked for being gone. */
const GROUP_POLL_MS = 50;

/** What a command may write to stdout, and to stderr, before it is cut. */
const OUTPUT_MAX_BYTES = 1024 * 1024;

/** A command cut for its output: never a `CapExceeded`, even when its cap fires while it is waited on. */
export class OutputExceeded extends Error {
  constructor(stream: "stdout" | "stderr") {
    super(`wrote more than 1 MiB to ${stream}`);
  }
}

/**
 * Runs `file` as the leader of its own process group, so a cut reaches what it started in that group (a
 * git child of `claude` keeps writing otherwise). Aborting `signal` cuts the command, and so does output
 * past `OUTPUT_MAX_BYTES`: the group is sent SIGTERM, then SIGKILL after `graceMs`, and the promise
 * rejects with the abort's reason, or an error naming the limit, once the command has closed and its
 * group is gone. Something that still holds on is given up on `KILL_WAIT_MS` after the SIGKILL, its
 * pipes destroyed so it can't hold the runner. A command that isn't cut settles once it has closed.
 */
export function runInGroup(
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; signal: AbortSignal; cwd?: string },
  graceMs: number = KILL_GRACE_MS,
): Promise<{ stdout: string }> {
  const { signal } = options;
  return new Promise((settle, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const child = spawn(file, args, {
      env: options.env,
      ...(options.cwd !== undefined && { cwd: options.cwd }),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const pid = child.pid;
    if (pid === undefined) {
      child.once("error", reject);
      return;
    }
    liveGroups.add(pid);
    let cut = false;
    let cutReason: unknown;
    let closed = false;
    let finished = false;
    const timers: NodeJS.Timeout[] = [];
    const done = (finish: () => void) => {
      // `close` can follow a give-up, when the pid may lead a later command's group
      if (finished) return;
      finished = true;
      signal.removeEventListener("abort", onAbort);
      for (const timer of timers) clearTimeout(timer);
      liveGroups.delete(pid);
      finish();
    };
    const settleCutIfGone = () => {
      const groupLeft = killGroup(pid, 0);
      if (closed && !groupLeft) done(() => reject(cutReason));
    };
    const giveUp = () =>
      done(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        reject(cutReason);
      });
    const cutShort = (reason: unknown) => {
      if (cut) return;
      cut = true;
      cutReason = reason;
      killGroup(pid, "SIGTERM");
      timers.push(
        setInterval(settleCutIfGone, GROUP_POLL_MS),
        setTimeout(() => killGroup(pid, "SIGKILL"), graceMs),
        setTimeout(giveUp, graceMs + KILL_WAIT_MS),
      );
    };
    const onAbort = () => cutShort(signal.reason);
    const output = { stdout: "", stderr: "" };
    for (const name of ["stdout", "stderr"] as const) {
      let bytes = 0;
      child[name].setEncoding("utf8").on("data", (chunk: string) => {
        // still read once cut, so a full pipe can't block the command's exit, but not kept
        if (cut) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > OUTPUT_MAX_BYTES) cutShort(new OutputExceeded(name));
        else output[name] += chunk;
      });
    }
    signal.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => done(() => reject(error)));
    // the leader is reaped by now, so an empty group's id is free for another process to take
    child.once("exit", () => killGroup(pid, 0));
    child.once("close", (code, by) => {
      closed = true;
      if (cut) {
        settleCutIfGone();
        return;
      }
      done(() => {
        if (code === 0) settle({ stdout: output.stdout });
        else
          reject(
            Object.assign(
              new Error(
                `Command failed: ${file} ${args.join(" ")}${by ? ` (${by})` : ""}`,
              ),
              { code, stderr: output.stderr },
            ),
          );
      });
    });
    // a listener isn't called for a signal that has already aborted
    if (signal.aborted) onAbort();
  });
}

type Exec = typeof runInGroup;

/**
 * The only groups that may be signalled: those of commands still running or waited on after a cut,
 * so the runner's end can take them along. A group that is gone leaves at once: its id can be reused.
 */
const liveGroups = new Set<number>();

/** Signals a tracked group, or with 0 only looks for it; false when it is untracked or found gone. */
const killGroup = (pid: number, by: NodeJS.Signals | 0): boolean => {
  if (!liveGroups.has(pid)) return false;
  try {
    process.kill(-pid, by);
  } catch (error) {
    // any other error (EPERM) is from a group that is still there
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      liveGroups.delete(pid);
      return false;
    }
  }
  return true;
};

/**
 * SIGKILLs every command a refresh still has running or is waiting on, each with the rest of its group.
 * Synchronous, for the runner's own end: a signal's death skips `exit` handlers, and a command in its
 * own group would outlive the runner.
 */
export function killRefreshCommands(): void {
  for (const pid of liveGroups) killGroup(pid, "SIGKILL");
  liveGroups.clear();
}
process.on("exit", killRefreshCommands);

/** A command cut by its own cap, not by the refresh's end or the run's stop: a type, as error text can't say which. */
class CapExceeded extends Error {
  constructor(capMs: number) {
    super(`timed out after ${seconds(capMs)}s`);
  }
}

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

/** `PluginRefresh`'s bounds in `@sky/shared`: a record past them is dropped from the `run.started` post. */
const REASON_MAX = 300;
const PLUGINS_MAX = 100;
const STEPS_MAX = 50;

/**
 * The pseudo-marketplace Claude Code lists plugins loaded from a skills directory under. It has
 * nothing to update, so a user-scope one is recorded but is neither marketplace-updated nor plugin-updated.
 */
const SKILLS_DIR = "skills-dir";

type Listing = {
  /** The user-scope plugins as recorded, each once: its `name@marketplace` id split, then cut to bounds. */
  plugins: PluginVersion[];
  /** The whole ids of those that can be updated, which is what commands are given. */
  ids: string[];
  /** The whole names of the marketplaces they come from, each once. */
  marketplaces: string[];
  /**
   * Those of `ids` that also have a project-scope record for `projectDir`. Claude Code
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
  const marketplaces = new Set<string>();
  const updatable: string[] = [];
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
    const marketplace = at > 0 ? id.slice(at + 1) : null;
    if (marketplace !== SKILLS_DIR) {
      updatable.push(id);
      if (marketplace !== null) marketplaces.add(marketplace);
    }
    plugins.push({
      name: (at > 0 ? id.slice(0, at) : id).slice(0, 100),
      marketplace: marketplace?.slice(0, 100) ?? null,
      version:
        typeof version === "string" && version !== ""
          ? version.slice(0, 100)
          : "unknown",
    });
  }
  return {
    plugins,
    ids: updatable,
    marketplaces: [...marketplaces],
    pinnedHere: updatable.filter((id) => projectIds.has(id)),
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
 * the run's stop: aborting it cuts the running command, and an already-aborted one spawns nothing.
 * Resolves to the record of what it did: the user-scope plugins before and after (null for a list
 * it never read; a waiting run with nothing to update has its one listing as both), the outcome
 * code (`refreshed`, `timed_out`, `failed` or `skipped`), the reason for a `failed` or `skipped`
 * one (and for a `timed_out` one, the updates that had failed or been cut and stopped before the
 * budget ran out), how long it took and how long each command did (`steps`). Each marketplace the
 * installed plugins come from, `skills-dir` aside, is updated by name, and every command has a cap
 * of its own besides the overall budget: an
 * update is cut at `stepTimeoutMs`, a listing at `listTimeoutMs`. A marketplace update that fails, cut
 * or not, is a failed update named for that marketplace, and the plugin updates after it still run from
 * the cached marketplace while the budget lasts. A listing cut at its own cap is tried once more; if the
 * first one is cut twice nothing is updated and the outcome is `failed`, and if the last one is, `after`
 * stays null. A cut command's process group is killed, and waited on until it is gone or given up on
 * (see `runInGroup`), before the next command or the lock's release.
 * Never throws.
 */
export async function refreshPlugins(options: {
  env: NodeJS.ProcessEnv;
  warn: (line: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** How long one marketplace update or one plugin update may take; `PLUGIN_STEP_TIMEOUT_MS` when absent. */
  stepTimeoutMs?: number;
  /** How long one `claude plugin list` may take; `PLUGIN_LIST_TIMEOUT_MS` when absent. */
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
      // a command that was cut is counted until it was stopped or given up on
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
  const run = options.run ?? runInGroup;
  const claude = options.claude ?? claudeBinary(env);
  const timeout = AbortSignal.timeout(
    options.timeoutMs ?? PLUGIN_REFRESH_TIMEOUT_MS,
  );
  const signal = stop ? AbortSignal.any([stop, timeout]) : timeout;
  const lockFile =
    options.lockFile ?? join(tmpdir(), "sky-plugin-refresh.lock");
  const stepMs = options.stepTimeoutMs ?? PLUGIN_STEP_TIMEOUT_MS;
  const listMs = options.listTimeoutMs ?? PLUGIN_LIST_TIMEOUT_MS;
  /**
   * One command, cut at `capMs` as well as when `within` ends; a cut by its own cap alone is a
   * `CapExceeded`, unless its output had already cut it.
   */
  const capped = async (
    name: string,
    capMs: number,
    within: AbortSignal,
    args: string[],
    cwd?: string,
  ) => {
    const own = AbortSignal.timeout(capMs);
    try {
      return await timed(name, () =>
        run(claude, args, {
          env,
          signal: AbortSignal.any([within, own]),
          ...(cwd !== undefined && { cwd }),
        }),
      );
    } catch (error) {
      if (!within.aborted && own.aborted && !(error instanceof OutputExceeded))
        throw new CapExceeded(capMs);
      throw error;
    }
  };
  const claudeRun = async (name: string, args: string[], cwd?: string) => {
    await capped(name, stepMs, signal, args, cwd);
  };
  const list = async (name: string, within: AbortSignal) =>
    readListing(
      (await capped(name, listMs, within, ["plugin", "list", "--json"])).stdout,
      options.projectDir,
    );
  /** A listing whose own cap cuts it is run once more; a second cut is the caller's. */
  const listWithRetry = async (name: string, within: AbortSignal) => {
    try {
      return await list(name, within);
    } catch (error) {
      if (!(error instanceof CapExceeded)) throw error;
      return await list(`${name} (retry)`, within);
    }
  };
  let failedReason = "";
  // updates that failed or were cut and stopped, outside the pass so a refresh the budget or a listing ends still names them
  const failed: string[] = [];
  const failedUpdates = () =>
    failed.length > 0 ? `update failed for ${failed.join(", ")}` : "";
  // set by a waiting run whose own pass found no record of its worktree to update
  let nothingPinnedHere = false;
  /** One pass under the lock: the whole refresh, or, after another run's, this worktree's records only. */
  const pass = (whole: boolean) => async () => {
    let read: Listing;
    try {
      read = await listWithRetry("list before", signal);
    } catch (error) {
      if (!(error instanceof CapExceeded)) throw error;
      // what is installed is unknown, so nothing can be updated
      failedReason = `list before ${error.message} twice; no plugin was updated`;
      warn(
        `runner: plugin refresh failed (${failedReason}); continuing with the installed versions`,
      );
      return;
    }
    before = read.plugins;
    if (!whole && read.pinnedHere.length === 0) {
      // no command ran since the listing, so it is the state either side
      after = before;
      nothingPinnedHere = true;
      return;
    }
    const updated: string[] = [];
    let unreadAfter = "";
    if (before.length === 0) {
      // nothing installed, so nothing for the refresh to change
      after = [];
    } else {
      try {
        if (whole) {
          // each by name, so a failure says which one; only the marketplaces of plugins that can be updated
          for (const name of read.marketplaces) {
            try {
              await claudeRun(`update marketplace ${name}`, [
                "plugin",
                "marketplace",
                "update",
                // without it a name like `--help` is an option, and exits 0 having updated nothing
                "--",
                name,
              ]);
            } catch (error) {
              // a marketplace that stalled or failed fast is not the whole refresh: the updates after it still run, from what is cached
              if (signal.aborted) throw error;
              failed.push(`marketplace ${name} (${firstLine(error)})`);
            }
          }
          for (const plugin of read.ids) {
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
        try {
          after = (await listWithRetry("list after", signal)).plugins;
        } catch (error) {
          if (!(error instanceof CapExceeded)) throw error;
          // the updates ran; only the read-back is missing, and `after` stays null
          unreadAfter = `list after ${error.message} twice`;
        }
      } catch (error) {
        // still under the lock, read back what is installed now: an update that landed before the cut may have changed it
        if (!stop?.aborted) {
          try {
            // the refresh's budget may be spent by now, so this runs under its own cap, ended only by a stop
            after = (
              await list(
                "list after (cut short)",
                stop ?? new AbortController().signal,
              )
            ).plugins;
          } catch {}
        }
        throw error;
      }
    }
    failedReason = [failedUpdates(), unreadAfter]
      .filter((part) => part !== "")
      .join("; ");
    const failures = failedReason === "" ? "" : `; ${failedReason}`;
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
    return failedReason === ""
      ? record("refreshed")
      : record("failed", failedReason);
  } catch (error) {
    if (stop?.aborted) {
      warn(`runner: plugin refresh stopped after ${seconds(now() - started)}s`);
      return record("skipped", "stopped");
    }
    const why = timeout.aborted
      ? `timed out after ${seconds(now() - started)}s`
      : firstLine(error);
    const cut = failedUpdates();
    warn(
      `runner: plugin refresh failed (${why}${cut === "" ? "" : `; ${cut}`}); continuing with the installed versions`,
    );
    return timeout.aborted
      ? record("timed_out", cut === "" ? undefined : cut)
      : record("failed", cut === "" ? why : `${why}; ${cut}`);
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
 * A failed command's error says `Command failed: <binary> <args>`, so its stderr names the cause instead.
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
