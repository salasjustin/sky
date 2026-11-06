import type { Db } from "@sky/db";
import type { RunId } from "@sky/shared";
import { isRunnerAlive } from "./launch.js";
import { failLostRun, recordProbe, silentRuns } from "./runs.js";
import { type SpriteOps, spriteExists } from "./sprites.js";

type Deps = {
  db: Db;
  sprites: SpriteOps;
  /** How long a `running` run may be silent before its runner is checked, and the window between checks. */
  probeMs: number;
  log: (line: string) => void;
  nudgeDeliveries: () => void;
};

/**
 * Wakes the sprite of a launch that never reported in, by looking for its runner: a sprite that
 * paused before the runner held it froze the runner, and any exec unfreezes it. Only logs: a live
 * runner is left alone, a missing one is left to the launch deadline. Never throws.
 */
export async function wakeLaunch(
  sprites: SpriteOps,
  runId: RunId,
  spriteName: string,
  log: (line: string) => void,
): Promise<void> {
  try {
    const alive = await isRunnerAlive(sprites, spriteName, runId);
    log(
      alive
        ? `woke ${spriteName} for ${runId}: its runner is alive`
        : `woke ${spriteName} for ${runId}: no runner found; the launch deadline decides`,
    );
  } catch (err) {
    log(`waking ${spriteName} for ${runId} failed: ${err}`);
  }
}

/**
 * Checks the runner of each `running` run silent for `probeMs`, so a sprite that slept through a
 * run is found in minutes, not at `runner_timeout`. The check wakes the sprite: a live runner gets a
 * `run.probed` event (which also starts its next window), a gone one fails the run with `runner_lost`,
 * as does a sprite that no longer exists. A sprite that can't answer is logged and retried a window
 * later, never held against the run.
 */
export function createRunProber({
  db,
  sprites,
  probeMs,
  log,
  nudgeDeliveries,
}: Deps) {
  // when each run was last probed, so a probe that records no event (a sprite that didn't answer, or
  // is still waking) isn't repeated every sweep; in memory, as a restart costs at most one extra probe
  const attempts = new Map<RunId, number>();
  const inFlight = new Set<RunId>();

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

  async function probe(
    runId: RunId,
    spriteName: string,
    silentMs: number,
    lastEventId: number,
  ): Promise<void> {
    try {
      let alive: boolean;
      try {
        alive = await isRunnerAlive(sprites, spriteName, runId);
      } catch (err) {
        log(`probing the runner of ${runId} on ${spriteName} failed: ${err}`);
        // a sprite that no longer exists holds no runner; one that only didn't answer is tried again
        if (!(await spriteGone(runId, spriteName))) return;
        alive = false;
      }
      if (alive) {
        if (recordProbe(db, runId, { spriteName, silentMs })) {
          log(
            `run ${runId} silent for ${Math.round(silentMs / 1000)}s; its runner is alive on ${spriteName}`,
          );
          nudgeDeliveries();
        }
      } else if (failLostRun(db, runId, spriteName, lastEventId)) {
        log(`run ${runId} failed: runner_lost on sprite ${spriteName}`);
        nudgeDeliveries();
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
        probes.push(probe(runId, spriteName, silentMs, lastEventId));
      }
      return Promise.all(probes).then(() => {});
    },
  };
}

export type RunProber = ReturnType<typeof createRunProber>;
