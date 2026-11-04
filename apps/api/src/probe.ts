import type { Db } from "@sky/db";
import type { RunId } from "@sky/shared";
import { isRunnerAlive } from "./launch.js";
import { failLostRun, recordProbe, silentRuns } from "./runs.js";
import type { SpriteOps } from "./sprites.js";

type Deps = {
  db: Db;
  sprites: SpriteOps;
  /** How long a `running` run may be silent before its runner is checked, and the window between checks. */
  probeMs: number;
  log: (line: string) => void;
  nudgeDeliveries: () => void;
};

/**
 * Checks the runner of each `running` run silent for `probeMs`, so a sprite that slept through a
 * run is found in minutes, not at `runner_timeout`. The check wakes the sprite: a live runner gets a
 * `run.probed` event (which also starts its next window), a gone one fails the run with `runner_lost`.
 * A sprite that can't answer is logged and retried a window later, never held against the run.
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

  async function probe(
    runId: RunId,
    spriteName: string,
    silentMs: number,
  ): Promise<void> {
    const started = Date.now();
    try {
      if (await isRunnerAlive(sprites, spriteName, runId)) {
        if (recordProbe(db, runId, { spriteName, silentMs })) {
          log(
            `run ${runId} silent for ${Math.round(silentMs / 1000)}s; its runner is alive on ${spriteName}`,
          );
          nudgeDeliveries();
        }
      } else if (failLostRun(db, runId, spriteName, started)) {
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
     * settle. Callers that mustn't wait on a slow sprite don't await it; it never rejects.
     */
    sweep(now = Date.now()): Promise<void> {
      for (const [runId, at] of attempts) {
        if (at <= now - probeMs && !inFlight.has(runId)) attempts.delete(runId);
      }
      const probes: Promise<void>[] = [];
      for (const { runId, spriteName, silentMs } of silentRuns(
        db,
        probeMs,
        now,
      )) {
        if (inFlight.has(runId) || attempts.has(runId)) continue;
        inFlight.add(runId);
        attempts.set(runId, now);
        probes.push(probe(runId, spriteName, silentMs));
      }
      return Promise.all(probes).then(() => {});
    },
  };
}

export type RunProber = ReturnType<typeof createRunProber>;
