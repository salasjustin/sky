import { z } from "zod";
import { AgentId, EnvironmentId, EventId, RequestId, RunId } from "./ids.js";
import { Usage } from "./run.js";

const pendingRequest = (toolSummary: z.ZodString) =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("question"),
      requestId: RequestId,
      prompt: z.string().min(1),
    }),
    z.object({
      kind: z.literal("approval"),
      requestId: RequestId,
      toolName: z.string().min(1),
      toolSummary,
    }),
  ]);

/** What a run is blocked on: a question from Claude, or a tool call the environment's approval policy holds. */
export const PendingRequest = pendingRequest(z.string().min(1));
export type PendingRequest = z.infer<typeof PendingRequest>;

/** Where an event read resumes: `evt_<n>` as events carry it, or the bare row id SSE frames carry. */
export const EventCursor = z.string().regex(/^(?:evt_)?\d{1,15}$/);

export const Decision = z.discriminatedUnion("decision", [
  z.object({
    requestId: RequestId,
    decision: z.literal("approve"),
    reason: z.string().optional(),
  }),
  z.object({
    requestId: RequestId,
    decision: z.literal("deny"),
    reason: z.string().optional(),
  }),
  z.object({
    requestId: RequestId,
    decision: z.literal("answer"),
    answer: z.string().min(1),
  }),
]);
export type Decision = z.infer<typeof Decision>;

export const EventType = z.enum([
  "run.started",
  "run.waiting",
  "run.resumed",
  "run.finished",
  "run.failed",
  "run.stopped",
  "run.probed",
  "runner.warning",
  "runner.heartbeat",
  "claude.PreToolUse",
  "claude.PostToolUse",
  "claude.PostToolUseFailure",
  "claude.SubagentStart",
  "claude.SubagentStop",
  "claude.TaskCreated",
  "claude.TaskCompleted",
  "claude.Notification",
  "claude.PreCompact",
  "claude.FileChanged",
  "claude.Message",
]);
export type EventType = z.infer<typeof EventType>;

/** SHA-1 or SHA-256 object name. */
const GitSha = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);

/** A diffstat and the commits behind it; `commits` is newest first, capped at 50. */
export const Rollup = z.object({
  commits: z
    .array(
      z.object({
        sha: GitSha,
        subject: z.string().max(200),
      }),
    )
    .max(50),
  /** binary files count here with 0 lines added and removed */
  files: z.number().int().nonnegative(),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
});
export type Rollup = z.infer<typeof Rollup>;

/** What the agent branch holds at run end: `run` since the run started, `cumulative` since `base`, its merge-base with `origin/HEAD`. */
export const RunRollup = z.object({
  base: GitSha,
  run: Rollup,
  cumulative: Rollup,
});
export type RunRollup = z.infer<typeof RunRollup>;

const runPayloads = {
  /** `sessionId` is the Claude session the API stores to resume the agent's next run. */
  "run.started": z.object({ sessionId: z.string().min(1) }),
  "run.waiting": z.object({ request: PendingRequest }),
  "run.finished": z.object({
    summary: z.string(),
    usage: Usage,
    rollup: RunRollup.optional(),
  }),
  "run.failed": z.object({
    error: z.string().min(1),
    usage: Usage.optional(),
    rollup: RunRollup.optional(),
  }),
  "run.stopped": z.object({}),
};

/** Most a runner may send in one text field; the API redacts the full text before trimming it. */
export const RUNNER_TEXT_MAX = 65_536;
/** Most the API stores of one text field after redaction, before the truncation marker. */
export const EVENT_TEXT_MAX = 4_096;
/** Appended by the API to a text field it trimmed to `EVENT_TEXT_MAX`. */
export const truncationMarker = (omitted: number) =>
  `\n…[truncated ${omitted} chars]`;

/**
 * Claude Code hook inputs (Agent SDK `<Name>HookInput`), camelCased, minus per-session plumbing;
 * `claude.Message` is assistant text from the message stream.
 * `subagentId` is the SDK's `agent_id` — `agentId` is the sky agent on the envelope.
 */
const claudePayloads = (textMax: number) => {
  const text = z.string().max(textMax);
  const tool = {
    toolName: z.string().min(1),
    toolUseId: z.string().min(1),
    /** the tool input as JSON text */
    input: text,
    /** set when a subagent made the call */
    subagentId: z.string().min(1).optional(),
  };
  const task = {
    taskId: z.string().min(1),
    taskSubject: text,
    taskDescription: text.optional(),
    teammateName: z.string().min(1).optional(),
  };
  const durationMs = z.number().nonnegative().optional();
  return {
    "claude.PreToolUse": z.object(tool),
    "claude.PostToolUse": z.object({ ...tool, output: text, durationMs }),
    "claude.PostToolUseFailure": z.object({
      ...tool,
      error: text,
      isInterrupt: z.boolean().optional(),
      durationMs,
    }),
    "claude.SubagentStart": z.object({
      subagentId: z.string().min(1),
      agentType: z.string().min(1),
    }),
    "claude.SubagentStop": z.object({
      subagentId: z.string().min(1),
      agentType: z.string().min(1),
      lastAssistantMessage: text.optional(),
    }),
    "claude.TaskCreated": z.object(task),
    "claude.TaskCompleted": z.object(task),
    "claude.Notification": z.object({
      message: text,
      title: text.optional(),
      notificationType: z.string().min(1),
    }),
    "claude.PreCompact": z.object({
      trigger: z.enum(["manual", "auto"]),
      customInstructions: text.nullable(),
    }),
    "claude.FileChanged": z.object({
      filePath: text,
      event: z.enum(["change", "add", "unlink"]),
    }),
    "claude.Message": z.object({
      text,
      /** set when a subagent wrote it: the Agent tool call that spawned the subagent */
      parentToolUseId: z.string().min(1).optional(),
    }),
  };
};

/** Recorded by the API when a request is decided; the decision's answer or reason stays out. */
const resumedPayload = z.object({
  requestId: RequestId,
  decision: z.enum(["answered", "approved", "denied"]),
});

/**
 * Recorded by the API when its sweep woke a silent run's sprite and found the runner alive:
 * the sprite probed and how long the run had been silent.
 */
const probedPayload = z.object({
  spriteName: z.string().min(1),
  silentMs: z.number().int().nonnegative(),
});

/** How often the runner posts a `runner.heartbeat` while a tool call is in flight. */
export const HEARTBEAT_INTERVAL_MS = 60_000;

const runnerPayloads = (textMax: number) => ({
  /** A problem the runner hit that doesn't end the run, e.g. a sprite hold that failed. */
  "runner.warning": z.object({ message: z.string().min(1).max(textMax) }),
  /** A tool call still running: the longest-running one in flight, and how long it has run. */
  "runner.heartbeat": z.object({
    // bounded on both sides: a heartbeat is not trimmed like claude.* text, and one is stored every minute
    toolName: z.string().min(1).max(256),
    toolUseId: z.string().min(1).max(256),
    elapsedMs: z.number().int().nonnegative(),
  }),
});

const postPayloads = {
  ...runPayloads,
  "run.waiting": z.object({
    request: pendingRequest(z.string().min(1).max(RUNNER_TEXT_MAX)),
  }),
  ...runnerPayloads(RUNNER_TEXT_MAX),
  ...claudePayloads(RUNNER_TEXT_MAX),
} satisfies Record<Exclude<EventType, "run.resumed" | "run.probed">, z.ZodType>;

/** the extra 64 admits `truncationMarker` after a trimmed field */
const storedPayloads = {
  ...runPayloads,
  "run.resumed": resumedPayload,
  "run.probed": probedPayload,
  ...runnerPayloads(EVENT_TEXT_MAX + 64),
  ...claudePayloads(EVENT_TEXT_MAX + 64),
} satisfies Record<EventType, z.ZodType>;

const posted = <T extends keyof typeof postPayloads>(type: T) =>
  z.strictObject({
    runId: RunId,
    type: z.literal(type),
    payload: postPayloads[type],
  });

/** Body of the runner's `POST /internal/events`; the API assigns `id` and `ts`. */
export const RunnerEventPost = z.discriminatedUnion("type", [
  posted("run.started"),
  posted("run.waiting"),
  posted("run.finished"),
  posted("run.failed"),
  posted("run.stopped"),
  posted("runner.warning"),
  posted("runner.heartbeat"),
  posted("claude.PreToolUse"),
  posted("claude.PostToolUse"),
  posted("claude.PostToolUseFailure"),
  posted("claude.SubagentStart"),
  posted("claude.SubagentStop"),
  posted("claude.TaskCreated"),
  posted("claude.TaskCompleted"),
  posted("claude.Notification"),
  posted("claude.PreCompact"),
  posted("claude.FileChanged"),
  posted("claude.Message"),
]);
export type RunnerEventPost = z.infer<typeof RunnerEventPost>;

const stored = <T extends EventType>(type: T) =>
  z.object({
    id: EventId,
    agentId: AgentId,
    /** the environment the agent belongs to */
    environmentId: EnvironmentId,
    runId: RunId,
    ts: z.iso.datetime(),
    type: z.literal(type),
    payload: storedPayloads[type],
  });

export const Event = z.discriminatedUnion("type", [
  stored("run.started"),
  stored("run.waiting"),
  stored("run.resumed"),
  stored("run.finished"),
  stored("run.failed"),
  stored("run.stopped"),
  stored("run.probed"),
  stored("runner.warning"),
  stored("runner.heartbeat"),
  stored("claude.PreToolUse"),
  stored("claude.PostToolUse"),
  stored("claude.PostToolUseFailure"),
  stored("claude.SubagentStart"),
  stored("claude.SubagentStop"),
  stored("claude.TaskCreated"),
  stored("claude.TaskCompleted"),
  stored("claude.Notification"),
  stored("claude.PreCompact"),
  stored("claude.FileChanged"),
  stored("claude.Message"),
]);
export type Event = z.infer<typeof Event>;
