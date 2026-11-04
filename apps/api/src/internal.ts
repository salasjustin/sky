import { zValidator } from "@hono/zod-validator";
import { agents, type Db, runRequests, runs } from "@sky/db";
import {
  canTransition,
  EVENT_TEXT_MAX,
  type EventType,
  type PendingRequest,
  RequestId,
  RunId,
  RunnerEventPost,
  RunRollup,
  type RunStatus,
  truncationMarker,
} from "@sky/shared";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { isAgentTokenFor, mintAgentToken } from "./agent-token.js";
import { apiError } from "./errors.js";
import { factory } from "./factory.js";
import { redactDeep } from "./redact.js";
import { openRequest, openRequestOf, requestDecisions } from "./requests.js";
import {
  activeRunStatuses,
  agentStatusFor,
  isActive,
  recordEvent,
  type Tx,
} from "./runs.js";
import { body, jsonBody } from "./validation.js";

// the status each event moves its run to; claude.* events leave it, and decideRequest moves it on run.resumed
const statusAfter: Record<EventType, RunStatus | null> = {
  "run.started": "running",
  "run.waiting": "waiting",
  "run.resumed": null,
  "run.finished": "finished",
  "run.failed": "failed",
  "run.stopped": "stopped",
  "run.probed": null,
  "runner.warning": null,
  "runner.heartbeat": null,
  "claude.PreToolUse": null,
  "claude.PostToolUse": null,
  "claude.PostToolUseFailure": null,
  "claude.SubagentStart": null,
  "claude.SubagentStop": null,
  "claude.TaskCreated": null,
  "claude.TaskCompleted": null,
  "claude.Notification": null,
  "claude.PreCompact": null,
  "claude.FileChanged": null,
  "claude.Message": null,
};

/** Most of an approval's `toolSummary` stored after redaction, before the truncation marker. */
const TOOL_SUMMARY_MAX = 2_000;

/** `text` cut to `max`, marking how much it dropped. */
const cut = (text: string, max: number) =>
  text.length > max
    ? text.slice(0, max) + truncationMarker(text.length - max)
    : text;

/** Cuts each string field of a flat payload to `EVENT_TEXT_MAX`, marking how much it dropped. */
function trimText<T extends object>(payload: T): T {
  return Object.fromEntries(
    Object.entries(payload).map(([k, v]) => [
      k,
      typeof v === "string" ? cut(v, EVENT_TEXT_MAX) : v,
    ]),
  ) as T;
}

/** `request` with an approval's `toolSummary` cut to `TOOL_SUMMARY_MAX`. */
const trimRequest = (request: PendingRequest): PendingRequest =>
  request.kind === "approval"
    ? { ...request, toolSummary: cut(request.toolSummary, TOOL_SUMMARY_MAX) }
    : request;

const bearer = (header: string | undefined) =>
  /^Bearer ([A-Za-z0-9_-]+)$/.exec(header ?? "")?.[1];

/** `runId`'s row when `token` is its agent token; else whether the token is a stranger's or another live run's. */
function runForToken(tx: Db | Tx, apiKey: string, runId: RunId, token: string) {
  const run = tx.select().from(runs).where(eq(runs.id, runId)).get();
  if (run && isAgentTokenFor(apiKey, runId, token)) {
    return { kind: "authorized", run } as const;
  }
  // a live run's token posting for another run is a runner bug, not a stranger
  const otherRun = tx
    .select({ id: runs.id })
    .from(runs)
    .where(inArray(runs.status, activeRunStatuses))
    .all()
    .some((r) => isAgentTokenFor(apiKey, r.id, token));
  return { kind: otherRun ? "forbidden" : "unauthorized" } as const;
}

const requestParam = zValidator(
  "param",
  z.object({ runId: RunId, requestId: RequestId }),
  (result, c) => {
    if (!result.success)
      return apiError(c, 404, "not_found", "no such request");
  },
);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `RunnerEventPost`, except a rollup that fails `RunRollup` is dropped with a log line rather than failing the event. */
const eventPost = (log: (line: string) => void) =>
  z.preprocess((raw) => {
    if (!isRecord(raw) || !isRecord(raw.payload)) return raw;
    if (raw.type !== "run.finished" && raw.type !== "run.failed") return raw;
    const { rollup, ...payload } = raw.payload;
    if (rollup === undefined) return raw;
    const parsed = RunRollup.safeParse(rollup);
    if (parsed.success) return raw;
    // runs before the token check, so the unverified runId is quoted to keep it on one line
    log(
      `dropped unparseable rollup on ${raw.type} for ${JSON.stringify(raw.runId)}: ${z.prettifyError(parsed.error)}`,
    );
    return { ...raw, payload };
  }, RunnerEventPost);

/** `longPollMs`: how long the decision long-poll waits before answering pending. */
export function internalRoutes(
  longPollMs: number,
  log: (line: string) => void,
) {
  const requireToken = factory.createMiddleware(async (c, next) => {
    if (!bearer(c.req.header("authorization"))) {
      return apiError(c, 401, "unauthorized", "missing agent token");
    }
    await next();
  });
  return factory
    .createApp()
    .use("/events", requireToken)
    .use("/runs/*", requireToken)
    .post("/events", jsonBody, body(eventPost(log)), (c) => {
      const event = c.req.valid("json");
      const { db, config, secrets } = c.var;
      const token = bearer(c.req.header("authorization")) ?? "";
      const outcome = db.transaction(
        (tx) => {
          const auth = runForToken(tx, config.apiKey, event.runId, token);
          if (auth.kind !== "authorized") return auth;
          const { run } = auth;
          if (!isActive(run.status)) return { kind: "ended" } as const;
          if (event.type === "run.waiting" && openRequestOf(tx, run.id)) {
            return { kind: "request_open" } as const;
          }
          const next = statusAfter[event.type];
          if (next && !canTransition(run.status, next)) {
            return { kind: "illegal", from: run.status, to: next } as const;
          }
          // Claude's output can echo its own environment, or any other live runner's on its sprite
          const liveTokens = tx
            .select({ id: runs.id })
            .from(runs)
            .where(inArray(runs.status, activeRunStatuses))
            .all()
            .map((r) => mintAgentToken(config.apiKey, r.id));
          const redacted = redactDeep(event, [
            ...secrets.values(),
            ...liveTokens,
          ]);
          // trimmed only after redaction, so a cut can't split a secret out of its match
          if (redacted.type === "run.waiting") {
            redacted.payload.request = trimRequest(redacted.payload.request);
            openRequest(tx, run.id, redacted.payload.request);
          }
          const { id, enqueued } = recordEvent(
            tx,
            run.id,
            event.type,
            event.type.startsWith("claude.") || event.type === "runner.warning"
              ? trimText(redacted.payload)
              : redacted.payload,
          );
          if (next) {
            const ended =
              redacted.type === "run.finished" || redacted.type === "run.failed"
                ? redacted.payload
                : undefined;
            tx.update(runs)
              .set({
                status: next,
                ...(redacted.type === "run.finished"
                  ? { summary: redacted.payload.summary }
                  : {}),
                ...(ended?.usage ?? {}),
                ...(ended?.rollup ? { rollup: ended.rollup } : {}),
              })
              .where(eq(runs.id, run.id))
              .run();
          }
          tx.update(agents)
            .set({
              status: agentStatusFor(next ?? run.status),
              ...(event.type === "run.started"
                ? { sessionId: event.payload.sessionId }
                : {}),
            })
            .where(eq(agents.id, run.agentId))
            .run();
          return { kind: "stored", id, enqueued } as const;
        },
        { behavior: "immediate" },
      );
      switch (outcome.kind) {
        case "unauthorized":
          return apiError(c, 401, "unauthorized", "invalid agent token");
        case "forbidden":
          return apiError(c, 403, "forbidden", "token belongs to another run");
        case "ended":
          return apiError(c, 401, "run_ended", "the run has ended");
        case "illegal":
          return apiError(
            c,
            409,
            "invalid_transition",
            `a ${outcome.from} run cannot become ${outcome.to}`,
          );
        case "request_open":
          return apiError(
            c,
            409,
            "request_open",
            "the run already has an open request",
          );
      }
      // after the commit, so the dispatcher sees the rows; never awaited, so delivery can't slow the runner
      if (outcome.enqueued > 0) c.var.nudgeDeliveries();
      return c.json({ id: outcome.id }, 201);
    })
    .get("/runs/:runId/requests/:requestId", requestParam, async (c) => {
      const { runId, requestId } = c.req.valid("param");
      const { db, config } = c.var;
      const token = bearer(c.req.header("authorization")) ?? "";
      const auth = runForToken(db, config.apiKey, runId, token);
      switch (auth.kind) {
        case "unauthorized":
          return apiError(c, 401, "unauthorized", "invalid agent token");
        case "forbidden":
          return apiError(c, 403, "forbidden", "token belongs to another run");
      }
      if (!isActive(auth.run.status)) {
        return apiError(c, 401, "run_ended", "the run has ended");
      }
      const decisionOf = () =>
        db
          .select({ decision: runRequests.decision })
          .from(runRequests)
          .where(
            and(eq(runRequests.id, requestId), eq(runRequests.runId, runId)),
          )
          .get();
      // subscribed before the first read, so a decision landing in between still wakes it
      let wake = () => {};
      const woken = new Promise<void>((resolve) => {
        wake = resolve;
      });
      const unsubscribe = requestDecisions.subscribe(requestId, wake);
      const timer = setTimeout(wake, longPollMs);
      const signal = c.req.raw.signal;
      signal.addEventListener("abort", wake, { once: true });
      try {
        const first = decisionOf();
        if (!first) return apiError(c, 404, "not_found", "no such request");
        if (!first.decision) await woken;
        const decision = first.decision ?? decisionOf()?.decision;
        return decision
          ? c.json({ status: "decided" as const, decision }, 200)
          : c.json({ status: "pending" as const }, 200);
      } finally {
        unsubscribe();
        clearTimeout(timer);
        signal.removeEventListener("abort", wake);
      }
    });
}
