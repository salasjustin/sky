import { zValidator } from "@hono/zod-validator";
import { agents, type Db, environments, events, runs } from "@sky/db";
import {
  AgentId,
  agentBranch,
  BranchName,
  type Decision,
  EnvironmentId,
  type EventType,
  PREVIEW_PROXY_PORT,
  PreviewStart,
  RequestId,
  RunId,
} from "@sky/shared";
import { and, count, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Context } from "hono";
import { z } from "zod";
import { AgentListQuery, decodeCursor, listAgents } from "./agent-list.js";
import { mintAgentToken } from "./agent-token.js";
import { canUseEnv, ownAgents, ownerKeyOf, type Principal } from "./auth.js";
import type { BranchCheck, BranchChecker } from "./branch-check.js";
import { apiError } from "./errors.js";
import { type AppEnv, factory } from "./factory.js";
import { mintId } from "./ids.js";
import {
  type Launcher,
  type LingeringRunner,
  removeWorktree,
  signalRunner,
  stopLingeringRunner,
} from "./launch.js";
import type { Previews, StartResult } from "./previews.js";
import { REPO_DIR } from "./provision.js";
import { redact } from "./redact.js";
import { decideRequest, openRequestOf, requestDecisions } from "./requests.js";
import { streamRunEvents } from "./run-stream.js";
import {
  activeRunOf,
  activeRunStatuses,
  agentUsage,
  isActive,
  presentRun,
  runError,
  runPlugins,
  runRefresh,
  stopActiveRun,
  type Tx,
} from "./runs.js";
import {
  CONNECTOR_NAMES,
  EnvVarName,
  isReservedName,
  registerRunEnvVars,
  reservedName,
  storeRunEnvVars,
} from "./secrets.js";
import {
  execCapped,
  execInSprite,
  SpriteExecStreamError,
  type SpriteOps,
} from "./sprites.js";
import { body, jsonBody } from "./validation.js";

const Prompt = z.string().min(1);
/** Values injected into one run only, held encrypted until `ttlSeconds` pass. */
const RunEnv = {
  envVars: z.record(EnvVarName, z.string()).default({}),
  ttlSeconds: z.int().min(1).max(86_400).default(3600),
};
const LaunchInput = z.strictObject({
  envId: EnvironmentId,
  prompt: Prompt,
  /** An existing GitHub branch the agent starts from and publishes to. */
  branch: BranchName.optional(),
  ...RunEnv,
});
const FollowUpInput = z.strictObject({ prompt: Prompt, ...RunEnv });

// a run's connector names would override the env's, and the runner sends the connector id to the
// gateway URL it is given
const reservedIn = (envVars: Record<string, string>) =>
  Object.keys(envVars).find(
    (name) => isReservedName(name) || CONNECTOR_NAMES.has(name),
  );
const AnswerInput = z.strictObject({
  requestId: RequestId,
  answer: z.string().min(1),
});
const ApprovalInput = z.discriminatedUnion("decision", [
  z.strictObject({
    requestId: RequestId,
    decision: z.literal("approve"),
    reason: z.string().min(1).optional(),
  }),
  z.strictObject({
    requestId: RequestId,
    decision: z.literal("deny"),
    reason: z.string().min(1).optional(),
  }),
]);

type AgentRow = typeof agents.$inferSelect;

/** The branch the agent's publishes land on, path-escaped: a branch name may hold `#` or `%`. */
const compareHead = (agent: Pick<AgentRow, "branch" | "remoteBranch">) =>
  (agent.remoteBranch ?? agent.branch)
    .split("/")
    .map(encodeURIComponent)
    .join("/");

const presentRunDetail = (
  db: Db,
  run: typeof runs.$inferSelect,
  agent: Pick<AgentRow, "branch" | "remoteBranch">,
  repo: string,
  diff: string | null,
  // the diff's full size in bytes, set only when `diff` is cut short of it
  truncatedFrom: number | null = null,
) => ({
  ...presentRun(run, runError(db, run.id)),
  branch: agent.branch,
  diff,
  ...(truncatedFrom === null
    ? {}
    : { diffTruncated: true, diffSize: truncatedFrom }),
  pendingRequest: openRequestOf(db, run.id)?.request ?? null,
  rollup: run.rollup,
  compareUrl: run.rollup
    ? `https://github.com/${repo}/compare/${run.rollup.base}...${compareHead(agent)}`
    : null,
  // null until the launch records what it injected
  secretNames: run.secretNames,
  // the plugin refresh and the versions the session loaded; null before the run starts, or from an older runner
  plugins: runPlugins(db, run.id),
  // what the environment's refresh script did before the run; null when it has none, or from an older runner
  refresh: runRefresh(db, run.id),
});

const presentAgent = (row: AgentRow) => ({
  id: row.id,
  envId: row.envId,
  sessionId: row.sessionId,
  branch: row.branch,
  remoteBranch: row.remoteBranch,
  status: row.status,
  createdAt: row.createdAt,
  archivedAt: row.archivedAt,
});

/** Runs still holding one of the env's concurrency slots. */
const activeRunsIn = (tx: Db | Tx, envId: EnvironmentId) =>
  tx
    .select({ n: count() })
    .from(runs)
    .innerJoin(agents, eq(runs.agentId, agents.id))
    .where(
      and(eq(agents.envId, envId), inArray(runs.status, activeRunStatuses)),
    )
    .get()?.n ?? 0;

/** The env an agent can launch in with a free slot, or why it can't. */
function launchableEnv(db: Db | Tx, id: EnvironmentId) {
  const env = db
    .select()
    .from(environments)
    .where(eq(environments.id, id))
    .get();
  if (!env) return { kind: "not_found" } as const;
  if (env.status !== "ready") return { kind: "not_ready" } as const;
  if (activeRunsIn(db, id) >= env.concurrency) {
    return { kind: "at_cap", limit: env.concurrency } as const;
  }
  return { kind: "ready", env } as const;
}

const refuseEnv = (c: Context, kind: "not_found" | "not_ready") =>
  kind === "not_found"
    ? apiError(c, 404, "not_found", "no such environment")
    : apiError(
        c,
        409,
        "env_not_ready",
        "environment is not ready; wait for provisioning to succeed",
      );

function refuseBranch(
  c: Context,
  check: Exclude<BranchCheck, { kind: "exists" }>,
  branch: BranchName,
  env: { name: string; repo: string },
) {
  switch (check.kind) {
    case "needs_connector":
      return apiError(
        c,
        422,
        "branch_needs_connector",
        `starting on a branch needs a GitHub connector secret on the environment; set one with sky secret set ${env.name} GITHUB_CONNECTOR --connector=<id>`,
      );
    case "not_found":
      return apiError(
        c,
        404,
        "branch_not_found",
        `branch ${branch} doesn't exist on GitHub (${env.repo}); check the name, or start without --branch`,
      );
    case "is_default":
      return apiError(
        c,
        422,
        "branch_is_default",
        `${branch} is the default branch of ${env.repo}; agents publish to their own branch, so omit --branch`,
      );
    case "failed":
      return apiError(
        c,
        502,
        "branch_check_failed",
        `could not check branch ${branch} in the environment's sprite (${check.detail}); retry`,
      );
  }
}

const atCap = (c: Context, limit: number) =>
  c.json(
    {
      error: {
        code: "concurrency_cap",
        message: `this environment allows ${limit} active runs; wait for one to end or stop one`,
        limit,
      },
    },
    409,
  );

/** The agent and its sprite, when `principal` may act on it. */
const agentWithSprite = (tx: Tx, id: AgentId, principal: Principal) =>
  tx
    .select({ agent: agents, spriteName: environments.spriteName })
    .from(agents)
    .innerJoin(environments, eq(agents.envId, environments.id))
    .where(and(eq(agents.id, id), ownAgents(principal)))
    .get();

// a runner aborting at its run's end commits and pushes within this; one still alive past it is
// wedged, not committing, and a SIGTERM (a second one kills at once) costs it no work
const COMMIT_WINDOW_MS = 60_000;
const END_EVENTS: EventType[] = ["run.finished", "run.failed", "run.stopped"];

/**
 * The agent's latest run, when it has ended and so may leave a runner still exiting, with whether
 * the follow-up may SIGTERM that runner: only once the run ended `COMMIT_WINDOW_MS` before `now`.
 * Undefined for an unknown, not-owned or archived agent, or one whose latest run is active, which
 * the follow-up refuses.
 */
function previousRunnerOf(
  db: Db,
  id: AgentId,
  principal: Principal,
  now: number,
) {
  const row = db
    .select({
      runId: runs.id,
      status: runs.status,
      archivedAt: agents.archivedAt,
      spriteName: environments.spriteName,
      // a run ended without a terminal event counts from its creation
      endedAt: sql<string>`coalesce((select max(${events.ts}) from ${events} where ${events.runId} = ${runs.id} and ${inArray(events.type, END_EVENTS)}), ${runs.createdAt})`,
    })
    .from(runs)
    .innerJoin(agents, eq(runs.agentId, agents.id))
    .innerJoin(environments, eq(agents.envId, environments.id))
    .where(and(eq(runs.agentId, id), ownAgents(principal)))
    .orderBy(desc(runs.createdAt), desc(sql`${runs}.rowid`))
    .get();
  if (!row || row.archivedAt || isActive(row.status)) return undefined;
  return {
    ...row,
    maySignal: now - Date.parse(row.endedAt) >= COMMIT_WINDOW_MS,
  };
}

/** Re-reads an agent this transaction already found. */
const agentRow = (tx: Tx, id: AgentId) => {
  const row = tx.select().from(agents).where(eq(agents.id, id)).get();
  if (!row) throw new Error(`agent ${id} vanished mid-transaction`);
  return row;
};

// $1 the base, $2 the agent's branch. A branch that was never created is a normal answer (exit 3),
// not an error. git's stderr is dropped, since it would share the HTTP exec with the exit frame
export const DIFF = `git rev-parse --verify --quiet "refs/heads/$2" >/dev/null 2>&1 || exit 3; exec git diff "$1...$2" 2>/dev/null`;

/** The most of a run's diff the run detail carries; a larger one is cut to it and flagged. */
export const DIFF_MAX_BYTES = 1024 * 1024;

const archived = (c: Context) =>
  apiError(c, 409, "agent_archived", "the agent is archived");

/** `work`'s result, or `late` once `ms` have passed; `work` is left to finish on its own. */
function within<T>(ms: number, work: Promise<T>, late: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(late), ms);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

// a wake still running past this is abandoned: the runner asks again once its sprite is up
const WAKE_TIMEOUT_MS = 15_000;

/**
 * Decides one of the agent's requests, wakes the runner long-polling for it, then execs a no-op in
 * its sprite: a paused sprite's runner never sees the decision until something resumes the
 * sprite, and any exec does.
 */
async function decide(
  c: Context<AppEnv>,
  sprites: SpriteOps,
  log: (line: string) => void,
  agentId: AgentId,
  decision: Decision,
) {
  const outcome = c.var.db.transaction(
    (tx) => {
      // a not-owned agent answers as an unknown one: its requests are not found
      const found = agentWithSprite(tx, agentId, c.var.principal);
      if (!found) return { kind: "not_found" } as const;
      const decided = decideRequest(tx, agentId, decision);
      if (decided.kind !== "decided") return decided;
      return { ...decided, spriteName: found.spriteName };
    },
    { behavior: "immediate" },
  );
  switch (outcome.kind) {
    case "not_found":
      return apiError(c, 404, "not_found", "no such request on this agent");
    case "wrong_kind":
      return apiError(
        c,
        409,
        "wrong_kind",
        `the request is a ${outcome.requestKind}`,
      );
    case "already_decided":
      return c.json(
        {
          error: {
            code: "already_decided",
            message:
              "an earlier decision on this request stands; this one was not applied",
            decision: outcome.decision,
          },
        },
        409,
      );
    case "withdrawn":
      return apiError(
        c,
        409,
        "request_withdrawn",
        "the run stopped waiting on this request before it was answered; nothing was applied",
      );
    case "closed":
      return apiError(
        c,
        409,
        "request_closed",
        "the request's run is no longer waiting",
      );
    case "repeated":
      return c.json(
        { run: presentRun(outcome.run, runError(c.var.db, outcome.run.id)) },
        200,
      );
  }
  if (outcome.enqueued > 0) c.var.nudgeDeliveries();
  requestDecisions.publish(decision.requestId);
  // a failed wake is only logged: the decision is already recorded
  try {
    await execInSprite(sprites, outcome.spriteName, ["true"], {
      op: "wake",
      timeoutMs: WAKE_TIMEOUT_MS,
    });
  } catch (err) {
    log(`waking ${outcome.spriteName} for ${outcome.run.id} failed: ${err}`);
  }
  return c.json({ run: presentRun(outcome.run, null) }, 200);
}

const agentParam = zValidator(
  "param",
  z.object({ id: AgentId }),
  (result, c) => {
    if (!result.success) return apiError(c, 404, "not_found", "no such agent");
  },
);

const listQuery = zValidator("query", AgentListQuery, (result, c) => {
  if (!result.success) {
    return apiError(c, 400, "invalid_query", z.prettifyError(result.error));
  }
});

const runParam = zValidator(
  "param",
  z.object({ id: AgentId, runId: RunId }),
  (result, c) => {
    if (!result.success) return apiError(c, 404, "not_found", "no such run");
  },
);

// a stream resumes after an event row id: EventSource's Last-Event-ID, or ?after= where headers can't be set
const Cursor = z
  .string()
  .regex(/^\d{1,15}$/)
  .transform(Number);
const badCursor = (result: { success: boolean }, c: Context) => {
  if (!result.success) {
    return apiError(c, 400, "invalid_cursor", "the cursor is not an event id");
  }
};
const afterQuery = zValidator(
  "query",
  z.object({ after: Cursor.optional() }),
  badCursor,
);
const lastEventId = zValidator(
  "header",
  z.object({ "last-event-id": Cursor.optional() }),
  badCursor,
);

/** The note at the top of an agent's first run after its environment was rebuilt. */
const rebuiltNote = (branch: string | null) =>
  `The environment was rebuilt since your last run, so your worktree is new: it starts ${
    branch === null
      ? "from the repository's default branch, because Sky found no branch of yours on GitHub to start from"
      : `from the \`${branch}\` branch on GitHub`
  }. Anything that existed only in the old worktree (uncommitted changes, commits that were never published) is gone, and so is your earlier session: you start a fresh one, so what you remember of the old session may no longer be true of the files. Read the worktree before you rely on it.\n\n`;

/** The GitHub branch the agent's latest published run went to, as the runs recorded it. */
function publishedBranchOf(db: Db, id: AgentId): string | undefined {
  const recorded = db
    .select({ rollup: runs.rollup })
    .from(runs)
    .where(and(eq(runs.agentId, id), isNotNull(runs.rollup)))
    .orderBy(desc(runs.createdAt), desc(sql`${runs}.rowid`))
    .limit(50)
    .all();
  return recorded.find((r) => r.rollup?.published?.branch)?.rollup?.published
    ?.branch;
}

/**
 * For an agent whose environment was rebuilt, the GitHub branch its new worktree starts from: the
 * first GitHub still has of the one it was started on, the one its runs recorded publishing to, and
 * its own (where a publish goes by default), else none (the default branch). A `Response` when
 * GitHub could not be asked: the follow-up is refused to retry, since starting from the default
 * branch because the question failed would drop the agent's work unannounced. An agent that was not
 * rebuilt has `branch: null` and nothing is checked.
 */
async function restartBranchOf(
  c: Context<AppEnv>,
  id: AgentId,
  checkBranch: BranchChecker,
  log: (line: string) => void,
  deadlineMs: number,
) {
  const found = c.var.db
    .select({ agent: agents, env: environments })
    .from(agents)
    .innerJoin(environments, eq(agents.envId, environments.id))
    .where(and(eq(agents.id, id), ownAgents(c.var.principal)))
    .get();
  if (!found?.agent.rebuiltAt || found.agent.archivedAt)
    return { branch: null };
  const { agent, env } = found;
  // the follow-up is refused below for an environment that isn't ready
  if (env.status !== "ready") return { branch: null };
  const candidates = new Set(
    [agent.remoteBranch, publishedBranchOf(c.var.db, id), agent.branch].filter(
      (branch): branch is string => Boolean(branch),
    ),
  );
  for (const candidate of candidates) {
    const check = await within(deadlineMs, checkBranch(env, candidate), {
      kind: "failed",
      detail: `no answer within ${deadlineMs / 1000}s`,
    } as BranchCheck);
    if (check.kind === "exists") return { branch: candidate };
    if (check.kind === "failed") {
      log(`branch check of ${candidate} on ${env.id} failed: ${check.detail}`);
      return apiError(
        c,
        502,
        "branch_check_failed",
        `the environment was rebuilt, and the agent's new worktree starts from its branch ${candidate} if GitHub still has it; could not check (${check.detail}); retry`,
      );
    }
    // gone from GitHub, the default branch, or no connector to look with: the next one
  }
  return { branch: null };
}

export function agentRoutes(
  launcher: Launcher,
  checkBranch: BranchChecker,
  sprites: SpriteOps,
  log: (line: string) => void,
  heartbeatMs: number,
  preLaunchDeadlineMs: number,
  previews: Previews,
) {
  return factory
    .createApp()
    .post("/", jsonBody, body(LaunchInput), async (c) => {
      const { envId, prompt, envVars, ttlSeconds, branch } =
        c.req.valid("json");
      const reserved = reservedIn(envVars);
      if (reserved) return reservedName(c, reserved);
      if (!canUseEnv(c.var.principal, envId)) return refuseEnv(c, "not_found");
      // the check execs in the env's sprite, so it runs before the transaction, which re-checks the env
      // and its cap
      if (branch !== undefined) {
        const gate = launchableEnv(c.var.db, envId);
        if (gate.kind === "at_cap") return atCap(c, gate.limit);
        if (gate.kind !== "ready") return refuseEnv(c, gate.kind);
        const check = await within(
          preLaunchDeadlineMs,
          checkBranch(gate.env, branch),
          {
            kind: "failed",
            detail: `no answer within ${preLaunchDeadlineMs / 1000}s`,
          },
        );
        if (check.kind !== "exists") {
          if (check.kind === "failed") {
            log(
              `branch check of ${branch} on ${envId} failed: ${check.detail}`,
            );
          }
          return refuseBranch(c, check, branch, gate.env);
        }
      }
      const agentId = mintId("agt");
      const runId = mintId("run");
      const outcome = c.var.db.transaction(
        (tx) => {
          const gate = launchableEnv(tx, envId);
          if (gate.kind !== "ready") return gate;
          const { env } = gate;
          const agent = tx
            .insert(agents)
            .values({
              id: agentId,
              envId,
              branch: agentBranch(agentId),
              remoteBranch: branch ?? null,
              status: "running",
              ownerKeyId: ownerKeyOf(c.var.principal),
            })
            .returning()
            .get();
          const run = tx
            .insert(runs)
            .values({ id: runId, agentId, status: launcher.entryStatus() })
            .returning()
            .get();
          storeRunEnvVars(
            tx,
            c.var.config.secretEncryptionKey,
            runId,
            envVars,
            ttlSeconds,
          );
          return { kind: "created", env, agent, run } as const;
        },
        { behavior: "immediate" },
      );
      switch (outcome.kind) {
        case "not_found":
        case "not_ready":
          return refuseEnv(c, outcome.kind);
        case "at_cap":
          return atCap(c, outcome.limit);
      }
      registerRunEnvVars(c.var.secrets, runId, envVars);
      launcher.start({
        envId,
        spriteName: outcome.env.spriteName,
        agentId,
        runId,
        prompt,
        sessionId: null,
        approvalPolicy: outcome.env.approvalPolicy,
        autoApprove: outcome.env.autoApprove,
        remoteBranch: outcome.agent.remoteBranch,
      });
      c.header("Location", `/v1/agents/${agentId}/runs/${runId}`);
      return c.json(
        {
          agent: presentAgent(outcome.agent),
          run: presentRun(outcome.run, null),
        },
        202,
      );
    })
    .post("/:id/runs", agentParam, jsonBody, body(FollowUpInput), async (c) => {
      const { id } = c.req.valid("param");
      const { prompt, envVars, ttlSeconds } = c.req.valid("json");
      const reserved = reservedIn(envVars);
      if (reserved) return reservedName(c, reserved);
      // an ended run's runner may still be aborting and committing in the worktree a new one resumes in,
      // or be alive long past its run's end (wedged): only that one is signalled, and the wait for
      // it stays inside the deadline so the caller gets this answer, not its own client's timeout
      const previous = previousRunnerOf(
        c.var.db,
        id,
        c.var.principal,
        Date.now(),
      );
      if (previous) {
        let runner: LingeringRunner;
        try {
          runner = await stopLingeringRunner(
            sprites,
            previous.spriteName,
            previous.runId,
            preLaunchDeadlineMs,
            previous.maySignal,
          );
        } catch (err) {
          log(`waiting for the runner of ${previous.runId} failed: ${err}`);
          return apiError(
            c,
            502,
            "sprite_unreachable",
            "could not check the agent's previous runner on its sprite; retry",
          );
        }
        if (runner === "terminated") {
          log(`the runner of ${previous.runId} outlived its run; SIGTERMed`);
        }
        if (runner === "alive") {
          return apiError(
            c,
            409,
            "runner_still_exiting",
            "the agent's previous runner is still exiting; retry shortly",
          );
        }
      }
      // an agent whose environment was rebuilt has no worktree: its next run makes one from a branch
      // of its that GitHub still has (`restartBranchOf`). The check execs in the sprite, so it runs
      // before the transaction
      const rebuilt = await restartBranchOf(
        c,
        id,
        checkBranch,
        log,
        preLaunchDeadlineMs,
      );
      if (rebuilt instanceof Response) return rebuilt;
      const runId = mintId("run");
      const outcome = c.var.db.transaction(
        (tx) => {
          const found = tx
            .select({ agent: agents, env: environments })
            .from(agents)
            .innerJoin(environments, eq(agents.envId, environments.id))
            .where(and(eq(agents.id, id), ownAgents(c.var.principal)))
            .get();
          if (!found) return { kind: "not_found" } as const;
          const { agent, env } = found;
          if (agent.archivedAt) return { kind: "archived" } as const;
          if (activeRunOf(tx, id)) return { kind: "busy" } as const;
          if (env.status !== "ready") return { kind: "not_ready" } as const;
          if (activeRunsIn(tx, env.id) >= env.concurrency) {
            return { kind: "at_cap", limit: env.concurrency } as const;
          }
          const run = tx
            .insert(runs)
            .values({ id: runId, agentId: id, status: launcher.entryStatus() })
            .returning()
            .get();
          storeRunEnvVars(
            tx,
            c.var.config.secretEncryptionKey,
            runId,
            envVars,
            ttlSeconds,
          );
          const fresh = agent.rebuiltAt !== null;
          const running = tx
            .update(agents)
            .set({
              status: "running",
              // once the run exists the worktree is its to make; the branch it starts from is kept
              // as a started-on branch, so a later rebuild finds it again, and one GitHub no longer
              // has is dropped, or the runner would make the worktree from it
              ...(fresh && { rebuiltAt: null, remoteBranch: rebuilt.branch }),
            })
            .where(eq(agents.id, id))
            .returning()
            .get();
          return { kind: "created", env, agent: running, run, fresh } as const;
        },
        { behavior: "immediate" },
      );
      switch (outcome.kind) {
        case "not_found":
          return apiError(c, 404, "not_found", "no such agent");
        case "archived":
          return archived(c);
        case "busy":
          return apiError(
            c,
            409,
            "agent_busy",
            "the agent already has an active run; wait for it or stop it",
          );
        case "not_ready":
          return refuseEnv(c, outcome.kind);
        case "at_cap":
          return atCap(c, outcome.limit);
      }
      registerRunEnvVars(c.var.secrets, runId, envVars);
      launcher.start({
        envId: outcome.env.id,
        spriteName: outcome.env.spriteName,
        agentId: id,
        runId,
        prompt: outcome.fresh
          ? `${rebuiltNote(outcome.agent.remoteBranch)}${prompt}`
          : prompt,
        sessionId: outcome.agent.sessionId,
        approvalPolicy: outcome.env.approvalPolicy,
        autoApprove: outcome.env.autoApprove,
        remoteBranch: outcome.agent.remoteBranch,
      });
      c.header("Location", `/v1/agents/${id}/runs/${runId}`);
      return c.json(
        {
          agent: presentAgent(outcome.agent),
          run: presentRun(outcome.run, null),
        },
        202,
      );
    })
    .post("/:id/stop", agentParam, async (c) => {
      const { id } = c.req.valid("param");
      const outcome = c.var.db.transaction(
        (tx) => {
          const found = agentWithSprite(tx, id, c.var.principal);
          if (!found) return { kind: "not_found" } as const;
          if (found.agent.archivedAt) return { kind: "archived" } as const;
          const run = stopActiveRun(tx, id);
          return {
            kind: "stopped",
            agent: agentRow(tx, id),
            run,
            spriteName: found.spriteName,
          } as const;
        },
        { behavior: "immediate" },
      );
      switch (outcome.kind) {
        case "not_found":
          return apiError(c, 404, "not_found", "no such agent");
        case "archived":
          return archived(c);
      }
      const { run, spriteName } = outcome;
      launcher.cancelChallengeRetry(id);
      if (run) c.var.nudgeDeliveries();
      // the run is stopped either way: a runner that missed the signal is refused its next post
      if (run) await signalRunner(sprites, spriteName, run.id, log);
      return c.json(
        {
          agent: presentAgent(outcome.agent),
          run: run ? presentRun(run, null) : null,
        },
        200,
      );
    })
    .post("/:id/archive", agentParam, async (c) => {
      const { id } = c.req.valid("param");
      const outcome = c.var.db.transaction(
        (tx) => {
          const found = agentWithSprite(tx, id, c.var.principal);
          if (!found) return undefined;
          const run = stopActiveRun(tx, id);
          const agent = found.agent.archivedAt
            ? agentRow(tx, id)
            : tx
                .update(agents)
                .set({ archivedAt: new Date().toISOString() })
                .where(eq(agents.id, id))
                .returning()
                .get();
          return { agent, run, spriteName: found.spriteName };
        },
        { behavior: "immediate" },
      );
      if (!outcome) return apiError(c, 404, "not_found", "no such agent");
      const { agent, run, spriteName } = outcome;
      if (run) {
        c.var.nudgeDeliveries();
        await signalRunner(sprites, spriteName, run.id, log);
      }
      // the app runs in the worktree, so it ends first, and so does the public URL it holds open
      try {
        await previews.stopForAgent(id, agent.envId);
      } catch (err) {
        log(`stopping the preview of ${id} failed: ${err}`);
        return apiError(
          c,
          502,
          "preview_stop_failed",
          "the agent is archived but its preview could not be stopped; retry archive",
        );
      }
      try {
        await removeWorktree(sprites, spriteName, id, run?.id ?? null);
      } catch (err) {
        log(`removing the worktree of ${id} failed: ${err}`);
        return apiError(
          c,
          502,
          "worktree_remove_failed",
          "the agent is archived but its worktree could not be removed; retry archive",
        );
      }
      return c.json({ agent: presentAgent(agent) }, 200);
    })
    .post(
      "/:id/preview",
      agentParam,
      jsonBody,
      body(PreviewStart),
      async (c) => {
        const { id } = c.req.valid("param");
        let result: StartResult;
        try {
          result = await previews.start(
            id,
            c.var.principal,
            c.req.valid("json"),
          );
        } catch (err) {
          log(`starting the preview of ${id} failed: ${err}`);
          return apiError(
            c,
            502,
            "sprite_unreachable",
            "could not reach the environment's sprite to start the preview; retry",
          );
        }
        switch (result.kind) {
          case "not_found":
            return apiError(c, 404, "not_found", "no such agent");
          case "archived":
            return archived(c);
          case "not_ready":
            return refuseEnv(c, "not_ready");
          case "no_worktree":
            return apiError(
              c,
              409,
              "no_worktree",
              "the agent has no worktree on its sprite yet; start a run first",
            );
          case "port_busy":
            return apiError(
              c,
              409,
              "port_busy",
              result.port === PREVIEW_PROXY_PORT
                ? `something on the environment's sprite already holds port ${PREVIEW_PROXY_PORT}, which a sprite's URL is routed to; the preview would break it, so nothing was started`
                : `port ${result.port} is already in use on the environment's sprite; start the preview on another port`,
            );
          case "preview_busy":
            return apiError(
              c,
              409,
              "preview_busy",
              "a preview started by another key is running in this environment, and one environment has one preview; it must stop or expire before this agent's can start",
            );
          case "commands_needed":
            return apiError(
              c,
              400,
              "preview_commands_needed",
              `the agent's worktree has no lockfile (pnpm-lock.yaml, yarn.lock, bun.lock or package-lock.json) to choose commands from; send ${result.missing.map((m) => `\`${m}\``).join(" and ")} (build may be "none" to skip the build; the CLI's flags are --build and --start)`,
            );
          case "replace_failed":
            return apiError(
              c,
              502,
              "preview_stop_failed",
              "the environment's running preview could not be stopped, so this one was not started; retry",
            );
          case "failed":
            return apiError(c, 502, "preview_failed", result.detail);
        }
        // answered once the link works; the build and the app's start go on, `state` following them
        return c.json({ preview: result.preview }, 202);
      },
    )
    .delete("/:id/preview", agentParam, async (c) => {
      const { id } = c.req.valid("param");
      let stopped: Awaited<ReturnType<Previews["stop"]>>;
      try {
        stopped = await previews.stop(id, c.var.principal);
      } catch (err) {
        log(`stopping the preview of ${id} failed: ${err}`);
        return apiError(
          c,
          502,
          "preview_stop_failed",
          "could not stop the preview on the environment's sprite; retry",
        );
      }
      if (stopped === undefined) {
        return apiError(c, 404, "not_found", "no such agent");
      }
      // nothing running is a stop that has nothing to do, so a retried stop or a cleanup trap succeeds
      return c.json({ preview: null, stopped }, 200);
    })
    .get("/:id/preview", agentParam, async (c) => {
      const { id } = c.req.valid("param");
      const preview = await previews.state(id, c.var.principal);
      if (preview === undefined)
        return apiError(c, 404, "not_found", "no such agent");
      // a failed preview is read like any other: `state` failed, why in `detail`, whose fault in `failure`,
      // and `expiresAt` when the sweep removes it
      return c.json({ preview }, 200);
    })
    .post("/:id/answers", agentParam, jsonBody, body(AnswerInput), (c) => {
      const { id } = c.req.valid("param");
      const { requestId, answer } = c.req.valid("json");
      return decide(c, sprites, log, id, {
        requestId,
        decision: "answer",
        answer,
      });
    })
    .post("/:id/approvals", agentParam, jsonBody, body(ApprovalInput), (c) =>
      decide(c, sprites, log, c.req.valid("param").id, c.req.valid("json")),
    )
    .get("/", listQuery, (c) => {
      const query = c.req.valid("query");
      let after: [string, string] | undefined;
      if (query.cursor !== undefined) {
        after = decodeCursor(query.cursor);
        if (!after) {
          return apiError(
            c,
            400,
            "invalid_cursor",
            "the cursor is not one this API returned",
          );
        }
      }
      return c.json(listAgents(c.var.db, c.var.principal, query, after), 200);
    })
    .get("/:id", agentParam, (c) => {
      const { id } = c.req.valid("param");
      const db = c.var.db;
      const agent = db
        .select()
        .from(agents)
        .where(and(eq(agents.id, id), ownAgents(c.var.principal)))
        .get();
      if (!agent) return apiError(c, 404, "not_found", "no such agent");
      return c.json({ ...presentAgent(agent), usage: agentUsage(db, id) }, 200);
    })
    .get("/:id/runs", agentParam, (c) => {
      const { id } = c.req.valid("param");
      const db = c.var.db;
      const found = db
        .select({
          branch: agents.branch,
          remoteBranch: agents.remoteBranch,
          repo: environments.repo,
        })
        .from(agents)
        .innerJoin(environments, eq(agents.envId, environments.id))
        .where(and(eq(agents.id, id), ownAgents(c.var.principal)))
        .get();
      if (!found) return apiError(c, 404, "not_found", "no such agent");
      const rows = db
        .select()
        .from(runs)
        .where(eq(runs.agentId, id))
        // ties within a millisecond go by insert order (rowid); ids are random
        .orderBy(desc(runs.createdAt), desc(sql`rowid`))
        .all();
      // reading a diff wakes the sprite, so only the single-run GET returns one
      const data = rows.map((run) =>
        presentRunDetail(db, run, found, found.repo, null),
      );
      return c.json({ data }, 200);
    })
    .get("/:id/runs/:runId", runParam, async (c) => {
      const { id, runId } = c.req.valid("param");
      const db = c.var.db;
      const found = db
        .select({
          run: runs,
          agent: agents,
          spriteName: environments.spriteName,
          repo: environments.repo,
        })
        .from(runs)
        .innerJoin(agents, eq(runs.agentId, agents.id))
        .innerJoin(environments, eq(agents.envId, environments.id))
        .where(
          and(
            eq(runs.id, runId),
            eq(runs.agentId, id),
            ownAgents(c.var.principal),
          ),
        )
        .get();
      if (!found) return apiError(c, 404, "not_found", "no such run");
      const { run, agent, spriteName, repo } = found;
      // the runner commits at run end, so an active run's branch doesn't hold its work yet
      let diff: string | null = null;
      let diffSize: number | null = null;
      if (!isActive(run.status)) {
        // the runner pins refs/sky/starts/<agentId> where the worktree left the start branch and never
        // moves it, unlike origin/<remoteBranch>, which an outside push advances past the agent's work
        const base = agent.remoteBranch
          ? `refs/sky/starts/${agent.id}`
          : "origin/HEAD";
        try {
          const out = await execCapped(
            sprites,
            spriteName,
            ["sh", "-c", DIFF, "sh", base, agent.branch],
            { op: "diff", cwd: REPO_DIR, maxBytes: DIFF_MAX_BYTES },
          );
          // 3: the runner never created the branch (a launch that failed, a runner killed first)
          if (out.exitCode !== 0 && out.exitCode !== 3) {
            log(
              `diff of ${run.id} (agent ${agent.id}) exited ${out.exitCode}; answered without one`,
            );
          }
          if (out.exitCode === 0) {
            // the worktree's files are Claude's to write, and it can write what it read from its env
            diff = redact(out.stdout, [
              ...c.var.secrets.values(),
              mintAgentToken(c.var.config.apiKey, run.id),
            ]);
            if (out.truncated) diffSize = out.size;
          }
        } catch (err) {
          log(
            `diff of ${run.id} failed: ${err}${err instanceof Error && err.cause ? ` (cause: ${err.cause})` : ""}`,
          );
          if (err instanceof SpriteExecStreamError) {
            return apiError(
              c,
              502,
              "sprite_exec_failed",
              "the sprite answered, but the run's diff could not be read back from it; retry, and if it fails again, check the sprite's free disk space",
            );
          }
          return apiError(
            c,
            502,
            "sprite_unreachable",
            "could not read the run's diff from its sprite; retry",
          );
        }
      }
      return c.json(
        presentRunDetail(db, run, agent, repo, diff, diffSize),
        200,
      );
    })
    .get("/:id/runs/:runId/stream", runParam, afterQuery, lastEventId, (c) => {
      const { id, runId } = c.req.valid("param");
      const run = c.var.db
        .select({ id: runs.id })
        .from(runs)
        .innerJoin(agents, eq(runs.agentId, agents.id))
        .where(
          and(
            eq(runs.id, runId),
            eq(runs.agentId, id),
            ownAgents(c.var.principal),
          ),
        )
        .get();
      if (!run) return apiError(c, 404, "not_found", "no such run");
      // a reconnecting EventSource keeps its original URL, so the header is the fresher cursor
      const after =
        c.req.valid("header")["last-event-id"] ??
        c.req.valid("query").after ??
        0;
      return streamRunEvents(c, runId, after, heartbeatMs, log);
    });
}
