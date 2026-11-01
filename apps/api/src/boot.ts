import { setMaxListeners } from "node:events";
import { join } from "node:path";
import { SpritesClient } from "@fly/sprites";
import { type Db, migrate, openDb } from "@sky/db";
import { createApp } from "./app.js";
import type { Config } from "./config.js";
import { createDispatcher } from "./deliveries.js";
import { signalRunner } from "./launch.js";
import { failInterruptedProvisioning } from "./provision.js";
import { KnownSecrets } from "./redact.js";
import {
  failAbandonedWaits,
  failStaleRuns,
  failUnlaunchedRuns,
  pruneClaudeEvents,
} from "./runs.js";
import { purgeExpiredEnvVars } from "./secrets.js";
import { SPRITES_TIMEOUT_MS, type SpriteOps } from "./sprites.js";

const SWEEP_EVERY_MS = 60_000;

/**
 * Opens and migrates the one DB handle the app reuses for its lifetime, fails provisioning a previous
 * process left unfinished, and fails silent runs and abandoned waits now and every minute after. Runs
 * outlive a restart: their runners keep posting, so only silence fails one. A run failed for missing its
 * launch deadline has its runner signalled too, without waiting on the sprite. The same sweep deletes
 * run envVars past their TTL and `claude.*` events past 7 days. Webhook deliveries left pending resume at once.
 */
export function boot(config: Config, log: (line: string) => void) {
  const db = openDb(join(config.dataDir, "sky.db"));
  migrate(db);
  failInterruptedProvisioning(db);
  const dispatcher = createDispatcher({
    db,
    signingKey: config.webhookSigningKey,
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
  };
  const sweep = () => {
    purgeExpiredEnvVars(db, secrets, new Date());
    const late = failUnlaunchedRuns(db, config.launchDeadlineMs);
    for (const { runId, spriteName } of late) {
      log(`run ${runId} failed: launch_timeout`);
      // a runner that started after all would hold the agent's sprite against its follow-up;
      // not awaited, so one slow sprite never holds up the sweep (signalRunner logs, never throws)
      void signalRunner(spriteOps, spriteName, runId, log);
    }
    const stale = failStaleRuns(db, config.runTimeoutMs);
    for (const id of stale) log(`run ${id} failed: runner_timeout`);
    const abandoned = failAbandonedWaits(db, config.waitTimeoutMs);
    for (const id of abandoned) log(`run ${id} failed: waiting_timeout`);
    if (late.length + stale.length + abandoned.length > 0) dispatcher.nudge();
    const pruned = pruneClaudeEvents(db);
    if (pruned > 0) log(`pruned ${pruned} claude.* events older than 7 days`);
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
