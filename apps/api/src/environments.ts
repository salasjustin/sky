import { zValidator } from "@hono/zod-validator";
import {
  agents,
  type Db,
  environments,
  events,
  runRequests,
  runs,
  webhookDeliveries,
  webhooks,
} from "@sky/db";
import {
  DEFAULT_CLAUDE_CREDENTIAL,
  Environment,
  EnvironmentId,
} from "@sky/shared";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { adminOnly, canUseEnv } from "./auth.js";
import { assignmentProblem } from "./claude-credentials.js";
import { apiError } from "./errors.js";
import { factory } from "./factory.js";
import { mintId } from "./ids.js";
import type { Provisioner } from "./provision.js";
import { activeRunStatuses, type Tx } from "./runs.js";
import { destroySprite, type SpriteOps, spriteNameFor } from "./sprites.js";
import { body, jsonBody } from "./validation.js";

const {
  name,
  repo,
  setup,
  base,
  concurrency,
  approvalPolicy,
  autoApprove,
  claudeCredential,
  claudeFallback,
} = Environment.shape;
const EnvironmentInput = z.strictObject({
  name,
  repo,
  setup,
  base,
  concurrency,
  approvalPolicy,
  autoApprove,
  claudeCredential,
  claudeFallback,
});
// unwrapped: zod 4 applies a default even inside .optional(), which would reset omitted fields;
// autoApprove's own fields too, so the handler merges what was sent over the stored value
const autoApproveFields = autoApprove.unwrap().shape;
const EnvironmentPatch = z.strictObject({
  name: name.optional(),
  repo: repo.optional(),
  setup: setup.optional(),
  base: base.unwrap().optional(),
  concurrency: concurrency.unwrap().optional(),
  approvalPolicy: approvalPolicy.unwrap().optional(),
  autoApprove: z
    .strictObject({
      defaults: autoApproveFields.defaults.unwrap().optional(),
      commands: autoApproveFields.commands.unwrap().optional(),
    })
    .optional(),
  claudeCredential: claudeCredential.unwrap().optional(),
  claudeFallback: claudeFallback.unwrap().optional(),
});

type EnvRow = typeof environments.$inferSelect;

const present = (row: EnvRow) => ({
  ...({
    id: row.id,
    name: row.name,
    repo: row.repo,
    setup: row.setup,
    base: row.base,
    status: row.status,
    spriteName: row.spriteName,
    checkpointId: row.checkpointId,
    concurrency: row.concurrency,
    approvalPolicy: row.approvalPolicy,
    autoApprove: row.autoApprove,
    claudeCredential: row.claudeCredential,
    claudeFallback: row.claudeFallback,
  } satisfies Environment),
  // while provisioning, failure_step holds the step in progress
  failure:
    row.status !== "failed" || row.failureStep === null
      ? null
      : { step: row.failureStep, stderr: row.failureStderr ?? "" },
  createdAt: row.createdAt,
});

const unknownBase = (base: string, known: string[]) =>
  `unknown base profile ${JSON.stringify(base)}; ${
    known.length === 0
      ? "this server has none configured"
      : `this server has: ${known.join(", ")}`
  }`;

/** `default` is the unset assignment; stored as null so the two never differ. */
const normalizeCredential = (value: string | null | undefined) =>
  value === DEFAULT_CLAUDE_CREDENTIAL ? null : value;

const nameTakenResult = { kind: "name_taken" } as const;

const isNameConflict = (err: unknown): boolean =>
  err instanceof Error &&
  (((err as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE" &&
    err.message.includes("environments.name")) ||
    isNameConflict(err.cause));

/** Runs a write, mapping a unique violation on name (a writer that won after our check) to name_taken. */
function nameTakenOnConflict<T>(write: () => T): T | typeof nameTakenResult {
  try {
    return write();
  } catch (err) {
    if (isNameConflict(err)) return nameTakenResult;
    throw err;
  }
}

const findEnv = (tx: Db | Tx, id: EnvironmentId) =>
  tx.select().from(environments).where(eq(environments.id, id)).get();

const nameTaken = (tx: Tx, envName: string) =>
  tx
    .select({ id: environments.id })
    .from(environments)
    .where(eq(environments.name, envName))
    .get() !== undefined;

const hasActiveRun = (tx: Db | Tx, id: EnvironmentId) =>
  tx
    .select({ id: runs.id })
    .from(runs)
    .innerJoin(agents, eq(runs.agentId, agents.id))
    .where(and(eq(agents.envId, id), inArray(runs.status, activeRunStatuses)))
    .get() !== undefined;

const unarchivedAgentIds = (tx: Tx, id: EnvironmentId) =>
  tx
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.envId, id), isNull(agents.archivedAt)))
    .orderBy(asc(agents.createdAt), asc(sql`rowid`))
    .all()
    .map((a) => a.id);

const notFound = "no such environment";
const runActive = "a run on this environment is active; wait for it or stop it";
const nameTakenMessage = "an environment with this name already exists";
const stillProvisioning =
  "environment is still provisioning; wait for it to finish";

const reprovisioning = {
  status: "provisioning",
  checkpointId: null,
  failureStep: null,
  failureStderr: null,
} as const;

const envParam = zValidator(
  "param",
  z.object({ id: EnvironmentId }),
  (result, c) => {
    if (!result.success) {
      return apiError(c, 404, "not_found", notFound);
    }
  },
);

/** `/v1/environments`; an issued key reads the ones on its list and changes none. */
export function environmentRoutes(
  provisioner: Provisioner,
  sprites: SpriteOps,
  log: (line: string) => void,
) {
  return factory
    .createApp()
    .on("POST", ["/", "/:id/retry"], adminOnly)
    .on(["PATCH", "DELETE"], "/:id", adminOnly)
    .get("/", (c) => {
      const { principal } = c.var;
      const rows = c.var.db
        .select()
        .from(environments)
        .where(
          principal.role === "admin"
            ? undefined
            : inArray(environments.id, principal.environmentIds),
        )
        // ties within a millisecond go by insert order (rowid); ids are random
        .orderBy(asc(environments.createdAt), asc(sql`rowid`))
        .all();
      return c.json({ data: rows.map(present) }, 200);
    })
    .post("/", jsonBody, body(EnvironmentInput), (c) => {
      const input = {
        ...c.req.valid("json"),
      };
      input.claudeCredential =
        normalizeCredential(input.claudeCredential) ?? null;
      const credentialProblem = assignmentProblem(
        c.var.config,
        input.claudeCredential,
      );
      if (credentialProblem) {
        return apiError(c, 400, "unknown_credential", credentialProblem);
      }
      const profiles = Object.keys(c.var.config.baseProfiles);
      if (input.base !== null && !profiles.includes(input.base)) {
        return apiError(
          c,
          400,
          "unknown_base",
          unknownBase(input.base, profiles),
        );
      }
      const id = mintId("env");
      const row = nameTakenOnConflict(() =>
        c.var.db.transaction(
          (tx) => {
            if (nameTaken(tx, input.name)) return nameTakenResult;
            return tx
              .insert(environments)
              .values({
                ...input,
                id,
                status: "provisioning",
                spriteName: spriteNameFor(id),
                checkpointId: null,
              })
              .returning()
              .get();
          },
          { behavior: "immediate" },
        ),
      );
      if ("kind" in row) {
        return apiError(c, 409, "name_taken", nameTakenMessage);
      }
      provisioner.start(row);
      c.header("Location", `/v1/environments/${id}`);
      return c.json(present(row), 202);
    })
    .get("/:id", envParam, (c) => {
      const { id } = c.req.valid("param");
      const row = canUseEnv(c.var.principal, id)
        ? findEnv(c.var.db, id)
        : undefined;
      if (!row) return apiError(c, 404, "not_found", notFound);
      return c.json(present(row), 200);
    })
    .patch("/:id", envParam, jsonBody, body(EnvironmentPatch), (c) => {
      const { id } = c.req.valid("param");
      const patch = c.req.valid("json");
      if (patch.claudeCredential !== undefined) {
        patch.claudeCredential =
          normalizeCredential(patch.claudeCredential) ?? null;
        const credentialProblem = assignmentProblem(
          c.var.config,
          patch.claudeCredential,
        );
        if (credentialProblem) {
          return apiError(c, 400, "unknown_credential", credentialProblem);
        }
      }
      const profiles = Object.keys(c.var.config.baseProfiles);
      if (
        patch.base !== undefined &&
        patch.base !== null &&
        !profiles.includes(patch.base)
      ) {
        return apiError(
          c,
          400,
          "unknown_base",
          unknownBase(patch.base, profiles),
        );
      }
      const outcome = nameTakenOnConflict(() =>
        c.var.db.transaction(
          (tx) => {
            const env = findEnv(tx, id);
            if (!env) return { kind: "not_found" } as const;
            if (hasActiveRun(tx, id)) return { kind: "run_active" } as const;
            const reprovision =
              (patch.repo !== undefined && patch.repo !== env.repo) ||
              (patch.setup !== undefined && patch.setup !== env.setup) ||
              (patch.base !== undefined && patch.base !== env.base);
            if (reprovision && env.status === "provisioning") {
              return { kind: "provisioning" } as const;
            }
            // reprovisioning removes the repo and every worktree, and the agents' branches exist nowhere else
            const agentIds = reprovision ? unarchivedAgentIds(tx, id) : [];
            if (agentIds.length > 0) {
              return { kind: "agents_exist", agentIds } as const;
            }
            if (
              patch.name !== undefined &&
              patch.name !== env.name &&
              nameTaken(tx, patch.name)
            ) {
              return nameTakenResult;
            }
            const { autoApprove: sentAutoApprove, ...rest } = patch;
            const fields =
              sentAutoApprove === undefined
                ? rest
                : {
                    ...rest,
                    autoApprove: { ...env.autoApprove, ...sentAutoApprove },
                  };
            const changes = reprovision
              ? { ...fields, ...reprovisioning }
              : fields;
            // drizzle refuses an update with nothing to set
            const row =
              Object.keys(changes).length === 0
                ? env
                : tx
                    .update(environments)
                    .set(changes)
                    .where(eq(environments.id, id))
                    .returning()
                    .get();
            return { kind: "updated", row, reprovision } as const;
          },
          { behavior: "immediate" },
        ),
      );
      switch (outcome.kind) {
        case "not_found":
          return apiError(c, 404, "not_found", notFound);
        case "run_active":
          return apiError(c, 409, "run_active", runActive);
        case "provisioning":
          return apiError(c, 409, "provisioning", stillProvisioning);
        case "name_taken":
          return apiError(c, 409, "name_taken", nameTakenMessage);
        case "agents_exist":
          return apiError(
            c,
            409,
            "agents_exist",
            `changing repo, setup or base replaces every agent's worktree and branch; archive agents ${outcome.agentIds.join(", ")} first`,
          );
      }
      if (outcome.reprovision) {
        provisioner.start(outcome.row);
        return c.json(present(outcome.row), 202);
      }
      return c.json(present(outcome.row), 200);
    })
    .post("/:id/retry", envParam, (c) => {
      const { id } = c.req.valid("param");
      const outcome = c.var.db.transaction(
        (tx) => {
          const env = findEnv(tx, id);
          if (!env) return { kind: "not_found" } as const;
          if (env.status !== "failed") return { kind: "not_failed" } as const;
          const row = tx
            .update(environments)
            .set(reprovisioning)
            .where(eq(environments.id, id))
            .returning()
            .get();
          // reprovisioning wipes the sprite's sessions, so a resume would name one that is gone
          tx.update(agents)
            .set({ sessionId: null })
            .where(eq(agents.envId, id))
            .run();
          return { kind: "retrying", row } as const;
        },
        { behavior: "immediate" },
      );
      switch (outcome.kind) {
        case "not_found":
          return apiError(c, 404, "not_found", notFound);
        case "not_failed":
          return apiError(
            c,
            409,
            "not_failed",
            "only a failed environment can be retried",
          );
      }
      provisioner.start(outcome.row);
      return c.json(present(outcome.row), 202);
    })
    .delete("/:id", envParam, async (c) => {
      const { id } = c.req.valid("param");
      const db = c.var.db;
      const env = findEnv(db, id);
      if (!env) return apiError(c, 404, "not_found", notFound);
      if (hasActiveRun(db, id)) {
        return apiError(c, 409, "run_active", runActive);
      }
      if (env.status === "provisioning") {
        return apiError(c, 409, "provisioning", stillProvisioning);
      }
      const filtering = db
        .select({ id: webhooks.id, environmentIds: webhooks.environmentIds })
        .from(webhooks)
        .all()
        .filter((w) => w.environmentIds?.includes(id));
      if (filtering.length > 0) {
        const webhookIds = filtering.map((w) => w.id);
        return c.json(
          {
            error: {
              code: "webhooks_filter",
              message: `webhooks filter on this environment: ${webhookIds.join(", ")}; delete them first`,
              webhookIds,
            },
          },
          409,
        );
      }
      try {
        await destroySprite(sprites, env.spriteName);
      } catch (err) {
        log(`destroying sprite ${env.spriteName} failed: ${err}`);
        return apiError(
          c,
          502,
          "sprite_destroy_failed",
          "could not destroy the environment's sprite; retry the delete",
        );
      }
      // committed on its own: if the row delete below fails, the env must not stay ready on a destroyed sprite
      db.update(environments)
        .set({ status: "failed" })
        .where(eq(environments.id, id))
        .run();
      db.transaction(
        (tx) => {
          const envAgents = tx
            .select({ id: agents.id })
            .from(agents)
            .where(eq(agents.envId, id));
          const envRuns = tx
            .select({ id: runs.id })
            .from(runs)
            .where(inArray(runs.agentId, envAgents));
          const envEvents = tx
            .select({ id: events.id })
            .from(events)
            .where(inArray(events.runId, envRuns));
          // both pin their parent without cascade (db/src/schema.ts), so they go first
          tx.delete(webhookDeliveries)
            .where(inArray(webhookDeliveries.eventId, envEvents))
            .run();
          tx.delete(runRequests)
            .where(inArray(runRequests.runId, envRuns))
            .run();
          tx.delete(events).where(inArray(events.runId, envRuns)).run();
          tx.delete(runs).where(inArray(runs.agentId, envAgents)).run();
          tx.delete(agents).where(eq(agents.envId, id)).run();
          tx.delete(environments).where(eq(environments.id, id)).run();
        },
        { behavior: "immediate" },
      );
      return c.body(null, 204);
    });
}
