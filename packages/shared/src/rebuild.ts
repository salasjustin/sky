import { z } from "zod";
import { AgentId } from "./ids.js";

/**
 * Set on an environment whose sprite stopped answering (HTTP 5xx such as 503 "Storage not ready", or
 * unreachable), cleared by the next call that gets through. `status` is the provisioning status and
 * is untouched: this says the sprite behind a `ready` environment may not be working.
 */
export const EnvironmentHealth = z.object({
  status: z.literal("unreachable"),
  /** The last error a call to the sprite failed with, redacted. */
  error: z.string(),
  /** When that error was recorded. */
  at: z.iso.datetime(),
  /** What to do about it, in words. */
  message: z.string(),
});
export type EnvironmentHealth = z.infer<typeof EnvironmentHealth>;

/** The body of `POST /v1/environments/:id/rebuild`. */
export const RebuildInput = z.strictObject({
  /** Rebuild even when an agent's work exists only on the sprite. */
  force: z.boolean().default(false),
});
export type RebuildInput = z.infer<typeof RebuildInput>;

/**
 * One agent whose work exists only on the sprite, and what of it is at risk: `uncommitted` files
 * (null when the sprite couldn't be asked), `unpublishedCommits` not on the GitHub branch the agent
 * publishes to, and whether that branch was never published at all.
 */
export const UnpublishedAgent = z.object({
  agentId: AgentId,
  /** The GitHub branch the agent publishes to. */
  branch: z.string(),
  uncommitted: z.int().nonnegative().nullable(),
  unpublishedCommits: z.int().nonnegative(),
  neverPublished: z.boolean(),
});
export type UnpublishedAgent = z.infer<typeof UnpublishedAgent>;

/** Where the check for unpublished work looked: the agents' worktrees, or what the API recorded of their runs. */
export const RebuildCheckSource = z.enum(["sprite", "records"]);
export type RebuildCheckSource = z.infer<typeof RebuildCheckSource>;

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** One agent's line in the refusal and in what the CLI lists: its id, its branch and what is at risk. */
export function describeUnpublished(agent: UnpublishedAgent): string {
  const parts: string[] = [];
  if (agent.uncommitted) {
    parts.push(plural(agent.uncommitted, "uncommitted file"));
  }
  if (agent.unpublishedCommits > 0) {
    parts.push(
      agent.neverPublished
        ? `${plural(agent.unpublishedCommits, "commit")} on a branch never published`
        : `${plural(agent.unpublishedCommits, "commit")} not on GitHub`,
    );
  }
  if (agent.uncommitted === null) parts.push("uncommitted changes unknown");
  return `${agent.agentId} (${agent.branch}): ${parts.join(", ")}`;
}
