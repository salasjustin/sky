import {
  agents,
  type Db,
  environments,
  events,
  runRequests,
  runs,
  webhookDeliveries,
} from "@sky/db";
import {
  type AgentId,
  type AgentStatus,
  type EventType,
  type RunId,
  RunStatus,
  runTransitions,
  type Usage,
} from "@sky/shared";
import { and, count, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { enqueueDeliveries } from "./deliveries.js";
import { runEvents } from "./run-events.js";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type RunRow = typeof runs.$inferSelect;

export const activeRunStatuses = RunStatus.options.filter(
  (s) => runTransitions[s].length > 0,
);

export const isActive = (status: RunStatus) =>
  activeRunStatuses.includes(status);

/** The agent's status while its latest run is in `status`. */
export const agentStatusFor = (status: RunStatus): AgentStatus =>
  status === "waiting" ? "waiting" : isActive(status) ? "running" : "idle";

export const presentRun = (row: RunRow, error: string | null) => ({
  id: row.id,
  agentId: row.agentId,
  status: row.status,
  summary: row.summary,
  usage:
    row.inputTokens === null ||
    row.outputTokens === null ||
    row.costUsd === null ||
    row.turns === null ||
    row.durationMs === null
      ? null
      : {
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          costUsd: row.costUsd,
          turns: row.turns,
          durationMs: row.durationMs,
        },
  error,
  createdAt: row.createdAt,
});

const total = (column: SQLiteColumn) =>
  sql<number>`sum(${column})`.mapWith(Number);

/** Usage summed over the agent's runs that reported it; null when none has. */
export function agentUsage(tx: Db | Tx, agentId: AgentId): Usage | null {
  // runs_usage keeps the columns all-or-none, so counting one counts runs with usage
  const row = tx
    .select({
      runs: count(runs.inputTokens),
      inputTokens: total(runs.inputTokens),
      outputTokens: total(runs.outputTokens),
      costUsd: total(runs.costUsd),
      turns: total(runs.turns),
      durationMs: total(runs.durationMs),
    })
    .from(runs)
    .where(eq(runs.agentId, agentId))
    .get();
  if (!row || row.runs === 0) return null;
  const { runs: _, ...usage } = row;
  return usage;
}

/** The agent's run that hasn't ended, if any; an agent has at most one. */
export const activeRunOf = (tx: Db | Tx, agentId: AgentId) =>
  tx
    .select()
    .from(runs)
    .where(
      and(eq(runs.agentId, agentId), inArray(runs.status, activeRunStatuses)),
    )
    .get();

/** The error of the run's `run.failed` event; null for a run that hasn't failed. */
export function runError(tx: Db | Tx, runId: RunId): string | null {
  const row = tx
    .select({ payload: events.payload })
    .from(events)
    .where(and(eq(events.runId, runId), eq(events.type, "run.failed")))
    .get();
  return row ? (row.payload as { error: string }).error : null;
}

/**
 * Stores one of the run's events, wakes its streams and enqueues its webhook deliveries, all in `tx`;
 * the caller nudges the dispatcher once `tx` commits when any were enqueued.
 */
export function recordEvent(
  tx: Tx,
  runId: RunId,
  type: EventType,
  payload: unknown,
): { id: number; enqueued: number } {
  const ts = new Date().toISOString();
  const { id } = tx
    .insert(events)
    .values({ runId, ts, type, payload })
    .returning({ id: events.id })
    .get();
  runEvents.publish(runId);
  return { id, enqueued: enqueueDeliveries(tx, id, type, ts) };
}

/** Ends a still-active run as `status`, recording `payload` as its event; the ended row, or undefined on an ended run. */
function endRun(
  tx: Tx,
  runId: RunId,
  status: "failed" | "stopped",
  payload: object,
): RunRow | undefined {
  const run = tx.select().from(runs).where(eq(runs.id, runId)).get();
  if (!run || !isActive(run.status)) return undefined;
  const ended = tx
    .update(runs)
    .set({ status })
    .where(eq(runs.id, runId))
    .returning()
    .get();
  recordEvent(
    tx,
    runId,
    status === "failed" ? "run.failed" : "run.stopped",
    payload,
  );
  tx.update(agents)
    .set({ status: "idle" })
    .where(eq(agents.id, run.agentId))
    .run();
  return ended;
}

/** Fails a still-active run with `error`, recording it as the run's `run.failed` event; no-op on an ended run. */
export function failRun(tx: Tx, runId: RunId, error: string): void {
  endRun(tx, runId, "failed", { error });
}

/** Stops the agent's active run, recording a `run.stopped` event; the stopped run, or undefined when none was active. */
export function stopActiveRun(tx: Tx, agentId: AgentId): RunRow | undefined {
  const run = activeRunOf(tx, agentId);
  return run && endRun(tx, run.id, "stopped", {});
}

/**
 * Fails every active run but a waiting one with no event (or, before its first, no launch) since
 * `timeoutMs` ago, so a runner that died can't hold a concurrency slot. Returns the ids it failed.
 */
export function failStaleRuns(db: Db, timeoutMs: number, now = Date.now()) {
  const cutoff = new Date(now - timeoutMs).toISOString();
  const lastActivity = sql<string>`coalesce((select max(${events.ts}) from ${events} where ${events.runId} = ${runs.id}), ${runs.createdAt})`;
  // one write transaction, so an event landing mid-sweep can't be overtaken by a stale read
  return db.transaction(
    (tx) => {
      const stale = tx
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            inArray(
              runs.status,
              activeRunStatuses.filter((s) => s !== "waiting"),
            ),
            sql`${lastActivity} < ${cutoff}`,
          ),
        )
        .all()
        .map((r) => r.id);
      for (const id of stale) failRun(tx, id, "runner_timeout");
      return stale;
    },
    { behavior: "immediate" },
  );
}

/**
 * Fails, with `launch_timeout`, every run still `starting` that was created over `deadlineMs` ago
 * and has no event: its runner never reported in (a launch stuck on the sprite, or a sprite that paused
 * before the runner held it), so the agent frees up for a follow-up instead of waiting out
 * `runner_timeout`. Returns each run it failed with the sprite its runner may still be on.
 */
export function failUnlaunchedRuns(
  db: Db,
  deadlineMs: number,
  now = Date.now(),
): { runId: RunId; spriteName: string }[] {
  const cutoff = new Date(now - deadlineMs).toISOString();
  return db.transaction(
    (tx) => {
      const late = tx
        .select({ runId: runs.id, spriteName: environments.spriteName })
        .from(runs)
        .innerJoin(agents, eq(runs.agentId, agents.id))
        .innerJoin(environments, eq(agents.envId, environments.id))
        .where(
          and(
            eq(runs.status, "starting"),
            lt(runs.createdAt, cutoff),
            sql`not exists (select 1 from ${events} where ${events.runId} = ${runs.id})`,
          ),
        )
        .all();
      for (const { runId } of late) failRun(tx, runId, "launch_timeout");
      return late;
    },
    { behavior: "immediate" },
  );
}

// past the runner's own wait timeout, so a live runner gives up first
const WAIT_GRACE_MS = 5 * 60_000;

/**
 * Fails, with `waiting_timeout`, every waiting run whose open request is older than the runner's
 * `waitTimeoutMs` plus a grace: its runner died while waiting. Returns the ids it failed.
 */
export function failAbandonedWaits(
  db: Db,
  waitTimeoutMs: number,
  now = Date.now(),
) {
  const cutoff = new Date(now - waitTimeoutMs - WAIT_GRACE_MS).toISOString();
  return db.transaction(
    (tx) => {
      const abandoned = tx
        .select({ id: runs.id })
        .from(runs)
        .innerJoin(runRequests, eq(runRequests.runId, runs.id))
        .where(
          and(
            eq(runs.status, "waiting"),
            isNull(runRequests.decidedAt),
            lt(runRequests.createdAt, cutoff),
          ),
        )
        .all()
        .map((r) => r.id);
      for (const id of abandoned) failRun(tx, id, "waiting_timeout");
      return abandoned;
    },
    { behavior: "immediate" },
  );
}

const CLAUDE_EVENT_TTL_MS = 7 * 86_400_000;

/**
 * Deletes `claude.*` events older than 7 days and their webhook deliveries; `run.*` events are kept.
 * Returns how many events it deleted.
 */
export function pruneClaudeEvents(db: Db, now = Date.now()) {
  const cutoff = new Date(now - CLAUDE_EVENT_TTL_MS).toISOString();
  // the literal pattern, not LIKE or a bound parameter: only then does the planner use events_claude_ts
  const expired = and(
    sql`${events.type} glob 'claude.*'`,
    lt(events.ts, cutoff),
  );
  return db.transaction(
    (tx) => {
      tx.delete(webhookDeliveries)
        .where(
          inArray(
            webhookDeliveries.eventId,
            tx.select({ id: events.id }).from(events).where(expired),
          ),
        )
        .run();
      return tx.delete(events).where(expired).run().changes;
    },
    { behavior: "immediate" },
  );
}
