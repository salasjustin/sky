import { z } from "zod";
import { AgentId, RunId } from "./ids.js";

export const RunStatus = z.enum([
  "queued",
  "starting",
  "running",
  "waiting",
  "finished",
  "failed",
  "stopped",
]);
export type RunStatus = z.infer<typeof RunStatus>;

/**
 * Every legal run status change; `finished`, `failed` and `stopped` are terminal. A `queued` run is a
 * launch held while the API drains: it becomes `starting` when released.
 */
export const runTransitions = {
  queued: ["starting", "failed", "stopped"],
  starting: ["running", "failed", "stopped"],
  running: ["waiting", "finished", "failed", "stopped"],
  waiting: ["running", "failed", "stopped"],
  finished: [],
  failed: [],
  stopped: [],
} as const satisfies Record<RunStatus, readonly RunStatus[]>;

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return (runTransitions[from] as readonly RunStatus[]).includes(to);
}

export const Usage = z.object({
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  costUsd: z.number().nonnegative(),
  turns: z.int().nonnegative(),
  durationMs: z.int().nonnegative(),
});
export type Usage = z.infer<typeof Usage>;

export const Run = z.object({
  id: RunId,
  agentId: AgentId,
  status: RunStatus,
  summary: z.string().nullable(),
  usage: Usage.nullable(),
});
export type Run = z.infer<typeof Run>;
