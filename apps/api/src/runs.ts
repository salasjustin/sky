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
  HEARTBEAT_INTERVAL_MS,
  type RunId,
  RunStatus,
  runTransitions,
  type Usage,
} from "@sky/shared";
import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  type SQL,
  sql,
} from "drizzle-orm";
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
  // the Claude credential's name, never a value; null before the launch picks one
  claudeCredential: row.claudeCredential,
  // the run this one retries after a usage limit, on the API key or a pool's next subscription; null for any other
  retryOf: row.retryOf,
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
 * When the run last had an event, else when it was created; events of the `excluding` types don't count.
 */
const lastEventAt = (excluding: EventType[] = []) =>
  sql<string>`coalesce((select max(${events.ts}) from ${events} where ${events.runId} = ${runs.id}${
    excluding.length > 0
      ? sql` and ${events.type} not in (${sql.join(
          excluding.map((t) => sql`${t}`),
          sql`, `,
        )})`
      : sql``
  }), ${runs.createdAt})`;

// a heartbeat older than this says the runner stopped reporting, not that the tool is still running
const HEARTBEAT_FRESH_MS = 3 * HEARTBEAT_INTERVAL_MS;

// the name the runner's heartbeat gives a background task the session is waiting on
const BACKGROUND_SUFFIX = " (background)";

type ToolInFlight = { toolName: string; ranMs: number; beatFresh: boolean };

/**
 * The tool call, or background task the session waits on, that the run's latest `runner.heartbeat`
 * reports, when that heartbeat came after every event but a `run.probed` or `runner.warning` (so no
 * result has been seen since), and how long it has run: up to now while the heartbeat is fresh,
 * else up to that heartbeat.
 */
function toolInFlight(
  tx: Tx,
  runId: RunId,
  now: number,
): ToolInFlight | undefined {
  const beat = tx
    .select({ ts: events.ts, payload: events.payload })
    .from(events)
    .where(
      and(
        eq(events.runId, runId),
        eq(events.type, "runner.heartbeat"),
        sql`${events.id} > coalesce((select max(e.id) from ${events} e where e.run_id = ${runId} and e.type not in ('runner.heartbeat', 'run.probed', 'runner.warning')), 0)`,
      ),
    )
    .orderBy(desc(events.id))
    .get();
  if (!beat) return undefined;
  const { toolName, elapsedMs } = beat.payload as {
    toolName: string;
    elapsedMs: number;
  };
  const sinceBeat = now - Date.parse(beat.ts);
  const beatFresh = sinceBeat <= HEARTBEAT_FRESH_MS;
  return {
    toolName,
    ranMs: elapsedMs + (beatFresh ? sinceBeat : 0),
    beatFresh,
  };
}

const duration = (ms: number) =>
  ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`;

// a background task's ranMs is its age, which can predate the quiet window by however long the session kept working
const timeoutError = (
  tool: ToolInFlight | undefined,
  quietMs: number,
  timeoutMs: number,
) => {
  if (!tool) return "runner_timeout";
  if (tool.toolName.endsWith(BACKGROUND_SUFFIX))
    return tool.beatFresh
      ? `runner_timeout: the session waited on ${tool.toolName} with nothing else happening for ${duration(quietMs)}, past the ${duration(timeoutMs)} limit; the task had run ${duration(tool.ranMs)}`
      : `runner_timeout: the runner went quiet while the session waited on ${tool.toolName}; the task had run ${duration(tool.ranMs)}`;
  return tool.beatFresh
    ? `runner_timeout: ${tool.toolName} was still running after ${duration(tool.ranMs)} with no result, past the ${duration(timeoutMs)} limit`
    : `runner_timeout: the runner went quiet during ${tool.toolName} after it had run ${duration(tool.ranMs)}`;
};

/**
 * Fails every active run but a waiting one with no event (or, before its first, no launch) since
 * `timeoutMs` ago, so a runner that died can't hold a concurrency slot. A `run.probed`, a
 * `runner.heartbeat` or a `runner.warning` doesn't count as an event: a runner that is alive but
 * wedged, a tool call that never returns, or a sprite hold that keeps failing, still times out. A
 * run that went quiet with a tool call in flight is failed naming it and how long it ran; one whose
 * heartbeat names a background task the session waits on, naming the task, how long the session was
 * quiet and how long the task had run. Returns the ids it failed.
 */
export function failStaleRuns(db: Db, timeoutMs: number, now = Date.now()) {
  const cutoff = new Date(now - timeoutMs).toISOString();
  const lastActivity = lastEventAt([
    "run.probed",
    "runner.heartbeat",
    "runner.warning",
  ]);
  // one write transaction, so an event landing mid-sweep can't be overtaken by a stale read
  return db.transaction(
    (tx) => {
      const stale = tx
        .select({ id: runs.id, lastActivityAt: lastActivity })
        .from(runs)
        // the join keeps the subquery's `runs.id` qualified: on one table drizzle drops the prefix in a select list, and `id` would read events.id
        .innerJoin(agents, eq(runs.agentId, agents.id))
        .where(
          and(
            inArray(
              runs.status,
              activeRunStatuses.filter((s) => s !== "waiting"),
            ),
            sql`${lastActivity} < ${cutoff}`,
          ),
        )
        .all();
      for (const { id, lastActivityAt } of stale) {
        const quietMs = now - Date.parse(lastActivityAt);
        failRun(
          tx,
          id,
          timeoutError(toolInFlight(tx, id, now), quietMs, timeoutMs),
        );
      }
      return stale.map((r) => r.id);
    },
    { behavior: "immediate" },
  );
}

/** The sprite each of `runIds` ran on, for the runners of runs just failed that may live on there. */
export function spritesOfRuns(
  db: Db,
  runIds: RunId[],
): { runId: RunId; spriteName: string }[] {
  if (runIds.length === 0) return [];
  return db
    .select({ runId: runs.id, spriteName: environments.spriteName })
    .from(runs)
    .innerJoin(agents, eq(runs.agentId, agents.id))
    .innerJoin(environments, eq(agents.envId, environments.id))
    .where(inArray(runs.id, runIds))
    .all();
}

/**
 * Fails, with `launch_timeout`, every run still `starting` that was created over `deadlineMs` ago
 * and has no event but a `runner.warning` or `runner.heartbeat`, neither of which proves the launch
 * worked: its runner never reported in (a launch stuck on the sprite, or a sprite that paused before
 * the runner held it), so the agent frees up for a follow-up instead of waiting out `runner_timeout`.
 * Returns each run it failed with the sprite its runner may still be on.
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
            sql`not exists (select 1 from ${events} where ${events.runId} = ${runs.id} and ${events.type} not in ('runner.warning', 'runner.heartbeat'))`,
          ),
        )
        .all();
      for (const { runId } of late) failRun(tx, runId, "launch_timeout");
      return late;
    },
    { behavior: "immediate" },
  );
}

/**
 * Whether the run is still `starting` with no event but a `runner.warning` or `runner.heartbeat`:
 * its runner hasn't reported in, which `failUnlaunchedRuns` judges at the launch deadline.
 */
export function isSilentLaunch(db: Db, runId: RunId): boolean {
  return (
    db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.id, runId),
          eq(runs.status, "starting"),
          sql`not exists (select 1 from ${events} where ${events.runId} = ${runs.id} and ${events.type} not in ('runner.warning', 'runner.heartbeat'))`,
        ),
      )
      .get() !== undefined
  );
}

/**
 * The `running` runs with no event of any kind (a `run.probed` included, so a probed run is next
 * due a window later) since `silentMs` ago, each with the sprite its runner is on and the id of its
 * latest event (0 when it has none), which `failLostRun` judges the run by.
 */
export function silentRuns(
  db: Db,
  silentMs: number,
  now = Date.now(),
): RunningRun[] {
  const cutoff = new Date(now - silentMs).toISOString();
  return runningRuns(db, (last) => sql`${last} < ${cutoff}`, now);
}

/** The `running` runs whose runner is on `spriteName`, silent or not; for a probe an exec's SIGKILL calls for. */
export function runningRunsOn(
  db: Db,
  spriteName: string,
  now = Date.now(),
): RunningRun[] {
  return runningRuns(db, () => eq(environments.spriteName, spriteName), now);
}

type RunningRun = {
  runId: RunId;
  spriteName: string;
  silentMs: number;
  lastEventId: number;
};

function runningRuns(
  db: Db,
  condition: (last: ReturnType<typeof lastEventAt>) => SQL,
  now: number,
): RunningRun[] {
  const last = lastEventAt();
  const lastId = sql<number>`coalesce((select max(${events.id}) from ${events} where ${events.runId} = ${runs.id}), 0)`;
  return db
    .select({
      runId: runs.id,
      spriteName: environments.spriteName,
      lastAt: last,
      lastEventId: lastId.mapWith(Number),
    })
    .from(runs)
    .innerJoin(agents, eq(runs.agentId, agents.id))
    .innerJoin(environments, eq(agents.envId, environments.id))
    .where(and(eq(runs.status, "running"), condition(last)))
    .all()
    .map(({ runId, spriteName, lastAt, lastEventId }) => ({
      runId,
      spriteName,
      silentMs: now - Date.parse(lastAt),
      lastEventId,
    }));
}

/**
 * Records a `run.probed` on a run that is still `running`; false when it ended meanwhile.
 * The caller nudges the dispatcher when this returns true.
 */
export function recordProbe(
  db: Db,
  runId: RunId,
  payload: { spriteName: string; silentMs: number },
): boolean {
  return db.transaction(
    (tx) => {
      const run = tx.select().from(runs).where(eq(runs.id, runId)).get();
      if (run?.status !== "running") return false;
      recordEvent(tx, runId, "run.probed", payload);
      return true;
    },
    { behavior: "immediate" },
  );
}

/**
 * Fails, with `error` (`runner_lost` or `runner_killed`), a run that is still `running` and has no
 * event past `lastEventId`, the latest it had when the probe began: the probe found its runner gone.
 * A later event means the runner spoke meanwhile, and the sweep's next window judges it. Event ids,
 * not clock times: a fast host can stamp the last event and the probe's start in the same millisecond.
 * The sprite's `diagnostics`, when collected, are recorded as a `runner.warning` just before the
 * failure, in the same transaction, so the guard above can't be tripped by it.
 * False when the run was left alone.
 */
export function failLostRun(
  db: Db,
  runId: RunId,
  lastEventId: number,
  error: string,
  diagnostics?: string,
): boolean {
  return db.transaction(
    (tx) => {
      // in the where clause, not the select list: on a single-table select Drizzle drops the table
      // name from a column in a selected expression, and `runs.id` inside would read `events.id`
      // (`silentRuns` selects its subquery safely only because its joins keep the qualifier)
      const silent = tx
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            eq(runs.id, runId),
            eq(runs.status, "running"),
            sql`not exists (select 1 from ${events} where ${events.runId} = ${runs.id} and ${events.id} > ${lastEventId})`,
          ),
        )
        .get();
      if (!silent) return false;
      if (diagnostics) {
        recordEvent(tx, runId, "runner.warning", { message: diagnostics });
      }
      failRun(tx, runId, error);
      return true;
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
 * Deletes `claude.*` and `runner.heartbeat` events older than 7 days and their webhook deliveries;
 * `run.*` events are kept.
 * Returns how many events it deleted.
 */
export function pruneClaudeEvents(db: Db, now = Date.now()) {
  const cutoff = new Date(now - CLAUDE_EVENT_TTL_MS).toISOString();
  // the literal patterns, not LIKE or a bound parameter: only then does the planner use the partial
  // indexes events_claude_ts and events_heartbeat_ts
  const expired = [
    and(sql`${events.type} glob 'claude.*'`, lt(events.ts, cutoff)),
    and(sql`${events.type} = 'runner.heartbeat'`, lt(events.ts, cutoff)),
  ];
  return db.transaction(
    (tx) => {
      let pruned = 0;
      for (const where of expired) {
        tx.delete(webhookDeliveries)
          .where(
            inArray(
              webhookDeliveries.eventId,
              tx.select({ id: events.id }).from(events).where(where),
            ),
          )
          .run();
        pruned += tx.delete(events).where(where).run().changes;
      }
      return pruned;
    },
    { behavior: "immediate" },
  );
}
