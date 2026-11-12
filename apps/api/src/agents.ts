import { zValidator } from "@hono/zod-validator";
import { agents, type Db, environments, runs } from "@sky/db";
import {
  AgentId,
  agentBranch,
  BranchName,
  type Decision,
  EnvironmentId,
  RequestId,
  RunId,
} from "@sky/shared";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import type { Context } from "hono";
import { z } from "zod";
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
  stopActiveRun,
  type Tx,
} from "./runs.js";
import {
  EnvVarName,
  isReservedName,
  registerRunEnvVars,
  reservedName,
  storeRunEnvVars,
} from "./secrets.js";
import { execInSprite, type SpriteOps } from "./sprites.js";
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

const reservedIn = (envVars: Record<string, string>) =>
  Object.keys(envVars).find(isReservedName);
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
) => ({
  ...presentRun(run, runError(db, run.id)),
  branch: agent.branch,
  diff,
  pendingRequest: openRequestOf(db, run.id)?.request ?? null,
  rollup: run.rollup,
  compareUrl: run.rollup
    ? `https://github.com/${repo}/compare/${run.rollup.base}...${compareHead(agent)}`
    : null,
  // null until the launch records what it injected
  secretNames: run.secretNames,
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

/**
 * The agent's latest run, when it has ended and so may leave a runner still exiting; undefined for
 * an unknown, not-owned or archived agent, or one whose latest run is active, which the follow-up
 * refuses.
 */
function previousRunnerOf(db: Db, id: AgentId, principal: Principal) {
  const row = db
    .select({
      runId: runs.id,
      status: runs.status,
      archivedAt: agents.archivedAt,
      spriteName: environments.spriteName,
    })
    .from(runs)
    .innerJoin(agents, eq(runs.agentId, agents.id))
    .innerJoin(environments, eq(agents.envId, environments.id))
    .where(and(eq(runs.agentId, id), ownAgents(principal)))
    .orderBy(desc(runs.createdAt), desc(sql`${runs}.rowid`))
    .get();
  if (!row || row.archivedAt || isActive(row.status)) return undefined;
  return row;
}

/** Re-reads an agent this transaction already found. */
const agentRow = (tx: Tx, id: AgentId) => {
  const row = tx.select().from(agents).where(eq(agents.id, id)).get();
  if (!row) throw new Error(`agent ${id} vanished mid-transaction`);
  return row;
};

// $1 the base, $2 the agent's branch. A branch that was never created is a normal answer, not an
// error, and git's complaint about it stays off the wire: the SDK's HTTP exec reads each chunk as a
// frame, so a failing command's stderr and exit status in one chunk fail the whole call
const DIFF = `git rev-parse --verify --quiet "refs/heads/$2" >/dev/null 2>&1 || exit 3; exec git diff "$1...$2" 2>/dev/null`;

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

export function agentRoutes(
  launcher: Launcher,
  checkBranch: BranchChecker,
  sprites: SpriteOps,
  log: (line: string) => void,
  heartbeatMs: number,
  preLaunchDeadlineMs: number,
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
            .values({ id: runId, agentId, status: "starting" })
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
      // or be alive past its run's end (a timed-out run's, wedged): it is signalled, and the wait for
      // it stays inside the deadline so the caller gets this answer, not its own client's timeout
      const previous = previousRunnerOf(c.var.db, id, c.var.principal);
      if (previous) {
        let runner: LingeringRunner;
        try {
          runner = await stopLingeringRunner(
            sprites,
            previous.spriteName,
            previous.runId,
            preLaunchDeadlineMs,
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
            .values({ id: runId, agentId: id, status: "starting" })
            .returning()
            .get();
          storeRunEnvVars(
            tx,
            c.var.config.secretEncryptionKey,
            runId,
            envVars,
            ttlSeconds,
          );
          const running = tx
            .update(agents)
            .set({ status: "running" })
            .where(eq(agents.id, id))
            .returning()
            .get();
          return { kind: "created", env, agent: running, run } as const;
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
        prompt,
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
      if (!isActive(run.status)) {
        // the runner pins refs/sky/starts/<agentId> where the worktree left the start branch and never
        // moves it, unlike origin/<remoteBranch>, which an outside push advances past the agent's work
        const base = agent.remoteBranch
          ? `refs/sky/starts/${agent.id}`
          : "origin/HEAD";
        try {
          const out = await execInSprite(
            sprites,
            spriteName,
            ["sh", "-c", DIFF, "sh", base, agent.branch],
            { op: "diff", cwd: REPO_DIR },
          );
          // nonzero: the runner never created the branch (a launch that failed, a runner killed first)
          if (out.exitCode === 0) {
            // the worktree's files are Claude's to write, and it can write what it read from its env
            diff = redact(out.stdout, [
              ...c.var.secrets.values(),
              mintAgentToken(c.var.config.apiKey, run.id),
            ]);
          }
        } catch (err) {
          log(`diff of ${run.id} failed: ${err}`);
          return apiError(
            c,
            502,
            "sprite_unreachable",
            "could not read the run's diff from its sprite; retry",
          );
        }
      }
      return c.json(presentRunDetail(db, run, agent, repo, diff), 200);
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
