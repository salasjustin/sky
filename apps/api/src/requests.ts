import { EventEmitter } from "node:events";
import { agents, type Db, runRequests, runs } from "@sky/db";
import type {
  AgentId,
  Decision,
  PendingRequest,
  RequestId,
  RunId,
  WithdrawalReason,
} from "@sky/shared";
import { and, eq, isNull } from "drizzle-orm";
import { recordEvent, type Tx } from "./runs.js";

const emitter = new EventEmitter().setMaxListeners(0);

/**
 * In-process wake-ups for a request's decision. Publish only after the deciding transaction commits:
 * a listener re-reads the row at once.
 */
export const requestDecisions = {
  publish(requestId: RequestId): void {
    emitter.emit(requestId);
  },
  /** Calls `listener` after each publish for `requestId`; returns the unsubscribe. */
  subscribe(requestId: RequestId, listener: () => void): () => void {
    emitter.on(requestId, listener);
    return () => emitter.off(requestId, listener);
  },
};

/** The run's undecided request, if any; a run has at most one. */
export const openRequestOf = (tx: Db | Tx, runId: RunId) =>
  tx
    .select({ request: runRequests.request })
    .from(runRequests)
    .where(and(eq(runRequests.runId, runId), isNull(runRequests.decidedAt)))
    .get();

/** Stores the run's pending request; the caller has checked it has none open. */
export function openRequest(tx: Tx, runId: RunId, request: PendingRequest) {
  tx.insert(runRequests)
    .values({ id: request.requestId, runId, kind: request.kind, request })
    .run();
}

const resumedAs = {
  answer: "answered",
  approve: "approved",
  deny: "denied",
} as const;

const sameDecision = (a: Decision, b: Decision) =>
  a.decision === "answer"
    ? b.decision === "answer" && a.answer === b.answer
    : a.decision === b.decision && a.reason === b.reason;

/**
 * Records `decision` on its request, if it is open on the agent's waiting run, and moves the run and
 * agent back to `running`. Publish the request's decision once `tx` commits. The same decision sent
 * again is `repeated`, with the run as it is now, whatever its status; a different one is
 * `already_decided`.
 */
export function decideRequest(tx: Tx, agentId: AgentId, decision: Decision) {
  const found = tx
    .select({ request: runRequests, run: runs })
    .from(runRequests)
    .innerJoin(runs, eq(runRequests.runId, runs.id))
    .where(
      and(eq(runRequests.id, decision.requestId), eq(runs.agentId, agentId)),
    )
    .get();
  if (!found) return { kind: "not_found" } as const;
  if (found.request.decision?.decision === "withdrawn") {
    return { kind: "withdrawn" } as const;
  }
  const wanted = decision.decision === "answer" ? "question" : "approval";
  if (found.request.kind !== wanted) {
    return { kind: "wrong_kind", requestKind: found.request.kind } as const;
  }
  const recorded = found.request.decision;
  if (recorded) {
    if (sameDecision(recorded, decision)) {
      return { kind: "repeated", run: found.run } as const;
    }
    return {
      kind: "already_decided",
      decision: resumedAs[recorded.decision],
    } as const;
  }
  if (found.run.status !== "waiting") return { kind: "closed" } as const;
  tx.update(runRequests)
    .set({ decision, decidedAt: new Date().toISOString() })
    .where(eq(runRequests.id, decision.requestId))
    .run();
  const run = tx
    .update(runs)
    .set({ status: "running" })
    .where(eq(runs.id, found.run.id))
    .returning()
    .get();
  tx.update(agents)
    .set({ status: "running" })
    .where(eq(agents.id, agentId))
    .run();
  const { enqueued } = recordEvent(tx, run.id, "run.resumed", {
    requestId: decision.requestId,
    decision: resumedAs[decision.decision],
  });
  return { kind: "decided", run, enqueued } as const;
}

/**
 * Closes the run's open request `requestId` as withdrawn and moves the run and agent from `waiting`
 * back to `running`, recording `run.withdrawn`. A request that is unknown, already decided or not
 * the open one changes nothing (`noop`): a decision that landed first stands.
 */
export function withdrawRequest(
  tx: Tx,
  run: typeof runs.$inferSelect,
  requestId: RequestId,
  reason: WithdrawalReason,
) {
  const open = openRequestOf(tx, run.id);
  if (open?.request.requestId !== requestId) return { kind: "noop" } as const;
  tx.update(runRequests)
    .set({
      decision: { requestId, decision: "withdrawn", reason },
      decidedAt: new Date().toISOString(),
    })
    .where(eq(runRequests.id, requestId))
    .run();
  if (run.status === "waiting") {
    tx.update(runs).set({ status: "running" }).where(eq(runs.id, run.id)).run();
    tx.update(agents)
      .set({ status: "running" })
      .where(eq(agents.id, run.agentId))
      .run();
  }
  const { id, enqueued } = recordEvent(tx, run.id, "run.withdrawn", {
    requestId,
    reason,
  });
  return { kind: "withdrawn", id, enqueued } as const;
}
