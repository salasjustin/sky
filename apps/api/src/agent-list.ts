import { agents, type Db, environments, events, runs } from "@sky/db";
import {
  AGENT_LIST_DEFAULT_LIMIT,
  AGENT_LIST_MAX_LIMIT,
  type AgentId,
  AgentState,
  ArchivedFilter,
  type EnvironmentId,
  type RunId,
  type RunStatus,
} from "@sky/shared";
import {
  and,
  desc,
  inArray,
  isNotNull,
  isNull,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import { canUseEnv, ownAgents, type Principal } from "./auth.js";

const values = (raw: string | string[] | undefined) =>
  (raw === undefined ? [] : [raw].flat())
    .flatMap((s) => s.split(","))
    .map((s) => s.trim())
    .filter((s) => s !== "");

/** A filter given once, repeated, or as a comma list, read as one list. */
const list = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform(values);

export const AgentListQuery = z.object({
  env: list,
  status: list.pipe(z.array(AgentState)),
  archived: ArchivedFilter.default("false"),
  limit: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.int().min(1).max(AGENT_LIST_MAX_LIMIT))
    .default(AGENT_LIST_DEFAULT_LIMIT),
  cursor: z.string().min(1).optional(),
});
export type AgentListQuery = z.infer<typeof AgentListQuery>;

// where a page ends: the last row's activity time and id, which order every row
const encodeCursor = (at: string, id: string) =>
  Buffer.from(JSON.stringify([at, id])).toString("base64url");

const Cursor = z.tuple([z.iso.datetime(), z.string().min(1)]);

/** The activity time and agent id a cursor names; undefined when it is not one this API issued. */
export function decodeCursor(raw: string): [string, string] | undefined {
  try {
    const parsed = Cursor.safeParse(
      JSON.parse(Buffer.from(raw, "base64url").toString("utf8")),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

// the agent's latest run is the first of its runs newest first, ties by insert order (rowid), as `GET /:id/runs` orders them;
// `runs_agent_id_created_at` serves the lookup. The subquery's aliases keep it apart from the outer `runs`
const latestRunRowid = sql`(select r.rowid from runs r where r.agent_id = ${agents.id} order by r.created_at desc, r.rowid desc limit 1)`;

// the id order of events is their time order, and `events_run_id_id` ends at the newest
const lastEventAt = sql<
  string | null
>`coalesce((select e.ts from events e where e.run_id = ${runs.id} order by e.id desc limit 1), ${runs.createdAt})`;

// when the agent last did anything: its latest run's last event, else its creation
const activityAt = sql<string>`coalesce(${lastEventAt}, ${agents.createdAt})`;

// an ended run's undecided request waits on no one: failing or stopping a run leaves its row undecided
const openRequests = sql<number>`case when ${runs.status} = 'waiting'
  then (select count(*) from run_requests q where q.run_id = ${runs.id} and q.decided_at is null)
  else 0
end`;

/**
 * A waiting run is `waiting_approval` or `waiting_answer` by the kind of its open request, and
 * every other status is its own state. Null for an agent with no run. A waiting run always has an
 * open request, since deciding or withdrawing one moves the run to `running` in the same commit,
 * so the `running` fallback below covers rows written some other way.
 */
const stateOf = sql<AgentState | null>`case
  when ${runs.id} is null then null
  when ${runs.status} <> 'waiting' then ${runs.status}
  else case (select q.kind from run_requests q where q.run_id = ${runs.id} and q.decided_at is null)
    when 'approval' then 'waiting_approval'
    when 'question' then 'waiting_answer'
    else 'running'
  end
end`;

const END_EVENTS = ["run.finished", "run.failed", "run.stopped"] as const;
const endedStatuses = ["finished", "failed", "stopped"] as const;

export type ListedAgent = {
  id: AgentId;
  envId: EnvironmentId;
  envName: string;
  branch: string;
  /** The existing GitHub branch the agent works on, so a branch's owner can be found; null when it publishes its own. */
  remoteBranch: string | null;
  createdAt: string;
  archivedAt: string | null;
  run: {
    id: RunId;
    status: RunStatus;
    state: AgentState;
    createdAt: string;
    lastEventAt: string;
    endedAt: string | null;
    openRequests: number;
  } | null;
};

export type AgentPage = { data: ListedAgent[]; nextCursor?: string };

/** The ids of the environments `tokens` (ids or names) name that `principal` may use. */
function envIdsOf(db: Db, principal: Principal, tokens: string[]) {
  return db
    .select({ id: environments.id })
    .from(environments)
    .where(
      or(
        inArray(environments.id, tokens as EnvironmentId[]),
        inArray(environments.name, tokens),
      ),
    )
    .all()
    .map((e) => e.id)
    .filter((id) => canUseEnv(principal, id));
}

/**
 * One page of the agents `principal` may see, newest activity first, each with its latest run. A
 * single query joins the latest run and counts its open requests and last event in subqueries, so
 * a page costs the same number of statements at any size; the runs' end times come in one more
 * batched read of the page's own runs.
 */
export function listAgents(
  db: Db,
  principal: Principal,
  query: AgentListQuery,
  after: [string, string] | undefined,
): AgentPage {
  const conditions: (SQL | undefined)[] = [ownAgents(principal)];
  if (query.env.length > 0) {
    const envIds = envIdsOf(db, principal, query.env);
    if (envIds.length === 0) return { data: [] };
    conditions.push(inArray(agents.envId, envIds));
  }
  if (query.status.length > 0) conditions.push(inArray(stateOf, query.status));
  if (query.archived === "false") conditions.push(isNull(agents.archivedAt));
  if (query.archived === "true") conditions.push(isNotNull(agents.archivedAt));
  if (after) {
    conditions.push(
      sql`(${activityAt}, ${agents.id}) < (${after[0]}, ${after[1]})`,
    );
  }
  const rows = db
    .select({
      id: agents.id,
      envId: agents.envId,
      envName: environments.name,
      branch: agents.branch,
      remoteBranch: agents.remoteBranch,
      createdAt: agents.createdAt,
      archivedAt: agents.archivedAt,
      activityAt,
      runId: runs.id,
      runStatus: runs.status,
      state: stateOf,
      runCreatedAt: runs.createdAt,
      lastEventAt,
      openRequests,
    })
    .from(agents)
    .innerJoin(environments, sql`${environments.id} = ${agents.envId}`)
    .leftJoin(runs, sql`${runs}.rowid = ${latestRunRowid}`)
    .where(and(...conditions))
    .orderBy(desc(activityAt), desc(agents.id))
    .limit(query.limit + 1)
    .all();
  const page = rows.slice(0, query.limit);
  const ended = endTimes(
    db,
    page.flatMap((r) =>
      r.runId !== null &&
      r.runStatus !== null &&
      (endedStatuses as readonly string[]).includes(r.runStatus)
        ? [r.runId]
        : [],
    ),
  );
  const last = page.at(-1);
  return {
    data: page.map((r) => ({
      id: r.id,
      envId: r.envId,
      envName: r.envName,
      branch: r.branch,
      remoteBranch: r.remoteBranch,
      createdAt: r.createdAt,
      archivedAt: r.archivedAt,
      run:
        r.runId === null
          ? null
          : {
              id: r.runId,
              status: r.runStatus as RunStatus,
              state: r.state as AgentState,
              createdAt: r.runCreatedAt as string,
              lastEventAt: r.lastEventAt as string,
              // a run ended with no terminal event counts from its last one
              endedAt: endedStatuses.includes(
                r.runStatus as (typeof endedStatuses)[number],
              )
                ? (ended.get(r.runId) ?? (r.lastEventAt as string))
                : null,
              openRequests: Number(r.openRequests),
            },
    })),
    ...(rows.length > query.limit && last
      ? { nextCursor: encodeCursor(last.activityAt, last.id) }
      : {}),
  };
}

/** When each of `runIds` recorded its terminal event, in one read. */
function endTimes(db: Db, runIds: RunId[]) {
  const ended = new Map<RunId, string>();
  if (runIds.length === 0) return ended;
  const rows = db
    .select({ runId: events.runId, at: sql<string>`max(${events.ts})` })
    .from(events)
    .where(
      and(inArray(events.runId, runIds), inArray(events.type, [...END_EVENTS])),
    )
    .groupBy(events.runId)
    .all();
  for (const { runId, at } of rows) ended.set(runId, at);
  return ended;
}
