import type { Db } from "@sky/db";
import type { RunId } from "@sky/shared";
import { isRunnerAlive } from "./launch.js";
import {
  collectDiagnostics,
  type Diagnostics,
  showsMemoryKill,
} from "./memory.js";
import { failLostRun, recordProbe, runningRunsOn, silentRuns } from "./runs.js";
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

/**
 * Checks the runner of each `running` run silent for `probeMs`, so a sprite that slept through a
 * run is found in minutes, not at `runner_timeout`. The check wakes the sprite: a live runner gets a
 * `run.probed` event (which also starts its next window), a gone one fails the run, as does a sprite
 * that no longer exists. A sprite that can't answer is logged and retried a window later, never held
 * against the run. Before failing a run whose runner is gone, the sprite's memory, biggest processes
 * and kernel kill lines are collected, logged and stored on the run; when they show a memory kill the
 * run fails with `runner_killed`, else `runner_lost`. An exec on a sprite exiting 137 probes its
 * running runs at once (`probeSprite`).
 */
export function createRunProber({
  db,
  sprites,
  probeMs,
  lowMemoryMb,
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

  /** Fails the run whose runner is gone; a sprite that is gone too skips the diagnostics, as there is nothing to read. */
  async function failGone(
    runId: RunId,
    spriteName: string,
    lastEventId: number,
    spriteIsThere: boolean,
  ): Promise<void> {
    const diagnostics = spriteIsThere
      ? await collectDiagnostics(sprites, spriteName, runId)
      : undefined;
    const killed = diagnostics && showsMemoryKill(diagnostics, lowMemoryMb);
    const code = killed ? "runner_killed" : "runner_lost";
    const error =
      killed && diagnostics
        ? killedError(spriteName, diagnostics)
        : `runner_lost: its runner is gone from sprite ${spriteName}`;
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
     * is left to that probe, which is what keeps a probe's own killed `pgrep` from probing again.
     * Resolves once they settle; never throws or rejects.
     */
    probeSprite(spriteName: string, now = Date.now()): Promise<void> {
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
      return Promise.all(probes).then(() => {});
    },
  };
}

export type RunProber = ReturnType<typeof createRunProber>;
