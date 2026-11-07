import { EventEmitter } from "node:events";
import type { events } from "@sky/db";
import type { AgentId, EnvironmentId, Event, RunId } from "@sky/shared";

const emitter = new EventEmitter().setMaxListeners(0);

/** The channel every run's publish also wakes, for account-wide readers. */
export const anyRun = Symbol("anyRun");

/**
 * In-process wake-ups for a run's new event rows. A publish carries no event: listeners re-read the
 * table, so it is safe to publish inside the inserting transaction. better-sqlite3 commits before any
 * awaited continuation runs, and a rolled-back insert just reads as nothing new. A listener must not
 * read the DB synchronously, or it sees the uncommitted row on the shared connection.
 */
export const runEvents = {
  publish(runId: RunId): void {
    emitter.emit(runId);
    emitter.emit(anyRun);
  },
  /** Calls `listener` after each publish for `runId`, or for any run; returns the unsubscribe. */
  subscribe(runId: RunId | typeof anyRun, listener: () => void): () => void {
    emitter.on(runId, listener);
    return () => emitter.off(runId, listener);
  },
  listenerCount: (runId: RunId | typeof anyRun) => emitter.listenerCount(runId),
};

/** The shared Event shape webhooks, the event streams and the long poll send for a stored row of `agent`'s run. */
export const presentEvent = (
  row: typeof events.$inferSelect,
  agent: { agentId: AgentId; environmentId: EnvironmentId },
): Event =>
  ({
    id: `evt_${row.id}`,
    agentId: agent.agentId,
    environmentId: agent.environmentId,
    runId: row.runId,
    ts: row.ts,
    type: row.type,
    payload: row.payload,
  }) as Event;
