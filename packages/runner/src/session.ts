import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type {
  CanUseTool,
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  HookInput,
  Options,
  PermissionResult,
  PreToolUseHookInput,
  SDKMessage,
  SDKResultMessage,
  SyncHookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
import type { AskUserQuestionInput } from "@anthropic-ai/claude-agent-sdk/sdk-tools";
import {
  type Decision,
  type PendingRequest,
  type RequestId,
  RUNNER_TEXT_MAX,
  type RunnerEventPost,
  type RunRollup,
  type Usage,
} from "@sky/shared";
import type { Config } from "./config.js";
import { type PostEvent, RunEndedError } from "./events.js";
import { policyOutcome } from "./policy.js";
import { CONNECTOR_ENV, PUBLISH_USAGE } from "./publish.js";
import type { AwaitDecision } from "./requests.js";
import { commitAll, diffRollup, ensureWorktree, headSha } from "./worktree.js";

/** The Agent SDK's `query`, narrowed to what the runner calls; tests feed it scripted streams. */
export type QueryFn = (params: {
  prompt: string;
  options: Options;
}) => AsyncIterable<SDKMessage>;

/**
 * Seconds before the SDK cancels a PreToolUse hook, and with it the approval gate (its default is
 * 600). `waitTimeoutMs` bounds each wait, but this clock also runs while a call queues behind
 * other waits, so it covers ten waits, and a day at least; kept far below a Node timer's
 * 2^31-1 ms, past which a timer fires at once.
 */
const gateTimeoutS = (waitTimeoutMs: number) =>
  Math.max(86_400, Math.ceil((10 * waitTimeoutMs) / 1000));
/**
 * Who the session's own commits are by; in the env, so a commit never needs `git config`. An
 * author set in the environment (`GIT_AUTHOR_NAME` and `GIT_AUTHOR_EMAIL`, as environment secrets)
 * is used instead, its committer defaulting to the same; Claude only when they aren't both set.
 */
export function sessionGitIdentity(env: NodeJS.ProcessEnv) {
  const name = env.GIT_AUTHOR_NAME;
  const email = env.GIT_AUTHOR_EMAIL;
  if (!name || !email) {
    return {
      GIT_AUTHOR_NAME: "Claude",
      GIT_AUTHOR_EMAIL: "noreply@anthropic.com",
      GIT_COMMITTER_NAME: "Claude",
      GIT_COMMITTER_EMAIL: "noreply@anthropic.com",
    };
  }
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: env.GIT_COMMITTER_NAME || name,
    GIT_COMMITTER_EMAIL: env.GIT_COMMITTER_EMAIL || email,
  };
}

/**
 * Config the session's git commands take from the env, which outranks every config file. A
 * worktree's `.git` is a file inside the worktree, so a write there can repoint it at a gitdir
 * whose config runs a command on a plain `git status`; this pins that key off.
 */
const SESSION_GIT_CONFIG: [key: string, value: string][] = [
  ["core.fsmonitor", "false"],
];

/** Appends `pairs` after the `GIT_CONFIG_KEY_n`/`VALUE_n` pairs `env` already holds, so those stay. */
function withGitConfig(
  env: NodeJS.ProcessEnv,
  pairs: [key: string, value: string][],
): NodeJS.ProcessEnv {
  const held = Number(env.GIT_CONFIG_COUNT);
  // git refuses a count that isn't a whole number, so no pair under one was ever in effect
  const start = Number.isSafeInteger(held) && held > 0 ? held : 0;
  const added: NodeJS.ProcessEnv = {
    GIT_CONFIG_COUNT: String(start + pairs.length),
  };
  for (const [i, [key, value]] of pairs.entries()) {
    added[`GIT_CONFIG_KEY_${start + i}`] = key;
    added[`GIT_CONFIG_VALUE_${start + i}`] = value;
  }
  return { ...env, ...added };
}

type RunnerEvent = Omit<RunnerEventPost, "runId">;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** Every Agent SDK option a run passes is assembled here. */
function sessionOptions(
  config: Config,
  cwd: string,
  abortController: AbortController,
  hooks: Options["hooks"],
  canUseTool: CanUseTool,
): Options {
  // `env` replaces the subprocess env rather than adding to it, so it carries the project's own
  // secrets (an ANTHROPIC_API_KEY among them) to the session's commands; the event token stays with
  // the runner
  const { AGENT_TOKEN: _, ...env } = process.env;
  return {
    cwd,
    resume: config.sessionId,
    abortController,
    env: withGitConfig(
      { ...env, ...sessionGitIdentity(env), ...config.sessionEnv },
      SESSION_GIT_CONFIG,
    ),
    // Claude Code's own commit trailer and pull request footer are off, for hosting that rejects them
    settings: { attribution: { commit: "", pr: "" } },
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: [
        ...(env[CONNECTOR_ENV] ? [publishInstructions()] : []),
        ...(config.checks.length > 0 ? [checkInstructions(config.checks)] : []),
      ].join("\n\n"),
    },
    // the approval policy holds calls in the PreToolUse hook; everything else runs unasked
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    hooks,
    // reached only by what bypassPermissions can't approve, AskUserQuestion among them
    canUseTool,
  };
}

/**
 * The sprite holds no GitHub credential, so `git push` and `gh` fail there; the runner's own
 * `publish` reaches GitHub through the Sprites connector instead.
 */
const publishInstructions = () =>
  [
    "This sandbox has no GitHub credential, so `git push` and `gh` fail here.",
    "To publish your branch and open a pull request, commit your work, then run",
    `\`${process.execPath} ${process.argv[1]} ${PUBLISH_USAGE}\``,
    "instead of `git push` or `gh pr create`. It sends the branch's commits to GitHub, opens a pull request into the base branch (or finds the open one), and prints its URL. Run it again after more commits to update the same pull request.",
    "`--branch <name>` publishes to a GitHub branch of that name instead of your worktree's branch, and the pull request's head is that branch; pass the same name each time. Commits go out under the git author configured for this environment, with every `Co-authored-by` trailer removed.",
    "Once commits are published, add new commits rather than amending or rebasing them: a rewritten branch can't be published again.",
    "Pass a multi-line body from a quoted heredoc, `--body \"$(cat <<'EOF'` … `EOF` `)\"`, so the shell leaves its backticks and `$` alone. A large branch can take minutes to send, so give the Bash call a 10-minute timeout.",
  ].join("\n");

/**
 * The env's base profile lists what to run before finishing. A command that calls `claude` runs as
 * a nested headless session, which the runner has logged in with the subscription; an API key must
 * stay out of it. The session env carries the project's ANTHROPIC_API_KEY, which a nested `claude`
 * would use over the login, so the prompt has it unset whatever the profile wrote.
 */
const checkInstructions = (checks: string[]) =>
  [
    "Before you finish, run these checks on your change, in order, from the repo root. Plugin skills can't be invoked through the Skill tool, so run any `claude -p` command through Bash:",
    ...checks.map((check) => `- ${check}`),
    "Run each command that calls `claude` with ANTHROPIC_API_KEY unset, as `env -u ANTHROPIC_API_KEY claude -p …`, even where the check leaves that prefix out.",
    "A nested `claude` session is already logged in with the sandbox's subscription. Never set or use an API key for it, and never print or read credential files or tokens. Give each call a 10-minute timeout, fix what the checks find, and report the checks' output if one can't run.",
  ].join("\n");

/**
 * Hooks forward what Claude is doing without holding it up: the event is queued
 * behind earlier posts and the hook answers `continue` at once, whatever the post does.
 * The one exception is `gate`, which holds a PreToolUse call until it has a decision.
 */
function sessionHooks(
  gateTimeout: number,
  on: {
    event: (event: RunnerEvent) => void;
    stop: (lastMessage: string | undefined) => void;
    gate: (
      input: PreToolUseHookInput,
      signal: AbortSignal,
    ) => Promise<SyncHookJSONOutput>;
  },
): Options["hooks"] {
  const matcher = <E extends HookEvent>(
    handle: (
      input: Extract<HookInput, { hook_event_name: E }>,
      signal: AbortSignal,
    ) => undefined | Promise<SyncHookJSONOutput>,
    timeout?: number,
  ): HookCallbackMatcher[] => {
    const hook: HookCallback = async (input, _toolUseId, { signal }) =>
      (await handle(
        input as Extract<HookInput, { hook_event_name: E }>,
        signal,
      )) ?? { continue: true };
    return [{ hooks: [hook], ...(timeout && { timeout }) }];
  };
  const tool = (input: {
    tool_name: string;
    tool_use_id: string;
    tool_input: unknown;
    agent_id?: string;
  }) => ({
    toolName: input.tool_name,
    toolUseId: input.tool_use_id,
    input: bound(JSON.stringify(input.tool_input) ?? ""),
    ...(input.agent_id && { subagentId: input.agent_id }),
  });
  const task = (input: {
    task_id: string;
    task_subject: string;
    task_description?: string;
    teammate_name?: string;
  }) => ({
    taskId: input.task_id,
    taskSubject: bound(input.task_subject),
    ...(input.task_description !== undefined && {
      taskDescription: bound(input.task_description),
    }),
    ...(input.teammate_name && { teammateName: input.teammate_name }),
  });
  return {
    PreToolUse: matcher<"PreToolUse">((input, signal) => {
      on.event({ type: "claude.PreToolUse", payload: tool(input) });
      return on.gate(input, signal);
    }, gateTimeout),
    PostToolUse: matcher<"PostToolUse">((input) => {
      const response = input.tool_response;
      on.event({
        type: "claude.PostToolUse",
        payload: {
          ...tool(input),
          output: bound(
            typeof response === "string"
              ? response
              : (JSON.stringify(response) ?? ""),
          ),
          ...(input.duration_ms !== undefined && {
            durationMs: input.duration_ms,
          }),
        },
      });
    }),
    PostToolUseFailure: matcher<"PostToolUseFailure">((input) => {
      on.event({
        type: "claude.PostToolUseFailure",
        payload: {
          ...tool(input),
          error: bound(input.error),
          ...(input.is_interrupt !== undefined && {
            isInterrupt: input.is_interrupt,
          }),
          ...(input.duration_ms !== undefined && {
            durationMs: input.duration_ms,
          }),
        },
      });
    }),
    SubagentStart: matcher<"SubagentStart">((input) => {
      on.event({
        type: "claude.SubagentStart",
        payload: { subagentId: input.agent_id, agentType: input.agent_type },
      });
    }),
    SubagentStop: matcher<"SubagentStop">((input) => {
      on.event({
        type: "claude.SubagentStop",
        payload: {
          subagentId: input.agent_id,
          agentType: input.agent_type,
          ...(input.last_assistant_message !== undefined && {
            lastAssistantMessage: bound(input.last_assistant_message),
          }),
        },
      });
    }),
    TaskCreated: matcher<"TaskCreated">((input) => {
      on.event({ type: "claude.TaskCreated", payload: task(input) });
    }),
    TaskCompleted: matcher<"TaskCompleted">((input) => {
      on.event({ type: "claude.TaskCompleted", payload: task(input) });
    }),
    Notification: matcher<"Notification">((input) => {
      on.event({
        type: "claude.Notification",
        payload: {
          message: bound(input.message),
          ...(input.title !== undefined && { title: bound(input.title) }),
          notificationType: input.notification_type,
        },
      });
    }),
    PreCompact: matcher<"PreCompact">((input) => {
      on.event({
        type: "claude.PreCompact",
        payload: {
          trigger: input.trigger,
          customInstructions:
            input.custom_instructions === null
              ? null
              : bound(input.custom_instructions),
        },
      });
    }),
    // fires only for paths a hook's matcher or `watchPaths` asks Claude Code to watch, which
    // this session names none of; Claude's own edits report through PostToolUse
    FileChanged: matcher<"FileChanged">((input) => {
      on.event({
        type: "claude.FileChanged",
        payload: { filePath: bound(input.file_path), event: input.event },
      });
    }),
    Stop: matcher<"Stop">((input) => {
      on.stop(input.last_assistant_message);
    }),
  };
}

/** Runs one Claude session for the run and reports it; resolves to the process exit code. */
export async function runSession(
  config: Config,
  deps: {
    query: QueryFn;
    post: PostEvent;
    awaitDecision: AwaitDecision;
    signal: AbortSignal;
    warn?: (line: string) => void;
  },
): Promise<0 | 1> {
  const { runId } = config;
  const warn = deps.warn ?? warnStderr;
  // one queue keeps the API's order the order things happened, hooks included
  let queue = Promise.resolve();
  const post = (event: RunnerEvent, options?: Parameters<PostEvent>[1]) => {
    const posted = queue.then(() =>
      deps.post({ runId, ...event } as RunnerEventPost, options),
    );
    queue = posted.catch(() => {});
    return posted;
  };
  let ended = false;
  const end = async (event: RunnerEvent) => {
    if (ended) return;
    ended = true;
    await post(event);
  };
  const fail = async (error: string, usage?: Usage, rollup?: RunRollup) => {
    await end({
      type: "run.failed",
      payload: { error, ...(usage && { usage }), ...(rollup && { rollup }) },
    });
    return 1 as const;
  };

  let cwd: string;
  try {
    cwd = await ensureWorktree(config);
  } catch (error) {
    return fail(`worktree setup failed: ${messageOf(error)}`);
  }
  // what HEAD holds before Claude touches the worktree; the run's commits are the ones after it
  const runStart = await headSha(cwd).catch((error: unknown) =>
    error instanceof Error ? error : new Error(String(error)),
  );

  const abortController = new AbortController();
  const forward = () => abortController.abort(deps.signal.reason);
  deps.signal.addEventListener("abort", forward, { once: true });
  // a stop during worktree setup aborted the signal before the listener existed
  if (deps.signal.aborted) forward();

  // why the runner itself aborted the session; it outranks the stream error or result that follows
  let stopReason: string | undefined;
  const stopSession = (reason: string) => {
    stopReason ??= reason;
    abortController.abort(reason);
  };

  // the API keeps one open request per run, so parallel tool calls take turns
  let turn = Promise.resolve();
  const decide = (
    request: DistributiveOmit<PendingRequest, "requestId">,
    signal: AbortSignal,
  ) => {
    const decided = turn.then(() => waitForDecision(request, signal));
    turn = decided.then(
      () => {},
      () => {},
    );
    return decided;
  };
  /**
   * The person's decision, or undefined when there is none: the SDK cancelled the wait, the session
   * is being torn down, or the API gave something short of a decision (a request it never stored,
   * an API unreachable until the deadline, a wait that expired), which stops the session and fails
   * the run.
   */
  const waitForDecision = async (
    request: DistributiveOmit<PendingRequest, "requestId">,
    signal: AbortSignal,
  ): Promise<Decision | undefined> => {
    if (abortController.signal.aborted || signal.aborted) return undefined;
    const requestId: RequestId = `req_${randomUUID().replaceAll("-", "")}`;
    // one budget for opening the request and polling it
    const deadline = Date.now() + config.waitTimeoutMs;
    const stop = AbortSignal.any([abortController.signal, signal]);
    const runEnded = () => {
      // the API already recorded how the run ended
      ended = true;
      stopSession("run ended while waiting");
      return undefined;
    };
    try {
      await post(
        {
          type: "run.waiting",
          payload: { request: { ...request, requestId } },
        },
        { deadline, signal: stop },
      );
      const outcome = await deps.awaitDecision(requestId, stop, deadline);
      switch (outcome.kind) {
        case "decided":
          return outcome.decision;
        case "run_ended":
          return runEnded();
        case "lost":
          stopSession(`request ${requestId} was never recorded`);
          return undefined;
        case "expired":
          stopSession("waiting_timeout");
          return undefined;
      }
    } catch (error) {
      if (error instanceof RunEndedError) return runEnded();
      if (!stop.aborted) stopSession(messageOf(error));
      return undefined;
    }
  };

  /** Why a held call can't go ahead: the run is ending, which is not the person's answer. */
  const endingReason = () =>
    `The run is ending: ${stopReason ?? "it was stopped"}.`;
  /** The SDK cancelled this one hook or permission prompt; the session goes on. */
  const WAIT_CANCELLED = "The approval wait was cancelled.";
  const denyCall = (reason: string) => ({
    hookEventName: "PreToolUse" as const,
    permissionDecision: "deny" as const,
    permissionDecisionReason: reason,
  });

  const gate = async (
    input: PreToolUseHookInput,
    signal: AbortSignal,
  ): Promise<SyncHookJSONOutput> => {
    const outcome = policyOutcome(
      config.approvalPolicy,
      config.autoApprove,
      // the hook's cwd is the shell's, which an earlier `cd` may have moved off the worktree
      { root: cwd, cwd: input.cwd, realpath: realpathSync.native },
      input.tool_name,
      input.tool_input,
    );
    if (outcome === "auto-approved")
      warn(
        `runner: auto-approved ${input.tool_name} call ${input.tool_use_id} without an approval request`,
      );
    if (outcome !== "hold") return { continue: true };
    const decision = await decide(
      {
        kind: "approval",
        toolName: input.tool_name,
        toolSummary: bound(
          toolHint(input.tool_input) ??
            (JSON.stringify(input.tool_input) || input.tool_name),
        ),
      },
      signal,
    );
    // approve adds nothing: an explicit allow would also skip canUseTool, which answers AskUserQuestion
    if (decision?.decision === "approve") return { continue: true };
    if (decision === undefined) {
      if (!abortController.signal.aborted)
        return { continue: true, hookSpecificOutput: denyCall(WAIT_CANCELLED) };
      // a stop, not a denial; the deny is still needed: Claude Code runs the tool on `continue: false` alone, then stops
      const reason = endingReason();
      return {
        continue: false,
        stopReason: reason,
        hookSpecificOutput: denyCall(reason),
      };
    }
    return {
      continue: true,
      hookSpecificOutput: denyCall(
        (decision.decision === "deny" && decision.reason) ||
          "The user denied this tool call.",
      ),
    };
  };

  const canUseTool: CanUseTool = async (toolName, input, { signal }) => {
    if (toolName !== "AskUserQuestion")
      return { behavior: "allow", updatedInput: input };
    return askPerson(input as unknown as AskUserQuestionInput, signal);
  };
  const askPerson = async (
    input: AskUserQuestionInput,
    signal: AbortSignal,
  ): Promise<PermissionResult> => {
    const decision = await decide(
      { kind: "question", prompt: questionPrompt(input) },
      signal,
    );
    if (decision === undefined)
      return abortController.signal.aborted
        ? { behavior: "deny", interrupt: true, message: endingReason() }
        : { behavior: "deny", message: WAIT_CANCELLED };
    if (decision.decision !== "answer")
      return {
        behavior: "deny",
        message:
          (decision.decision === "deny" && decision.reason) ||
          "The user declined to answer.",
      };
    // one answer covers every question: the person replies once, in their own words
    const answers = Object.fromEntries(
      input.questions.map((q) => [q.question, decision.answer]),
    );
    return {
      behavior: "allow",
      updatedInput: { questions: input.questions, answers },
    };
  };

  let result: SDKResultMessage | undefined;
  let streamError: string | undefined;
  let started = false;
  let stopMessage: string | undefined;
  // Claude's activity stops retrying once the session stops, so the ending event isn't queued behind
  // its backoff; each event still gets its one attempt
  const progress = { giveUp: abortController.signal };
  const hooks = sessionHooks(gateTimeoutS(config.waitTimeoutMs), {
    // a failed post must not fail the tool call that triggered it
    event: (event) => void post(event, progress).catch(() => {}),
    stop: (lastMessage) => {
      stopMessage = lastMessage || stopMessage;
    },
    gate,
  });
  try {
    const stream = deps.query({
      prompt: config.prompt,
      options: sessionOptions(config, cwd, abortController, hooks, canUseTool),
    });
    for await (const message of stream) {
      if (message.type === "system" && message.subtype === "init" && !started) {
        started = true;
        await post({
          type: "run.started",
          payload: { sessionId: message.session_id },
        });
      } else if (message.type === "assistant") {
        const parent = message.parent_tool_use_id;
        // queued, not awaited: the post waits behind every hook event already queued, and a slow API must not hold the loop
        for (const text of textOf(message.message.content))
          void post(
            {
              type: "claude.Message",
              payload: { text, ...(parent && { parentToolUseId: parent }) },
            },
            progress,
          ).catch(() => {});
      } else if (message.type === "result") {
        result = message;
      }
    }
  } catch (error) {
    streamError = deps.signal.aborted
      ? `interrupted by ${String(deps.signal.reason)}`
      : messageOf(error);
  } finally {
    deps.signal.removeEventListener("abort", forward);
  }

  let commitError: string | undefined;
  try {
    await commitAll({ cwd, agentId: config.agentId, runId });
  } catch (error) {
    commitError = `commit failed: ${messageOf(error)}`;
  }

  // a run the API already ended posts nothing, so it needs no rollup
  const rollup = ended ? undefined : await rollupOf(cwd, runStart);
  const usage = result && usageOf(result);
  const failure = stopReason ?? streamError;
  if (failure) return fail(failure, usage, rollup);
  if (!result) return fail("session ended without a result", undefined, rollup);
  if (result.subtype !== "success" || result.is_error) {
    const reason =
      ("errors" in result && result.errors.join("; ")) || result.subtype;
    return fail(reason, usage, rollup);
  }
  if (commitError) return fail(commitError, usage, rollup);
  await end({
    type: "run.finished",
    payload: {
      summary: result.result || stopMessage || "",
      usage: usageOf(result),
      ...(rollup && { rollup }),
    },
  });
  return 0;

  /** The rollup is a nice-to-have on the result: when git can't produce it, the run reports without it. */
  async function rollupOf(cwd: string, since: string | Error) {
    try {
      if (since instanceof Error) throw since;
      return await diffRollup({ cwd, since });
    } catch (error) {
      warn(`runner: rollup skipped: ${messageOf(error)}`);
      return undefined;
    }
  }
}

const warnStderr = (line: string) => process.stderr.write(`${line}\n`);

type AssistantContent = Extract<
  SDKMessage,
  { type: "assistant" }
>["message"]["content"];

/** Assistant text, one entry per text block; tool calls report through the PreToolUse hook instead. */
function textOf(content: AssistantContent): string[] {
  return content.flatMap((block) =>
    block.type === "text" && block.text.trim()
      ? [bound(block.text.trim())]
      : [],
  );
}

/** What an approver judges: the command itself, not Claude's description of it. */
const SUBJECT_KEYS = [
  "command",
  "file_path",
  "notebook_path",
  "url",
  "pattern",
  "query",
];

/** The one input field that says what a built-in tool call is acting on. */
function toolHint(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  for (const key of SUBJECT_KEYS) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

/** Claude's questions as one prompt for the person: each question with its options beneath. */
function questionPrompt(input: AskUserQuestionInput): string {
  return input.questions
    .map((q) =>
      [
        q.question,
        ...q.options.map((o) => `- ${o.label}: ${o.description}`),
      ].join("\n"),
    )
    .join("\n\n");
}

function usageOf(result: SDKResultMessage): Usage {
  let inputTokens = 0;
  let outputTokens = 0;
  // modelUsage covers subagents and compaction too; `usage` is the main loop only
  for (const m of Object.values(result.modelUsage)) {
    inputTokens +=
      m.inputTokens + m.cacheReadInputTokens + m.cacheCreationInputTokens;
    outputTokens += m.outputTokens;
  }
  return {
    inputTokens,
    outputTokens,
    costUsd: result.total_cost_usd,
    turns: result.num_turns,
    durationMs: Math.round(result.duration_ms),
  };
}

/** A plain cut at what the API accepts: it redacts the whole text, so nothing here may clip it shorter. */
const bound = (s: string) => s.slice(0, RUNNER_TEXT_MAX);

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
