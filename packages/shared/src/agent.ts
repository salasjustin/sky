import { z } from "zod";
import { AgentId, EnvironmentId } from "./ids.js";

export const AgentStatus = z.enum(["idle", "running", "waiting"]);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const agentBranch = <Id extends AgentId>(agentId: Id) =>
  `claude/${agentId}` as const;

const UNSAFE_IN_BRANCH =
  /[\s\p{Cc}~^:?*[\\]|\.\.|@\{|\/\/|^[-/]|[/.]$|(?:^|\/)\.|\.lock(?:\/|$)|^@$|^HEAD$|^refs\//u;

/**
 * A branch name `git check-ref-format --branch` accepts, narrowed to one the API can start an agent
 * on: at most 255 characters, no Unicode whitespace, and never `@`, `HEAD` or a full `refs/` ref.
 */
export const BranchName = z
  .string()
  .min(1)
  .max(255)
  .refine((name) => !UNSAFE_IN_BRANCH.test(name), {
    message:
      "expected a git branch name: no whitespace, control characters, ~ ^ : ? * [ \\, '..', '@{' or '//'; not starting with '-', '/' or 'refs/'; not ending with '/' or '.'; no '/'-separated part starting with '.' or ending in '.lock'; not '@' or 'HEAD'",
  });
export type BranchName = z.infer<typeof BranchName>;

export const Agent = z
  .object({
    id: AgentId,
    envId: EnvironmentId,
    /** Claude session id; null until the agent's first run starts a session. */
    sessionId: z.string().min(1).nullable(),
    branch: z.templateLiteral(["claude/", AgentId]),
    /** The existing GitHub branch this agent works on and publishes to; null when it publishes its own `branch`. */
    remoteBranch: BranchName.nullable(),
    status: AgentStatus,
    /** When the agent was archived; an archived agent takes no more runs. */
    archivedAt: z.iso.datetime().nullable(),
  })
  .refine((agent) => agent.branch === agentBranch(agent.id), {
    path: ["branch"],
    message: "branch must be claude/<agentId>",
  });
export type Agent = z.infer<typeof Agent>;
