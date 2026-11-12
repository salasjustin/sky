import { zValidator } from "@hono/zod-validator";
import { agents, type Db, events, runs } from "@sky/db";
import { type AgentId, type Event, EventCursor, EventType } from "@sky/shared";
import { and, asc, eq, gt, inArray, max } from "drizzle-orm";
import { z } from "zod";
import { ownAgents, type Principal } from "./auth.js";
import { apiError } from "./errors.js";
import { factory } from "./factory.js";
import { anyRun, presentEvent, runEvents } from "./run-events.js";
import { tailSSE } from "./run-stream.js";

const PAGE = 100;

/** `principal` limits the read to the agents it may see. */
type EventFilter = {
  types?: EventType[];
  agentId?: AgentId;
  principal: Principal;
};

const latestEventId = (db: Db) =>
  db
    .select({ id: max(events.id) })
    .from(events)
    .get()?.id ?? 0;

/**
 * Up to a page of `filter`'s events after row id `after`, oldest first, and the highest row id the read
 * examined, matching or not, so the next read never rescans what this one skipped.
 */
function readEvents(
  db: Db,
  after: number,
  filter: EventFilter,
): { data: Event[]; cursor: number } {
  // read in the same tick as the rows, so the cursor never falls behind them
  const latest = latestEventId(db);
  const rows = db
    .select({
      event: events,
      agentId: runs.agentId,
      environmentId: agents.envId,
    })
    .from(events)
    .innerJoin(runs, eq(runs.id, events.runId))
    .innerJoin(agents, eq(agents.id, runs.agentId))
    .where(
      and(
        gt(events.id, after),
        filter.types && inArray(events.type, filter.types),
        filter.agentId && eq(runs.agentId, filter.agentId),
        ownAgents(filter.principal),
      ),
    )
    .orderBy(asc(events.id))
    .limit(PAGE)
    .all();
  const last = rows.at(-1);
  return {
    data: rows.map((r) => presentEvent(r.event, r)),
    cursor:
      rows.length === PAGE && last ? last.event.id : Math.max(after, latest),
  };
}

const Cursor = EventCursor.transform((s) => Number(s.replace("evt_", "")));

const filterQuery = {
  types: z
    .string()
    .transform((s) => s.split(","))
    .pipe(z.array(EventType))
    .optional(),
  agentId: z.string().optional(),
  after: Cursor.optional(),
};

const query = <T extends z.ZodRawShape>(shape: T) =>
  zValidator("query", z.object(shape), (result, c) => {
    if (result.success) return;
    if (result.error.issues.some((i) => i.path[0] === "after")) {
      return apiError(
        c,
        400,
        "invalid_cursor",
        "the cursor is not an event id",
      );
    }
    return apiError(c, 400, "invalid_query", z.prettifyError(result.error));
  });

const lastEventId = zValidator(
  "header",
  z.object({ "last-event-id": Cursor.optional() }),
  (result, c) => {
    if (!result.success) {
      return apiError(
        c,
        400,
        "invalid_cursor",
        "the cursor is not an event id",
      );
    }
  },
);

/**
 * The filter's agent: `{ agentId: undefined }` when none is named, undefined when the named one
 * doesn't exist or isn't `principal`'s to see.
 */
const knownAgent = (
  db: Db,
  agentId: string | undefined,
  principal: Principal,
) =>
  agentId === undefined
    ? { agentId: undefined }
    : db
        .select({ agentId: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId as AgentId), ownAgents(principal)))
        .get();

/** Account-wide event reads: a long-poll page and a live SSE tail, both off the API's own database. */
export function accountEventRoutes(
  heartbeatMs: number,
  log: (line: string) => void,
) {
  return factory
    .createApp()
    .get(
      "/events",
      query({
        ...filterQuery,
        wait: z.coerce.number().int().min(0).max(30).default(30),
      }),
      async (c) => {
        const db = c.var.db;
        const { types, after, wait, ...q } = c.req.valid("query");
        const { principal } = c.var;
        const agent = knownAgent(db, q.agentId, principal);
        if (!agent) return apiError(c, 404, "not_found", "no such agent");
        const filter = { types, agentId: agent.agentId, principal };

        // subscribed before the first read, so an event landing in between still wakes it
        let dirty = false;
        let expired = false;
        let wake = () => {};
        const unsubscribe = runEvents.subscribe(anyRun, () => {
          dirty = true;
          wake();
        });
        const expire = () => {
          expired = true;
          wake();
        };
        const timer = setTimeout(expire, wait * 1000);
        const signal = c.req.raw.signal;
        signal.addEventListener("abort", expire, { once: true });
        // a shutdown answers like a timeout, so the client polls the next process from this cursor
        const closing = c.var.closing;
        if (closing.aborted) expired = true;
        closing.addEventListener("abort", expire, { once: true });
        try {
          let page = readEvents(db, after ?? latestEventId(db), filter);
          while (page.data.length === 0 && !expired) {
            if (!dirty) {
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
            }
            if (dirty) {
              dirty = false;
              page = readEvents(db, page.cursor, filter);
            }
          }
          return c.json({ data: page.data, cursor: `evt_${page.cursor}` }, 200);
        } finally {
          unsubscribe();
          clearTimeout(timer);
          signal.removeEventListener("abort", expire);
          closing.removeEventListener("abort", expire);
        }
      },
    )
    .get("/stream", query(filterQuery), lastEventId, (c) => {
      const db = c.var.db;
      const { types, after, ...q } = c.req.valid("query");
      const { principal } = c.var;
      const agent = knownAgent(db, q.agentId, principal);
      if (!agent) return apiError(c, 404, "not_found", "no such agent");
      const filter = { types, agentId: agent.agentId, principal };
      // a reconnecting EventSource keeps its original URL, so the header is the fresher cursor
      let cursor =
        c.req.valid("header")["last-event-id"] ?? after ?? latestEventId(db);
      return tailSSE(
        c,
        anyRun,
        () => {
          const page = readEvents(db, cursor, filter);
          cursor = page.cursor;
          return {
            frames: page.data.map((event) => ({
              id: event.id.slice("evt_".length),
              event: event.type,
              data: JSON.stringify(event),
            })),
            more: page.data.length === PAGE,
          };
        },
        heartbeatMs,
        (err) => log(`streaming account events failed: ${err}`),
        () => cursor,
      );
    });
}
