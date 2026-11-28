import { EventEmitter } from "node:events";
import type { events } from "@sky/db";
import {
  type AgentId,
  type EnvironmentId,
  EnvRefresh,
  type Event,
  PluginRefresh,
  type RunId,
} from "@sky/shared";

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

/**
 * A stored `run.started`'s plugin record as it reads today: `PluginRefresh` splits a record from before
 * `outcome` was a code. Null for no record, or one that doesn't parse.
 */
export function storedPlugins(plugins: unknown): PluginRefresh | null {
  const parsed = PluginRefresh.safeParse(plugins);
  return parsed.success ? parsed.data : null;
}

/** A stored `run.started`'s env refresh record; null for none, or one that doesn't parse. */
export function storedRefresh(refresh: unknown): EnvRefresh | null {
  const parsed = EnvRefresh.safeParse(refresh);
  return parsed.success ? parsed.data : null;
}

/** A stored payload as sent; only a `run.started`'s plugin and refresh records are re-read, and dropped when they don't parse. */
function presentPayload(type: string, payload: unknown): unknown {
  if (type !== "run.started" || typeof payload !== "object" || payload === null)
    return payload;
  const { plugins, refresh, ...rest } = payload as {
    plugins?: unknown;
    refresh?: unknown;
  };
  const parsedPlugins = storedPlugins(plugins);
  const parsedRefresh = storedRefresh(refresh);
  return {
    ...rest,
    ...(parsedPlugins && { plugins: parsedPlugins }),
    ...(parsedRefresh && { refresh: parsedRefresh }),
  };
}

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
    payload: presentPayload(row.type, row.payload),
  }) as Event;
