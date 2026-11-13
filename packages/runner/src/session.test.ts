import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import type {
  HookEvent,
  HookInput,
  Options,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { RUNNER_TEXT_MAX, type RunnerEventPost } from "@sky/shared";
import { delay, HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { server } from "../../../test/msw.js";
import {
  credentialDir,
  PROJECT_VARIABLES,
  prepareNestedLogin,
} from "./claude-auth.js";
import type { Config } from "./config.js";
import { createPoster } from "./events.js";
import { createDecisionWaiter } from "./requests.js";
import {
  nestedClaude,
  type QueryFn,
  sessionGitIdentity,
} from "./session.js";
import { defaultSettingsDirs, settingsRedirects } from "./settings-guard.js";
import { hermeticRunSession as runSession } from "./testing/hermetic-run.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let root: string;
let config: Config;

beforeEach(() => {
  // a sandbox host exports its own connector, which would send every run here through a refresh
  vi.stubEnv("GITHUB_CONNECTOR", undefined);
  root = mkdtempSync(join(tmpdir(), "runner-session-"));
  const origin = join(root, "origin");
  execFileSync("git", ["init", "-q", "-b", "main", origin]);
  writeFileSync(join(origin, "README"), "hi\n");
  git(origin, "add", ".");
  git(
    origin,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-qm",
    "init",
  );
  execFileSync("git", ["clone", "-q", origin, join(root, "repo")]);
  config = {
    agentId: "agt_1",
    runId: "run_1",
    prompt: "add a file",
    sessionId: undefined,
    apiBaseUrl: "https://api.test",
    agentToken: "agent-secret",
    claudeAuth: "oauth",
    repoDir: join(root, "repo"),
    worktreesDir: join(root, "worktrees"),
    approvalPolicy: [],
    autoApprove: { defaults: true, commands: [] },
    sessionEnv: {},
    checks: [],
    mcpServers: {},
    waitTimeoutMs: 60_000,
    startBranch: undefined,
  };
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const init = { type: "system", subtype: "init", session_id: "sess-new" };
const assistant = (...content: unknown[]) => ({
  type: "assistant",
  session_id: "sess-new",
  parent_tool_use_id: null,
  message: { content },
});
/** Assistant text from inside the subagent the Agent call `parentToolUseId` started. */
const subagentSays = (parentToolUseId: string, text: string) => ({
  ...assistant({ type: "text", text }),
  parent_tool_use_id: parentToolUseId,
});
const success = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "Added hello.txt",
  num_turns: 2,
  duration_ms: 1234.6,
  total_cost_usd: 0.02,
  modelUsage: {
    "claude-opus-5-5": {
      inputTokens: 100,
      outputTokens: 40,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 5,
    },
  },
  session_id: "sess-new",
};

/** A scripted step that drives the session's options instead of yielding a message, as the SDK does when it fires a hook. */
type Step = (options: Options) => Promise<void>;

/** Fires the session's registered `event` hook the way the SDK does, and returns what the hook answered. */
async function fire(options: Options, event: HookEvent, fields: object) {
  const input = {
    session_id: "sess-new",
    transcript_path: "/t.jsonl",
    cwd: options.cwd ?? "",
    hook_event_name: event,
    ...fields,
  } as HookInput;
  const answers = [];
  for (const matcher of options.hooks?.[event] ?? [])
    for (const hook of matcher.hooks)
      answers.push(
        await hook(input, "toolu_1", { signal: new AbortController().signal }),
      );
  return answers;
}

const hook =
  (event: HookEvent, fields: object): Step =>
  async (options) => {
    expect(await fire(options, event, fields)).toEqual([{ continue: true }]);
  };

/** A scripted SDK stream; `onStart` runs once the session has its cwd, before the first message. */
function scripted(
  messages: unknown[],
  onStart?: (cwd: string) => void,
): QueryFn & { calls: Parameters<QueryFn>[0][] } {
  const calls: Parameters<QueryFn>[0][] = [];
  const fn = (params: Parameters<QueryFn>[0]) => {
    calls.push(params);
    return (async function* () {
      onStart?.(params.options.cwd ?? "");
      for (const m of messages) {
        if (m instanceof Error) throw m;
        if (typeof m === "function") await (m as Step)(params.options);
        else yield m as SDKMessage;
        // the SDK rejects its stream once its abortController fires
        if (params.options.abortController?.signal.aborted)
          throw new Error("Claude Code process aborted by user");
      }
    })();
  };
  return Object.assign(fn, { calls });
}

/** Reads a run's streaming prompt to its end, as the Claude process does; the texts of its messages. */
async function textOf(prompt: Parameters<QueryFn>[0]["prompt"] | undefined) {
  const texts: string[] = [];
  for await (const message of prompt ?? [])
    texts.push(String(message.message.content));
  return texts;
}

/**
 * A stand-in for the SDK and its Claude process: it reads the prompt as it streams. Each function
 * in `turns` is a point where `atPoint` learns whether the prompt had ended by then, and the end
 * of the script is one more.
 */
function claudeProcess(
  turns: unknown[],
  atPoint: (inputEnded: boolean) => void,
): QueryFn {
  return ({ prompt }) =>
    (async function* () {
      let inputEnded = false;
      const reading = (async () => {
        for await (const _ of prompt);
        inputEnded = true;
      })();
      for (const m of turns) {
        if (typeof m === "function") {
          // a beat for a closing input to be seen
          await new Promise((resolve) => setTimeout(resolve, 20));
          atPoint(inputEnded);
        } else yield m as SDKMessage;
      }
      // a process whose stdin never closes does not exit
      await Promise.race([
        reading,
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
      atPoint(inputEnded);
    })();
}

const backgroundTasks = (count: number, ambient = false) => ({
  type: "system",
  subtype: "background_tasks_changed",
  tasks: Array.from({ length: count }, (_, i) => ({
    task_id: `t${i}`,
    task_type: "local_bash",
    description: "claude -p /kru:reflect",
    ...(ambient && { ambient }),
  })),
  session_id: "sess-new",
});

/** For runs that hold nothing: any wait fails the test. */
const noDecision = async (): Promise<never> => {
  throw new Error("no request should wait");
};

const recorder = () => {
  const posted: RunnerEventPost[] = [];
  return { posted, post: async (e: RunnerEventPost) => void posted.push(e) };
};

const finished = {
  runId: "run_1",
  type: "run.finished",
  payload: {
    summary: "Added hello.txt",
    usage: {
      inputTokens: 115,
      outputTokens: 40,
      costUsd: 0.02,
      turns: 2,
      durationMs: 1235,
    },
    rollup: expect.any(Object),
  },
};

/** Events as the API receives them: through the real poster, so each one passed the shared schema. */
function apiPoster() {
  const sent: RunnerEventPost[] = [];
  server.use(
    http.post("https://api.test/internal/events", async ({ request }) => {
      sent.push((await request.json()) as RunnerEventPost);
      return new HttpResponse(null, { status: 204 });
    }),
  );
  const post = createPoster({
    apiBaseUrl: "https://api.test",
    agentToken: "agent-secret",
    warn: () => {},
    sleep: async () => {},
  });
  return { sent, post };
}

test("a finished run posts started, assistant text as claude.Message, then finished with the SDK usage, and exits 0", async () => {
  const { posted, post } = recorder();
  const query = scripted([
    init,
    assistant(
      { type: "text", text: "I'll add the file." },
      {
        type: "tool_use",
        id: "t1",
        name: "Write",
        input: { file_path: "hello.txt", content: "x" },
      },
    ),
    success,
  ]);
  const code = await runSession(config, {
    query,
    post,
    signal: new AbortController().signal,
    awaitDecision: noDecision,
  });
  expect(code).toBe(0);
  expect(posted).toEqual([
    { runId: "run_1", type: "run.started", payload: { sessionId: "sess-new" } },
    {
      runId: "run_1",
      type: "claude.Message",
      payload: { text: "I'll add the file." },
    },
    finished,
  ]);
});

test("each hook reaches the API as its claude.* event, in hook order, and nothing posts run.progress", async () => {
  const { sent, post } = apiPoster();
  const query = scripted([
    init,
    hook("Notification", {
      message: "Claude needs your attention",
      title: "Waiting",
      notification_type: "idle_prompt",
    }),
    assistant({ type: "text", text: "Looking around." }),
    hook("PreToolUse", {
      tool_name: "Bash",
      tool_input: { command: "ls -la src" },
      tool_use_id: "t1",
    }),
    hook("PostToolUse", {
      tool_name: "Bash",
      tool_input: { command: "ls -la src" },
      tool_response: { stdout: "a.ts", stderr: "" },
      tool_use_id: "t1",
      duration_ms: 12,
    }),
    hook("SubagentStart", { agent_id: "sub_1", agent_type: "Explore" }),
    hook("PreToolUse", {
      agent_id: "sub_1",
      tool_name: "Read",
      tool_input: { file_path: "src/a.ts" },
      tool_use_id: "t2",
    }),
    hook("PostToolUse", {
      agent_id: "sub_1",
      tool_name: "Read",
      tool_input: { file_path: "src/a.ts" },
      tool_response: "export {}",
      tool_use_id: "t2",
    }),
    hook("PostToolUseFailure", {
      agent_id: "sub_1",
      tool_name: "Grep",
      tool_input: { pattern: "x" },
      tool_use_id: "t3",
      error: "no matches",
      is_interrupt: false,
      duration_ms: 3,
    }),
    hook("SubagentStop", {
      stop_hook_active: false,
      agent_id: "sub_1",
      agent_transcript_path: "/s.jsonl",
      agent_type: "Explore",
      last_assistant_message: "Found a.ts.",
    }),
    hook("TaskCreated", {
      task_id: "1",
      task_subject: "Add hello.txt",
      task_description: "write the file",
    }),
    hook("TaskCompleted", { task_id: "1", task_subject: "Add hello.txt" }),
    hook("PreCompact", { trigger: "auto", custom_instructions: null }),
    hook("FileChanged", { file_path: "/w/.env", event: "change" }),
    hook("Stop", {
      stop_hook_active: false,
      last_assistant_message: "Done.",
    }),
    success,
  ]);
  const code = await runSession(config, {
    query,
    post,
    signal: new AbortController().signal,
    awaitDecision: noDecision,
  });
  expect(code).toBe(0);
  const ls = JSON.stringify({ command: "ls -la src" });
  const read = JSON.stringify({ file_path: "src/a.ts" });
  expect(sent).toEqual(
    [
      { type: "run.started", payload: { sessionId: "sess-new" } },
      {
        type: "claude.Notification",
        payload: {
          message: "Claude needs your attention",
          title: "Waiting",
          notificationType: "idle_prompt",
        },
      },
      { type: "claude.Message", payload: { text: "Looking around." } },
      {
        type: "claude.PreToolUse",
        payload: { toolName: "Bash", toolUseId: "t1", input: ls },
      },
      {
        type: "claude.PostToolUse",
        payload: {
          toolName: "Bash",
          toolUseId: "t1",
          input: ls,
          output: JSON.stringify({ stdout: "a.ts", stderr: "" }),
          durationMs: 12,
        },
      },
      {
        type: "claude.SubagentStart",
        payload: { subagentId: "sub_1", agentType: "Explore" },
      },
      {
        type: "claude.PreToolUse",
        payload: {
          toolName: "Read",
          toolUseId: "t2",
          input: read,
          subagentId: "sub_1",
        },
      },
      {
        type: "claude.PostToolUse",
        payload: {
          toolName: "Read",
          toolUseId: "t2",
          input: read,
          output: "export {}",
          subagentId: "sub_1",
        },
      },
      {
        type: "claude.PostToolUseFailure",
        payload: {
          toolName: "Grep",
          toolUseId: "t3",
          input: JSON.stringify({ pattern: "x" }),
          subagentId: "sub_1",
          error: "no matches",
          isInterrupt: false,
          durationMs: 3,
        },
      },
      {
        type: "claude.SubagentStop",
        payload: {
          subagentId: "sub_1",
          agentType: "Explore",
          lastAssistantMessage: "Found a.ts.",
        },
      },
      {
        type: "claude.TaskCreated",
        payload: {
          taskId: "1",
          taskSubject: "Add hello.txt",
          taskDescription: "write the file",
        },
      },
      {
        type: "claude.TaskCompleted",
        payload: { taskId: "1", taskSubject: "Add hello.txt" },
      },
      {
        type: "claude.PreCompact",
        payload: { trigger: "auto", customInstructions: null },
      },
      {
        type: "claude.FileChanged",
        payload: { filePath: "/w/.env", event: "change" },
      },
      finished,
    ].map((e) => ({ runId: "run_1", ...e })),
  );
});

test("tool text is sent whole up to RUNNER_TEXT_MAX and cut there, never clipped short ahead of redaction", async () => {
  const { sent, post } = apiPoster();
  const big = "x".repeat(100_000);
  const query = scripted([
    init,
    assistant({ type: "text", text: "y".repeat(20_000) }),
    hook("PostToolUse", {
      tool_name: "Bash",
      tool_input: { command: big },
      tool_response: big,
      tool_use_id: "t1",
    }),
    success,
  ]);
  await runSession(config, {
    query,
    post,
    signal: new AbortController().signal,
    awaitDecision: noDecision,
  });
  const message = sent.find((e) => e.type === "claude.Message");
  expect(message?.type === "claude.Message" && message.payload.text).toBe(
    "y".repeat(20_000),
  );
  const tool = sent.find((e) => e.type === "claude.PostToolUse");
  expect(tool?.type === "claude.PostToolUse" && tool.payload).toMatchObject({
    output: big.slice(0, RUNNER_TEXT_MAX),
    input: JSON.stringify({ command: big }).slice(0, RUNNER_TEXT_MAX),
  });
});

test("a subagent's text carries the Agent call's parentToolUseId; main-thread text has none", async () => {
  const { sent, post } = apiPoster();
  const query = scripted([
    init,
    assistant({ type: "text", text: "Delegating." }),
    subagentSays("toolu_agent", "Found a.ts."),
    success,
  ]);
  await runSession(config, {
    query,
    post,
    signal: new AbortController().signal,
    awaitDecision: noDecision,
  });
  expect(sent.filter((e) => e.type === "claude.Message")).toEqual([
    {
      runId: "run_1",
      type: "claude.Message",
      payload: { text: "Delegating." },
    },
    {
      runId: "run_1",
      type: "claude.Message",
      payload: { text: "Found a.ts.", parentToolUseId: "toolu_agent" },
    },
  ]);
});

/** A query whose producer runs ahead of the consumer, as the SDK reads the CLI's stdout while the runner is still posting. */
function eager(
  produce: (options: Options, push: (m: unknown) => void) => Promise<void>,
): QueryFn {
  return ({ options }) => {
    const buffered: unknown[] = [];
    let done = false;
    let wake = () => {};
    void produce(options, (m) => {
      buffered.push(m);
      wake();
    }).finally(() => {
      done = true;
      wake();
    });
    return (async function* () {
      while (true) {
        const next = buffered.shift();
        if (next !== undefined) yield next as SDKMessage;
        else if (done) return;
        else await new Promise<void>((r) => (wake = r));
      }
    })();
  };
}

test("with a slow API, text and hook events post in stream order and the ending event comes after all of them", async () => {
  const posted: RunnerEventPost[] = [];
  const post = async (e: RunnerEventPost) => {
    await new Promise((r) => setTimeout(r, 20));
    posted.push(e);
  };
  const query = eager(async (options, push) => {
    push(init);
    // run.started has landed before Claude says anything
    await new Promise((r) => setTimeout(r, 60));
    push(assistant({ type: "text", text: "First." }));
    await setImmediate();
    push(assistant({ type: "text", text: "Second." }));
    await setImmediate();
    await fire(options, "PreToolUse", {
      tool_name: "Read",
      tool_input: { file_path: "a.ts" },
      tool_use_id: "t1",
    });
    await setImmediate();
    push(success);
  });
  const code = await runSession(config, {
    query,
    post,
    signal: new AbortController().signal,
    awaitDecision: noDecision,
  });
  expect(code).toBe(0);
  expect(
    posted.map((e) =>
      e.type === "claude.Message" ? `${e.type}:${e.payload.text}` : e.type,
    ),
  ).toEqual([
    "run.started",
    "claude.Message:First.",
    "claude.Message:Second.",
    "claude.PreToolUse",
    "run.finished",
  ]);
});

test("a result with no text takes its summary from the Stop hook's last message", async () => {
  const { posted, post } = recorder();
  const query = scripted([
    init,
    hook("Stop", {
      stop_hook_active: false,
      last_assistant_message: "Added hello.txt and a test.",
    }),
    { ...success, result: "" },
  ]);
  await runSession(config, {
    query,
    post,
    signal: new AbortController().signal,
    awaitDecision: noDecision,
  });
  expect(posted.filter((e) => e.type === "run.finished")).toEqual([
    expect.objectContaining({
      payload: expect.objectContaining({
        summary: "Added hello.txt and a test.",
      }),
    }),
  ]);
});

test("a hook answers continue without waiting on its post, and a post that rejects doesn't fail the tool call", async () => {
  const posted: RunnerEventPost[] = [];
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  const post = async (e: RunnerEventPost) => {
    if (e.type === "claude.PreToolUse" && e.payload.toolName === "Bash") {
      await held;
      throw new Error("post blew up");
    }
    posted.push(e);
  };
  const query = scripted([
    init,
    async (options: Options) => {
      const answers = await fire(options, "PreToolUse", {
        tool_name: "Bash",
        tool_input: { command: "ls" },
        tool_use_id: "t1",
      });
      expect(answers).toEqual([{ continue: true }]);
      release();
    },
    hook("PreToolUse", {
      tool_name: "Read",
      tool_input: { file_path: "a.ts" },
      tool_use_id: "t2",
    }),
    success,
  ]);
  const code = await runSession(config, {
    query,
    post,
    signal: new AbortController().signal,
    awaitDecision: noDecision,
  });
  expect(code).toBe(0);
  expect(posted.map((e) => e.type)).toEqual([
    "run.started",
    "claude.PreToolUse",
    "run.finished",
  ]);
});

test("runs the session in the agent worktree, resuming the stored session, without AGENT_TOKEN in its env", async () => {
  process.env.AGENT_TOKEN = "agent-secret";
  try {
    const query = scripted([init, success]);
    await runSession(
      { ...config, sessionId: "sess-old" },
      {
        query,
        post: recorder().post,
        signal: new AbortController().signal,
        awaitDecision: noDecision,
      },
    );
    const [call] = query.calls;
    expect(await textOf(call?.prompt)).toEqual(["add a file"]);
    expect(call?.options.cwd).toBe(join(root, "worktrees", "agt_1"));
    expect(call?.options.resume).toBe("sess-old");
    expect(call?.options.env).not.toHaveProperty("AGENT_TOKEN");
    expect(call?.options.env?.PATH).toBe(process.env.PATH);
  } finally {
    delete process.env.AGENT_TOKEN;
  }
});

const HOST_GIT_IDENTITY = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
] as const;

// the host running the tests may carry a git identity of its own; unstubEnvs() puts it back
const stubHostGitIdentity = (identity: Record<string, string> = {}) => {
  for (const key of HOST_GIT_IDENTITY) {
    vi.stubEnv(key, identity[key]);
  }
};

afterEach(() => {
  vi.unstubAllEnvs();
});

test("the session commits as Claude through its env, so nothing writes the clone's git config", async () => {
  stubHostGitIdentity();
  const query = scripted([init, success]);
  await runSession(config, {
    query,
    post: recorder().post,
    signal: new AbortController().signal,
    awaitDecision: noDecision,
  });
  expect(query.calls[0]?.options.env).toMatchObject({
    GIT_AUTHOR_NAME: "Claude",
    GIT_AUTHOR_EMAIL: "noreply@anthropic.com",
    GIT_COMMITTER_NAME: "Claude",
    GIT_COMMITTER_EMAIL: "noreply@anthropic.com",
  });
});

test("a git author set in the runner's env replaces Claude in the session env, the committer defaulting to it", async () => {
  stubHostGitIdentity({
    GIT_AUTHOR_NAME: "Dev Person",
    GIT_AUTHOR_EMAIL: "dev@example.com",
  });
  const query = scripted([init, success]);
  await runSession(config, {
    query,
    post: recorder().post,
    signal: new AbortController().signal,
    awaitDecision: noDecision,
  });
  expect(query.calls[0]?.options.env).toMatchObject({
    GIT_AUTHOR_NAME: "Dev Person",
    GIT_AUTHOR_EMAIL: "dev@example.com",
    GIT_COMMITTER_NAME: "Dev Person",
    GIT_COMMITTER_EMAIL: "dev@example.com",
  });
});

test("sessionGitIdentity: a committer field overrides the author's alone, and half an author is ignored", () => {
  expect(
    sessionGitIdentity({
      GIT_AUTHOR_NAME: "Dev Person",
      GIT_AUTHOR_EMAIL: "dev@example.com",
      GIT_COMMITTER_EMAIL: "ci@example.com",
    }),
  ).toEqual({
    GIT_AUTHOR_NAME: "Dev Person",
    GIT_AUTHOR_EMAIL: "dev@example.com",
    GIT_COMMITTER_NAME: "Dev Person",
    GIT_COMMITTER_EMAIL: "ci@example.com",
  });
  expect(sessionGitIdentity({ GIT_AUTHOR_NAME: "Dev Person" })).toMatchObject({
    GIT_AUTHOR_NAME: "Claude",
    GIT_AUTHOR_EMAIL: "noreply@anthropic.com",
  });
});

test("the session turns Claude Code's commit and pull request attribution off", async () => {
  const query = scripted([init, success]);
  await runSession(config, {
    query,
    post: recorder().post,
    signal: new AbortController().signal,
    awaitDecision: noDecision,
  });
  expect(query.calls[0]?.options.settings).toEqual({
    attribution: { commit: "", pr: "" },
  });
});

const sessionEnvOf = async () => {
  const query = scripted([init, success]);
  await runSession(config, {
    query,
    post: recorder().post,
    signal: new AbortController().signal,
    awaitDecision: noDecision,
  });
  const env = query.calls[0]?.options.env;
  if (!env) throw new Error("no session env");
  return env;
};

test("a plain git status in the session never runs a core.fsmonitor the repo's config names", async () => {
  vi.stubEnv("GIT_CONFIG_COUNT", undefined);
  try {
    const env = await sessionEnvOf();
    const repo = mkdtempSync(join(tmpdir(), "runner-fsmonitor-"));
    try {
      const pwned = join(repo, "pwned");
      execFileSync("git", ["init", "-q", repo]);
      execFileSync("git", [
        "-C",
        repo,
        "config",
        "core.fsmonitor",
        `touch ${pwned}; false`,
      ]);
      execFileSync("git", ["-C", repo, "status", "--short"], {
        env: env as NodeJS.ProcessEnv,
      });
      expect(existsSync(pwned)).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  } finally {
    vi.unstubAllEnvs();
  }
});

test("the session's git config pairs go after any the project's env already sets, which stay", async () => {
  vi.stubEnv("GIT_CONFIG_COUNT", "1");
  vi.stubEnv("GIT_CONFIG_KEY_0", "user.signingkey");
  vi.stubEnv("GIT_CONFIG_VALUE_0", "ABC");
  try {
    expect(await sessionEnvOf()).toMatchObject({
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "user.signingkey",
      GIT_CONFIG_VALUE_0: "ABC",
      GIT_CONFIG_KEY_1: "core.fsmonitor",
      GIT_CONFIG_VALUE_1: "false",
    });
  } finally {
    vi.unstubAllEnvs();
  }
});

test("the profile's session variables reach the session, over the caller's env", async () => {
  vi.stubEnv("PLUGIN_SWITCH", "caller");
  const query = scripted([init, success]);
  await runSession(
    { ...config, sessionEnv: { PLUGIN_SWITCH: "1", OTHER: "x" } },
    {
      query,
      post: recorder().post,
      signal: new AbortController().signal,
      awaitDecision: noDecision,
    },
  );
  expect(query.calls[0]?.options.env).toMatchObject({
    PLUGIN_SWITCH: "1",
    OTHER: "x",
  });
});

test("with no profile, the session env holds the caller's env plus only host mode and the runner's git identity and config", async () => {
  for (const name of [
    "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0",
  ])
    vi.stubEnv(name, undefined);
  const query = scripted([init, success]);
  await runSession(config, {
    query,
    post: recorder().post,
    signal: new AbortController().signal,
    awaitDecision: noDecision,
  });
  const env = query.calls[0]?.options.env ?? {};
  expect(
    Object.keys(env)
      .filter((k) => !(k in process.env))
      .sort(),
  ).toEqual([
    "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
    "GIT_AUTHOR_EMAIL",
    "GIT_AUTHOR_NAME",
    "GIT_COMMITTER_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0",
  ]);
});

test("with a GitHub connector in its env, the session is told to publish through the runner instead of git push or gh", async () => {
  const start = () => {
    const query = scripted([init, success]);
    return runSession(config, {
      query,
      post: recorder().post,
      signal: new AbortController().signal,
      awaitDecision: noDecision,
    }).then(() => query.calls[0]?.options.systemPrompt);
  };
  try {
    vi.stubEnv("GITHUB_CONNECTOR", undefined);
    const bare = (await start()) as { append?: string };
    expect(bare.append).not.toContain("publish --title");
    vi.stubEnv("GITHUB_CONNECTOR", "conn_123");
    const prompt = await start();
    expect(prompt).toMatchObject({ type: "preset", preset: "claude_code" });
    const append = (prompt as { append?: string }).append ?? "";
    expect(append).toContain(" publish --title <title>");
    expect(append).toContain(`--body "$(cat <<'EOF'`);
    expect(append).toContain("instead of `git push` or `gh pr create`");
    expect(append).toContain(
      "This sandbox has no git transport and no GitHub credential: `git fetch`, `git pull` and `git push` fail here, and so does `gh`.",
    );
    expect(append).toContain(
      "The runner refreshed this repo from GitHub when this run started; what that changed, if anything, is in the notes at the end.",
    );
    expect(append).toContain(
      `Run \`${process.execPath} ${process.argv[1]}\` only for its \`publish\` command: its other subcommands are the Sky API's, and run with none it refuses: only the Sky API starts a run.`,
    );
  } finally {
    vi.unstubAllEnvs();
  }
});

const appendOf = async (checks: string[]) => {
  const query = scripted([init, success]);
  await runSession(
    { ...config, checks },
    {
      query,
      post: recorder().post,
      signal: new AbortController().signal,
      awaitDecision: noDecision,
    },
  );
  return (
    (query.calls[0]?.options.systemPrompt as { append?: string } | undefined)
      ?.append ?? ""
  );
};

test("with checks in the profile, the session is told to run them in order before finishing, connector or not", async () => {
  vi.stubEnv("GITHUB_CONNECTOR", undefined);
  try {
    const append = await appendOf([
      'env -u ANTHROPIC_API_KEY claude -p "/acme:review"',
      "update the changelog",
    ]);
    expect(append).not.toContain("publish --title");
    expect(append).toContain("Before you finish, run these checks");
    expect(append).toContain(
      '- env -u ANTHROPIC_API_KEY claude -p "/acme:review"\n- update the changelog',
    );
    expect(append).toContain("Never set or use an API key");
  } finally {
    vi.unstubAllEnvs();
  }
});

test("with a connector and checks, the publish instructions come first, then the checks, as separate paragraphs", async () => {
  vi.stubEnv("GITHUB_CONNECTOR", "conn_123");
  try {
    const append = await appendOf(["update the changelog"]);
    // the connector makes the run try to refresh from GitHub, which this test's origin fails, and
    // that failure is a note of its own
    const paragraphs = append
      .split("\n\n")
      .filter(
        (paragraph) => !paragraph.startsWith("What the runner's refresh"),
      );
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]).toContain(" publish --title <title>");
    expect(paragraphs[0]).not.toContain("Before you finish");
    expect(paragraphs[1]).toMatch(/^Before you finish, run these checks/);
    expect(paragraphs[1]).toContain("- update the changelog");
  } finally {
    vi.unstubAllEnvs();
  }
});

test("a check written as plain `claude -p` is still run with every project credential, gateway and provider switch unset", async () => {
  vi.stubEnv("GITHUB_CONNECTOR", undefined);
  // no run credential, so no login prefix: what this reads is the `env` part alone
  vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", undefined);
  try {
    const append = await appendOf(['claude -p "/acme:review"']);
    expect(append).toContain('- claude -p "/acme:review"');
    expect(append).not.toContain("as written");
    const instruction =
      /`(env (?:-u \S+ )+(?:\S+=\S+ )*)claude -p …`, even where/;
    const prefix = instruction.exec(append)?.[1] ?? "";
    for (const name of [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      ...PROJECT_VARIABLES,
    ])
      expect(prefix).toContain(`-u ${name} `);
    // what the nested `claude` would see, run in a command's env: the subscription login and nothing
    // of the project's that outranks it or redirects it
    const projectEnv = Object.fromEntries(
      PROJECT_VARIABLES.map((name) => [name, `project-${name}`]),
    );
    const seen = execFileSync("sh", ["-c", `${prefix}env`], {
      env: {
        PATH: process.env.PATH,
        CLAUDE_CODE_OAUTH_TOKEN: "subscription-token",
        CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "0",
        ...projectEnv,
      },
      encoding: "utf8",
    });
    expect(seen).toContain("CLAUDE_CODE_OAUTH_TOKEN=subscription-token");
    expect(seen).toMatch(/^CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1$/m);
    for (const name of PROJECT_VARIABLES)
      expect(seen).not.toContain(`${name}=`);
  } finally {
    vi.unstubAllEnvs();
  }
});

test("a result with a background task still running leaves the prompt open for the turn its notification wakes (JUS-96)", async () => {
  const seen: boolean[] = [];
  const { post } = recorder();
  const outcome = await runSession(config, {
    query: claudeProcess(
      [
        init,
        backgroundTasks(1),
        success,
        // the turn ended and the nested `claude -p` is still running: stdin must still be open
        () => {},
        backgroundTasks(0),
        success,
      ],
      (inputEnded) => seen.push(inputEnded),
    ),
    post,
    signal: new AbortController().signal,
    awaitDecision: noDecision,
  });
  // open at the idle turn end; closed once the last result came with nothing running
  expect(seen).toEqual([false, true]);
  expect(outcome).toBe(0);
});

test("a background task that never finishes holds the prompt open only for the hold, then the run ends with its result", async () => {
  const seen: boolean[] = [];
  const warnings: string[] = [];
  const { post } = recorder();
  const outcome = await runSession(config, {
    query: claudeProcess(
      [init, backgroundTasks(1), success, () => {}],
      (ended) => seen.push(ended),
    ),
    post,
    signal: new AbortController().signal,
    awaitDecision: noDecision,
    warn: (line) => warnings.push(line),
    backgroundHoldMs: 5,
  });
  expect(seen).toEqual([true, true]);
  expect(
    warnings.some((w) => w.includes("1 background task(s) still running")),
  ).toBe(true);
  expect(outcome).toBe(0);
});

test("a result with no background task running closes the prompt, so the process can exit", async () => {
  const seen: boolean[] = [];
  const { post } = recorder();
  await runSession(config, {
    query: claudeProcess([init, backgroundTasks(0), success], (ended) =>
      seen.push(ended),
    ),
    post,
    signal: new AbortController().signal,
    awaitDecision: noDecision,
  });
  expect(seen).toEqual([true]);
});

test("an ambient background task (a watcher) does not hold the prompt open", async () => {
  const seen: boolean[] = [];
  const { post } = recorder();
  await runSession(config, {
    query: claudeProcess([init, backgroundTasks(1, true), success], (ended) =>
      seen.push(ended),
    ),
    post,
    signal: new AbortController().signal,
    awaitDecision: noDecision,
  });
  expect(seen).toEqual([true]);
});

test("without checks, the session is told nothing about them", async () => {
  vi.stubEnv("GITHUB_CONNECTOR", undefined);
  try {
    const append = await appendOf([]);
    expect(append).toBe("");
  } finally {
    vi.unstubAllEnvs();
  }
});

test("AGENT_TOKEN never reaches the session", async () => {
  vi.stubEnv("AGENT_TOKEN", "agent-secret");
  try {
    const query = scripted([init, success]);
    await runSession(config, {
      query,
      post: recorder().post,
      signal: new AbortController().signal,
      awaitDecision: noDecision,
    });
    expect(query.calls[0]?.options.env).not.toHaveProperty("AGENT_TOKEN");
  } finally {
    vi.unstubAllEnvs();
  }
});

describe("the Claude credential of a run", () => {
  const SKY_KEY = "sky-anthropic-key-opaque";
  const PROJECT_KEY = "project-anthropic-key-opaque";
  const TOKEN = "subscription-token-opaque";

  type Seen = {
    options: Options;
    /** What a Bash command sees of ANTHROPIC_API_KEY, from sourcing the file Claude Code sources before each command. */
    commandKey: string;
    /** What a Bash command's env holds, from sourcing that file over Claude's own env. */
    commandEnv: Record<string, string>;
    /** What the SessionStart hook appended to the file Claude Code sources before each command. */
    commandScript: string;
    scriptPath: string | undefined;
  };

  /** Runs a session, and at its start runs the SessionStart hook the way Claude Code does. */
  async function sessionSeen(
    runConfig: Config,
    result: unknown = success,
  ): Promise<Seen> {
    const seen: Partial<Seen> = {};
    const query = scripted([
      init,
      (async (options: Options) => {
        seen.options = options;
        const command = (
          options.settings as {
            hooks?: {
              SessionStart?: { hooks: { command: string }[] }[];
            };
          }
        ).hooks?.SessionStart?.[0]?.hooks[0]?.command;
        const envFile = join(root, "claude-env-file");
        writeFileSync(envFile, "");
        if (command) {
          execFileSync("sh", ["-c", command], {
            env: { ...process.env, CLAUDE_ENV_FILE: envFile },
          });
        }
        seen.commandScript = readFileSync(envFile, "utf8");
        seen.scriptPath = /-r '([^']+)'/.exec(seen.commandScript)?.[1];
        // a command's shell: Claude's own env, with that file sourced first
        seen.commandKey = execFileSync(
          "sh",
          ["-c", `. '${envFile}'; printf %s "$ANTHROPIC_API_KEY"`],
          { env: options.env as Record<string, string>, encoding: "utf8" },
        );
        const sourced = execFileSync("sh", ["-c", `. '${envFile}'; env`], {
          env: options.env as Record<string, string>,
          encoding: "utf8",
        });
        seen.commandEnv = Object.fromEntries(
          sourced.split("\n").flatMap((line) => {
            const at = line.indexOf("=");
            return at > 0 ? [[line.slice(0, at), line.slice(at + 1)]] : [];
          }),
        );
      }) as unknown as SDKMessage,
      result,
    ]);
    await runSession(runConfig, {
      query,
      post: recorder().post,
      signal: new AbortController().signal,
      awaitDecision: noDecision,
    });
    return seen as Seen;
  }

  afterEach(() => vi.unstubAllEnvs());

  /** Points the runner's credential files at a directory this test alone writes to, and returns it. */
  const isolatedCredentialDir = () => {
    const tmp = join(root, "tmp");
    mkdirSync(tmp);
    vi.stubEnv("TMPDIR", tmp);
    return credentialDir(tmp);
  };

  test("a subscription run: the Claude process holds the token and no API key, even when the project has one", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", TOKEN);
    vi.stubEnv("ANTHROPIC_API_KEY", PROJECT_KEY);
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "project-auth-token-opaque");
    vi.stubEnv("SKY_CLAUDE_API_KEY", SKY_KEY);
    const seen = await sessionSeen(config);
    const env = seen.options.env ?? {};
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
    expect(env).not.toHaveProperty("SKY_CLAUDE_API_KEY");
    expect(JSON.stringify(env)).not.toContain(SKY_KEY);
    expect(JSON.stringify(env)).not.toContain(PROJECT_KEY);
  });

  test("a subscription run: the project's own ANTHROPIC_API_KEY still works for its commands", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", TOKEN);
    vi.stubEnv("ANTHROPIC_API_KEY", PROJECT_KEY);
    const seen = await sessionSeen(config);
    expect(seen.commandKey).toBe(PROJECT_KEY);
    // the key rides in a file only this user reads, not in the settings Claude Code is started with
    expect(JSON.stringify(seen.options.settings)).not.toContain(PROJECT_KEY);
  });

  test("a subscription run whose project has no key sets nothing up for commands", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", TOKEN);
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    const seen = await sessionSeen(config);
    expect(seen.options.settings).not.toHaveProperty("hooks");
    expect(seen.commandKey).toBe("");
  });

  test("an API-key run: the Claude process holds Sky's key alone, with no subscription token", async () => {
    vi.stubEnv("SKY_CLAUDE_API_KEY", SKY_KEY);
    // a real token in the runner's env: the run chose the key, so the token must be left out
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", TOKEN);
    vi.stubEnv("ANTHROPIC_API_KEY", PROJECT_KEY);
    const seen = await sessionSeen({ ...config, claudeAuth: "api-key" });
    const env = seen.options.env ?? {};
    expect(env.ANTHROPIC_API_KEY).toBe(SKY_KEY);
    expect(env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(JSON.stringify(env)).not.toContain(TOKEN);
    expect(env).not.toHaveProperty("SKY_CLAUDE_API_KEY");
    expect(JSON.stringify(env)).not.toContain(PROJECT_KEY);
  });

  test("an API-key run: Sky's key never reaches the project's commands, which keep the project's own key", async () => {
    vi.stubEnv("SKY_CLAUDE_API_KEY", SKY_KEY);
    vi.stubEnv("ANTHROPIC_API_KEY", PROJECT_KEY);
    const seen = await sessionSeen({ ...config, claudeAuth: "api-key" });
    expect(seen.commandKey).toBe(PROJECT_KEY);
    expect(JSON.stringify(seen.options.settings)).not.toContain(SKY_KEY);
  });

  test("an API-key run whose project has no key: its commands see no ANTHROPIC_API_KEY, not Sky's", async () => {
    vi.stubEnv("SKY_CLAUDE_API_KEY", SKY_KEY);
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    const seen = await sessionSeen({ ...config, claudeAuth: "api-key" });
    expect(seen.options.env?.ANTHROPIC_API_KEY).toBe(SKY_KEY);
    expect(seen.commandKey).toBe("");
  });

  describe("when the runner env and the profile's session env both carry a key, a token and a gateway", () => {
    const GATEWAY = "https://project-gateway.example";
    const PROFILE = {
      ANTHROPIC_API_KEY: "profile-anthropic-key-opaque",
      CLAUDE_CODE_OAUTH_TOKEN: "profile-token-opaque",
      ANTHROPIC_BASE_URL: "https://profile-gateway.example",
    };
    const CREDENTIAL_NAMES = [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "SKY_CLAUDE_API_KEY",
    ];
    const credentialsIn = (env: Options["env"]) =>
      Object.fromEntries(
        Object.entries(env ?? {}).filter(([name]) =>
          CREDENTIAL_NAMES.includes(name),
        ),
      );

    beforeEach(() => {
      vi.stubEnv("ANTHROPIC_API_KEY", PROJECT_KEY);
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", TOKEN);
      vi.stubEnv("ANTHROPIC_BASE_URL", GATEWAY);
      vi.stubEnv("SKY_CLAUDE_API_KEY", SKY_KEY);
    });

    test.each([
      ["a subscription run", "oauth", { CLAUDE_CODE_OAUTH_TOKEN: TOKEN }],
      ["an API-key run", "api-key", { ANTHROPIC_API_KEY: SKY_KEY }],
    ] as const)(
      "%s: the Claude process holds exactly the chosen credential, sent to no gateway",
      async (_, claudeAuth, chosen) => {
        const seen = await sessionSeen({
          ...config,
          claudeAuth,
          sessionEnv: PROFILE,
        });
        const env = seen.options.env;
        expect(credentialsIn(env)).toEqual(chosen);
        const all = JSON.stringify(env);
        for (const other of [
          PROJECT_KEY,
          GATEWAY,
          ...Object.values(PROFILE),
          ...(claudeAuth === "oauth" ? [SKY_KEY] : [TOKEN]),
        ])
          expect(all).not.toContain(other);
      },
    );
  });

  test("a project's gateway and auth token still reach its commands, through the file and not Claude's env", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", TOKEN);
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "project-auth-token-opaque");
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://project-gateway.example");
    const seen = await sessionSeen(config);
    expect(seen.options.env).not.toHaveProperty("ANTHROPIC_BASE_URL");
    expect(seen.options.env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
    expect(seen.commandEnv).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: "project-auth-token-opaque",
      ANTHROPIC_BASE_URL: "https://project-gateway.example",
    });
    // Claude Code's own env file only points at the runner's, which the runner deletes
    expect(seen.commandScript).not.toContain("project-auth-token-opaque");
    expect(seen.commandScript).not.toContain("project-gateway.example");
  });

  test("the file holding the project's key is removed when the session ends", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", TOKEN);
    vi.stubEnv("ANTHROPIC_API_KEY", PROJECT_KEY);
    const seen = await sessionSeen(config);
    expect(seen.scriptPath).toBeDefined();
    expect(existsSync(String(seen.scriptPath))).toBe(false);
  });

  test("a run that can't write that file fails rather than start with Sky's key visible to commands", async () => {
    vi.stubEnv("SKY_CLAUDE_API_KEY", SKY_KEY);
    vi.stubEnv("TMPDIR", join(root, "not-a-directory"));
    writeFileSync(join(root, "not-a-directory"), "");
    const { posted, post } = recorder();
    const query = scripted([init, success]);
    const code = await runSession(
      { ...config, claudeAuth: "api-key" },
      {
        query,
        post,
        signal: new AbortController().signal,
        awaitDecision: noDecision,
      },
    );
    expect(code).toBe(1);
    expect(query.calls).toHaveLength(0);
    expect(posted.at(-1)?.type).toBe("run.failed");
  });

  test("a usage limit, which Claude reports as an error result of subtype success, reaches run.failed as its own text", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", TOKEN);
    const { posted, post } = recorder();
    const limit = "You've hit your 5-hour limit · resets 10:20am (UTC)";
    const query = scripted([
      init,
      { ...success, is_error: true, result: limit },
    ]);
    const code = await runSession(config, {
      query,
      post,
      signal: new AbortController().signal,
      awaitDecision: noDecision,
    });
    expect(code).toBe(1);
    expect(posted.at(-1)).toMatchObject({
      type: "run.failed",
      payload: { error: limit },
    });
  });

  describe("the nested claude's login in the prompt", () => {
    const promptOf = async (
      overrides: Partial<typeof config>,
      runnerEnv: Record<string, string | undefined>,
    ) => {
      for (const [name, value] of Object.entries(runnerEnv))
        vi.stubEnv(name, value);
      const query = scripted([init, success]);
      await runSession(
        { ...config, checks: ["claude -p /review"], ...overrides },
        {
          query,
          post: recorder().post,
          signal: new AbortController().signal,
          awaitDecision: noDecision,
        },
      );
      const options = query.calls[0]?.options;
      const prompt = options?.systemPrompt as { append?: string } | undefined;
      return prompt?.append ?? "";
    };

    test("an API-key run's nested claude is logged in with Sky's key, which the prompt never holds", async () => {
      const append = await promptOf(
        { claudeAuth: "api-key" },
        { SKY_CLAUDE_API_KEY: SKY_KEY },
      );
      expect(append).toContain('`ANTHROPIC_API_KEY="$(<');
      expect(append).toContain("logged in with this run's API key");
      expect(append).not.toContain("is not logged in");
      expect(append).not.toContain(SKY_KEY);
    });

    test("a subscription run's nested claude is logged in with its token, which the prompt never holds", async () => {
      const append = await promptOf(
        { claudeAuth: "oauth" },
        { CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
      );
      expect(append).toContain('`CLAUDE_CODE_OAUTH_TOKEN="$(<');
      expect(append).toContain("logged in with this run's subscription");
      expect(append).not.toContain(TOKEN);
    });

    test("a run with no credential tells the agent its nested claude isn't logged in", async () => {
      const append = await promptOf(
        { claudeAuth: "api-key" },
        { SKY_CLAUDE_API_KEY: undefined },
      );
      expect(append).toContain("is not logged in on this run");
      expect(append).not.toContain("$(<");
    });

    test("the file holding the credential exists alone, for this user only, during the run and is gone once it ends", async () => {
      const dir = isolatedCredentialDir();
      let during: { names: string[]; modes: number[]; values: string[] } = {
        names: [],
        modes: [],
        values: [],
      };
      const query = scripted([
        init,
        async () => {
          const names = readdirSync(dir).filter((name) =>
            name.startsWith("sky-nested-claude-run_1-"),
          );
          const at = (name: string) => join(dir, name);
          during = {
            names,
            modes: names.map((name) => statSync(at(name)).mode & 0o777),
            values: names.map((name) => readFileSync(at(name), "utf8")),
          };
        },
        success,
      ]);
      vi.stubEnv("SKY_CLAUDE_API_KEY", SKY_KEY);
      await runSession(
        { ...config, claudeAuth: "api-key" },
        {
          query,
          post: recorder().post,
          signal: new AbortController().signal,
          awaitDecision: noDecision,
        },
      );
      expect(during.names).toHaveLength(1);
      expect(during.modes).toEqual([0o600]);
      expect(during.values).toEqual([SKY_KEY]);
      expect(readdirSync(dir)).toEqual([]);
    });

    describe("a run that does not finish", () => {
      /** Runs an API-key run whose script ends as `tail` says, and lists the credential directory during the run and after it. */
      const credentialFilesAround = async (
        tail: unknown[],
        controller = new AbortController(),
      ) => {
        const dir = isolatedCredentialDir();
        let during: string[] = [];
        const query = scripted([
          init,
          async () => {
            during = readdirSync(dir);
          },
          ...tail,
        ]);
        vi.stubEnv("SKY_CLAUDE_API_KEY", SKY_KEY);
        const code = await runSession(
          { ...config, claudeAuth: "api-key" },
          {
            query,
            post: recorder().post,
            signal: controller.signal,
            awaitDecision: noDecision,
          },
        );
        return { code, during, after: readdirSync(dir) };
      };
      const loginsIn = (names: string[]) =>
        names.filter((name) => name.startsWith("sky-nested-claude-run_1-"));

      test("an SDK that throws leaves no credential file behind", async () => {
        const { code, during, after } = await credentialFilesAround([
          new Error("Claude Code process exited with code 1"),
        ]);
        expect(code).toBe(1);
        expect(loginsIn(during)).toHaveLength(1);
        expect(after).toEqual([]);
      });

      test("a run aborted by its signal leaves no credential file behind", async () => {
        const controller = new AbortController();
        const { code, during, after } = await credentialFilesAround(
          [async () => controller.abort("SIGTERM"), success],
          controller,
        );
        expect(code).toBe(1);
        expect(loginsIn(during)).toHaveLength(1);
        expect(after).toEqual([]);
      });
    });

    test("no event the run posts holds the credential, though the check's command that reads it does", async () => {
      vi.stubEnv("SKY_CLAUDE_API_KEY", SKY_KEY);
      const { posted, post } = recorder();
      // the command the run's prompt gives for a nested claude, as a Bash call in the run would carry it
      const nestedCommand = (options: Options) =>
        /`(ANTHROPIC_API_KEY="\$\(<[^`]+)`/.exec(
          (options.systemPrompt as { append?: string }).append ?? "",
        )?.[1] ?? "";
      const bashCall =
        (event: "PreToolUse" | "PostToolUse"): Step =>
        async (options) => {
          await fire(options, event, {
            tool_name: "Bash",
            tool_input: { command: nestedCommand(options) },
            tool_response: { stdout: "ok", stderr: "" },
            tool_use_id: "t1",
          });
        };
      await runSession(
        { ...config, claudeAuth: "api-key", checks: ["claude -p /review"] },
        {
          query: scripted([
            init,
            bashCall("PreToolUse"),
            bashCall("PostToolUse"),
            success,
          ]),
          post,
          signal: new AbortController().signal,
          awaitDecision: noDecision,
        },
      );
      const all = JSON.stringify(posted);
      // the read is live: the command reached the events, naming the file
      expect(all).toContain("$(<");
      expect(all).not.toContain(SKY_KEY);
    });
  });

  describe("a check's nested claude command", () => {
    const PROJECT_ENV = Object.fromEntries(
      PROJECT_VARIABLES.map((name) => [name, `project-value-${name}`]),
    );
    const loginOf = (auth: Config["claudeAuth"]) =>
      prepareNestedLogin(
        auth,
        { CLAUDE_CODE_OAUTH_TOKEN: TOKEN, SKY_CLAUDE_API_KEY: SKY_KEY },
        "run_1",
        join(root, "logins"),
      );
    /** Runs the command in bash as a Bash command would, with `program` in place of `claude -p …`. */
    const run = (
      command: string,
      program: string,
      env: Record<string, string> = {},
    ) =>
      execFileSync("bash", ["-c", command.replace(/claude -p …$/, program)], {
        env: { PATH: process.env.PATH, ...env },
        encoding: "utf8",
      });

    test("the credential is assigned by the shell ahead of env, so neither the command nor env's argv holds it", async () => {
      const { prefix } = await loginOf("oauth");
      const command = nestedClaude(prefix);
      expect(command).toMatch(
        /^CLAUDE_CODE_OAUTH_TOKEN="\$\(<'[^']+'\)" env -u /,
      );
      expect(command).not.toContain(TOKEN);
      // a shell function shadowing `env` gets exactly the arguments the real one would be run with
      const argv = run(
        `env() { printf '%s\\n' "$@"; }; ${command}`,
        "claude -p check",
      );
      expect(argv).toContain("CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1\n");
      expect(argv).not.toContain(TOKEN);
    });

    test("a subscription token already in the command's env does not win over the run's own", async () => {
      const { prefix } = await loginOf("oauth");
      const command = nestedClaude(prefix);
      const env = { CLAUDE_CODE_OAUTH_TOKEN: "command-env-token" };
      const seen = run(command, "printenv CLAUDE_CODE_OAUTH_TOKEN", env);
      expect(seen).toBe(`${TOKEN}\n`);
    });

    test.each([
      ["api-key", "ANTHROPIC_API_KEY", SKY_KEY],
      ["oauth", "CLAUDE_CODE_OAUTH_TOKEN", TOKEN],
    ] as const)(
      "on an %s run the nested claude gets the run's %s, never the project's ANTHROPIC_API_KEY, and no other project variable",
      async (auth, variable, value) => {
        const { prefix } = await loginOf(auth);
        const seen = run(nestedClaude(prefix), "printenv", PROJECT_ENV);
        expect(seen).toMatch(new RegExp(`^${variable}=${value}$`, "m"));
        expect(seen).toMatch(/^CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1$/m);
        expect(seen).not.toContain("project-value-");
        for (const name of PROJECT_VARIABLES)
          if (name !== variable)
            expect(seen).not.toMatch(new RegExp(`^${name}=`, "m"));
      },
    );
  });
});

test("the PreToolUse hook outlasts the longest wait, so a late approval still reaches the tool call", async () => {
  const query = scripted([init, success]);
  const waitTimeoutMs = 120 * 60_000;
  await runSession(
    { ...config, waitTimeoutMs },
    {
      query,
      post: recorder().post,
      signal: new AbortController().signal,
      awaitDecision: noDecision,
    },
  );
  const matchers = query.calls[0]?.options.hooks?.PreToolUse ?? [];
  expect(matchers).not.toHaveLength(0);
  for (const { timeout } of matchers) {
    // seconds; a call queued behind other waits needs several wait timeouts
    expect(timeout).toBeGreaterThanOrEqual((10 * waitTimeoutMs) / 1000);
    // past 2^31-1 ms a Node timer fires at once; a tenth of that leaves room for drift in the SDK
    expect((timeout ?? 0) * 1000).toBeLessThan(2 ** 31 / 10);
  }
});

test("a stop before the session starts still aborts it", async () => {
  const { posted, post } = recorder();
  const controller = new AbortController();
  controller.abort("SIGTERM");
  const query = scripted([init, success]);
  expect(
    await runSession(config, {
      query,
      post,
      signal: controller.signal,
      awaitDecision: noDecision,
    }),
  ).toBe(1);
  expect(query.calls[0]?.options.abortController?.signal.aborted).toBe(true);
  expect(posted.at(-1)).toMatchObject({
    type: "run.failed",
    payload: { error: "interrupted by SIGTERM" },
  });
});

test("a new session passes no resume", async () => {
  const query = scripted([init, success]);
  await runSession(config, {
    query,
    post: recorder().post,
    signal: new AbortController().signal,
    awaitDecision: noDecision,
  });
  expect(query.calls[0]?.options.resume).toBeUndefined();
});

test("commits what the session left uncommitted on the agent branch", async () => {
  const query = scripted([init, success], (cwd) =>
    writeFileSync(join(cwd, "hello.txt"), "x\n"),
  );
  await runSession(config, {
    query,
    post: recorder().post,
    signal: new AbortController().signal,
    awaitDecision: noDecision,
  });
  const wt = join(root, "worktrees", "agt_1");
  expect(git(wt, "status", "--porcelain")).toBe("");
  expect(git(wt, "log", "-1", "--format=%s")).toBe("agent agt_1 run run_1");
  expect(git(wt, "rev-parse", "--abbrev-ref", "HEAD")).toBe("claude/agt_1");
});

test("an SDK error result posts run.failed with its errors and usage, still commits, and exits 1", async () => {
  const { posted, post } = recorder();
  const query = scripted(
    [
      init,
      {
        ...success,
        subtype: "error_max_turns",
        is_error: true,
        errors: ["hit max turns"],
        result: undefined,
      },
    ],
    (cwd) => writeFileSync(join(cwd, "partial.txt"), "x\n"),
  );
  const code = await runSession(config, {
    query,
    post,
    signal: new AbortController().signal,
    awaitDecision: noDecision,
  });
  expect(code).toBe(1);
  expect(posted.at(-1)).toEqual({
    runId: "run_1",
    type: "run.failed",
    payload: {
      error: "hit max turns",
      usage: {
        inputTokens: 115,
        outputTokens: 40,
        costUsd: 0.02,
        turns: 2,
        durationMs: 1235,
      },
      rollup: expect.any(Object),
    },
  });
  expect(git(join(root, "worktrees", "agt_1"), "status", "--porcelain")).toBe(
    "",
  );
});

test("an SDK that throws posts run.failed and exits 1", async () => {
  const { posted, post } = recorder();
  const query = scripted([
    init,
    new Error("Claude Code process exited with code 1"),
  ]);
  expect(
    await runSession(config, {
      query,
      post,
      signal: new AbortController().signal,
      awaitDecision: noDecision,
    }),
  ).toBe(1);
  expect(posted.at(-1)).toEqual({
    runId: "run_1",
    type: "run.failed",
    payload: {
      error: "Claude Code process exited with code 1",
      rollup: expect.any(Object),
    },
  });
});

test("a stream that ends without a result is a failure", async () => {
  const { posted, post } = recorder();
  expect(
    await runSession(config, {
      query: scripted([init]),
      post,
      signal: new AbortController().signal,
      awaitDecision: noDecision,
    }),
  ).toBe(1);
  expect(posted.at(-1)?.type).toBe("run.failed");
});

test("a worktree that can't be made fails the run before any session starts", async () => {
  const { posted, post } = recorder();
  const query = scripted([init, success]);
  const code = await runSession(
    { ...config, repoDir: join(root, "missing") },
    {
      query,
      post,
      signal: new AbortController().signal,
      awaitDecision: noDecision,
    },
  );
  expect(code).toBe(1);
  expect(query.calls).toHaveLength(0);
  expect(posted).toEqual([
    {
      runId: "run_1",
      type: "run.failed",
      payload: { error: expect.stringMatching(/worktree/) },
    },
  ]);
});

test("an abort mid-session posts run.failed naming the signal", async () => {
  const { posted, post } = recorder();
  const controller = new AbortController();
  const query = scripted([init, success]);
  const wrapped: QueryFn = (params) => {
    const inner = query(params);
    return (async function* () {
      for await (const m of inner) {
        yield m;
        // the SDK rejects its stream once its abortController fires
        controller.abort("SIGTERM");
        throw new Error("Claude Code process aborted by user");
      }
    })();
  };
  expect(
    await runSession(config, {
      query: wrapped,
      post,
      signal: controller.signal,
      awaitDecision: noDecision,
    }),
  ).toBe(1);
  expect(posted.at(-1)).toEqual({
    runId: "run_1",
    type: "run.failed",
    payload: { error: "interrupted by SIGTERM", rollup: expect.any(Object) },
  });
});

/**
 * Live resources once handles closed earlier have finished closing: libuv runs close
 * callbacks after the check phase, so the second `setImmediate` lands past them.
 */
async function liveResources() {
  await setImmediate();
  await setImmediate();
  return process.getActiveResourcesInfo().filter((r) => r !== "TTYWrap");
}

/** What `after` holds beyond `before`; a sky timer that fired meanwhile is not a leak. */
function added(before: string[], after: string[]) {
  const unmatched = [...before];
  return after.filter((r) => {
    const i = unmatched.indexOf(r);
    if (i === -1) return true;
    unmatched.splice(i, 1);
    return false;
  });
}

test("leaves no child process or other handle behind", async () => {
  const before = await liveResources();
  await runSession(config, {
    query: scripted([init, success], (cwd) =>
      writeFileSync(join(cwd, "a.txt"), "a\n"),
    ),
    post: recorder().post,
    signal: new AbortController().signal,
    awaitDecision: noDecision,
  });
  expect(added(before, await liveResources())).toEqual([]);
});

type DecisionReply = (requestId: string) => Promise<Response> | Response;

/** The API's two internal routes: events land in `sent`; each decision poll is answered by the next reply, the last one repeating. */
function api(...replies: DecisionReply[]) {
  const sent: RunnerEventPost[] = [];
  const polls: { auth: string | null; requestId: string }[] = [];
  server.use(
    http.post("https://api.test/internal/events", async ({ request }) => {
      sent.push((await request.json()) as RunnerEventPost);
      return HttpResponse.json({ id: "evt_1" }, { status: 201 });
    }),
    http.get(
      "https://api.test/internal/runs/run_1/requests/:requestId",
      ({ request, params }) => {
        const requestId = String(params.requestId);
        polls.push({ auth: request.headers.get("authorization"), requestId });
        const reply = replies[Math.min(polls.length, replies.length) - 1];
        return reply?.(requestId) ?? new HttpResponse(null, { status: 500 });
      },
    ),
  );
  const deps = {
    post: createPoster({
      apiBaseUrl: "https://api.test",
      agentToken: "agent-secret",
      warn: () => {},
      sleep: async () => {},
    }),
    awaitDecision: createDecisionWaiter({
      apiBaseUrl: "https://api.test",
      agentToken: "agent-secret",
      runId: "run_1",
      sleep: async () => {},
    }),
    signal: new AbortController().signal,
  };
  return { sent, polls, deps };
}

const pending: DecisionReply = () => HttpResponse.json({ status: "pending" });
const decided =
  (decision: object): DecisionReply =>
  (requestId) =>
    HttpResponse.json({
      status: "decided",
      decision: { requestId, ...decision },
    });

const gitPush = {
  tool_name: "Bash",
  tool_input: { command: "git push origin main", description: "Push" },
  tool_use_id: "t1",
};
/** Fires PreToolUse for `gitPush` whatever the hook answers. */
const firePush: Step = async (options) =>
  void (await fire(options, "PreToolUse", gitPush));

test("a held tool call posts approval waiting, polls past pending, and an approval lets the tool run", async () => {
  const { sent, polls, deps } = api(pending, decided({ decision: "approve" }));
  let answers: unknown[] = [];
  const query = scripted([
    init,
    async (options: Options) => {
      answers = await fire(options, "PreToolUse", gitPush);
    },
    success,
  ]);
  const code = await runSession(
    { ...config, approvalPolicy: ["Bash(git push:*)"] },
    { ...deps, query },
  );
  expect(code).toBe(0);
  expect(answers).toEqual([{ continue: true }]);
  const waiting = sent.find((e) => e.type === "run.waiting");
  expect(waiting).toEqual({
    runId: "run_1",
    type: "run.waiting",
    payload: {
      request: {
        kind: "approval",
        requestId: expect.stringMatching(/^req_[0-9A-Za-z]+$/),
        toolName: "Bash",
        toolSummary: "git push origin main",
      },
    },
  });
  const requestId =
    waiting?.type === "run.waiting" ? waiting.payload.request.requestId : "";
  expect(polls).toEqual([
    { auth: "Bearer agent-secret", requestId },
    { auth: "Bearer agent-secret", requestId },
  ]);
  expect(sent.map((e) => e.type)).toEqual([
    "run.started",
    "claude.PreToolUse",
    "run.waiting",
    "run.finished",
  ]);
});

test("a read-only Bash command runs without an approval request even under a bare Bash policy", async () => {
  const { sent, deps } = api();
  let answers: unknown[] = [];
  const query = scripted([
    init,
    async (options: Options) => {
      answers = await fire(options, "PreToolUse", {
        ...gitPush,
        tool_input: { command: "git status" },
      });
    },
    success,
  ]);
  const code = await runSession(
    { ...config, approvalPolicy: ["Bash"] },
    { ...deps, query },
  );
  expect(code).toBe(0);
  expect(answers).toEqual([{ continue: true }]);
  expect(sent.map((e) => e.type)).not.toContain("run.waiting");
});

/**
 * Fires one Bash PreToolUse per call under a bare `Bash` policy, approving whatever is held, and
 * returns the commands that waited for approval and the runner's log lines.
 */
async function bareBashRun(
  calls: (worktree: string) => { command: string; cwd?: string }[],
  autoApprove = config.autoApprove,
) {
  const { sent, deps } = api(decided({ decision: "approve" }));
  const warned: string[] = [];
  const query = scripted([
    init,
    async (options: Options) => {
      for (const [i, { command, cwd }] of calls(options.cwd ?? "").entries())
        await fire(options, "PreToolUse", {
          tool_name: "Bash",
          tool_input: { command },
          tool_use_id: `t${i + 1}`,
          ...(cwd !== undefined && { cwd }),
        });
    },
    success,
  ]);
  const code = await runSession(
    { ...config, approvalPolicy: ["Bash"], autoApprove },
    { ...deps, query, warn: (line) => warned.push(line) },
  );
  const held = sent.flatMap((e) =>
    e.type === "run.waiting" && e.payload.request.kind === "approval"
      ? [e.payload.request.toolSummary]
      : [],
  );
  return { code, held, warned };
}

test("a relative path that leaves the worktree still asks under a bare Bash policy", async () => {
  const { held } = await bareBashRun(() => [
    { command: "cat ../x" },
    { command: "cat README" },
  ]);
  expect(held).toEqual(["cat ../x"]);
});

test("relative paths resolve against the shell's cwd from the hook, not the worktree root", async () => {
  const { held } = await bareBashRun((worktree) => [
    // an earlier `cd` left the shell in the clone, outside the worktree
    { command: "cat README", cwd: join(root, "repo") },
    { command: "cat ../README", cwd: join(worktree, "sub") },
  ]);
  expect(held).toEqual(["cat README"]);
});

test("a symlink in the worktree that leads outside it still asks", async () => {
  const { held } = await bareBashRun((worktree) => {
    symlinkSync(join(root, "repo", "README"), join(worktree, "link"));
    return [{ command: "cat link" }];
  });
  expect(held).toEqual(["cat link"]);
});

test("an auto-approved call is logged by its tool use id; held and unheld calls are not", async () => {
  const { held, warned } = await bareBashRun(() => [
    { command: "git status" },
    { command: "git push origin main" },
  ]);
  expect(held).toEqual(["git push origin main"]);
  expect(warned).toEqual([
    "runner: auto-approved Bash call t1 without an approval request",
  ]);
});

test("an auto-approve check that throws holds the call for approval", async () => {
  const broken = {
    defaults: true,
    commands: 1,
  } as unknown as Config["autoApprove"];
  const { code, held, warned } = await bareBashRun(
    () => [{ command: "git status" }],
    broken,
  );
  expect(code).toBe(0);
  expect(held).toEqual(["git status"]);
  expect(warned).toEqual([]);
});

test("a long approval summary reaches run.waiting whole, for the API to redact before it trims", async () => {
  const { sent, deps } = api(decided({ decision: "approve" }));
  const command = `git push ${"x".repeat(5000)}`;
  const query = scripted([
    init,
    async (options: Options) =>
      void (await fire(options, "PreToolUse", {
        ...gitPush,
        tool_input: { command },
      })),
    success,
  ]);
  await runSession(
    { ...config, approvalPolicy: ["Bash(git push:*)"] },
    { ...deps, query },
  );
  const waiting = sent.find((e) => e.type === "run.waiting");
  expect(
    waiting?.type === "run.waiting" &&
      waiting.payload.request.kind === "approval" &&
      waiting.payload.request.toolSummary,
  ).toBe(command);
});

test("a denial blocks the tool and hands Claude the reason", async () => {
  const { deps } = api(decided({ decision: "deny", reason: "open a PR" }));
  let answers: unknown[] = [];
  const query = scripted([
    init,
    async (options: Options) => {
      answers = await fire(options, "PreToolUse", gitPush);
    },
    success,
  ]);
  await runSession(
    { ...config, approvalPolicy: ["Bash(git push:*)"] },
    { ...deps, query },
  );
  expect(answers).toEqual([
    {
      continue: true,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "open a PR",
      },
    },
  ]);
});

test("a call the policy doesn't hold never waits", async () => {
  const { sent, polls, deps } = api();
  const query = scripted([
    init,
    hook("PreToolUse", { ...gitPush, tool_input: { command: "git status" } }),
    success,
  ]);
  await runSession(
    { ...config, approvalPolicy: ["Bash(git push:*)"] },
    { ...deps, query },
  );
  expect(polls).toEqual([]);
  expect(sent.map((e) => e.type)).not.toContain("run.waiting");
});

const questions = [
  {
    question: "Which database?",
    header: "Database",
    multiSelect: false,
    options: [
      { label: "Postgres", description: "Managed, relational" },
      { label: "SQLite", description: "One file" },
    ],
  },
];

test("Claude's question posts question waiting, and the answer goes back as the tool's answers", async () => {
  const { sent, deps } = api(decided({ decision: "answer", answer: "SQLite" }));
  let permission: unknown;
  const query = scripted([
    init,
    async (options: Options) => {
      permission = await options.canUseTool?.(
        "AskUserQuestion",
        { questions },
        {
          signal: new AbortController().signal,
          toolUseID: "t1",
          requestId: "perm_1",
        },
      );
    },
    success,
  ]);
  expect(await runSession(config, { ...deps, query })).toBe(0);
  expect(sent.find((e) => e.type === "run.waiting")?.payload).toEqual({
    request: {
      kind: "question",
      requestId: expect.stringMatching(/^req_/),
      prompt:
        "Which database?\n- Postgres: Managed, relational\n- SQLite: One file",
    },
  });
  expect(permission).toEqual({
    behavior: "allow",
    updatedInput: { questions, answers: { "Which database?": "SQLite" } },
  });
});

test("a declined question tells Claude the user declined", async () => {
  const { deps } = api(decided({ decision: "deny" }));
  let permission: unknown;
  const query = scripted([
    init,
    async (options: Options) => {
      permission = await options.canUseTool?.(
        "AskUserQuestion",
        { questions },
        {
          signal: new AbortController().signal,
          toolUseID: "t1",
          requestId: "perm_1",
        },
      );
    },
    success,
  ]);
  await runSession(config, { ...deps, query });
  expect(permission).toEqual({
    behavior: "deny",
    message: "The user declined to answer.",
  });
});

test("a wait past the max aborts the session, commits, and fails the run with waiting_timeout", async () => {
  // frozen Date: the run.waiting post can't spend the 50 ms, so the poll is what expires
  vi.useFakeTimers({ toFake: ["Date"] });
  const { sent, deps } = api(async () => {
    await delay("infinite");
    return new HttpResponse(null, { status: 500 });
  });
  const timed = scripted([init, firePush, success], (cwd) =>
    writeFileSync(join(cwd, "partial.txt"), "x\n"),
  );
  const code = await runSession(
    { ...config, approvalPolicy: ["Bash"], waitTimeoutMs: 50 },
    { ...deps, query: timed },
  );
  expect(code).toBe(1);
  expect(sent.at(-1)).toEqual({
    runId: "run_1",
    type: "run.failed",
    payload: { error: "waiting_timeout", rollup: expect.any(Object) },
  });
  expect(git(join(root, "worktrees", "agt_1"), "status", "--porcelain")).toBe(
    "",
  );
});

test("a run the API already ended stops the session and posts nothing terminal", async () => {
  const { sent, deps } = api(() =>
    HttpResponse.json(
      { error: { code: "run_ended", message: "the run has ended" } },
      { status: 401 },
    ),
  );
  const code = await runSession(
    { ...config, approvalPolicy: ["Bash"] },
    { ...deps, query: scripted([init, firePush, success]) },
  );
  expect(code).toBe(1);
  expect(sent.map((e) => e.type)).toEqual([
    "run.started",
    "claude.PreToolUse",
    "run.waiting",
  ]);
});

/** Freezes `Date`; the sleep it returns moves the frozen clock forward instead of waiting. The file's afterEach restores it. */
function virtualTiming() {
  vi.useFakeTimers({ toFake: ["Date"] });
  return {
    sleep: async (ms: number) => void vi.setSystemTime(Date.now() + ms),
    random: () => 0.5,
  };
}

/**
 * The API through a redeploy, as the runner sees it: events after `run.started` meet `outage`
 * failed attempts (dropped connections and proxy 502/503s) before one lands; a poll for a request
 * the API never stored is a 404, and polls for a stored one get `pollReplies` in turn, the last
 * repeating. `virtualTime` freezes `Date` and lets each backoff pause advance it, so a small
 * `waitTimeoutMs` is spent by pauses alone and never races the real clock.
 */
function restartingApi(options: {
  outage: number;
  pollReplies: DecisionReply[];
  refuse?: (event: RunnerEventPost) => boolean;
  virtualTime?: boolean;
}) {
  const timing = options.virtualTime
    ? virtualTiming()
    : { sleep: async () => {} };
  const sent: RunnerEventPost[] = [];
  const stored = new Set<string>();
  let failures = 0;
  let polls = 0;
  const failure = () =>
    [
      HttpResponse.error(),
      new HttpResponse(null, { status: 503 }),
      new HttpResponse(null, { status: 502 }),
    ][failures++ % 3] as Response;
  server.use(
    http.post("https://api.test/internal/events", async ({ request }) => {
      const event = (await request.json()) as RunnerEventPost;
      if (options.refuse?.(event))
        return new HttpResponse(null, { status: 503 });
      if (event.type !== "run.started" && failures < options.outage)
        return failure();
      sent.push(event);
      if (event.type === "run.waiting")
        stored.add(event.payload.request.requestId);
      return HttpResponse.json({ id: "evt_1" }, { status: 201 });
    }),
    http.get(
      "https://api.test/internal/runs/run_1/requests/:requestId",
      ({ params }) => {
        const requestId = String(params.requestId);
        if (!stored.has(requestId))
          return HttpResponse.json(
            { error: { code: "not_found", message: "no such request" } },
            { status: 404 },
          );
        const replies = options.pollReplies;
        const reply = replies[Math.min(++polls, replies.length) - 1];
        return reply?.(requestId) ?? new HttpResponse(null, { status: 500 });
      },
    ),
  );
  const deps = {
    post: createPoster({
      apiBaseUrl: "https://api.test",
      agentToken: "agent-secret",
      warn: () => {},
      ...timing,
    }),
    awaitDecision: createDecisionWaiter({
      apiBaseUrl: "https://api.test",
      agentToken: "agent-secret",
      runId: "run_1",
      ...timing,
    }),
    signal: new AbortController().signal,
  };
  return { sent, deps, polls: () => polls };
}

const dropped: DecisionReply = () => HttpResponse.error();
const status =
  (code: number): DecisionReply =>
  () =>
    new HttpResponse(null, { status: code });

test("an API restart mid-approval is ridden out: the tool call is approved, and PreToolUse and run.waiting both land", async () => {
  // longer than a fixed count of tries would survive: both posts ride it out on their deadlines
  const { sent, deps } = restartingApi({
    outage: 14,
    pollReplies: [
      dropped,
      status(503),
      status(502),
      dropped,
      decided({ decision: "approve" }),
    ],
  });
  let answers: unknown[] = [];
  const query = scripted([
    init,
    async (options: Options) => {
      answers = await fire(options, "PreToolUse", gitPush);
    },
    success,
  ]);
  const code = await runSession(
    { ...config, approvalPolicy: ["Bash"] },
    { ...deps, query },
  );
  expect(answers).toEqual([{ continue: true }]);
  expect(code).toBe(0);
  expect(sent.map((e) => e.type)).toEqual([
    "run.started",
    "claude.PreToolUse",
    "run.waiting",
    "run.finished",
  ]);
});

test("a stop cuts a claude.PreToolUse retry short, so run.failed goes out without waiting out its budget", async () => {
  // virtual time: every backoff pause advances it, and holds until the stop has happened
  let time = 0;
  let markStopped!: () => void;
  const stopHappened = new Promise<void>((resolve) => {
    markStopped = resolve;
  });
  let failedAt: number | undefined;
  server.use(
    http.post("https://api.test/internal/events", async ({ request }) => {
      const event = (await request.json()) as RunnerEventPost;
      if (event.type === "claude.PreToolUse")
        return new HttpResponse(null, { status: 503 });
      if (event.type === "run.failed") failedAt ??= time;
      return HttpResponse.json({ id: "evt_1" }, { status: 201 });
    }),
  );
  const controller = new AbortController();
  const query = scripted([
    init,
    hook("PreToolUse", gitPush),
    async () => {
      controller.abort("SIGTERM");
      markStopped();
    },
    success,
  ]);
  const code = await runSession(config, {
    query,
    post: createPoster({
      apiBaseUrl: "https://api.test",
      agentToken: "agent-secret",
      warn: () => {},
      now: () => time,
      random: () => 0.5,
      sleep: async (ms: number) => {
        time += ms;
        await stopHappened;
      },
    }),
    awaitDecision: noDecision,
    signal: controller.signal,
  });
  expect(code).toBe(1);
  expect(failedAt).toBeLessThan(1_000);
});

test("a stop still sends Claude's queued activity to a healthy API, the teardown's interrupt included, before run.failed", async () => {
  const sent: RunnerEventPost[] = [];
  server.use(
    http.post("https://api.test/internal/events", async ({ request }) => {
      await delay(20);
      sent.push((await request.json()) as RunnerEventPost);
      return HttpResponse.json({ id: "evt_1" }, { status: 201 });
    }),
  );
  const controller = new AbortController();
  const query = scripted([
    init,
    hook("PostToolUse", {
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_response: "a.ts",
      tool_use_id: "t1",
    }),
    assistant({ type: "text", text: "Listed." }),
    async (options: Options) => {
      controller.abort("SIGTERM");
      await fire(options, "PostToolUseFailure", {
        tool_name: "Bash",
        tool_input: { command: "sleep 9" },
        tool_use_id: "t2",
        error: "interrupted",
        is_interrupt: true,
      });
    },
    success,
  ]);
  const code = await runSession(config, {
    query,
    post: createPoster({
      apiBaseUrl: "https://api.test",
      agentToken: "agent-secret",
      warn: () => {},
      sleep: async () => {},
    }),
    awaitDecision: noDecision,
    signal: controller.signal,
  });
  expect(code).toBe(1);
  expect(sent.map((e) => e.type)).toEqual([
    "run.started",
    "claude.PostToolUse",
    "claude.Message",
    "claude.PostToolUseFailure",
    "run.failed",
  ]);
});

test("a run the API ended before its run.waiting landed stops the session and posts nothing terminal", async () => {
  const tried: string[] = [];
  server.use(
    http.post("https://api.test/internal/events", async ({ request }) => {
      const event = (await request.json()) as RunnerEventPost;
      tried.push(event.type);
      if (event.type === "run.waiting" || event.type === "run.failed")
        return HttpResponse.json(
          { error: { code: "run_ended", message: "the run has ended" } },
          { status: 401 },
        );
      return HttpResponse.json({ id: "evt_1" }, { status: 201 });
    }),
  );
  let answers: unknown[] = [];
  const query = scripted([
    init,
    async (options: Options) => {
      answers = await fire(options, "PreToolUse", gitPush);
    },
    success,
  ]);
  const code = await runSession(
    { ...config, approvalPolicy: ["Bash"] },
    {
      query,
      post: createPoster({
        apiBaseUrl: "https://api.test",
        agentToken: "agent-secret",
        warn: () => {},
        sleep: async () => {},
      }),
      awaitDecision: noDecision,
      signal: new AbortController().signal,
    },
  );
  expect(code).toBe(1);
  expect(answers).toEqual([stopped(/run ended while waiting/)]);
  expect(tried).toEqual(["run.started", "claude.PreToolUse", "run.waiting"]);
});

/** What the gate answers when the run has to end without a decision: a stop, not the person's denial. */
const stopped = (reason: RegExp) => ({
  continue: false,
  stopReason: expect.stringMatching(reason),
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: expect.stringMatching(reason),
  },
});

test("the SDK cancelling a held call's hook denies that call without claiming the run is ending", async () => {
  const { deps } = api(async () => {
    await delay(20);
    return HttpResponse.json({ status: "pending" });
  });
  let answer: unknown;
  const query = scripted([
    init,
    async (options: Options) => {
      const [gate] = options.hooks?.PreToolUse?.[0]?.hooks ?? [];
      const cancel = new AbortController();
      setTimeout(() => cancel.abort(new Error("hook timed out")), 50);
      answer = await gate?.(
        {
          session_id: "sess-new",
          transcript_path: "/t.jsonl",
          cwd: options.cwd ?? "",
          hook_event_name: "PreToolUse",
          ...gitPush,
        } as HookInput,
        "toolu_1",
        { signal: cancel.signal },
      );
    },
    success,
  ]);
  const code = await runSession(
    { ...config, approvalPolicy: ["Bash"] },
    { ...deps, query },
  );
  expect(answer).toEqual({
    continue: true,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "The approval wait was cancelled.",
    },
  });
  expect(code).toBe(0);
});

test("the SDK cancelling Claude's question declines it without interrupting the session", async () => {
  const { deps } = api(async () => {
    await delay(20);
    return HttpResponse.json({ status: "pending" });
  });
  let permission: unknown;
  const query = scripted([
    init,
    async (options: Options) => {
      const cancel = new AbortController();
      setTimeout(() => cancel.abort(new Error("cancelled")), 50);
      permission = await options.canUseTool?.(
        "AskUserQuestion",
        { questions },
        { signal: cancel.signal, toolUseID: "t1", requestId: "perm_1" },
      );
    },
    success,
  ]);
  expect(await runSession(config, { ...deps, query })).toBe(0);
  expect(permission).toEqual({
    behavior: "deny",
    message: "The approval wait was cancelled.",
  });
});

test("an API unreachable for the whole wait fails the run naming it, and stops the session instead of denying the call", async () => {
  const { sent, deps } = restartingApi({
    outage: 0,
    pollReplies: [dropped, status(503), status(502)],
    virtualTime: true,
  });
  let answers: unknown[] = [];
  const query = scripted([
    init,
    async (options: Options) => {
      answers = await fire(options, "PreToolUse", gitPush);
    },
    success,
  ]);
  const code = await runSession(
    { ...config, approvalPolicy: ["Bash"], waitTimeoutMs: 100 },
    { ...deps, query },
  );
  expect(code).toBe(1);
  expect(answers).toEqual([stopped(/API unreachable/)]);
  expect(sent.at(-1)).toEqual({
    runId: "run_1",
    type: "run.failed",
    payload: {
      error: expect.stringMatching(
        /^API unreachable while waiting for request req_[0-9a-f]+: /,
      ),
      rollup: expect.any(Object),
    },
  });
});

test("a run.waiting that never lands fails the run before any poll, and stops the session instead of denying the call", async () => {
  const { sent, deps, polls } = restartingApi({
    outage: 0,
    pollReplies: [decided({ decision: "approve" })],
    refuse: (event) => event.type === "run.waiting",
    virtualTime: true,
  });
  let answers: unknown[] = [];
  const query = scripted([
    init,
    async (options: Options) => {
      answers = await fire(options, "PreToolUse", gitPush);
    },
    success,
  ]);
  const code = await runSession(
    { ...config, approvalPolicy: ["Bash"], waitTimeoutMs: 100 },
    { ...deps, query },
  );
  expect(code).toBe(1);
  expect(answers).toEqual([stopped(/run\.waiting/)]);
  expect(polls()).toBe(0);
  expect(sent.at(-1)).toMatchObject({
    type: "run.failed",
    payload: {
      error: expect.stringMatching(/run\.waiting .*not recorded.*HTTP 503/),
    },
  });
});

test("a request the API lost fails the run instead of denying the call", async () => {
  const { sent, deps } = api((requestId) =>
    HttpResponse.json(
      { error: { code: "not_found", message: `no request ${requestId}` } },
      { status: 404 },
    ),
  );
  let answers: unknown[] = [];
  const query = scripted([
    init,
    async (options: Options) => {
      answers = await fire(options, "PreToolUse", gitPush);
    },
    success,
  ]);
  const code = await runSession(
    { ...config, approvalPolicy: ["Bash"] },
    { ...deps, query },
  );
  expect(code).toBe(1);
  expect(answers).toEqual([stopped(/never recorded/)]);
  expect(sent.at(-1)).toMatchObject({
    type: "run.failed",
    payload: { error: expect.stringMatching(/never recorded/) },
  });
});

test("Claude's question with the API unreachable interrupts the session rather than declining", async () => {
  const { deps } = restartingApi({
    outage: 0,
    pollReplies: [status(503)],
    virtualTime: true,
  });
  let permission: unknown;
  const query = scripted([
    init,
    async (options: Options) => {
      permission = await options.canUseTool?.(
        "AskUserQuestion",
        { questions },
        {
          signal: new AbortController().signal,
          toolUseID: "t1",
          requestId: "perm_1",
        },
      );
    },
    success,
  ]);
  expect(
    await runSession({ ...config, waitTimeoutMs: 100 }, { ...deps, query }),
  ).toBe(1);
  expect(permission).toEqual({
    behavior: "deny",
    interrupt: true,
    message: expect.stringMatching(/API unreachable/),
  });
});

/** A poll the API holds for a moment, as it does while nobody has decided. */
const heldPending: DecisionReply = async () => {
  await delay(20);
  return HttpResponse.json({ status: "pending" });
};

test("a stop while a gated call awaits its decision answers continue:false naming the stop, not the person's denial", async () => {
  const { deps } = api(heldPending);
  const controller = new AbortController();
  let answers: unknown[] = [];
  const query = scripted([
    init,
    async (options: Options) => {
      setTimeout(() => controller.abort("SIGTERM"), 50);
      answers = await fire(options, "PreToolUse", gitPush);
    },
    success,
  ]);
  const code = await runSession(
    { ...config, approvalPolicy: ["Bash"] },
    { ...deps, query, signal: controller.signal },
  );
  expect(code).toBe(1);
  expect(answers).toEqual([stopped(/it was stopped/)]);
});

test("a stop while Claude's question awaits its answer denies with interrupt, not a plain decline", async () => {
  const { deps } = api(heldPending);
  const controller = new AbortController();
  let permission: unknown;
  const query = scripted([
    init,
    async (options: Options) => {
      setTimeout(() => controller.abort("SIGTERM"), 50);
      permission = await options.canUseTool?.(
        "AskUserQuestion",
        { questions },
        {
          signal: new AbortController().signal,
          toolUseID: "t1",
          requestId: "perm_1",
        },
      );
    },
    success,
  ]);
  const code = await runSession(config, {
    ...deps,
    query,
    signal: controller.signal,
  });
  expect(code).toBe(1);
  expect(permission).toEqual({
    behavior: "deny",
    interrupt: true,
    message: expect.stringMatching(/it was stopped/),
  });
});

test("a run.waiting stored by the API whose response was lost is retried, answered request_open, and still decided under one requestId", async () => {
  const opened: string[] = [];
  const polled: string[] = [];
  server.use(
    http.post("https://api.test/internal/events", async ({ request }) => {
      const event = (await request.json()) as RunnerEventPost;
      if (event.type !== "run.waiting")
        return HttpResponse.json({ id: "evt_1" }, { status: 201 });
      opened.push(event.payload.request.requestId);
      // the first open was stored, but its response never arrived
      if (opened.length === 1) return HttpResponse.error();
      return HttpResponse.json(
        { error: { code: "request_open", message: "open" } },
        { status: 409 },
      );
    }),
    http.get(
      "https://api.test/internal/runs/run_1/requests/:requestId",
      ({ params }) => {
        const requestId = String(params.requestId);
        polled.push(requestId);
        return opened.includes(requestId)
          ? decided({ decision: "approve" })(requestId)
          : HttpResponse.json(
              { error: { code: "not_found", message: "no such request" } },
              { status: 404 },
            );
      },
    ),
  );
  const timing = { sleep: async () => {} };
  let answers: unknown[] = [];
  const code = await runSession(
    { ...config, approvalPolicy: ["Bash"] },
    {
      query: scripted([
        init,
        async (options: Options) => {
          answers = await fire(options, "PreToolUse", gitPush);
        },
        success,
      ]),
      post: createPoster({
        apiBaseUrl: "https://api.test",
        agentToken: "agent-secret",
        warn: () => {},
        ...timing,
      }),
      awaitDecision: createDecisionWaiter({
        apiBaseUrl: "https://api.test",
        agentToken: "agent-secret",
        runId: "run_1",
        ...timing,
      }),
      signal: new AbortController().signal,
    },
  );
  expect(code).toBe(0);
  expect(answers).toEqual([{ continue: true }]);
  expect(opened).toHaveLength(2);
  expect(new Set(opened).size).toBe(1);
  expect(polled).toEqual([opened[0]]);
});

const rollupOf = (event: RunnerEventPost | undefined) =>
  event?.type === "run.finished" || event?.type === "run.failed"
    ? event.payload.rollup
    : undefined;

test("run.finished carries the rollup: this run's commit, and the branch's commits since base", async () => {
  const worktree = join(root, "worktrees", "agt_1");
  const base = git(join(root, "repo"), "rev-parse", "origin/HEAD");
  const first = recorder();
  await runSession(config, {
    query: scripted([init, success], (cwd) =>
      writeFileSync(join(cwd, "hello.txt"), "hi\n"),
    ),
    post: first.post,
    signal: new AbortController().signal,
    awaitDecision: noDecision,
  });
  const firstSha = git(worktree, "rev-parse", "HEAD");
  const firstRun = {
    commits: [{ sha: firstSha, subject: "agent agt_1 run run_1" }],
    files: 1,
    added: 1,
    removed: 0,
  };
  expect(rollupOf(first.posted.at(-1))).toEqual({
    base,
    run: firstRun,
    cumulative: firstRun,
  });

  const second = recorder();
  await runSession(
    { ...config, runId: "run_2" },
    {
      query: scripted([init, success], (cwd) =>
        writeFileSync(join(cwd, "hello.txt"), "hello\n"),
      ),
      post: second.post,
      signal: new AbortController().signal,
      awaitDecision: noDecision,
    },
  );
  const secondSha = git(worktree, "rev-parse", "HEAD");
  expect(rollupOf(second.posted.at(-1))).toEqual({
    base,
    run: {
      commits: [{ sha: secondSha, subject: "agent agt_1 run run_2" }],
      files: 1,
      added: 1,
      removed: 1,
    },
    cumulative: {
      commits: [
        { sha: secondSha, subject: "agent agt_1 run run_2" },
        { sha: firstSha, subject: "agent agt_1 run run_1" },
      ],
      files: 1,
      added: 1,
      removed: 0,
    },
  });
});

test("a run that changed nothing finishes with an empty run rollup", async () => {
  const { posted, post } = recorder();
  await runSession(config, {
    query: scripted([init, success]),
    post,
    signal: new AbortController().signal,
    awaitDecision: noDecision,
  });
  const empty = { commits: [], files: 0, added: 0, removed: 0 };
  expect(rollupOf(posted.at(-1))).toEqual({
    base: git(join(root, "repo"), "rev-parse", "origin/HEAD"),
    run: empty,
    cumulative: empty,
  });
});

test("run.failed still carries the rollup of what the run committed", async () => {
  const { posted, post } = recorder();
  const code = await runSession(config, {
    query: scripted(
      [init, new Error("Claude Code process exited with code 1")],
      (cwd) => writeFileSync(join(cwd, "partial.txt"), "x\n"),
    ),
    post,
    signal: new AbortController().signal,
    awaitDecision: noDecision,
  });
  expect(code).toBe(1);
  expect(posted.at(-1)).toMatchObject({
    type: "run.failed",
    payload: {
      error: "Claude Code process exited with code 1",
      rollup: {
        run: {
          commits: [{ subject: "agent agt_1 run run_1" }],
          files: 1,
          added: 1,
          removed: 0,
        },
      },
    },
  });
});

test("a rollup that can't be computed is left off with one warning; the run still finishes", async () => {
  const { posted, post } = recorder();
  const warnings: string[] = [];
  const code = await runSession(config, {
    // without origin/HEAD there is no base to diff against
    query: scripted([init, success], () =>
      git(join(root, "repo"), "remote", "set-head", "origin", "--delete"),
    ),
    post,
    signal: new AbortController().signal,
    awaitDecision: noDecision,
    warn: (line) => warnings.push(line),
  });
  expect(code).toBe(0);
  expect(posted.at(-1)?.type).toBe("run.finished");
  expect(rollupOf(posted.at(-1))).toBeUndefined();
  expect(warnings).toEqual([
    expect.stringMatching(/^runner: rollup skipped: /),
  ]);
});

const pause =
  (ms: number): Step =>
  () =>
    new Promise((resolve) => setTimeout(resolve, ms));
/** A step that waits for `check` to pass, however slow the machine; the heartbeat tests pace on it, not on a clock. */
const until =
  (check: () => void): Step =>
  () =>
    vi.waitFor(check, { timeout: 10_000, interval: 5 });
const bash = (id: string) => ({
  tool_name: "Bash",
  tool_input: { command: "pnpm build" },
  tool_use_id: id,
});
const beatsIn = (posted: RunnerEventPost[]) =>
  posted.flatMap((e) => (e.type === "runner.heartbeat" ? [e.payload] : []));
/** Long against the 25 ms beat: a heartbeat that should be silent has had several chances to post. */
const QUIET_MS = 200;

test("a tool call in flight is reported as runner.heartbeat with its name and how long it has run, and stops when it returns", async () => {
  const { posted, post } = recorder();
  const query = scripted([
    init,
    hook("PreToolUse", bash("t1")),
    until(() => expect(beatsIn(posted).length).toBeGreaterThanOrEqual(3)),
    hook("PostToolUse", { ...bash("t1"), tool_response: "ok" }),
    pause(QUIET_MS),
    success,
  ]);
  const code = await runSession(config, {
    query,
    post,
    signal: new AbortController().signal,
    awaitDecision: noDecision,
    heartbeatMs: 25,
  });
  expect(code).toBe(0);
  const beats = posted.filter((e) => e.type === "runner.heartbeat");
  for (const beat of beats) {
    expect(beat).toEqual({
      runId: "run_1",
      type: "runner.heartbeat",
      payload: {
        toolName: "Bash",
        toolUseId: "t1",
        elapsedMs: expect.any(Number),
      },
    });
  }
  const elapsed = beatsIn(posted).map((b) => b.elapsedMs);
  expect(elapsed).toEqual([...elapsed].sort((a, b) => a - b));
  expect(elapsed.at(-1)).toBeGreaterThan(elapsed[0] ?? 0);
  // none after the call returned: its PostToolUse is the last thing before the quiet pause
  const types = posted.map((e) => e.type);
  const returned = types.indexOf("claude.PostToolUse");
  expect(types.slice(returned)).not.toContain("runner.heartbeat");
});

test("with several tool calls in flight the heartbeat names the longest-running; with none, it is silent", async () => {
  const { posted, post } = recorder();
  let secondStarted = 0;
  const query = scripted([
    init,
    pause(QUIET_MS),
    hook("PreToolUse", bash("t1")),
    until(() => expect(beatsIn(posted).length).toBeGreaterThanOrEqual(1)),
    hook("PreToolUse", bash("t2")),
    async () => {
      secondStarted = beatsIn(posted).length;
    },
    until(() =>
      expect(beatsIn(posted).length).toBeGreaterThanOrEqual(secondStarted + 3),
    ),
    hook("PostToolUse", { ...bash("t1"), tool_response: "ok" }),
    hook("PostToolUseFailure", { ...bash("t2"), error: "x" }),
    pause(QUIET_MS),
    success,
  ]);
  await runSession(config, {
    query,
    post,
    signal: new AbortController().signal,
    awaitDecision: noDecision,
    heartbeatMs: 25,
  });
  const types = posted.map((e) => e.type);
  // silent before any call ran
  expect(types.slice(0, types.indexOf("claude.PreToolUse"))).not.toContain(
    "runner.heartbeat",
  );
  // t2 started after t1, so every beat, those with both in flight included, names t1
  expect(new Set(beatsIn(posted).map((b) => b.toolUseId))).toEqual(
    new Set(["t1"]),
  );
  expect(types.slice(types.indexOf("claude.PostToolUseFailure"))).not.toContain(
    "runner.heartbeat",
  );
});

/** An assistant message of the model response `id` making the tool calls `toolUseIds`, as the SDK emits it. */
const turn = (id: string, ...toolUseIds: string[]) => ({
  ...assistant(),
  message: {
    id,
    content: [
      { type: "text", text: "next" },
      ...toolUseIds.map((toolUseId) => ({
        type: "tool_use",
        id: toolUseId,
        name: "Bash",
        input: {},
      })),
    ],
  },
});

/** An assistant message of subagent `agentId`'s model response `id`, as the SDK emits it. */
const subagentTurn = (
  agentId: string,
  id: string,
  ...toolUseIds: string[]
) => ({
  ...turn(id, ...toolUseIds),
  parent_tool_use_id: "agent-call",
  agent_id: agentId,
});

test("a call that never gets an end hook stops being beaten for once the session starts its next turn", async () => {
  const { posted, post } = recorder();
  let beatsBefore = 0;
  const toolSearch = { ...bash("t1"), tool_name: "ToolSearch" };
  const query = scripted([
    init,
    turn("m1", "t1"),
    hook("PreToolUse", toolSearch),
    until(() => expect(beatsIn(posted).length).toBeGreaterThanOrEqual(2)),
    turn("m2"),
    async () => {
      beatsBefore = beatsIn(posted).length;
    },
    pause(QUIET_MS),
    success,
  ]);
  await runSession(config, {
    query,
    post,
    signal: new AbortController().signal,
    awaitDecision: noDecision,
    heartbeatMs: 25,
  });
  expect(beatsIn(posted).length).toBe(beatsBefore);
});

test("parallel calls of one turn keep beating across its split messages", async () => {
  const { posted, post } = recorder();
  const query = scripted([
    init,
    turn("m1", "t1"),
    hook("PreToolUse", bash("t1")),
    turn("m1", "t2"),
    hook("PreToolUse", bash("t2")),
    hook("PostToolUse", { ...bash("t2"), tool_response: "ok" }),
    until(() => expect(beatsIn(posted).length).toBeGreaterThanOrEqual(3)),
    hook("PostToolUse", { ...bash("t1"), tool_response: "ok" }),
    success,
  ]);
  await runSession(config, {
    query,
    post,
    signal: new AbortController().signal,
    awaitDecision: noDecision,
    heartbeatMs: 25,
  });
  expect(new Set(beatsIn(posted).map((b) => b.toolUseId))).toEqual(
    new Set(["t1"]),
  );
});

test("a call whose hook runs before the session reads the response that made it keeps beating through that turn change", async () => {
  const { posted, post } = recorder();
  const query = scripted([
    init,
    turn("m1", "t1"),
    hook("PreToolUse", bash("t1")),
    hook("PostToolUse", { ...bash("t1"), tool_response: "ok" }),
    // the SDK answers hooks as it reads them, but queues m2 behind the loop
    hook("PreToolUse", bash("t2")),
    turn("m2", "t2"),
    until(() =>
      expect(
        beatsIn(posted).filter((b) => b.toolUseId === "t2").length,
      ).toBeGreaterThanOrEqual(2),
    ),
    hook("PostToolUse", { ...bash("t2"), tool_response: "ok" }),
    success,
  ]);
  const code = await runSession(config, {
    query,
    post,
    signal: new AbortController().signal,
    awaitDecision: noDecision,
    heartbeatMs: 25,
  });
  expect(code).toBe(0);
  expect(beatsIn(posted).map((b) => b.toolUseId)).toContain("t2");
});

test("a subagent's responses mid-call don't end a main-thread call", async () => {
  const { posted, post } = recorder();
  let beatsBefore = 0;
  const query = scripted([
    init,
    turn("m1", "t1"),
    hook("PreToolUse", bash("t1")),
    until(() => expect(beatsIn(posted).length).toBeGreaterThanOrEqual(1)),
    subagentTurn("sub_1", "s1"),
    subagentSays("agent-call", "looking"),
    subagentTurn("sub_1", "s2"),
    async () => {
      beatsBefore = beatsIn(posted).length;
    },
    until(() =>
      expect(beatsIn(posted).length).toBeGreaterThanOrEqual(beatsBefore + 2),
    ),
    hook("PostToolUse", { ...bash("t1"), tool_response: "ok" }),
    success,
  ]);
  const code = await runSession(config, {
    query,
    post,
    signal: new AbortController().signal,
    awaitDecision: noDecision,
    heartbeatMs: 25,
  });
  expect(code).toBe(0);
  expect(new Set(beatsIn(posted).map((b) => b.toolUseId))).toEqual(
    new Set(["t1"]),
  );
});

test("a background subagent's call that never gets an end hook stops being beaten for at the subagent's next turn", async () => {
  const { posted, post } = recorder();
  let beatsBefore = 0;
  const toolSearch = {
    ...bash("t1"),
    tool_name: "ToolSearch",
    agent_id: "sub_1",
  };
  const query = scripted([
    init,
    backgroundTasks(1),
    subagentTurn("sub_1", "s1", "t1"),
    hook("PreToolUse", toolSearch),
    until(() =>
      expect(
        beatsIn(posted).filter((b) => b.toolName === "ToolSearch").length,
      ).toBeGreaterThanOrEqual(2),
    ),
    subagentTurn("sub_1", "s2"),
    async () => {
      beatsBefore = beatsIn(posted).length;
    },
    until(() =>
      expect(beatsIn(posted).length).toBeGreaterThanOrEqual(beatsBefore + 2),
    ),
    backgroundTasks(0),
    success,
  ]);
  await runSession(config, {
    query,
    post,
    signal: new AbortController().signal,
    awaitDecision: noDecision,
    heartbeatMs: 25,
  });
  // the session is waiting on the subagent's task now, not on the call it lost the end of
  expect(
    new Set(
      beatsIn(posted)
        .slice(beatsBefore)
        .map((b) => b.toolName),
    ),
  ).toEqual(new Set(["Bash (background)"]));
  expect(
    new Set(
      beatsIn(posted)
        .slice(beatsBefore)
        .map((b) => b.toolUseId),
    ),
  ).toEqual(new Set(["t0"]));
});

test("a run waiting on a background task beats as 'Bash (background)' until the task ends", async () => {
  const { posted, post } = recorder();
  let beatsBefore = 0;
  const query = scripted([
    init,
    turn("m1", "t1"),
    hook("PreToolUse", { ...bash("t1"), tool_input: { command: "pnpm test" } }),
    hook("PostToolUse", { ...bash("t1"), tool_response: "started" }),
    backgroundTasks(1),
    until(() => expect(beatsIn(posted).length).toBeGreaterThanOrEqual(3)),
    backgroundTasks(0),
    async () => {
      beatsBefore = beatsIn(posted).length;
    },
    pause(QUIET_MS),
    success,
  ]);
  await runSession(config, {
    query,
    post,
    signal: new AbortController().signal,
    awaitDecision: noDecision,
    heartbeatMs: 25,
  });
  expect(new Set(beatsIn(posted).map((b) => b.toolName))).toEqual(
    new Set(["Bash (background)"]),
  );
  // the beat names the task itself (backgroundTasks ids it t0), not the finished call t1
  expect(new Set(beatsIn(posted).map((b) => b.toolUseId))).toEqual(
    new Set(["t0"]),
  );
  expect(beatsIn(posted).length).toBe(beatsBefore);
});

test("an ambient background task, which the run doesn't wait on, is not beaten for", async () => {
  const { posted, post } = recorder();
  const query = scripted([
    init,
    backgroundTasks(1, true),
    pause(QUIET_MS),
    success,
  ]);
  const code = await runSession(config, {
    query,
    post,
    signal: new AbortController().signal,
    awaitDecision: noDecision,
    heartbeatMs: 25,
  });
  expect(code).toBe(0);
  expect(beatsIn(posted)).toEqual([]);
});

test("a call held for approval is not beaten for until it is approved and runs", async () => {
  const { posted, post } = recorder();
  let approve: (() => void) | undefined;
  let beatsWhileHeld: unknown[] | undefined;
  const query = scripted([
    init,
    async (options: Options) => {
      const gated = fire(options, "PreToolUse", bash("t1"));
      await vi.waitFor(() => expect(approve).toBeDefined());
      await pause(QUIET_MS)(options);
      beatsWhileHeld = beatsIn(posted);
      approve?.();
      expect(await gated).toEqual([{ continue: true }]);
    },
    until(() => expect(beatsIn(posted).length).toBeGreaterThanOrEqual(2)),
    hook("PostToolUse", { ...bash("t1"), tool_response: "ok" }),
    success,
  ]);
  const code = await runSession(
    { ...config, approvalPolicy: ["Bash"] },
    {
      query,
      post,
      signal: new AbortController().signal,
      awaitDecision: () =>
        new Promise((resolve) => {
          approve = () =>
            resolve({
              kind: "decided",
              decision: { requestId: "req_x", decision: "approve" },
            });
        }),
      heartbeatMs: 25,
    },
  );
  expect(code).toBe(0);
  expect(beatsWhileHeld).toEqual([]);
  expect(posted.map((e) => e.type)).toContain("runner.heartbeat");
});

test("a denied call is never beaten for", async () => {
  const { posted, post } = recorder();
  const query = scripted([
    init,
    async (options: Options) => {
      await fire(options, "PreToolUse", bash("t1"));
      await pause(QUIET_MS)(options);
    },
    success,
  ]);
  await runSession(
    { ...config, approvalPolicy: ["Bash"] },
    {
      query,
      post,
      signal: new AbortController().signal,
      awaitDecision: async () => ({
        kind: "decided",
        decision: { requestId: "req_x", decision: "deny" },
      }),
      heartbeatMs: 25,
    },
  );
  expect(posted.map((e) => e.type)).toContain("run.waiting");
  expect(posted.map((e) => e.type)).not.toContain("runner.heartbeat");
});

test("Claude's question is a wait for a person, not a tool running: it is never beaten for", async () => {
  const { posted, post } = recorder();
  const query = scripted([
    init,
    hook("PreToolUse", {
      tool_name: "AskUserQuestion",
      tool_input: { questions },
      tool_use_id: "q1",
    }),
    // the SDK holds the call in canUseTool for the answer, and a declined one may never fire PostToolUse
    pause(QUIET_MS),
    hook("PreToolUse", bash("t1")),
    until(() => expect(beatsIn(posted).length).toBeGreaterThanOrEqual(1)),
    hook("PostToolUse", { ...bash("t1"), tool_response: "ok" }),
    success,
  ]);
  await runSession(config, {
    query,
    post,
    signal: new AbortController().signal,
    awaitDecision: noDecision,
    heartbeatMs: 25,
  });
  // a later call's beats name that call, not the question left in flight
  expect(new Set(beatsIn(posted).map((b) => b.toolUseId))).toEqual(
    new Set(["t1"]),
  );
  const types = posted.map((e) => e.type);
  expect(types.slice(0, types.lastIndexOf("claude.PreToolUse"))).not.toContain(
    "runner.heartbeat",
  );
});

test("a heartbeat the API refuses gets one attempt, so an outage never queues its retries ahead of run.finished", async () => {
  const beats: number[] = [];
  const sent: string[] = [];
  server.use(
    http.post("https://api.test/internal/events", async ({ request }) => {
      const event = (await request.json()) as RunnerEventPost;
      if (event.type !== "runner.heartbeat") {
        sent.push(event.type);
        return new HttpResponse(null, { status: 204 });
      }
      beats.push(event.payload.elapsedMs);
      return new HttpResponse(null, { status: 503 });
    }),
  );
  const post = createPoster({
    apiBaseUrl: "https://api.test",
    agentToken: "agent-secret",
    warn: () => {},
    sleep: async () => {},
  });
  const query = scripted([
    init,
    hook("PreToolUse", bash("t1")),
    until(() => expect(beats.length).toBeGreaterThanOrEqual(3)),
    hook("PostToolUse", { ...bash("t1"), tool_response: "ok" }),
    success,
  ]);
  const code = await runSession(config, {
    query,
    post,
    signal: new AbortController().signal,
    awaitDecision: noDecision,
    heartbeatMs: 25,
  });
  expect(code).toBe(0);
  // a retry would resend the same beat, its elapsedMs repeated
  expect(new Set(beats).size).toBe(beats.length);
  expect(sent.at(-1)).toBe("run.finished");
});

describe("the base profile's MCP servers", () => {
  const profile: Config["mcpServers"] = {
    doop: {
      url: "https://doop.test/mcp",
      headers: { Authorization: "DOOP_KEY" },
    },
    notes: {
      command: "notes-mcp",
      args: ["--stdio"],
      env: { NOTES_TOKEN: "NOTES_SECRET" },
    },
  };
  const secrets = {
    DOOP_KEY: "Bearer doop-secret-value",
    NOTES_SECRET: "n-secret-value",
  };
  let home: string;
  let claudeDir: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sky-home-"));
    claudeDir = mkdtempSync(join(tmpdir(), "sky-claude-dir-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(claudeDir, { recursive: true, force: true });
  });

  const userConfig = (servers: object) =>
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ mcpServers: servers }),
    );
  const run = async (extraEnv: NodeJS.ProcessEnv = {}) => {
    const query = scripted([init, success]);
    const rec = recorder();
    const warn = vi.fn();
    await runSession(
      { ...config, mcpServers: profile },
      {
        query,
        post: rec.post,
        warn,
        signal: new AbortController().signal,
        awaitDecision: noDecision,
        env: { HOME: home, ...secrets, ...extraEnv },
      },
    );
    return { query, rec, warn };
  };
  const warnings = (rec: ReturnType<typeof recorder>) =>
    rec.posted.filter((e) => e.type === "runner.warning");
  const firstWarning = (rec: ReturnType<typeof recorder>): string => {
    const [event] = warnings(rec);
    return event?.type === "runner.warning" ? event.payload.message : "";
  };

  test("the session gets them with each secret resolved from the run's env", async () => {
    userConfig({ doop: {}, notes: {} });
    const { query } = await run();
    expect(query.calls[0]?.options.mcpServers).toEqual({
      doop: {
        type: "http",
        url: "https://doop.test/mcp",
        headers: { Authorization: "Bearer doop-secret-value" },
      },
      notes: {
        type: "stdio",
        command: "notes-mcp",
        args: ["--stdio"],
        env: { NOTES_TOKEN: "n-secret-value" },
      },
    });
  });

  test("one removed from the config is in the next session, with one warning that names it and no value", async () => {
    userConfig({ notes: {} });
    const { query, rec, warn } = await run();
    expect(Object.keys(query.calls[0]?.options.mcpServers ?? {})).toEqual([
      "doop",
      "notes",
    ]);
    const posted = warnings(rec);
    expect(posted).toHaveLength(1);
    expect(firstWarning(rec)).toBe(
      "base-profile MCP server missing from the sprite's config: doop; passed to this session directly. Reprovision the sprite to restore it.",
    );
    const everything = JSON.stringify([rec.posted, warn.mock.calls]);
    for (const value of Object.values(secrets))
      expect(everything).not.toContain(value);
    expect(everything).not.toContain("Authorization");
  });

  test("all present: no warning, and the config file is left as it was", async () => {
    userConfig({ doop: { marker: 1 }, notes: {} });
    const before = readFileSync(join(home, ".claude.json"), "utf8");
    const { rec } = await run();
    expect(warnings(rec)).toEqual([]);
    expect(readFileSync(join(home, ".claude.json"), "utf8")).toBe(before);
  });

  const bothMissing =
    "base-profile MCP servers missing from the sprite's config: doop, notes; passed to this session directly. Reprovision the sprite to restore them.";

  test("an unreadable config counts every server as missing", async () => {
    writeFileSync(join(home, ".claude.json"), "{ half a wri");
    const { rec } = await run();
    expect(firstWarning(rec)).toBe(bothMissing);
  });

  test("no config file counts every server as missing", async () => {
    const { rec } = await run();
    expect(firstWarning(rec)).toBe(bothMissing);
  });

  test("CLAUDE_CONFIG_DIR, not HOME, is where the config is read", async () => {
    userConfig({});
    writeFileSync(
      join(claudeDir, ".claude.json"),
      JSON.stringify({ mcpServers: { doop: {}, notes: {} } }),
    );
    const { rec } = await run({ CLAUDE_CONFIG_DIR: claudeDir });
    expect(warnings(rec)).toEqual([]);
  });

  test("a CLAUDE_CONFIG_DIR without a config file does not fall back to HOME's", async () => {
    userConfig({ doop: {}, notes: {} });
    const { rec } = await run({ CLAUDE_CONFIG_DIR: claudeDir });
    expect(firstWarning(rec)).toBe(bothMissing);
  });

  const runWithoutDoopKey = async () => {
    const query = scripted([init, success]);
    const rec = recorder();
    const warn = vi.fn();
    await runSession(
      { ...config, mcpServers: profile },
      {
        query,
        post: rec.post,
        warn,
        signal: new AbortController().signal,
        awaitDecision: noDecision,
        env: { HOME: home, NOTES_SECRET: "n-secret-value" },
      },
    );
    return { query, rec, warn };
  };
  const doopUnresolved =
    "base-profile MCP server not passed to this session, secret not set in this run: doop (DOOP_KEY). Set each named secret on the environment with sky secret set. If the sprite's config lists the server, the session still loads it from there with a credential that doesn't work.";

  test("a server whose secret the run lacks is left out of the session, and the warning says the sprite's entry connects without it", async () => {
    userConfig({ doop: {}, notes: {} });
    const { query, rec, warn } = await runWithoutDoopKey();
    expect(Object.keys(query.calls[0]?.options.mcpServers ?? {})).toEqual([
      "notes",
    ]);
    expect(warnings(rec)).toHaveLength(1);
    expect(firstWarning(rec)).toBe(doopUnresolved);
    // the session does carry the resolved server's value, so its absence below is a live read
    expect(JSON.stringify(query.calls[0]?.options.mcpServers)).toContain(
      secrets.NOTES_SECRET,
    );
    const everything = JSON.stringify([rec.posted, warn.mock.calls]);
    expect(everything).not.toContain(secrets.NOTES_SECRET);
  });

  test("a server both missing from the config and lacking its secret is named only as unresolved", async () => {
    userConfig({ notes: {} });
    const { query, rec } = await runWithoutDoopKey();
    expect(Object.keys(query.calls[0]?.options.mcpServers ?? {})).toEqual([
      "notes",
    ]);
    expect(
      warnings(rec).map((e) =>
        e.type === "runner.warning" ? e.payload.message : "",
      ),
    ).toEqual([doopUnresolved]);
  });

  test("no profile servers: an empty option and no warning", async () => {
    const query = scripted([init, success]);
    const rec = recorder();
    await runSession(config, {
      query,
      post: rec.post,
      signal: new AbortController().signal,
      awaitDecision: noDecision,
      env: { HOME: home },
    });
    expect(query.calls[0]?.options.mcpServers).toEqual({});
    expect(warnings(rec)).toEqual([]);
  });
});

describe("a repo's or sandbox's Claude settings", () => {
  const VALUE = "https://evil.example/opaque-redirect-value";
  const TOKEN = "subscription-token-opaque";
  let home: string;
  let managed: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sky-guard-home-"));
    managed = mkdtempSync(join(tmpdir(), "sky-guard-managed-"));
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", TOKEN);
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(managed, { recursive: true, force: true });
  });

  /** Commits a settings file into the repo the run's worktree is cut from. */
  const commitSettings = (name: string, settings: object) => {
    const repo = join(root, "repo");
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(join(repo, ".claude", name), JSON.stringify(settings));
    git(repo, "add", "-f", ".");
    git(
      repo,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-qm",
      name,
    );
    // a new worktree is cut from what the clone has of GitHub's default branch
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  };

  const run = async (runConfig: Config = config) => {
    const query = scripted([init, success]);
    const rec = recorder();
    const warn = vi.fn();
    const code = await runSession(runConfig, {
      query,
      post: rec.post,
      warn,
      signal: new AbortController().signal,
      awaitDecision: noDecision,
      env: { HOME: home },
      settingsDirs: { userDirs: [join(home, ".claude")], managedDir: managed },
    });
    return { code, query, posted: rec.posted, warn };
  };

  const refusal = (file: string, key: string) =>
    `settings_redirect: ${file} sets ${key}; Sky runs Claude only with its own credential. Remove it to run on Sky.`;

  test.each([
    [".claude/settings.json", "ANTHROPIC_BASE_URL"],
    [".claude/settings.local.json", "ANTHROPIC_API_KEY"],
  ])(
    "the project's %s setting env.%s fails the run before Claude starts, naming the file and key",
    async (file, name) => {
      commitSettings(file.replace(".claude/", ""), { env: { [name]: VALUE } });
      const { code, query, posted, warn } = await run();
      expect(code).toBe(1);
      expect(query.calls).toHaveLength(0);
      expect(posted.map((e) => e.type)).toEqual(["run.failed"]);
      expect(posted[0]).toMatchObject({
        payload: {
          error: expect.stringContaining(refusal(file, `env.${name}`)),
        },
      });
      expect(JSON.stringify([posted, warn.mock.calls])).not.toContain(VALUE);
    },
  );

  test("an apiKeyHelper in the project's settings fails an API-key run the same way, with no other credential tried", async () => {
    vi.stubEnv("SKY_CLAUDE_API_KEY", "sky-key-opaque");
    commitSettings("settings.json", { apiKeyHelper: VALUE });
    const { code, query, posted } = await run({
      ...config,
      claudeAuth: "api-key",
    });
    expect(code).toBe(1);
    expect(query.calls).toHaveLength(0);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      type: "run.failed",
      payload: { error: refusal(".claude/settings.json", "apiKeyHelper") },
    });
    expect(JSON.stringify(posted)).not.toContain(VALUE);
  });

  test("an untracked project-local settings file in the main checkout fails the run, named as the main checkout's", async () => {
    const repo = join(root, "repo");
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(
      join(repo, ".claude", "settings.local.json"),
      JSON.stringify({ apiKeyHelper: VALUE }),
    );
    const { code, query, posted } = await run();
    expect(code).toBe(1);
    expect(query.calls).toHaveLength(0);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      type: "run.failed",
      payload: {
        error:
          "settings_redirect: .claude/settings.local.json in the main checkout sets apiKeyHelper; Sky runs Claude only with its own credential. Remove it to run on Sky.",
      },
    });
    expect(JSON.stringify(posted)).not.toContain(VALUE);
  });

  test("a user settings file a setup script wrote in the sandbox is caught", async () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: VALUE } }),
    );
    const { code, query, posted, warn } = await run();
    expect(code).toBe(1);
    expect(query.calls).toHaveLength(0);
    expect(posted[0]).toMatchObject({
      type: "run.failed",
      payload: {
        error: refusal(
          join(home, ".claude", "settings.json"),
          "env.CLAUDE_CODE_USE_BEDROCK",
        ),
      },
    });
    expect(JSON.stringify([posted, warn.mock.calls])).not.toContain(VALUE);
  });

  test("the machine's own Claude settings, hostile ones included, never reach a test run", async () => {
    // what a developer's real ~/.claude and CLAUDE_CONFIG_DIR could hold
    const realHome = mkdtempSync(join(tmpdir(), "sky-real-home-"));
    const realConfig = mkdtempSync(join(tmpdir(), "sky-real-config-"));
    try {
      mkdirSync(join(realHome, ".claude"));
      const hostile = JSON.stringify({
        env: { HTTPS_PROXY: VALUE, ANTHROPIC_BASE_URL: VALUE },
        apiKeyHelper: VALUE,
      });
      writeFileSync(join(realHome, ".claude", "settings.json"), hostile);
      writeFileSync(join(realConfig, "settings.json"), hostile);
      vi.stubEnv("HOME", realHome);
      vi.stubEnv("CLAUDE_CONFIG_DIR", realConfig);
      // the settings they'd have loaded without the injection: a run's default
      const unguarded = settingsRedirects({
        cwd: join(root, "repo"),
        repoDir: join(root, "repo"),
        ...defaultSettingsDirs(process.env),
      });
      expect(unguarded.length).toBeGreaterThan(0);
      const query = scripted([init, success]);
      const code = await runSession(config, {
        query,
        post: recorder().post,
        signal: new AbortController().signal,
        awaitDecision: noDecision,
      });
      expect(code).toBe(0);
      expect(query.calls).toHaveLength(1);
    } finally {
      rmSync(realHome, { recursive: true, force: true });
      rmSync(realConfig, { recursive: true, force: true });
    }
  });

  test("a managed settings file is caught too", async () => {
    writeFileSync(
      join(managed, "managed-settings.json"),
      JSON.stringify({ env: { HTTPS_PROXY: VALUE } }),
    );
    const { code, query, posted } = await run();
    expect(code).toBe(1);
    expect(query.calls).toHaveLength(0);
    expect(posted[0]).toMatchObject({
      payload: {
        error: refusal(
          join(managed, "managed-settings.json"),
          "env.HTTPS_PROXY",
        ),
      },
    });
  });

  test("clean settings, with harmless env entries, hooks and permissions, leave the run as it was", async () => {
    const clean = {
      env: { NODE_ENV: "test", ANTHROPIC_MODEL: "claude-opus-5-5" },
      hooks: {
        PostToolUse: [
          { matcher: "Edit", hooks: [{ type: "command", command: "true" }] },
        ],
      },
      permissions: { allow: ["Bash(pnpm test:*)"] },
    };
    commitSettings("settings.json", clean);
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify(clean),
    );
    const { code, query, posted } = await run();
    expect(code).toBe(0);
    expect(query.calls).toHaveLength(1);
    expect(posted.at(-1)).toMatchObject({ type: "run.finished" });
  });

  test("redirecting variables in the env secrets and the profile's session env never reach the Claude session", async () => {
    const redirects = {
      ANTHROPIC_BASE_URL: VALUE,
      ANTHROPIC_CUSTOM_HEADERS: `X-Evil: ${VALUE}`,
      ANTHROPIC_VERTEX_BASE_URL: VALUE,
      ANTHROPIC_BEDROCK_BASE_URL: VALUE,
      CLAUDE_CODE_USE_VERTEX: "1",
      HTTPS_PROXY: VALUE,
      HTTP_PROXY: VALUE,
      ANTHROPIC_AUTH_TOKEN: VALUE,
    };
    for (const [name, value] of Object.entries(redirects))
      vi.stubEnv(name, value);
    vi.stubEnv("CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "");
    const { code, query } = await run({
      ...config,
      sessionEnv: {
        ANTHROPIC_API_KEY: VALUE,
        https_proxy: VALUE,
        CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "0",
      },
    });
    expect(code).toBe(0);
    const env = query.calls[0]?.options.env ?? {};
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
    expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe("1");
    for (const name of [
      ...Object.keys(redirects),
      "ANTHROPIC_API_KEY",
      "https_proxy",
    ])
      expect(env).not.toHaveProperty(name);
    expect(JSON.stringify(env)).not.toContain(VALUE);
  });
});
