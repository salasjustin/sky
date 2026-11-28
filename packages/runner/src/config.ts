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

/** A Codex plugin id, `<plugin>@<marketplace>`: written into Codex's config as a TOML key, so it holds nothing that could quote out of one. */
const CODEX_PLUGIN_ID =
  /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A pi skill directory: absolute, or `~/…` or `$HOME/…` under the run's home, so it can't read as one of pi's flags, with no control characters. */
const PI_SKILL_DIR = /^(?:\/|~\/|\$HOME\/)[^\p{Cc}]*$/u;

const Env = z
  .object({
    AGENT_ID: AgentId,
    RUN_ID: RunId,
    PROMPT: z.string().min(1),
    SESSION_ID: z
      .string()
      .optional()
      .transform((s) => s || undefined),
    API_BASE_URL: z.url(),
    AGENT_TOKEN: z.string().min(1),
    // which agent drives the session: Claude Code through the Agent SDK, Codex through its app server
    // (`codex.ts`), or pi through its RPC mode (`pi.ts`); the last two reach their model through the
    // Vercel AI Gateway rather than a Claude credential
    SKY_RUNTIME: z.enum(["claude-code", "codex", "pi"]).default("claude-code"),
    // the pi session's model, as the AI Gateway names it; `DEFAULT_PI_MODEL` when unset
    SKY_PI_MODEL: z
      .string()
      .optional()
      .transform((s) => s || undefined),
    // the directories of `SKILL.md` skills a pi run loads, separated by commas: absolute, or `~/` or
    // `$HOME/` for the run's home. The environment's setup installs them. Checked on pi runs only (below)
    SKY_PI_SKILLS: z
      .string()
      .optional()
      .transform((s) =>
        (s ?? "")
          .split(",")
          .map((dir) => dir.trim())
          .filter(Boolean),
      ),
    // the Codex session's model, as the AI Gateway names it; `DEFAULT_CODEX_MODEL` when unset
    SKY_CODEX_MODEL: z
      .string()
      .optional()
      .transform((s) => s || undefined),
    // the Codex plugins a run turns on, as `<plugin>@<marketplace>` separated by commas; the environment's
    // setup installs them under the run's Codex home. Their hooks run without Codex's per-hook trust
    SKY_CODEX_PLUGINS: z
      .string()
      .optional()
      .transform((s) =>
        (s ?? "")
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.string().regex(CODEX_PLUGIN_ID))),
    // the environment's `refresh` script, run before the session (`refresh.ts`); absent when it has none
    SKY_REFRESH: z
      .string()
      .optional()
      .transform((s) => s || undefined),
    // how long that script may run, in seconds; an env secret may set it, and what isn't a positive number is ignored
    SKY_REFRESH_TIMEOUT_SECONDS: z
      .string()
      .optional()
      .transform((s) => {
        const seconds = Number(s);
        return s && Number.isFinite(seconds) && seconds > 0
          ? seconds
          : undefined;
      }),
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
    // what is left of the launch's deadline when the API starts the runner; the API fails a run that hasn't
    // reported by then, so worktree setup's wait for the repo lock ends inside it
    LAUNCH_DEADLINE_MINUTES: z.coerce.number().positive().default(15),
    // the env's base profile: variables for the session, and the lines it is told to follow before finishing
    SKY_SESSION_ENV: json.pipe(z.record(z.string(), z.string())).default({}),
    SKY_CHECKS: json.pipe(z.array(z.string().min(1))).default([]),
    SKY_MCP_SERVERS: json
      .pipe(z.record(z.string(), BaseProfileMcpServer))
      .default({}),
    // the store checkout's directory below $HOME; the API sets it with the base profile's store, so it is absent without one
    SKY_STORE_HOME: z
      .string()
      .optional()
      .transform((s) => s || undefined),
    START_BRANCH: z
      .string()
      .optional()
      .transform((s) => s || undefined),
  })
  .superRefine((e, ctx) => {
    // a bad entry stops pi runs only: the value means nothing to Claude Code or Codex
    if (
      e.SKY_RUNTIME === "pi" &&
      e.SKY_PI_SKILLS.some((d) => !PI_SKILL_DIR.test(d))
    )
      ctx.addIssue({
        code: "custom",
        path: ["SKY_PI_SKILLS"],
        message: "expected absolute, ~/ or $HOME/ paths",
      });
  });

/**
 * The variable holding the credential the run's session can't start without: for Claude Code, the one
 * `SKY_CLAUDE_AUTH` names; for Codex and pi, the AI Gateway key, which only the run's gateway proxy reads.
 */
const credentialVariable = (env: NodeJS.ProcessEnv) =>
  env.SKY_RUNTIME === "codex" || env.SKY_RUNTIME === "pi"
    ? CODEX_KEY_ENV
    : env.SKY_CLAUDE_AUTH === "api-key"
      ? "SKY_CLAUDE_API_KEY"
      : "CLAUDE_CODE_OAUTH_TOKEN";

/** The AI Gateway key a Codex or pi run's model calls carry; `main` takes it out of the env for the run's gateway proxy alone. */
export const CODEX_KEY_ENV = "AI_GATEWAY_API_KEY";

export type Config = {
  /**
   * `codex` when `SKY_RUNTIME=codex`, which runs through `runCodexSession`, or `pi` when it is `pi`
   * (`runPiSession`); absent for Claude Code, so a Claude Code run's config holds no runtime field at all.
   */
  runtime?: "codex" | "pi";
  /** The pi session's model, from `SKY_PI_MODEL`; set only on a pi run that names one. */
  piModel?: string;
  /** The skill directories a pi run loads, from `SKY_PI_SKILLS`; set only on a pi run that names some. */
  piSkills?: string[];
  /** The Codex session's model, from `SKY_CODEX_MODEL`; set only on a Codex run that names one. */
  codexModel?: string;
  /** The Codex plugins the run turns on, from `SKY_CODEX_PLUGINS`; set only on a Codex run that names some. */
  codexPlugins?: string[];
  /** The environment's refresh script, from `SKY_REFRESH`; set only when the env has one. */
  refresh?: string;
  /** What `SKY_REFRESH_TIMEOUT_SECONDS` asks the refresh's budget to be, in ms; `refresh.ts` bounds it. */
  refreshTimeoutMs?: number;
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
  /**
   * The time the launch has left, counted from this process's start, before the API fails the run
   * as `launch_timeout`; the wait for the repo lock ends early enough inside it to report its own failure.
   */
  launchDeadlineMs: number;
  /** The store checkout's directory below the session's home, from `SKY_STORE_HOME`; none without a base profile's store. */
  storeHome?: string | undefined;
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
    ...(e.SKY_RUNTIME === "codex" && {
      runtime: e.SKY_RUNTIME,
      ...(e.SKY_CODEX_MODEL && { codexModel: e.SKY_CODEX_MODEL }),
      ...(e.SKY_CODEX_PLUGINS.length > 0 && {
        codexPlugins: e.SKY_CODEX_PLUGINS,
      }),
    }),
    ...(e.SKY_RUNTIME === "pi" && {
      runtime: e.SKY_RUNTIME,
      ...(e.SKY_PI_MODEL && { piModel: e.SKY_PI_MODEL }),
      ...(e.SKY_PI_SKILLS.length > 0 && { piSkills: e.SKY_PI_SKILLS }),
    }),
    ...(e.SKY_REFRESH && { refresh: e.SKY_REFRESH }),
    ...(e.SKY_REFRESH_TIMEOUT_SECONDS !== undefined && {
      refreshTimeoutMs: e.SKY_REFRESH_TIMEOUT_SECONDS * 1000,
    }),
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
    launchDeadlineMs: e.LAUNCH_DEADLINE_MINUTES * 60_000,
    storeHome: e.SKY_STORE_HOME,
    startBranch: e.START_BRANCH,
  };
}
