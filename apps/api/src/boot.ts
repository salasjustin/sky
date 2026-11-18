import { setMaxListeners } from "node:events";
import { statSync } from "node:fs";
import { join } from "node:path";
import { SpritesClient } from "@fly/sprites";
import { type Db, type MigrateOptions, migrate, openDb } from "@sky/db";
import type { RunId } from "@sky/shared";
import { createApp } from "./app.js";
import type { Config } from "./config.js";
import { createDispatcher } from "./deliveries.js";
import { signalRunner } from "./launch.js";
import { sweepExpiredPreviews } from "./previews.js";
import { createRunProber } from "./probe.js";
import { failInterruptedProvisioning } from "./provision.js";
import { KnownSecrets } from "./redact.js";
import {
  failAbandonedWaits,
  failStaleRuns,
  failUnlaunchedRuns,
  pruneClaudeEvents,
  spritesOfRuns,
} from "./runs.js";
import { purgeExpiredEnvVars } from "./secrets.js";
import { SPRITES_TIMEOUT_MS, type SpriteOps } from "./sprites.js";

const SWEEP_EVERY_MS = 60_000;

const walBytes = (dbPath: string) => {
  try {
    return statSync(`${dbPath}-wal`).size;
  } catch {
    return 0;
  }
};

const walMb = (dbPath: string) =>
  `${(walBytes(dbPath) / 1_048_576).toFixed(1)} MB`;

const errorCode = (err: unknown) =>
  err instanceof Error && "code" in err && typeof err.code === "string"
    ? ` (${err.code})`
    : "";

/**
 * Opens and migrates the one DB handle the app reuses for its lifetime, fails provisioning a previous
 * process left unfinished, and fails silent runs and abandoned waits now and every minute after. Runs
 * outlive a restart: their runners keep posting, so only silence fails one. A run failed for missing its
 * launch deadline, for going quiet (`runner_timeout`) or for an abandoned wait has its runner signalled
 * too, without waiting on the sprite. A `running` run silent past the probe window has its runner
 * looked for on its sprite, also unawaited (see
 * `createRunProber`). The same sweep deletes run envVars past their TTL and `claude.*` and
 * `runner.heartbeat` events past 7 days. Webhook deliveries left pending resume at once.
 *
 * A migration that can't fit on the data volume fails the boot with a log line before any data
 * changes. Once migrated, the WAL is checkpointed and truncated, so a rebuild's pages don't sit on the
 * volume until the next restart; the boot logs the migrations it applied, or that none were pending.
 */
export function boot(
  config: Config,
  log: (line: string) => void,
  migrateOptions?: MigrateOptions,
) {
  const dbPath = join(config.dataDir, "sky.db");
  const db = openDb(dbPath);
  let applied: string[];
  try {
    applied = migrate(db, migrateOptions);
  } catch (err) {
    log(
      `boot failed: ${err instanceof Error ? err.message : err}${errorCode(err)}`,
    );
    db.$client.close();
    throw err;
  }
  const walBefore = walMb(dbPath);
  // the row's first column is 1 when another connection kept the checkpoint from finishing, and then the
  // WAL is left untruncated; the other columns are page counts
  const busy = db.$client.pragma("wal_checkpoint(TRUNCATE)", { simple: true });
  const blocked = Number(busy) !== 0;
  const checkpoint = blocked
    ? "the WAL checkpoint was blocked by another connection"
    : "checkpointed the WAL";
  log(
    applied.length > 0
      ? `migrated ${applied.join(", ")}; ${checkpoint}: ${walBefore} before, ${walMb(dbPath)} after`
      : `no migrations pending${blocked ? `; ${checkpoint}` : ""}`,
  );
  failInterruptedProvisioning(db);
  const dispatcher = createDispatcher({
    db,
    signingKey: config.webhookSigningKey,
    secretEncryptionKey: config.secretEncryptionKey,
    log,
  });
  // the app redacts with it; the sweep drops each envVar it purges
  const secrets = KnownSecrets.fromConfig(config);
  const sprites = new SpritesClient(config.spritesToken);
  const spriteOps: SpriteOps = {
    client: sprites,
    log,
    secrets,
    timeoutMs: SPRITES_TIMEOUT_MS,
    longTimeoutMs: config.spritesLongTimeoutMs,
    onExecKilled: (spriteName) => void prober.probeSprite(spriteName),
  };
  const prober = createRunProber({
    db,
    sprites: spriteOps,
    apiKey: config.apiKey,
    probeMs: config.runProbeMs,
    lowMemoryMb: config.spriteMinFreeMb,
    log,
    nudgeDeliveries: dispatcher.nudge,
  });
  // not awaited, so one slow sprite never holds up the sweep (signalRunner is bounded, logs, never throws)
  const signalAll = (found: { runId: RunId; spriteName: string }[]) => {
    for (const { runId, spriteName } of found) {
      void signalRunner(spriteOps, spriteName, runId, log);
    }
  };
  const sweep = () => {
    purgeExpiredEnvVars(db, secrets, new Date());
    const late = failUnlaunchedRuns(db, config.launchDeadlineMs);
    for (const { runId } of late) log(`run ${runId} failed: launch_timeout`);
    // a runner that started after all would hold the agent's sprite against its follow-up
    signalAll(late);
    const stale = failStaleRuns(db, config.runTimeoutMs);
    for (const id of stale) log(`run ${id} failed: runner_timeout`);
    // a runner that went quiet may be wedged yet alive, and would hold up its agent's next
    // follow-up; the sweep after a restart finds the runs a dead process left, so they are signalled too
    signalAll(spritesOfRuns(db, stale));
    // after the timeout sweep, so a run it just failed isn't probed; not awaited, so a sprite
    // that is slow to wake never holds up the sweep (the prober logs, never throws)
    void prober.sweep();
    // not awaited, like the probe: a sprite slow to answer never holds up the sweep; a failure is logged and retried on the next sweep
    void sweepExpiredPreviews(db, spriteOps, log).catch((err: unknown) => {
      log(`sweeping expired previews failed: ${err}`);
    });
    const abandoned = failAbandonedWaits(db, config.waitTimeoutMs);
    for (const id of abandoned) log(`run ${id} failed: waiting_timeout`);
    signalAll(spritesOfRuns(db, abandoned));
    if (late.length + stale.length + abandoned.length > 0) dispatcher.nudge();
    const pruned = pruneClaudeEvents(db);
    if (pruned > 0) {
      log(
        `pruned ${pruned} claude.* and runner.heartbeat events older than 7 days`,
      );
    }
  };
  sweep();
  const sweeper = setInterval(
    () => {
      try {
        sweep();
      } catch (err) {
        log(`sweeping stale runs failed: ${err}`);
      }
    },
    Math.min(SWEEP_EVERY_MS, config.runTimeoutMs),
  );
  sweeper.unref();
  dispatcher.start();
  const closing = new AbortController();
  // one listener per open stream or parked poll; past 10, Node would warn of a leak that isn't one
  setMaxListeners(0, closing.signal);
  return {
    db,
    app: createApp({
      db,
      config,
      sprites,
      log,
      nudgeDeliveries: dispatcher.nudge,
      onExecKilled: spriteOps.onExecKilled,
      secrets,
      closing: closing.signal,
    }),
    /** Ends every event stream with a `server.shutdown` frame and answers parked event polls; call before `shutdown`. */
    closeStreams: () => closing.abort(),
    stopSweeping: () => clearInterval(sweeper),
    stopDelivering: dispatcher.stop,
  };
}

type Closable = {
  close(done: (err?: Error) => void): unknown;
  closeIdleConnections(): void;
  closeAllConnections(): void;
};

const IDLE_SWEEP_MS = 100;

/**
 * Stops accepting requests and gives in-flight ones `drainMs` before closing every connection still
 * open, then closes the DB. Event streams end at `closeStreams`, before this; runner long-polls never
 * end on their own, so the cutoff takes them and their runners retry. 5 s keeps the whole of it inside
 * fly.toml's `kill_timeout`.
 */
export async function shutdown(
  server: Closable,
  db: Db,
  drainMs = 5_000,
): Promise<void> {
  const cutoff = setTimeout(() => server.closeAllConnections(), drainMs);
  // close() drops only the keep-alive sockets idle at that moment; one whose response ends during the
  // drain (a stream ended by closeStreams) would otherwise wait out Node's keepAliveTimeout
  const idleSweep = setInterval(
    () => server.closeIdleConnections(),
    IDLE_SWEEP_MS,
  );
  try {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  } finally {
    clearTimeout(cutoff);
    clearInterval(idleSweep);
    db.$client.close();
  }
}
