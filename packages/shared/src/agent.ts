import { z } from "zod";
import { AgentId, EnvironmentId } from "./ids.js";

export const AgentStatus = z.enum(["idle", "running", "waiting"]);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const agentBranch = <Id extends AgentId>(agentId: Id) =>
  `claude/${agentId}` as const;

const UNSAFE_IN_BRANCH =
  /[\s\p{Cc}~^:?*[\\]|\.\.|@\{|\/\/|^[-/]|[/.]$|\.lock$|^@$|^refs\//u;

/** A branch name git accepts and that names a branch, never a full ref. */
export const BranchName = z
  .string()
  .min(1)
  .max(255)
  .refine((name) => !UNSAFE_IN_BRANCH.test(name), {
    message:
      "expected a git branch name: no whitespace, control characters, ~ ^ : ? * [ \\, '..', '@{' or '//'; not starting with '-', '/' or 'refs/'; not ending with '/', '.' or '.lock'; not '@'",
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
