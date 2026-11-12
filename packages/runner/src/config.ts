import {
  AgentId,
  type AutoApprove,
  AutoApproveConfig,
  BaseProfileMcpServer,
  RunId,
} from "@sky/shared";
import { z } from "zod";
import { PolicyPattern } from "./policy.js";

const json = z.string().transform((s, ctx) => {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    ctx.issues.push({ code: "custom", message: "expected JSON", input: s });
    return z.NEVER;
  }
});

const Env = z.object({
  AGENT_ID: AgentId,
  RUN_ID: RunId,
  PROMPT: z.string().min(1),
  SESSION_ID: z
    .string()
    .optional()
    .transform((s) => s || undefined),
  API_BASE_URL: z.url(),
  AGENT_TOKEN: z.string().min(1),
  // which credential the Claude session uses, and its value, which only the Claude subprocess reads,
  // so it never enters Config: the subscription token for `oauth`, `SKY_CLAUDE_API_KEY` for `api-key`
  SKY_CLAUDE_AUTH: z.enum(["oauth", "api-key"]).default("oauth"),
  CLAUDE_CODE_OAUTH_TOKEN: z.string().min(1).optional(),
  SKY_CLAUDE_API_KEY: z.string().min(1).optional(),
  REPO_DIR: z.string().min(1).default("/workspace/repo"),
  WORKTREES_DIR: z.string().min(1).default("/workspace/worktrees"),
  APPROVAL_POLICY: json.pipe(z.array(PolicyPattern)).default([]),
  AUTO_APPROVE: json.pipe(AutoApproveConfig).default({
    defaults: true,
    commands: [],
  }),
  WAIT_TIMEOUT_MINUTES: z.coerce.number().positive().default(120),
  // the env's base profile: variables for the session, and the lines it is told to follow before finishing
  SKY_SESSION_ENV: json.pipe(z.record(z.string(), z.string())).default({}),
  SKY_CHECKS: json.pipe(z.array(z.string().min(1))).default([]),
  SKY_MCP_SERVERS: json
    .pipe(z.record(z.string(), BaseProfileMcpServer))
    .default({}),
  START_BRANCH: z
    .string()
    .optional()
    .transform((s) => s || undefined),
});

/** The variable holding the credential the run's `SKY_CLAUDE_AUTH` names; a run without it can't start a session. */
const credentialVariable = (env: NodeJS.ProcessEnv) =>
  env.SKY_CLAUDE_AUTH === "api-key"
    ? "SKY_CLAUDE_API_KEY"
    : "CLAUDE_CODE_OAUTH_TOKEN";

export type Config = {
  agentId: AgentId;
  runId: RunId;
  prompt: string;
  sessionId: string | undefined;
  apiBaseUrl: string;
  agentToken: string;
  /** The credential the session authenticates with; its value is read from the env by `claudeProcessEnv`. */
  claudeAuth: "oauth" | "api-key";
  repoDir: string;
  worktreesDir: string;
  /** Tool-call patterns that wait for a person's approval; see `matchesPolicy`. */
  approvalPolicy: string[];
  /** Read-only Bash commands that skip `approvalPolicy`; see `isAutoApproved`. */
  autoApprove: AutoApprove;
  /** Variables set in the session on top of the runner's own env. */
  sessionEnv: Record<string, string>;
  /** Instruction lines or commands the agent is told to run before it finishes; none when empty. */
  checks: string[];
  /** The base profile's MCP servers, secrets as names; passed to every session whatever the sprite's config holds. */
  mcpServers: Record<string, BaseProfileMcpServer>;
  /** How long one wait for an answer or approval may last before the run fails. */
  waitTimeoutMs: number;
  /** An existing GitHub branch the agent's work continues; `publish` updates it instead of `claude/<agentId>`. */
  startBranch: string | undefined;
};

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = Env.safeParse(env);
  const credential = credentialVariable(env);
  if (!parsed.success || !env[credential]) {
    // keys only: issue messages can quote the received value, and two of these are secrets
    const keys = [
      ...new Set([
        ...(parsed.success
          ? []
          : parsed.error.issues.map((i) => String(i.path[0]))),
        ...(env[credential] ? [] : [credential]),
      ]),
    ];
    throw new ConfigError(`missing or invalid env: ${keys.join(", ")}`);
  }
  const e = parsed.data;
  return {
    agentId: e.AGENT_ID,
    runId: e.RUN_ID,
    prompt: e.PROMPT,
    sessionId: e.SESSION_ID,
    apiBaseUrl: e.API_BASE_URL,
    agentToken: e.AGENT_TOKEN,
    claudeAuth: e.SKY_CLAUDE_AUTH,
    repoDir: e.REPO_DIR,
    worktreesDir: e.WORKTREES_DIR,
    approvalPolicy: e.APPROVAL_POLICY,
    autoApprove: e.AUTO_APPROVE,
    sessionEnv: e.SKY_SESSION_ENV,
    checks: e.SKY_CHECKS,
    mcpServers: e.SKY_MCP_SERVERS,
    waitTimeoutMs: e.WAIT_TIMEOUT_MINUTES * 60_000,
    startBranch: e.START_BRANCH,
  };
}
