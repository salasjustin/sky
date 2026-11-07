import { agents, events, runs } from "@sky/db";
import type { RunId } from "@sky/shared";
import { and, asc, eq, gt } from "drizzle-orm";
import type { Context } from "hono";
import { type SSEMessage, streamSSE } from "hono/streaming";
import type { AppEnv } from "./factory.js";
import { presentEvent, runEvents } from "./run-events.js";
import { isActive } from "./runs.js";

const SHUTDOWN_RETRY_MS = 2_000;

/** One read's frames; `done` ends the stream once they're written, `more` reads again without waiting. */
export type Batch = { frames: SSEMessage[]; done?: boolean; more?: boolean };

/**
 * Streams `read()`'s frames as SSE, reading again after each publish on `channel`, with a `: ping`
 * comment once `heartbeatMs` passes with nothing written. `read` runs after an await, never inside the
 * publish. With `cursor`, the stream opens with a bare `id:` field and every ping carries one, so a
 * client that reconnects before any matching event still resumes where the server read to. When
 * `c.var.closing` aborts, the stream ends with one `server.shutdown` frame (its `id` the cursor, when
 * there is one) whose `retry` tells the client to reconnect to the next process soon; a stream stuck
 * behind a stalled reader gets no frame and is cut at the shutdown drain.
 */
export function tailSSE(
  c: Context<AppEnv>,
  channel: Parameters<typeof runEvents.subscribe>[0],
  read: () => Batch,
  heartbeatMs: number,
  onFail: (err: unknown) => void,
  cursor?: () => number,
) {
  return streamSSE(c, async (stream) => {
    // set by every publish, so one landing mid-read is never missed
    let dirty = true;
    let wake = () => {};
    let lastWrite = Date.now();
    // id-only: EventSource takes it as its Last-Event-ID without dispatching; writeSSE would add `data:`
    const idField = () => (cursor ? `id: ${cursor()}\n` : "");
    const tracked = async (written: Promise<unknown>) => {
      await written;
      lastWrite = Date.now();
    };
    const unsubscribe = runEvents.subscribe(channel, () => {
      dirty = true;
      wake();
    });
    stream.onAbort(() => {
      unsubscribe();
      wake();
    });
    const closing = c.var.closing;
    const onClosing = () => wake();
    closing.addEventListener("abort", onClosing, { once: true });
    try {
      if (cursor) await tracked(stream.write(`${idField()}\n`));
      while (!stream.aborted && !closing.aborted) {
        if (!dirty) {
          // publishes that yield no frames (a filtered stream) don't count as traffic
          const quiet = Date.now() - lastWrite;
          if (quiet >= heartbeatMs) {
            await tracked(stream.write(`: ping\n${idField()}\n`));
            continue;
          }
          let timer: NodeJS.Timeout | undefined;
          await new Promise<void>((resolve) => {
            wake = resolve;
            timer = setTimeout(resolve, heartbeatMs - quiet);
          });
          clearTimeout(timer);
          continue;
        }
        dirty = false;
        const batch = read();
        for (const frame of batch.frames) await tracked(stream.writeSSE(frame));
        if (batch.done) return;
        if (batch.more) dirty = true;
      }
      if (!stream.aborted) {
        await stream.writeSSE({
          event: "server.shutdown",
          data: JSON.stringify({ reason: "shutdown" }),
          retry: SHUTDOWN_RETRY_MS,
          id: cursor && String(cursor()),
        });
      }
    } catch (err) {
      onFail(err);
    } finally {
      unsubscribe();
      closing.removeEventListener("abort", onClosing);
    }
  });
}

/**
 * Streams the run's events after row id `after` as SSE, then live-tails until its terminal event,
 * with a `: ping` comment after each `heartbeatMs` with nothing written.
 */
export function streamRunEvents(
  c: Context<AppEnv>,
  runId: RunId,
  after: number,
  heartbeatMs: number,
  log: (line: string) => void,
) {
  const db = c.var.db;
  let cursor = after;
  const read = (): Batch => {
    // read together in one tick, so no commit lands between the rows and the status
    const rows = db
      .select()
      .from(events)
      .where(and(eq(events.runId, runId), gt(events.id, cursor)))
      .orderBy(asc(events.id))
      .all();
    const run = db
      .select({
        agentId: runs.agentId,
        environmentId: agents.envId,
        status: runs.status,
      })
      .from(runs)
      .innerJoin(agents, eq(agents.id, runs.agentId))
      .where(eq(runs.id, runId))
      .get();
    if (!run) return { frames: [], done: true };
    cursor = rows.at(-1)?.id ?? cursor;
    return {
      frames: rows.map((row) => ({
        id: String(row.id),
        event: row.type,
        data: JSON.stringify(presentEvent(row, run)),
      })),
      // an ended run's terminal event is its last row, so it went out in `rows` or before `after`
      done: !isActive(run.status),
    };
  };
  return tailSSE(c, runId, read, heartbeatMs, (err) =>
    log(`streaming ${runId} failed: ${err}`),
  );
}
