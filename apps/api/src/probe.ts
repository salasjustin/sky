import { type Db, runs } from "@sky/db";
import type { RunId } from "@sky/shared";
import { eq } from "drizzle-orm";
import { isRunnerAlive } from "./launch.js";
import {
  collectDiagnostics,
  type Diagnostics,
  restartSince,
} from "./memory.js";
import { redact } from "./redact.js";
import {
  failLostRun,
  lastBashCommand,
  recordProbe,
  runningRunsOn,
  silentRuns,
} from "./runs.js";
import { type SpriteOps, spriteExists } from "./sprites.js";

type Deps = {
  db: Db;
  sprites: SpriteOps;
  /** How long a `running` run may be silent before its runner is checked, and the window between checks. */
  probeMs: number;
  /** Below this many MB available, a sprite whose runner is gone is taken to have killed it for memory. */
  lowMemoryMb: number;
  log: (line: string) => void;
  nudgeDeliveries: () => void;
};

/** Says why the sprite killed the runner, naming the sprite and the memory it had. */
function killedError(spriteName: string, { memory }: Diagnostics): string {
  const seen = memory
    ? `${memory.availableMb} MB of ${memory.totalMb} MB available`
    : "its free memory could not be read";
  return `runner_killed: the sprite killed the runner, likely out of memory (sprite ${spriteName}: ${seen})`;
}

const LAST_COMMAND_MAX = 300;

/**
 * Says the sprite restarted while the run worked, when and in what way, with the 5-minute load and
 * the run's last Bash command (redacted by `known`, cut to `LAST_COMMAND_MAX`).
 */
function restartedError(
  kind: "rebooted" | "processes",
  { bootAgeSec, initAgeSec, load5 }: Diagnostics,
  lastCommand: string | undefined,
  known: readonly string[],
): string {
  const ageSec = (kind === "rebooted" ? bootAgeSec : initAgeSec) ?? 0;
  const at = new Date(Date.now() - ageSec * 1000)
    .toISOString()
    .replace(/\.\d+Z$/, "Z")
    .replace("T", " ")
    .replace("Z", " UTC");
  const what =
    kind === "rebooted"
      ? "the machine rebooted"
      : "its processes restarted: the machine stayed up but its init did not";
  const load = load5 === undefined ? "unknown" : String(load5);
  const command = lastCommand
    ? redact(lastCommand, known).slice(0, LAST_COMMAND_MAX) +
      (lastCommand.length > LAST_COMMAND_MAX ? "…" : "")
    : "none recorded";
  return `sandbox_restarted: the sandbox restarted at ${at} while this run was working (${what}), most often because memory use passed the machine's limit (5-min load ${load}); the last command was: ${command}`;
}

/**
 * Wakes the sprite of a launch that never reported in, by looking for its runner: a sprite that
 * paused before the runner held it froze the runner, and any exec unfreezes it. A live runner is
 * left alone, a missing one is left to the launch deadline. Resolves to whether the runner is alive,
 * or `undefined` when the check failed; never throws.
 */
export async function wakeLaunch(
  sprites: SpriteOps,
  runId: RunId,
  spriteName: string,
  log: (line: string) => void,
): Promise<boolean | undefined> {
  try {
    const alive = await isRunnerAlive(sprites, spriteName, runId);
    log(
      alive
        ? `woke ${spriteName} for ${runId}: its runner is alive`
        : `woke ${spriteName} for ${runId}: no runner found; the launch deadline decides`,
    );
    return alive;
  } catch (err) {
    log(`waking ${spriteName} for ${runId} failed: ${err}`);
    return undefined;
  }
}

/**
 * Checks the runner of each `running` run silent for `probeMs`, so a sprite that slept through a
 * run is found in minutes, not at `runner_timeout`. The check wakes the sprite: a live runner gets a
 * `run.probed` event (which also starts its next window), a gone one fails the run, as does a sprite
 * that no longer exists. A sprite that can't answer is logged and retried a window later, never held
 * against the run. Before failing a run whose runner is gone, the sprite's memory, biggest processes
 * and kernel kill lines are collected, logged and stored on the run; when the kernel logged a memory
 * kill since the run began, or the sprite has less than `lowMemoryMb` available, the run fails with
 * `runner_killed`, else `runner_lost`; a sprite that booted, or whose pid 1 started, after the run
 * began restarted under it, which fails the run as `sandbox_restarted` before either. An exec on a sprite exiting 137 probes its running runs at
 * once (`probeSprite`).
 */
export function createRunProber({
  db,
  sprites: ops,
  probeMs,
  lowMemoryMb,
  log,
  nudgeDeliveries,
}: Deps) {
  // a probe's own exec killed with 137 never probes again, or probes would ping-pong on a starving sprite
  const sprites: SpriteOps = { ...ops, onExecKilled: undefined };
  // when each run was last probed, so a probe that records no event (a sprite that didn't answer, or
  // is still waking) isn't repeated every sweep; in memory, as a restart costs at most one extra probe
  const attempts = new Map<RunId, number>();
  const inFlight = new Set<RunId>();
  // sprites with a `probeSprite` underway: the kills that follow one 137 on a starving sprite start no more
  const spritesInFlight = new Set<string>();

  // a lookup that fails says nothing of the sprite, so it counts as still there
  async function spriteGone(runId: RunId, spriteName: string) {
    try {
      return !(await spriteExists(sprites, spriteName));
    } catch (err) {
      log(
        `checking whether sprite ${spriteName} exists after probing ${runId} failed: ${err}`,
      );
      return false;
    }
  }

  // a run with no row is past failing; now then counts no kill line
  function startedAt(runId: RunId): number {
    const row = db
      .select({ createdAt: runs.createdAt })
      .from(runs)
      .where(eq(runs.id, runId))
      .get();
    return row ? Date.parse(row.createdAt) : Date.now();
  }

  /** Fails the run whose runner is gone; a sprite that is gone too skips the diagnostics, as there is nothing to read. */
  async function failGone(
    runId: RunId,
    spriteName: string,
    lastEventId: number,
    spriteIsThere: boolean,
  ): Promise<void> {
    const began = startedAt(runId);
    const diagnostics = spriteIsThere
      ? await collectDiagnostics(sprites, spriteName, runId, began)
      : undefined;
    // a sprite that can't read its kernel log (dmesg is often closed to the sprite's user) still shows
    // memory exhaustion by what's left: a runner gone from a sprite below the launch floor was likely killed
    const killed =
      diagnostics !== undefined &&
      (diagnostics.killLines.length > 0 ||
        (diagnostics.memory !== undefined &&
          diagnostics.memory.availableMb < lowMemoryMb));
    // a restart takes the runner with everything else, so it is named before a kill is guessed at
    const restart =
      diagnostics && restartSince(diagnostics, (Date.now() - began) / 1000);
    let code = "runner_lost";
    let error = `runner_lost: its runner is gone from sprite ${spriteName}`;
    if (restart && diagnostics) {
      code = "sandbox_restarted";
      error = restartedError(restart, diagnostics, lastBashCommand(db, runId), [
        ...sprites.secrets.values(),
      ]);
    } else if (killed) {
      code = "runner_killed";
      error = killedError(spriteName, diagnostics);
    }
    const report =
      diagnostics &&
      `diagnostics of sprite ${spriteName}, collected when its runner was found gone:\n${diagnostics.text}`;
    if (failLostRun(db, runId, lastEventId, error, report)) {
      if (report) log(`run ${runId}: ${report}`);
      log(`run ${runId} failed: ${code} on sprite ${spriteName}`);
      nudgeDeliveries();
    }
  }

  async function probe(
    runId: RunId,
    spriteName: string,
    silentMs: number,
    lastEventId: number,
    /** False for a probe that isn't for silence: a runner found alive is no news. */
    recordAlive: boolean,
  ): Promise<void> {
    try {
      let alive: boolean;
      let gone = false;
      try {
        alive = await isRunnerAlive(sprites, spriteName, runId);
      } catch (err) {
        log(`probing the runner of ${runId} on ${spriteName} failed: ${err}`);
        // a sprite that no longer exists holds no runner; one that only didn't answer is tried again
        gone = await spriteGone(runId, spriteName);
        if (!gone) return;
        alive = false;
      }
      if (alive) {
        if (recordAlive && recordProbe(db, runId, { spriteName, silentMs })) {
          log(
            `run ${runId} silent for ${Math.round(silentMs / 1000)}s; its runner is alive on ${spriteName}`,
          );
          nudgeDeliveries();
        }
      } else {
        await failGone(runId, spriteName, lastEventId, !gone);
      }
    } catch (err) {
      log(`probing the runner of ${runId} on ${spriteName} failed: ${err}`);
    } finally {
      inFlight.delete(runId);
    }
  }

  return {
    /**
     * Starts a probe for each silent run not probed within the window, and resolves once they all
     * settle. Callers that mustn't wait on a slow sprite don't await it; it never throws or rejects.
     */
    sweep(now = Date.now()): Promise<void> {
      for (const [runId, at] of attempts) {
        if (at <= now - probeMs && !inFlight.has(runId)) attempts.delete(runId);
      }
      let silent: ReturnType<typeof silentRuns>;
      try {
        silent = silentRuns(db, probeMs, now);
      } catch (err) {
        log(`finding the silent runs to probe failed: ${err}`);
        return Promise.resolve();
      }
      const probes: Promise<void>[] = [];
      for (const { runId, spriteName, silentMs, lastEventId } of silent) {
        if (inFlight.has(runId) || attempts.has(runId)) continue;
        inFlight.add(runId);
        attempts.set(runId, now);
        probes.push(probe(runId, spriteName, silentMs, lastEventId, true));
      }
      return Promise.all(probes).then(() => {});
    },
    /**
     * Probes every `running` run on the sprite now, silent or not, because an exec there exited 137:
     * a runner the kernel killed is found in seconds, not a window later. A run already being probed
     * is left to that probe, and a sprite already being probed this way isn't probed again until that
     * settles. Resolves once they settle; never throws or rejects.
     */
    probeSprite(spriteName: string, now = Date.now()): Promise<void> {
      if (spritesInFlight.has(spriteName)) return Promise.resolve();
      let running: ReturnType<typeof runningRunsOn>;
      try {
        running = runningRunsOn(db, spriteName, now);
      } catch (err) {
        log(`finding the runs on ${spriteName} to probe failed: ${err}`);
        return Promise.resolve();
      }
      const probes: Promise<void>[] = [];
      for (const { runId, silentMs, lastEventId } of running) {
        if (inFlight.has(runId)) continue;
        inFlight.add(runId);
        log(
          `an exec on ${spriteName} was killed; probing the runner of ${runId}`,
        );
        probes.push(probe(runId, spriteName, silentMs, lastEventId, false));
      }
      spritesInFlight.add(spriteName);
      return Promise.all(probes).then(() => {
        spritesInFlight.delete(spriteName);
      });
    },
  };
}

export type RunProber = ReturnType<typeof createRunProber>;
