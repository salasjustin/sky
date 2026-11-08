import { expect, test } from "vitest";
import {
  Decision,
  EVENT_TEXT_MAX,
  Event,
  EventCursor,
  EventType,
  PendingRequest,
  Rollup,
  RUNNER_TEXT_MAX,
  RunnerEventPost,
  truncationMarker,
} from "./event.js";

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  costUsd: 0.001,
  turns: 1,
  durationMs: 900,
};
const meta = {
  id: "evt_1",
  agentId: "agt_1",
  environmentId: "env_1",
  runId: "run_1",
  ts: "2026-10-29T12:00:00.000Z",
};

test("event types cover the run lifecycle and no longer include run.progress", () => {
  expect(EventType.options).toEqual(
    expect.arrayContaining([
      "run.started",
      "run.waiting",
      "run.finished",
      "run.failed",
    ]),
  );
  expect(EventType.options).not.toContain("run.progress");
  expect(
    RunnerEventPost.safeParse({
      runId: "run_1",
      type: "run.progress",
      payload: { message: "editing" },
    }).success,
  ).toBe(false);
});

test("run.started carries the Claude session id", () => {
  const post = {
    runId: "run_1",
    type: "run.started",
    payload: { sessionId: "sess-1" },
  };
  expect(RunnerEventPost.parse(post)).toEqual(post);
  expect(RunnerEventPost.safeParse({ ...post, payload: {} }).success).toBe(
    false,
  );
});

test("accepts run.finished carrying summary and usage", () => {
  const event = {
    ...meta,
    type: "run.finished",
    payload: { summary: "done", usage },
  };
  expect(Event.parse(event)).toEqual(event);
});

test("rejects run.finished without usage", () => {
  expect(
    Event.safeParse({
      ...meta,
      type: "run.finished",
      payload: { summary: "done" },
    }).success,
  ).toBe(false);
});

test("accepts a waiting event", () => {
  const request = {
    kind: "question",
    requestId: "req_1",
    prompt: "Which branch?",
  };
  expect(
    Event.parse({ ...meta, type: "run.waiting", payload: { request } }).payload,
  ).toEqual({ request });
});

test("rejects an unknown type and a non-ISO timestamp", () => {
  expect(
    Event.safeParse({ ...meta, type: "run.exploded", payload: {} }).success,
  ).toBe(false);
  expect(
    Event.safeParse({
      ...meta,
      ts: "yesterday",
      type: "run.started",
      payload: { sessionId: "sess-1" },
    }).success,
  ).toBe(false);
});

test("pending request is a question with a prompt or an approval with a tool summary", () => {
  expect(
    PendingRequest.parse({
      kind: "question",
      requestId: "req_1",
      prompt: "Which db?",
    }).kind,
  ).toBe("question");
  const approval = {
    kind: "approval",
    requestId: "req_2",
    toolName: "Bash",
    toolSummary: "rm -rf dist",
  };
  expect(PendingRequest.parse(approval)).toEqual(approval);
  expect(
    PendingRequest.safeParse({
      kind: "approval",
      requestId: "req_2",
      prompt: "ok?",
    }).success,
  ).toBe(false);
});

test("decision approves, denies or answers a request", () => {
  expect(
    Decision.parse({ requestId: "req_1", decision: "approve" }).decision,
  ).toBe("approve");
  expect(
    Decision.parse({ requestId: "req_1", decision: "approve", reason: "ok" }),
  ).toEqual({ requestId: "req_1", decision: "approve", reason: "ok" });
  expect(
    Decision.parse({ requestId: "req_1", decision: "deny", reason: "no" })
      .decision,
  ).toBe("deny");
  expect(
    Decision.parse({
      requestId: "req_1",
      decision: "answer",
      answer: "postgres",
    }).decision,
  ).toBe("answer");
  expect(
    Decision.safeParse({ requestId: "req_1", decision: "answer" }).success,
  ).toBe(false);
  expect(
    Decision.safeParse({ requestId: "req_1", decision: "maybe" }).success,
  ).toBe(false);
});

test("runner posts an event without id or timestamp; the API assigns those", () => {
  const post = {
    runId: "run_1",
    type: "run.failed",
    payload: { error: "exit 1" },
  };
  expect(RunnerEventPost.parse(post)).toEqual(post);
  expect(RunnerEventPost.safeParse({ ...post, id: "evt_9" }).success).toBe(
    false,
  );
  expect(
    RunnerEventPost.safeParse({
      runId: "run_1",
      type: "run.failed",
      payload: {},
    }).success,
  ).toBe(false);
});

test("runner.warning is posted by the runner with a message; run.probed is the API's own and can't be posted", () => {
  const warning = {
    runId: "run_1",
    type: "runner.warning",
    payload: { message: "runner: sprite task PUT failed: HTTP 503" },
  };
  expect(RunnerEventPost.parse(warning)).toEqual(warning);
  expect(RunnerEventPost.safeParse({ ...warning, payload: {} }).success).toBe(
    false,
  );
  expect(
    RunnerEventPost.safeParse({
      runId: "run_1",
      type: "run.probed",
      payload: { spriteName: "s", silentMs: 1 },
    }).success,
  ).toBe(false);

  const probed = {
    ...meta,
    type: "run.probed",
    payload: { spriteName: "sky-env-1", silentMs: 300_000 },
  };
  expect(Event.parse(probed)).toEqual(probed);
  expect(Event.safeParse({ ...probed, payload: {} }).success).toBe(false);
  expect(Event.parse({ ...meta, ...warning, runId: "run_1" })).toMatchObject({
    type: "runner.warning",
  });
});

test("runner.heartbeat names the tool call in flight and how long it has run", () => {
  const heartbeat = {
    runId: "run_1",
    type: "runner.heartbeat",
    payload: { toolName: "Bash", toolUseId: "toolu_1", elapsedMs: 61_000 },
  };
  expect(RunnerEventPost.parse(heartbeat)).toEqual(heartbeat);
  expect(Event.parse({ ...meta, ...heartbeat })).toMatchObject({
    type: "runner.heartbeat",
  });
  for (const payload of [
    { toolName: "Bash", toolUseId: "toolu_1" },
    { toolName: "", toolUseId: "toolu_1", elapsedMs: 1 },
    { toolName: "Bash", toolUseId: "toolu_1", elapsedMs: -1 },
    { toolName: "x".repeat(257), toolUseId: "toolu_1", elapsedMs: 1 },
    { toolName: "Bash", toolUseId: "x".repeat(257), elapsedMs: 1 },
  ]) {
    expect(RunnerEventPost.safeParse({ ...heartbeat, payload }).success).toBe(
      false,
    );
  }
});

const sha = (c: string) => c.repeat(40);
const rollup = {
  base: sha("a"),
  run: {
    commits: [{ sha: sha("c"), subject: "add hello" }],
    files: 1,
    added: 3,
    removed: 0,
  },
  cumulative: {
    commits: [
      { sha: sha("c"), subject: "add hello" },
      { sha: sha("b"), subject: "" },
    ],
    files: 2,
    added: 5,
    removed: 1,
  },
};

test("run.finished and run.failed may carry the diff rollup; it stays optional", () => {
  const finished = {
    runId: "run_1",
    type: "run.finished",
    payload: { summary: "done", usage, rollup },
  };
  const failed = {
    runId: "run_1",
    type: "run.failed",
    payload: { error: "exit 1", rollup },
  };
  expect(RunnerEventPost.parse(finished)).toEqual(finished);
  expect(RunnerEventPost.parse(failed)).toEqual(failed);
  expect(Event.parse({ ...meta, ...finished })).toEqual({
    ...meta,
    ...finished,
  });
});

test("a rollup caps its commit list at 50 and each subject at 200 characters", () => {
  const commits = Array.from({ length: 51 }, () => ({
    sha: sha("c"),
    subject: "x",
  }));
  expect(Rollup.safeParse({ ...rollup.run, commits }).success).toBe(false);
  expect(
    Rollup.safeParse({
      ...rollup.run,
      commits: [{ sha: sha("c"), subject: "x".repeat(201) }],
    }).success,
  ).toBe(false);
  expect(
    Rollup.safeParse({
      ...rollup.run,
      commits: [{ sha: "HEAD", subject: "x" }],
    }).success,
  ).toBe(false);
  expect(Rollup.safeParse({ ...rollup.run, added: -1 }).success).toBe(false);
});

test("a stored event names its agent, so a run.waiting can be answered from the event alone", () => {
  const waiting = {
    ...meta,
    type: "run.waiting",
    payload: {
      request: { kind: "question", requestId: "req_1", prompt: "which db?" },
    },
  };
  expect(Event.parse(waiting)).toEqual(waiting);
  const { agentId: _, ...anonymous } = waiting;
  expect(Event.safeParse(anonymous).success).toBe(false);
  const { environmentId: __, ...unplaced } = waiting;
  expect(Event.safeParse(unplaced).success).toBe(false);
});

const claudeTypes = [
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
];

test("event types include Claude Code's hook events and its messages as claude.*", () => {
  expect(EventType.options).toEqual(expect.arrayContaining(claudeTypes));
});

const claudePosts = [
  {
    type: "claude.PreToolUse",
    payload: {
      toolName: "Bash",
      toolUseId: "toolu_01",
      input: '{"command":"pnpm test"}',
    },
  },
  {
    type: "claude.PostToolUse",
    payload: {
      toolName: "Read",
      toolUseId: "toolu_02",
      input: '{"file_path":"src/a.ts"}',
      output: "export const a = 1;",
      durationMs: 12,
      subagentId: "sub_1",
    },
  },
  {
    type: "claude.PostToolUseFailure",
    payload: {
      toolName: "Bash",
      toolUseId: "toolu_03",
      input: '{"command":"false"}',
      error: "exit 1",
      isInterrupt: false,
    },
  },
  {
    type: "claude.SubagentStart",
    payload: { subagentId: "sub_1", agentType: "Explore" },
  },
  {
    type: "claude.SubagentStop",
    payload: {
      subagentId: "sub_1",
      agentType: "Explore",
      lastAssistantMessage: "found it in src/a.ts",
    },
  },
  {
    type: "claude.TaskCreated",
    payload: { taskId: "1", taskSubject: "add tests" },
  },
  {
    type: "claude.TaskCompleted",
    payload: {
      taskId: "1",
      taskSubject: "add tests",
      taskDescription: "cover the parser",
    },
  },
  {
    type: "claude.Notification",
    payload: {
      message: "Claude needs your permission to use Bash",
      notificationType: "permission_prompt",
    },
  },
  {
    type: "claude.PreCompact",
    payload: { trigger: "auto", customInstructions: null },
  },
  {
    type: "claude.FileChanged",
    payload: { filePath: "src/a.ts", event: "change" },
  },
  { type: "claude.Message", payload: { text: "Running the tests now." } },
];

test("every claude.* type has a realistic payload the runner can post and the API can store", () => {
  expect(claudePosts.map((p) => p.type).sort()).toEqual(
    [...claudeTypes].sort(),
  );
  for (const post of claudePosts) {
    const body = { runId: "run_1", ...post };
    expect(RunnerEventPost.parse(body)).toEqual(body);
    expect(Event.parse({ ...meta, ...post })).toEqual({ ...meta, ...post });
  }
});

test("a subagent is named by subagentId, never agentId, which is the sky agent", () => {
  const post = {
    runId: "run_1",
    type: "claude.SubagentStart",
    payload: { agentId: "sub_1", agentType: "Explore" },
  };
  expect(RunnerEventPost.safeParse(post).success).toBe(false);
});

test("a runner text field over RUNNER_TEXT_MAX is rejected", () => {
  const post = (output: string) => ({
    runId: "run_1",
    type: "claude.PostToolUse",
    payload: { toolName: "Bash", toolUseId: "toolu_1", input: "{}", output },
  });
  expect(
    RunnerEventPost.safeParse(post("x".repeat(RUNNER_TEXT_MAX))).success,
  ).toBe(true);
  expect(
    RunnerEventPost.safeParse(post("x".repeat(RUNNER_TEXT_MAX + 1))).success,
  ).toBe(false);
});

test("a stored text field admits EVENT_TEXT_MAX plus the truncation marker, and no more", () => {
  const event = (text: string) => ({
    ...meta,
    type: "claude.Message",
    payload: { text },
  });
  const trimmed = "x".repeat(EVENT_TEXT_MAX) + truncationMarker(60_000);
  expect(truncationMarker(60_000)).toBe("\n…[truncated 60000 chars]");
  expect(Event.safeParse(event(trimmed)).success).toBe(true);
  expect(Event.safeParse(event("x".repeat(EVENT_TEXT_MAX + 65))).success).toBe(
    false,
  );
});

test("run.resumed is a stored event the runner can't post", () => {
  const payload = { requestId: "req_1", decision: "approved" };
  expect(
    Event.parse({ ...meta, type: "run.resumed", payload }).payload,
  ).toEqual(payload);
  expect(
    Event.safeParse({
      ...meta,
      type: "run.resumed",
      payload: { ...payload, decision: "maybe" },
    }).success,
  ).toBe(false);
  expect(
    RunnerEventPost.safeParse({ runId: "run_1", type: "run.resumed", payload })
      .success,
  ).toBe(false);
});

test("an event cursor is an event id or its bare row number, nothing else", () => {
  expect(EventCursor.safeParse("evt_12").success).toBe(true);
  expect(EventCursor.safeParse("12").success).toBe(true);
  expect(EventCursor.safeParse("evt_1&x=2").success).toBe(false);
  expect(EventCursor.safeParse("evt_").success).toBe(false);
});

test("claude.Message carries the subagent's parentToolUseId, and parses without it", () => {
  const message = (payload: object) => ({ type: "claude.Message", payload });
  const sub = message({ text: "Found it.", parentToolUseId: "toolu_1" });
  expect(RunnerEventPost.parse({ runId: "run_1", ...sub })).toEqual({
    runId: "run_1",
    ...sub,
  });
  expect(Event.parse({ ...meta, ...sub })).toEqual({ ...meta, ...sub });
  expect(
    RunnerEventPost.safeParse({
      runId: "run_1",
      ...message({ text: "x", parentToolUseId: "" }),
    }).success,
  ).toBe(false);
});

test("a posted approval's toolSummary is bounded at RUNNER_TEXT_MAX", () => {
  const waiting = (toolSummary: string) => ({
    runId: "run_1",
    type: "run.waiting",
    payload: {
      request: {
        kind: "approval",
        requestId: "req_1",
        toolName: "Bash",
        toolSummary,
      },
    },
  });
  expect(RunnerEventPost.safeParse(waiting("x".repeat(5000))).success).toBe(
    true,
  );
  expect(
    RunnerEventPost.safeParse(waiting("x".repeat(RUNNER_TEXT_MAX + 1))).success,
  ).toBe(false);
});
