import { z } from "zod";
import { AgentId, EnvironmentId, EventId, RequestId, RunId } from "./ids.js";
import { Usage } from "./run.js";

/** Most of an approval's full tool input the API stores, before the truncation marker: 64 KiB. */
export const TOOL_INPUT_MAX = 65_536;

/**
 * Most of an approval's tool input a runner may post: past `TOOL_INPUT_MAX` by `REDACTION_MARGIN`
 * in apps/api/src/redact.ts (8 KiB), so the API redacts before it cuts and adds the truncation
 * marker, and a secret straddling the cut is never stored half-redacted.
 */
export const TOOL_INPUT_POST_MAX = TOOL_INPUT_MAX + 8_192;

const pendingRequest = (toolSummary: z.ZodString, toolInput: z.ZodString) =>
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
      /** The tool call's whole input as JSON text, where `toolSummary` is bounded for events and webhooks; stored on the request, never on its events. */
      toolInput: toolInput.optional(),
    }),
  ]);

/** What a run is blocked on: a question from Claude, or a tool call the environment's approval policy holds. */
export const PendingRequest = pendingRequest(
  z.string().min(1),
  // the extra 64 admits the truncation marker after a trimmed input
  z.string().max(TOOL_INPUT_MAX + 64),
);
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

/** Why a request was withdrawn: the runner's `hook_cancelled`, `session_ending`, `run_stopping` and `run_ending`, and the API's `run_finished`. */
export const WithdrawalReason = z.enum([
  "hook_cancelled",
  "session_ending",
  "run_stopping",
  "run_ending",
  "run_finished",
]);
export type WithdrawalReason = z.infer<typeof WithdrawalReason>;

/**
 * Stored in place of a decision when a request closed before anyone answered it, because the
 * runner stopped waiting or the run finished; a later answer is refused.
 */
export const Withdrawal = z.object({
  requestId: RequestId,
  decision: z.literal("withdrawn"),
  reason: WithdrawalReason,
});
export type Withdrawal = z.infer<typeof Withdrawal>;

/** What a request row records as its outcome: a person's decision, or a withdrawal. */
export type StoredDecision = Decision | Withdrawal;

export const EventType = z.enum([
  "run.started",
  "run.waiting",
  "run.resumed",
  "run.withdrawn",
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
  "claude.TaskNotification",
  "claude.BackgroundTasksChanged",
  "claude.Notification",
  "claude.PreCompact",
  "claude.FileChanged",
  "claude.Message",
]);
export type EventType = z.infer<typeof EventType>;

/**
 * Why a Bash call ran with no approval request although the environment's policy holds Bash,
 * carried by that call's `claude.PreToolUse`: `approved` is the auto-approve list's own verdict
 * (the command is on the list), `broker` the agent's `publish` or `sync`, which the runner's own
 * approval stands for. Absent on every other call, and from an older runner; a client that doesn't
 * know it ignores it.
 */
export const AutoApproved = z.object({
  verdict: z.enum(["approved", "broker"]),
  reason: z.string().min(1).max(300),
});
export type AutoApproved = z.infer<typeof AutoApproved>;

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

/** A plugin at one version; `marketplace` is null when the runner couldn't tell where it came from. */
export const PluginVersion = z.object({
  name: z.string().min(1).max(100),
  marketplace: z.string().max(100).nullable(),
  version: z.string().min(1).max(100),
});
export type PluginVersion = z.infer<typeof PluginVersion>;

/** One `claude` command of the refresh and how long it ran, in ms; one that was cut counts until it was stopped or given up on. */
export const PluginRefreshStep = z.object({
  name: z.string().min(1).max(100),
  ms: z.number().int().nonnegative(),
});
export type PluginRefreshStep = z.infer<typeof PluginRefreshStep>;

/** How the start-of-run plugin refresh ended. */
export const PluginRefreshOutcome = z.enum([
  "refreshed",
  "timed_out",
  "failed",
  "skipped",
]);
export type PluginRefreshOutcome = z.infer<typeof PluginRefreshOutcome>;

/**
 * A record from before `outcome` was a code carried the reason in it (`failed: <reason>`,
 * `skipped: <reason>`); split it so the old record reads as a new one. Anything else is left alone.
 */
function splitLegacyOutcome(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || !("outcome" in raw))
    return raw;
  const match =
    typeof raw.outcome === "string"
      ? /^(failed|skipped|timed_out|refreshed)(?:: ([\s\S]*))?$/.exec(
          raw.outcome,
        )
      : null;
  if (!match?.[2]) return raw;
  return { ...raw, outcome: match[1], reason: match[2] };
}

/**
 * What the start-of-run plugin refresh did, as the run records it. `outcome` is a code: `refreshed`,
 * `timed_out`, `failed` or `skipped`; `reason` says why for a `failed` or `skipped` one, and for a
 * `timed_out` one names the updates, if any, that had failed or been cut and stopped before the
 * budget ran out. `before` and `after` are the user-scope plugins either side of the refresh, per
 * `claude plugin list`, each cut to its first 100. Either is null when the refresh never read that
 * list (a skip before any listing, or a refresh cut short before the read), and `[]` when it read the
 * list and found no plugins, so null means "not read", not "none". A record from before the codes has its `<code>: <reason>` outcome split into the
 * two, and keeps its lists as arrays, where `[]` can also be a list it never read. `loaded` is what the session's own init reports it loaded, from any scope, which is what
 * counts when `plugin update` and the session disagree. `steps` is where the time went, one entry per
 * command in order, at most 50; it is absent from a record made before it existed, and from one that
 * ran no command.
 */
export const PluginRefresh = z.preprocess(
  splitLegacyOutcome,
  z.object({
    outcome: PluginRefreshOutcome,
    reason: z.string().min(1).max(300).optional(),
    durationMs: z.number().int().nonnegative(),
    before: z.array(PluginVersion).max(100).nullable(),
    after: z.array(PluginVersion).max(100).nullable(),
    steps: z.array(PluginRefreshStep).max(50).optional(),
    loaded: z.array(PluginVersion).max(100),
  }),
);
export type PluginRefresh = z.infer<typeof PluginRefresh>;

const runPayloads = {
  /**
   * `sessionId` is the Claude session the API stores to resume the agent's next run. `plugins` is the
   * run's plugin record; absent from an older runner, and from a start whose record the API couldn't
   * read.
   */
  "run.started": z.object({
    sessionId: z.string().min(1),
    plugins: PluginRefresh.optional(),
  }),
  "run.waiting": z.object({ request: PendingRequest }),
  /** `requestId` closed before anyone answered it (`reason`: why); the run goes back to `running`, or finishes on `run_finished`. */
  "run.withdrawn": z.object({
    requestId: RequestId,
    reason: WithdrawalReason,
  }),
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

/** Most tasks one `claude.BackgroundTasksChanged` lists; the runner sends the first ones when there are more. */
export const BACKGROUND_TASKS_MAX = 50;

/**
 * Claude Code hook inputs (Agent SDK `<Name>HookInput`), camelCased, minus per-session plumbing;
 * `claude.Message`, `claude.TaskNotification` and `claude.BackgroundTasksChanged` come from the message stream.
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
    "claude.PreToolUse": z.object({
      ...tool,
      /** set when the call ran unasked under a policy that holds Bash */
      autoApproved: AutoApproved.optional(),
    }),
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
    /** a background task (a shell, a monitor, a subagent) ended; `taskType` is the type the runner last saw listed for it, absent when it never was; the task itself may be in no posted `claude.BackgroundTasksChanged`, whose list is capped */
    "claude.TaskNotification": z.object({
      taskId: z.string().min(1).max(256),
      taskType: z.string().min(1).max(256).optional(),
      status: z.enum(["completed", "failed", "stopped"]),
      summary: text,
      reason: z.string().min(1).max(256).optional(),
      ambient: z.boolean().optional(),
    }),
    /** the background tasks running after a change, at most `BACKGROUND_TASKS_MAX` of them; `ambient` ones (watchers) don't wake a turn */
    "claude.BackgroundTasksChanged": z.object({
      tasks: z
        .array(
          z.object({
            taskId: z.string().min(1).max(256),
            taskType: z.string().min(1).max(256),
            ambient: z.boolean(),
          }),
        )
        .max(BACKGROUND_TASKS_MAX),
    }),
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
    request: pendingRequest(
      z.string().min(1).max(RUNNER_TEXT_MAX),
      z.string().max(TOOL_INPUT_POST_MAX),
    ),
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
  posted("run.withdrawn"),
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
  posted("claude.TaskNotification"),
  posted("claude.BackgroundTasksChanged"),
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
  stored("run.withdrawn"),
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
  stored("claude.TaskNotification"),
  stored("claude.BackgroundTasksChanged"),
  stored("claude.Notification"),
  stored("claude.PreCompact"),
  stored("claude.FileChanged"),
  stored("claude.Message"),
]);
export type Event = z.infer<typeof Event>;
