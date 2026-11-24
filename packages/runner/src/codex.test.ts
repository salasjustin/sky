import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Decision, RequestId, RunnerEventPost } from "@sky/shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  CODEX_PROVIDER,
  codexConfigToml,
  codexInstructions,
  DEFAULT_CODEX_MODEL,
  runCodexSession,
  toolCallOf,
  unwrapShell,
  withdrawCodexKey,
} from "./codex.js";
import { type Config, loadConfig } from "./config.js";
import type { PostEvent } from "./events.js";
import type { AwaitDecision } from "./requests.js";

const base = {
  AGENT_ID: "agt_1",
  RUN_ID: "run_1",
  PROMPT: "do it",
  API_BASE_URL: "http://api.test",
  AGENT_TOKEN: "tok",
};

describe("SKY_RUNTIME", () => {
  test("defaults to Claude Code, which still needs its credential", () => {
    expect(() => loadConfig(base)).toThrow(/CLAUDE_CODE_OAUTH_TOKEN/);
    const config = loadConfig({ ...base, CLAUDE_CODE_OAUTH_TOKEN: "t" });
    expect(config.runtime).toBeUndefined();
    expect(config.codexModel).toBeUndefined();
  });

  test("codex needs the AI Gateway key and no Claude credential", () => {
    expect(() => loadConfig({ ...base, SKY_RUNTIME: "codex" })).toThrow(
      /AI_GATEWAY_API_KEY/,
    );
    const config = loadConfig({
      ...base,
      SKY_RUNTIME: "codex",
      AI_GATEWAY_API_KEY: "k",
      SKY_CODEX_MODEL: "openai/gpt-5.4-mini",
    });
    expect(config.runtime).toBe("codex");
    expect(config.codexModel).toBe("openai/gpt-5.4-mini");
  });

  test("refuses an unknown runtime", () => {
    expect(() =>
      loadConfig({
        ...base,
        SKY_RUNTIME: "opencode",
        CLAUDE_CODE_OAUTH_TOKEN: "t",
      }),
    ).toThrow(/SKY_RUNTIME/);
  });
});

describe("withdrawCodexKey", () => {
  test("takes the gateway key out of the env and returns it", () => {
    const env: NodeJS.ProcessEnv = { AI_GATEWAY_API_KEY: "k", OTHER: "1" };
    expect(withdrawCodexKey(env)).toEqual({ AI_GATEWAY_API_KEY: "k" });
    expect(env).toEqual({ OTHER: "1" });
  });
});

describe("unwrapShell", () => {
  test.each([
    ["/bin/bash -lc 'git status && ls'", "git status && ls"],
    ["bash -c 'echo hi'", "echo hi"],
    ["zsh -lc 'pnpm test'", "pnpm test"],
    ["git status", "git status"],
    ["python -c 'print(1)'", "python -c 'print(1)'"],
    ["bash -lc 'a' extra", "bash -lc 'a' extra"],
  ])("%s", (command, expected) => {
    expect(unwrapShell(command)).toBe(expected);
  });
});

describe("toolCallOf", () => {
  test("a command is Bash, unwrapped from its shell", () => {
    expect(
      toolCallOf(
        { type: "commandExecution", command: "/bin/bash -lc 'rm -rf x'" },
        "/w",
      ),
    ).toEqual({ toolName: "Bash", input: { command: "rm -rf x" } });
  });

  test("a change is Edit, its paths made absolute from the worktree", () => {
    expect(
      toolCallOf(
        {
          type: "fileChange",
          changes: [
            { path: "src/a.ts", kind: "update", diff: "" },
            { path: "/etc/hosts", kind: "add", diff: "" },
          ],
        },
        "/w",
      ),
    ).toEqual({
      toolName: "Edit",
      input: {
        file_path: "/w/src/a.ts",
        files: [
          { path: "/w/src/a.ts", kind: "update" },
          { path: "/etc/hosts", kind: "add" },
        ],
      },
    });
  });

  test("a change that only adds files is Write", () => {
    expect(
      toolCallOf(
        {
          type: "fileChange",
          changes: [{ path: "new.txt", kind: "add", diff: "+x" }],
        },
        "/w",
      ).toolName,
    ).toBe("Write");
  });
});

describe("codexConfigToml", () => {
  test("routes the model through the gateway and keeps its key out of commands", () => {
    const toml = codexConfigToml();
    expect(toml).toContain(`model_provider = "${CODEX_PROVIDER}"`);
    expect(toml).toContain(
      'base_url = "https://ai-gateway.vercel.sh/codex/v1"',
    );
    expect(toml).toContain('env_key = "AI_GATEWAY_API_KEY"');
    expect(toml).toContain('wire_api = "responses"');
    expect(toml).toContain('exclude = ["AI_GATEWAY_API_KEY"]');
    // the project's own secrets reach its commands, as Claude Code's do
    expect(toml).toContain("ignore_default_excludes = true");
  });
});

describe("codexInstructions", () => {
  test("names the publish and sync tools only when the run can reach GitHub", () => {
    const withBroker = codexInstructions({
      broker: true,
      checks: [],
      notes: [],
    });
    expect(withBroker).toContain("`sky_publish`");
    expect(withBroker).toContain("`sky_sync`");
    expect(
      codexInstructions({ broker: false, checks: [], notes: [] }),
    ).not.toContain("sky_publish");
  });

  test("lists the checks, and says a `claude` check can't run", () => {
    const text = codexInstructions({
      broker: false,
      checks: ["pnpm test"],
      notes: ["fetched 2 commits"],
    });
    expect(text).toContain("- pnpm test");
    expect(text).toContain("this run has no Claude login");
    expect(text).toContain("- fetched 2 commits");
  });
});

// a stand-in for `codex app-server`: speaks its JSON-RPC over stdio, logs every message it reads to
// FAKE_CODEX_LOG, and plays the scenario FAKE_CODEX_SCENARIO names once a turn starts
const FAKE_SERVER = `#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require("node:fs");
const { createInterface } = require("node:readline");
const { join } = require("node:path");
const log = (entry) => appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(entry) + "\\n");
log({ env: { key: process.env.AI_GATEWAY_API_KEY ?? null, home: process.env.CODEX_HOME, connector: process.env.GITHUB_CONNECTOR ?? null, token: process.env.AGENT_TOKEN ?? null, lastGitConfig: process.env["GIT_CONFIG_KEY_" + (process.env.GIT_CONFIG_COUNT - 1)] + "=" + process.env["GIT_CONFIG_VALUE_" + (process.env.GIT_CONFIG_COUNT - 1)] } });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const waiting = new Map();
let nextId = 100;
const ask = (method, params) => new Promise((resolve) => { const id = nextId++; waiting.set(id, resolve); send({ id, method, params }); });
const note = (method, params) => send({ method, params });
let cwd = process.cwd();
const thread = "thr_1";
const turn = "turn_1";
const usage = (input, output) => note("thread/tokenUsage/updated", { threadId: thread, turnId: turn, tokenUsage: { total: { totalTokens: input + output, inputTokens: input, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: output, reasoningOutputTokens: 0 }, last: { totalTokens: input + output, inputTokens: input, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: output, reasoningOutputTokens: 0 }, modelContextWindow: null } });
const finish = (status) => note("turn/completed", { threadId: thread, turn: { id: turn, status, error: status === "failed" ? { message: "model said no" } : null, items: [] } });
const scenarios = {
  async command() {
    const command = "/bin/bash -lc 'touch made.txt'";
    note("item/started", { threadId: thread, turnId: turn, startedAtMs: Date.now(), item: { type: "commandExecution", id: "cmd_1", command, cwd, status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null } });
    const answer = await ask("item/commandExecution/requestApproval", { threadId: thread, turnId: turn, itemId: "cmd_1", command, cwd, startedAtMs: Date.now() });
    const accepted = answer.decision === "accept";
    if (accepted) writeFileSync(join(cwd, "made.txt"), "made\\n");
    note("item/completed", { threadId: thread, turnId: turn, completedAtMs: Date.now(), item: { type: "commandExecution", id: "cmd_1", command, cwd, status: accepted ? "completed" : "declined", commandActions: [], aggregatedOutput: accepted ? "ok" : null, exitCode: accepted ? 0 : null, durationMs: 5 } });
    usage(120, 30);
    note("item/completed", { threadId: thread, turnId: turn, completedAtMs: Date.now(), item: { type: "agentMessage", id: "msg_1", text: accepted ? "made it" : "was refused" } });
    setTimeout(() => finish("completed"), 50);
  },
  async change() {
    const changes = [{ path: "notes.md", kind: { type: "add" }, diff: "+hello" }];
    note("item/started", { threadId: thread, turnId: turn, startedAtMs: Date.now(), item: { type: "fileChange", id: "fc_1", changes, status: "inProgress" } });
    const answer = await ask("item/fileChange/requestApproval", { threadId: thread, turnId: turn, itemId: "fc_1", startedAtMs: Date.now() });
    const accepted = answer.decision === "accept";
    if (accepted) writeFileSync(join(cwd, "notes.md"), "hello\\n");
    note("item/completed", { threadId: thread, turnId: turn, completedAtMs: Date.now(), item: { type: "fileChange", id: "fc_1", changes, status: accepted ? "completed" : "declined" } });
    usage(50, 10);
    finish("completed");
  },
  async outside() {
    const changes = [{ path: "/tmp/elsewhere.txt", kind: { type: "add" }, diff: "+x" }];
    note("item/started", { threadId: thread, turnId: turn, startedAtMs: Date.now(), item: { type: "fileChange", id: "fc_2", changes, status: "inProgress" } });
    const answer = await ask("item/fileChange/requestApproval", { threadId: thread, turnId: turn, itemId: "fc_2", startedAtMs: Date.now() });
    note("item/completed", { threadId: thread, turnId: turn, completedAtMs: Date.now(), item: { type: "fileChange", id: "fc_2", changes, status: answer.decision === "accept" ? "completed" : "declined" } });
    usage(10, 1);
    finish("completed");
  },
  async publish() {
    const reply = await ask("item/tool/call", { threadId: thread, turnId: turn, callId: "call_1", namespace: null, tool: "sky_publish", arguments: { title: "T" } });
    note("item/completed", { threadId: thread, turnId: turn, completedAtMs: Date.now(), item: { type: "agentMessage", id: "msg_2", text: reply.contentItems[0].text } });
    usage(10, 1);
    finish("completed");
  },
  async failing() {
    usage(10, 1);
    finish("failed");
  },
  async hang() {},
};
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  log(m);
  if (m.method === undefined) { const resolve = waiting.get(m.id); waiting.delete(m.id); resolve?.(m.result ?? m.error); return; }
  if (m.id === undefined) return;
  switch (m.method) {
    case "initialize": return send({ id: m.id, result: { userAgent: "fake" } });
    case "thread/start": cwd = m.params.cwd; return send({ id: m.id, result: { thread: { id: thread } } });
    case "thread/resume":
      if (m.params.threadId !== thread) return send({ id: m.id, error: { code: -32600, message: "no rollout found" } });
      cwd = m.params.cwd; return send({ id: m.id, result: { thread: { id: thread } } });
    case "turn/start":
      send({ id: m.id, result: { turn: { id: turn, status: "inProgress", items: [] } } });
      setTimeout(() => scenarios[process.env.FAKE_CODEX_SCENARIO](), 10);
      return;
    case "turn/steer": return send({ id: m.id, result: { turnId: turn } });
    case "turn/interrupt": send({ id: m.id, result: {} }); return finish("interrupted");
    default: return send({ id: m.id, error: { code: -32601, message: "unknown " + m.method } });
  }
});
`;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("runCodexSession", () => {
  let root: string;
  let config: Config;
  let bin: string;
  let logFile: string;
  let events: RunnerEventPost[];
  let decide: (request: {
    toolName?: string;
  }) => Decision["decision"] | "deny-with-reason";

  beforeEach(() => {
    vi.stubEnv("GITHUB_CONNECTOR", undefined);
    root = mkdtempSync(join(tmpdir(), "runner-codex-"));
    mkdirSync(join(root, "os-tmp"));
    vi.stubEnv("TMPDIR", join(root, "os-tmp"));
    mkdirSync(join(root, "home"));
    vi.stubEnv("HOME", join(root, "home"));
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
    bin = join(root, "fake-codex");
    writeFileSync(bin, FAKE_SERVER);
    chmodSync(bin, 0o755);
    logFile = join(root, "codex.log");
    events = [];
    decide = () => "approve";
    config = {
      runtime: "codex",
      agentId: "agt_1",
      runId: "run_1",
      prompt: "make a file",
      sessionId: undefined,
      apiBaseUrl: "https://api.test",
      agentToken: "agent-secret",
      claudeAuth: "oauth",
      repoDir: join(root, "repo"),
      worktreesDir: join(root, "worktrees"),
      approvalPolicy: ["Bash", "Edit", "Write"],
      autoApprove: { defaults: true, commands: [] },
      sessionEnv: {
        FAKE_CODEX_LOG: logFile,
        FAKE_CODEX_SCENARIO: "command",
        SKY_CODEX_HOME: join(root, "codex-home"),
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
      checks: [],
      mcpServers: {},
      waitTimeoutMs: 60_000,
      launchDeadlineMs: 15 * 60_000,
      storeHome: undefined,
      startBranch: undefined,
    };
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  const post: PostEvent = async (event) => {
    events.push(event);
  };
  const awaitDecision: AwaitDecision = async (id) => {
    const requestId = id as RequestId;
    const waiting = events.find(
      (e) =>
        e.type === "run.waiting" && e.payload.request.requestId === requestId,
    );
    const request =
      waiting?.type === "run.waiting" ? waiting.payload.request : undefined;
    const verdict = decide(request && "toolName" in request ? request : {});
    if (verdict === "deny-with-reason")
      return {
        kind: "decided",
        decision: { requestId, decision: "deny", reason: "not that file" },
      };
    if (verdict === "deny")
      return { kind: "decided", decision: { requestId, decision: "deny" } };
    return { kind: "decided", decision: { requestId, decision: "approve" } };
  };
  const run = (signal = new AbortController().signal, scenario?: string) => {
    if (scenario) config.sessionEnv.FAKE_CODEX_SCENARIO = scenario;
    return runCodexSession(config, {
      post,
      awaitDecision,
      signal,
      warn: () => {},
      codexEnv: { AI_GATEWAY_API_KEY: "gw-key" },
      bin,
      stopGraceMs: 2_000,
    });
  };
  const sent = () =>
    readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  const ofType = <T extends RunnerEventPost["type"]>(type: T) =>
    events.filter(
      (e): e is Extract<RunnerEventPost, { type: T }> => e.type === type,
    );

  test("opens a thread on the gateway with Sky's approvals and reports a held command", async () => {
    vi.stubEnv("AGENT_TOKEN", "agent-secret");
    expect(await run()).toBe(0);
    const log = sent();
    const start = log.find((m) => m.method === "thread/start");
    expect(start.params).toMatchObject({
      model: DEFAULT_CODEX_MODEL,
      modelProvider: CODEX_PROVIDER,
      approvalPolicy: "untrusted",
      sandbox: "danger-full-access",
      cwd: join(root, "worktrees", "agt_1"),
    });
    // no connector, so nothing to publish with
    expect(start.params.dynamicTools).toBeUndefined();
    expect(log[0].env).toEqual({
      key: "gw-key",
      home: join(root, "codex-home"),
      connector: null,
      // the event token stays with the runner, and the commands' git runs no fsmonitor
      token: null,
      lastGitConfig: "core.fsmonitor=false",
    });
    expect(readFileSync(join(root, "codex-home", "config.toml"), "utf8")).toBe(
      codexConfigToml(),
    );

    expect(ofType("run.started")[0]?.payload.sessionId).toBe("thr_1");
    const waiting = ofType("run.waiting").map((e) => e.payload.request);
    expect(waiting).toEqual([
      expect.objectContaining({
        kind: "approval",
        toolName: "Bash",
        toolSummary: "touch made.txt",
      }),
    ]);
    expect(ofType("claude.PreToolUse")[0]?.payload).toMatchObject({
      toolName: "Bash",
      toolUseId: "cmd_1",
    });
    expect(ofType("claude.PostToolUse")[0]?.payload).toMatchObject({
      toolName: "Bash",
      output: "ok",
    });
    expect(ofType("claude.Message").map((e) => e.payload.text)).toEqual([
      "made it",
    ]);
    const finished = ofType("run.finished")[0]?.payload;
    expect(finished?.summary).toBe("made it");
    expect(finished?.usage).toMatchObject({
      inputTokens: 120,
      outputTokens: 30,
      turns: 1,
    });
    expect(finished?.rollup?.run.files).toBe(1);
    expect(
      git(join(root, "worktrees", "agt_1"), "show", "--name-only", "--format="),
    ).toBe("made.txt");
  });

  test("a command no policy pattern holds runs without asking", async () => {
    config.approvalPolicy = [];
    expect(await run()).toBe(0);
    expect(ofType("run.waiting")).toEqual([]);
    expect(sent().find((m) => m.id === 100 && m.result)?.result).toEqual({
      decision: "accept",
    });
  });

  test("a denial declines the call and steers the turn with its reason", async () => {
    decide = () => "deny-with-reason";
    expect(await run()).toBe(0);
    const log = sent();
    expect(log.find((m) => m.id === 100)?.result).toEqual({
      decision: "decline",
    });
    const steer = log.find((m) => m.method === "turn/steer");
    expect(steer?.params.input[0].text).toBe(
      "The person denied touch made.txt: not that file",
    );
    expect(ofType("claude.PostToolUseFailure")[0]?.payload.error).toBe(
      "The person declined this command.",
    );
    expect(existsSync(join(root, "worktrees", "agt_1", "made.txt"))).toBe(
      false,
    );
  });

  test("a file change is held as the policy holds Write, with its diff shown", async () => {
    expect(await run(undefined, "change")).toBe(0);
    const request = ofType("run.waiting")[0]?.payload.request;
    expect(request).toMatchObject({
      toolName: "Write",
      toolSummary: join(root, "worktrees", "agt_1", "notes.md"),
    });
    expect(
      request && "toolInput" in request ? request.toolInput : "",
    ).toContain("+hello");
  });

  test("a change outside the worktree is held even when no pattern names it", async () => {
    config.approvalPolicy = [];
    decide = () => "deny";
    expect(await run(undefined, "outside")).toBe(0);
    expect(ofType("run.waiting")[0]?.payload.request).toMatchObject({
      toolName: "Write",
      toolSummary: "/tmp/elsewhere.txt",
    });
    expect(sent().find((m) => m.id === 100)?.result).toEqual({
      decision: "decline",
    });
  });

  test("sky_publish without the connector sends nothing and says why", async () => {
    expect(await run(undefined, "publish")).toBe(0);
    const reply = sent().find((m) => m.id === 100)?.result;
    expect(reply.success).toBe(false);
    expect(reply.contentItems[0].text).toMatch(/GitHub connector/);
  });

  test("resumes the session's thread", async () => {
    config.sessionId = "thr_1";
    expect(await run()).toBe(0);
    const log = sent();
    expect(log.some((m) => m.method === "thread/start")).toBe(false);
    expect(log.find((m) => m.method === "thread/resume")?.params.threadId).toBe(
      "thr_1",
    );
  });

  test("a thread Codex doesn't have fails the run", async () => {
    config.sessionId = "thr_gone";
    expect(await run()).toBe(1);
    expect(ofType("run.failed")[0]?.payload.error).toMatch(
      /Codex has no thread thr_gone to resume/,
    );
  });

  test("a failed turn fails the run with the model's error", async () => {
    expect(await run(undefined, "failing")).toBe(1);
    expect(ofType("run.failed")[0]?.payload.error).toBe("model said no");
  });

  test("a stop interrupts the turn and fails the run", async () => {
    const stop = new AbortController();
    const ended = run(stop.signal, "hang");
    await vi.waitFor(() => expect(ofType("run.started")).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 100));
    stop.abort("SIGTERM");
    expect(await ended).toBe(1);
    expect(sent().some((m) => m.method === "turn/interrupt")).toBe(true);
    expect(ofType("run.failed")[0]?.payload.error).toBe(
      "interrupted by SIGTERM",
    );
  });
});
