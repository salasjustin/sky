import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import type { Decision, RequestId, RunnerEventPost } from "@sky/shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  AppServer,
  CODEX_PROVIDER,
  codexConfigToml,
  codexInstructions,
  DEFAULT_CODEX_MODEL,
  gatewayUnavailable,
  missingCodexPluginWarnings,
  resolveCodexExecutable,
  runCodexSession,
  toolCallOf,
  unwrapShell,
  withdrawGatewayKey,
} from "./codex.js";
import { type Config, loadConfig } from "./config.js";
import type { PostEvent } from "./events.js";
import { runEnvRefresh } from "./refresh.js";
import type { AwaitDecision } from "./requests.js";
import type { Seal } from "./seal.js";

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

  test("SKY_CODEX_PLUGINS names the plugins a Codex run turns on", () => {
    const codex = { ...base, SKY_RUNTIME: "codex", AI_GATEWAY_API_KEY: "k" };
    expect(loadConfig(codex).codexPlugins).toBeUndefined();
    expect(
      loadConfig({ ...codex, SKY_CODEX_PLUGINS: " kru@kru, tools@acme-1 ," })
        .codexPlugins,
    ).toEqual(["kru@kru", "tools@acme-1"]);
    // a Claude Code run takes no Codex plugins
    expect(
      loadConfig({
        ...base,
        CLAUDE_CODE_OAUTH_TOKEN: "t",
        SKY_CODEX_PLUGINS: "kru@kru",
      }).codexPlugins,
    ).toBeUndefined();
  });

  test("refuses a plugin id that could quote out of Codex's config", () => {
    const codex = { ...base, SKY_RUNTIME: "codex", AI_GATEWAY_API_KEY: "k" };
    for (const bad of ['kru@kru"]\nx = 1', "kru", "kru@", "@kru", "a b@c"])
      expect(() => loadConfig({ ...codex, SKY_CODEX_PLUGINS: bad })).toThrow(
        /SKY_CODEX_PLUGINS/,
      );
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

describe("withdrawGatewayKey", () => {
  test("takes the gateway key out of the env and returns it", () => {
    const env: NodeJS.ProcessEnv = { AI_GATEWAY_API_KEY: "k", OTHER: "1" };
    expect(withdrawGatewayKey(env)).toEqual({ AI_GATEWAY_API_KEY: "k" });
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
  test("routes the model through the run's proxy and keeps its token out of commands", () => {
    const toml = codexConfigToml("http://127.0.0.1:4100/codex/v1");
    expect(toml).toContain(`model_provider = "${CODEX_PROVIDER}"`);
    expect(toml).toContain('base_url = "http://127.0.0.1:4100/codex/v1"');
    expect(toml).toContain('env_key = "SKY_CODEX_GATEWAY_TOKEN"');
    expect(toml).toContain('wire_api = "responses"');
    expect(toml).toContain(
      'exclude = ["SKY_CODEX_GATEWAY_TOKEN", "AI_GATEWAY_API_KEY"]',
    );
    // the project's own secrets reach its commands, as Claude Code's do
    expect(toml).toContain("ignore_default_excludes = true");
    expect(toml).not.toContain("[plugins.");
  });

  test("turns on each plugin it is given", () => {
    const toml = codexConfigToml("http://127.0.0.1:1/v1", [
      "kru@kru",
      "tools@acme",
    ]);
    expect(toml).toContain('[plugins."kru@kru"]\nenabled = true\n');
    expect(toml).toContain('[plugins."tools@acme"]\nenabled = true\n');
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

describe("gatewayUnavailable", () => {
  const e = (message: string, codexErrorInfo: unknown = null) => ({
    message,
    codexErrorInfo,
  });
  test.each([
    [
      "a spend limit code",
      [e("x", "apiKeySpendLimitExceeded")],
      undefined,
      "credit",
    ],
    [
      "Codex's unmapped 402",
      [e("unexpected status 402 Payment Required: {}")],
      undefined,
      "credit",
    ],
    [
      "the body's quota code",
      [e('{"error":{"code":"insufficient_quota"}}')],
      undefined,
      "credit",
    ],
    ["the rate-limit code", [e("x", "rateLimitExceeded")], undefined, "rate"],
    ["a proxy-seen 429", [e("the turn failed")], 429, "rate"],
    [
      "credit over rate",
      [
        e("x", "rateLimitExceeded"),
        e("x", { httpConnectionFailed: { httpStatusCode: 402 } }),
      ],
      undefined,
      "credit",
    ],
    [
      "an unknown object variant",
      [e("x", { somethingNew: { httpStatusCode: 500 } })],
      undefined,
      undefined,
    ],
    [
      "unauthorized",
      [e("unexpected status 401 Unauthorized", "unauthorized")],
      undefined,
      undefined,
    ],
    [
      "a final error Codex named otherwise, after a retried 429 the proxy saw",
      [
        e("exceeded retry limit, last status: 429 Too Many Requests", {
          responseTooManyFailedAttempts: { httpStatusCode: 429 },
        }),
        e("context window exceeded", "contextWindowExceeded"),
      ],
      429,
      undefined,
    ],
    [
      "a final stream disconnect, after a retried 429 the proxy saw",
      [
        e("rate limited", "rateLimitExceeded"),
        e("stream disconnected before completion", {
          responseStreamDisconnected: { httpStatusCode: null },
        }),
      ],
      429,
      undefined,
    ],
    [
      "a final variant with another status, after a retried 429 the proxy saw",
      [
        e("rate limited", "rateLimitExceeded"),
        e("unexpected status 503 Service Unavailable", {
          responseTooManyFailedAttempts: { httpStatusCode: 503 },
        }),
      ],
      429,
      undefined,
    ],
    [
      "a final variant's own 429",
      [
        e("exceeded retry limit", {
          responseTooManyFailedAttempts: { httpStatusCode: 429 },
        }),
      ],
      undefined,
      "rate",
    ],
    [
      "a final variant's own 402",
      [e("x", { httpConnectionFailed: { httpStatusCode: 402 } })],
      undefined,
      "credit",
    ],
    [
      "a final other that is Codex's retry giving up on a 429",
      [
        e("rate limited", "rateLimitExceeded"),
        e("exceeded retry limit, last status: 429 Too Many Requests", "other"),
      ],
      undefined,
      "rate",
    ],
    [
      "a mention of credit that isn't the gateway's",
      [e("the build failed: credit-card form test")],
      undefined,
      undefined,
    ],
  ] as const)("%s", (_, errors, proxy, expected) => {
    expect(gatewayUnavailable(errors, proxy)).toBe(expected);
  });
});

// a stand-in for `codex app-server`: speaks its JSON-RPC over stdio, logs every message it reads to
// FAKE_CODEX_LOG, and plays the scenario FAKE_CODEX_SCENARIO names once a turn starts
const FAKE_SERVER = `#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require("node:fs");
const { createInterface } = require("node:readline");
const { join } = require("node:path");
const log = (entry) => appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(entry) + "\\n");
log({ env: { key: process.env.AI_GATEWAY_API_KEY ?? null, gatewayToken: process.env.SKY_CODEX_GATEWAY_TOKEN ? "set" : null, home: process.env.CODEX_HOME, connector: process.env.GITHUB_CONNECTOR ?? null, token: process.env.AGENT_TOKEN ?? null, lastGitConfig: process.env["GIT_CONFIG_KEY_" + (process.env.GIT_CONFIG_COUNT - 1)] + "=" + process.env["GIT_CONFIG_VALUE_" + (process.env.GIT_CONFIG_COUNT - 1)] }, marker: require("node:fs").existsSync(join(process.env.CODEX_HOME ?? "", "plugins", "marker")) });
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
  async rename() {
    const changes = [{ path: "README", kind: { type: "update", move_path: "/tmp/moved.txt" }, diff: "" }];
    note("item/started", { threadId: thread, turnId: turn, startedAtMs: Date.now(), item: { type: "fileChange", id: "fc_3", changes, status: "inProgress" } });
    const answer = await ask("item/fileChange/requestApproval", { threadId: thread, turnId: turn, itemId: "fc_3", startedAtMs: Date.now() });
    note("item/completed", { threadId: thread, turnId: turn, completedAtMs: Date.now(), item: { type: "fileChange", id: "fc_3", changes, status: answer.decision === "accept" ? "completed" : "declined" } });
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
  // a turn that fails with FAKE_CODEX_TURN_ERROR as its TurnError, after a retried FAKE_CODEX_RETRY_ERROR when set
  async failingWith() {
    if (process.env.FAKE_CODEX_RETRY_ERROR) note("error", { threadId: thread, turnId: turn, willRetry: true, error: JSON.parse(process.env.FAKE_CODEX_RETRY_ERROR) });
    usage(10, 1);
    note("turn/completed", { threadId: thread, turn: { id: turn, status: "failed", error: JSON.parse(process.env.FAKE_CODEX_TURN_ERROR ?? "null"), items: [] } });
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
  // the seal a run gets: starts the process as it is asked to, and records what it was asked
  let spawned: SpawnOptions[];
  let seal: Seal;
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
    spawned = [];
    seal = {
      problem: undefined,
      spawn: (options) => {
        spawned.push(options);
        return spawn(options.command, options.args, {
          cwd: options.cwd,
          env: options.env,
          stdio: ["pipe", "pipe", "pipe"],
        }) as ReturnType<Seal["spawn"]>;
      },
      check: () => undefined,
    };
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
      seal,
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

  test("what the env's refresh script left in the Codex home is there when Codex starts, and the run.started carries its record", async () => {
    const codexHome = join(root, "codex-home");
    const record = await runEnvRefresh({
      script: `mkdir -p "$CH/plugins" && echo kru > "$CH/plugins/marker"; echo refreshed`,
      env: { PATH: process.env.PATH ?? "", HOME: root, CH: codexHome },
      warn: () => {},
      lockFile: join(root, "refresh.lock"),
      logFile: join(root, "refresh.log"),
    });
    expect(record).toMatchObject({ outcome: "ran", tail: "refreshed" });
    expect(
      await runCodexSession(config, {
        post,
        awaitDecision,
        signal: new AbortController().signal,
        warn: () => {},
        codexEnv: { AI_GATEWAY_API_KEY: "gw-key" },
        seal,
        bin,
        stopGraceMs: 2_000,
        envRefresh: record,
      }),
    ).toBe(0);
    // Codex's own process saw it, and Sky's config write beside it left it
    expect(sent()[0].marker).toBe(true);
    expect(existsSync(join(codexHome, "plugins", "marker"))).toBe(true);
    expect(existsSync(join(codexHome, "config.toml"))).toBe(true);
    expect(ofType("run.started")[0]?.payload).toEqual({
      sessionId: "thr_1",
      refresh: record,
    });
  });

  test("a run with no refresh posts the bare run.started", async () => {
    await run();
    expect(ofType("run.started")[0]?.payload).toEqual({ sessionId: "thr_1" });
  });

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
    // no plugins, so Codex's hook trust stays as it is
    expect(start.params.config).toBeUndefined();
    expect(log[0].env).toEqual({
      // the gateway key stays in the runner; Codex holds only the run's proxy token
      key: null,
      gatewayToken: "set",
      home: join(root, "codex-home"),
      connector: null,
      // the event token stays with the runner, and the commands' git runs no fsmonitor
      token: null,
      lastGitConfig: "core.fsmonitor=false",
    });
    const toml = readFileSync(join(root, "codex-home", "config.toml"), "utf8");
    expect(toml).toMatch(/base_url = "http:\/\/127\.0\.0\.1:\d+\/codex\/v1"/);
    expect(toml).not.toContain("gw-key");

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

  test("a rename out of the worktree is held, with its destination shown", async () => {
    config.approvalPolicy = [];
    decide = () => "deny";
    expect(await run(undefined, "rename")).toBe(0);
    const request = ofType("run.waiting")[0]?.payload.request;
    expect(request).toMatchObject({ toolName: "Edit" });
    expect(
      request && "toolInput" in request ? request.toolInput : "",
    ).toContain('"movePath":"/tmp/moved.txt"');
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

  const turnError = (message: string, codexErrorInfo: unknown = null) =>
    JSON.stringify({
      message,
      codexErrorInfo,
      additionalDetails: null,
      misalignment: null,
    });

  test("a turn the gateway refuses for credit fails as codex_unavailable, quoting Codex", async () => {
    config.sessionEnv.FAKE_CODEX_TURN_ERROR = turnError(
      "You've hit your usage limit.",
      "usageLimitExceeded",
    );
    expect(await run(undefined, "failingWith")).toBe(1);
    expect(ofType("run.failed")[0]?.payload.error).toBe(
      "codex_unavailable: the AI Gateway is out of credit (Codex said: You've hit your usage limit.)",
    );
  });

  test("a turn whose retries gave up on 429s fails as rate-limited", async () => {
    config.sessionEnv.FAKE_CODEX_TURN_ERROR = turnError(
      "exceeded retry limit, last status: 429 Too Many Requests",
      { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
    );
    expect(await run(undefined, "failingWith")).toBe(1);
    expect(ofType("run.failed")[0]?.payload.error).toBe(
      "codex_unavailable: the AI Gateway rate-limited this run (Codex said: exceeded retry limit, last status: 429 Too Many Requests)",
    );
  });

  test("a retried 402 makes a later bare failure out of credit", async () => {
    config.sessionEnv.FAKE_CODEX_RETRY_ERROR = turnError("stream error", {
      responseStreamConnectionFailed: { httpStatusCode: 402 },
    });
    expect(await run(undefined, "failingWith")).toBe(1);
    expect(ofType("run.failed")[0]?.payload.error).toBe(
      "codex_unavailable: the AI Gateway is out of credit (Codex said: the turn failed)",
    );
  });

  test("a bare failure after the proxy saw a 402 is out of credit", async () => {
    const ran = await runCodexSession(
      {
        ...config,
        sessionEnv: {
          ...config.sessionEnv,
          FAKE_CODEX_SCENARIO: "failingWith",
        },
      },
      {
        post,
        awaitDecision,
        signal: new AbortController().signal,
        warn: () => {},
        codexEnv: { AI_GATEWAY_API_KEY: "gw-key" },
        startProxy: async () => ({
          baseUrl: "http://127.0.0.1:9/codex/v1",
          token: "t".repeat(64),
          close: async () => {},
          limitStatus: () => 402,
        }),
        seal,
        bin,
        stopGraceMs: 2_000,
      },
    );
    expect(ran).toBe(1);
    expect(ofType("run.failed")[0]?.payload.error).toBe(
      "codex_unavailable: the AI Gateway is out of credit (Codex said: the turn failed)",
    );
  });

  test("a failure the gateway didn't cause keeps Codex's own error", async () => {
    config.sessionEnv.FAKE_CODEX_TURN_ERROR = turnError(
      "context window exceeded",
      "contextWindowExceeded",
    );
    expect(await run(undefined, "failingWith")).toBe(1);
    expect(ofType("run.failed")[0]?.payload.error).toBe(
      "context window exceeded",
    );
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

  test("Codex starts through the seal, from its own binary, with the proxy's token and not the key", async () => {
    // a key a base profile's session env put back is dropped too
    config.sessionEnv.AI_GATEWAY_API_KEY = "gw-key";
    expect(await run()).toBe(0);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({
      command: realpathSync(bin),
      args: ["app-server"],
      cwd: join(root, "worktrees", "agt_1"),
    });
    expect(spawned[0]?.env.AI_GATEWAY_API_KEY).toBeUndefined();
    expect(spawned[0]?.env.SKY_CODEX_GATEWAY_TOKEN).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the run's proxy gets the key, and closes when the run ends", async () => {
    let closed = false;
    const given: { upstream?: string; key?: string } = {};
    const ran = await runCodexSession(config, {
      post,
      awaitDecision,
      signal: new AbortController().signal,
      warn: () => {},
      codexEnv: { AI_GATEWAY_API_KEY: "gw-key" },
      gatewayUrl: "https://gateway.test/codex/v1",
      startProxy: async (options) => {
        given.upstream = options.upstream;
        given.key = options.key;
        return {
          baseUrl: "http://127.0.0.1:9/codex/v1",
          token: "t".repeat(64),
          close: async () => {
            closed = true;
          },
        };
      },
      seal,
      bin,
      stopGraceMs: 2_000,
    });
    expect(ran).toBe(0);
    expect(given).toEqual({
      upstream: "https://gateway.test/codex/v1",
      key: "gw-key",
    });
    expect(spawned[0]?.env.SKY_CODEX_GATEWAY_TOKEN).toBe("t".repeat(64));
    expect(
      readFileSync(join(root, "codex-home", "config.toml"), "utf8"),
    ).toContain('base_url = "http://127.0.0.1:9/codex/v1"');
    expect(closed).toBe(true);
  });

  test("named plugins are turned on and their hooks run without Codex's trust prompt", async () => {
    config.codexPlugins = ["kru@kru"];
    expect(await run()).toBe(0);
    expect(
      readFileSync(join(root, "codex-home", "config.toml"), "utf8"),
    ).toContain('[plugins."kru@kru"]\nenabled = true\n');
    const start = sent().find((m) => m.method === "thread/start");
    expect(start.params.config).toEqual({ bypass_hook_trust: true });
  });

  test("a hooks.json left in the Codex home is gone when Codex starts; plugins and agents stay", async () => {
    config.codexPlugins = ["kru@kru"];
    const home = join(root, "codex-home");
    mkdirSync(join(home, "plugins", "cache"), { recursive: true });
    mkdirSync(join(home, "agents"), { recursive: true });
    writeFileSync(join(home, "hooks.json"), '{"hooks":{}}');
    writeFileSync(join(home, "plugins", "cache", "kept.txt"), "plugin");
    writeFileSync(join(home, "agents", "role.toml"), "role");
    let hooksAtSpawn: boolean | undefined;
    const sealSpawn = seal.spawn;
    seal = {
      ...seal,
      spawn: (options) => {
        hooksAtSpawn = existsSync(join(home, "hooks.json"));
        return sealSpawn(options);
      },
    };
    expect(await run()).toBe(0);
    expect(spawned).toHaveLength(1);
    expect(hooksAtSpawn).toBe(false);
    expect(
      readFileSync(join(home, "plugins", "cache", "kept.txt"), "utf8"),
    ).toBe("plugin");
    expect(readFileSync(join(home, "agents", "role.toml"), "utf8")).toBe(
      "role",
    );
    expect(existsSync(join(home, "config.toml"))).toBe(true);
  });

  test("a resumed thread keeps its plugins' hooks running", async () => {
    config.codexPlugins = ["kru@kru"];
    config.sessionId = "thr_1";
    expect(await run()).toBe(0);
    const resume = sent().find((m) => m.method === "thread/resume");
    expect(resume.params.config).toEqual({ bypass_hook_trust: true });
  });

  test("a runner that can't be hidden fails the run before anything starts", async () => {
    seal = { ...seal, problem: "the kernel still lets commands read it" };
    expect(await run()).toBe(1);
    expect(ofType("run.failed")[0]?.payload.error).toMatch(
      /^credential_exposed: .*the kernel still lets commands read it.*did not start/,
    );
    expect(spawned).toEqual([]);
    expect(existsSync(join(root, "worktrees"))).toBe(false);
    expect(existsSync(logFile)).toBe(false);
  });

  test("a Codex process the kernel leaves readable stops the run", async () => {
    seal = { ...seal, check: () => "the kernel lets commands read Codex" };
    expect(await run()).toBe(1);
    expect(ofType("run.failed")[0]?.payload.error).toMatch(
      /^credential_exposed: the kernel lets commands read Codex/,
    );
    expect(ofType("run.started")).toEqual([]);
  });

  test("publish and sync check the seal each time they are asked for", async () => {
    vi.stubEnv("GITHUB_CONNECTOR", undefined);
    let checks = 0;
    // sound at Codex's start, readable by the time the agent asks to publish
    seal = { ...seal, check: () => (checks++ === 0 ? undefined : "readable") };
    const connected = (signal: AbortSignal) =>
      runCodexSession(config, {
        post,
        awaitDecision,
        signal,
        warn: () => {},
        codexEnv: { AI_GATEWAY_API_KEY: "gw-key" },
        connector: { GITHUB_CONNECTOR: "connector-secret" },
        seal,
        bin,
        stopGraceMs: 2_000,
      });
    config.sessionEnv.FAKE_CODEX_SCENARIO = "publish";
    expect(await connected(new AbortController().signal)).toBe(0);
    const reply = sent().find((m) => m.id === 100)?.result;
    expect(reply.success).toBe(false);
    expect(reply.contentItems[0].text).toMatch(
      /sky publish refused: the runner can't confirm.*readable.*nothing was sent/,
    );
  });
});

describe("resolveCodexExecutable", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "runner-codex-bin-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const install = (pkg: string, triple: string) => {
    const modules = join(root, "node_modules");
    mkdirSync(join(modules, "@openai", "codex", "bin"), { recursive: true });
    writeFileSync(join(modules, "@openai", "codex", "bin", "codex.js"), "");
    const native = join(modules, "@openai", pkg, "vendor", triple, "bin");
    mkdirSync(native, { recursive: true });
    writeFileSync(join(modules, "@openai", pkg, "package.json"), "{}");
    writeFileSync(join(native, "codex"), "");
    mkdirSync(join(modules, ".bin"));
    symlinkSync(
      "../@openai/codex/bin/codex.js",
      join(modules, ".bin", "codex"),
    );
    return { launcher: join(modules, ".bin", "codex"), native };
  };

  test("the npm launcher resolves to the platform package's binary", () => {
    const { launcher, native } = install(
      "codex-linux-x64",
      "x86_64-unknown-linux-musl",
    );
    expect(resolveCodexExecutable(launcher, "x64")).toBe(
      realpathSync(join(native, "codex")),
    );
  });

  test("arm64 picks its own package", () => {
    const { launcher, native } = install(
      "codex-linux-arm64",
      "aarch64-unknown-linux-musl",
    );
    expect(resolveCodexExecutable(launcher, "arm64")).toBe(
      realpathSync(join(native, "codex")),
    );
  });

  test("a launcher with no platform package beside it is an error, not a guess", () => {
    const { launcher } = install(
      "codex-linux-arm64",
      "aarch64-unknown-linux-musl",
    );
    expect(() => resolveCodexExecutable(launcher, "x64")).toThrow();
    expect(() => resolveCodexExecutable(launcher, "ia32")).toThrow(
      /no Linux build for ia32/,
    );
  });

  test("a binary that is not the launcher is used as it is", () => {
    const file = join(root, "codex-native");
    writeFileSync(file, "");
    expect(resolveCodexExecutable(file)).toBe(realpathSync(file));
  });
});

describe("AppServer", () => {
  test("a write that fails after Codex died ends the process's wait, not the runner", async () => {
    const child = spawn("sleep", ["30"], { stdio: ["pipe", "pipe", "pipe"] });
    const server = new AppServer(child, () => {});
    try {
      // what Node does with a write to a pipe whose reader is gone
      child.stdin?.emit("error", new Error("write EPIPE"));
      await expect(server.exited).resolves.toMatchObject({
        status: "exited",
        error: expect.stringContaining("EPIPE"),
      });
    } finally {
      child.kill("SIGKILL");
    }
  });
});

describe("a Codex plugin the run turns on but the Codex home doesn't hold", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "runner-codex-plugins-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  test("an installed plugin, a version directory under plugins/cache/<marketplace>/<plugin>, draws no warning", () => {
    mkdirSync(join(home, ".sky/codex/plugins/cache/kru/kru/0.1.0"), {
      recursive: true,
    });
    expect(missingCodexPluginWarnings(["kru@kru"], { HOME: home })).toEqual([]);
  });

  test("a missing one, or an empty directory, or one under another marketplace, gets a warning each, naming it and the home", () => {
    mkdirSync(join(home, ".sky/codex/plugins/cache/kru/empty"), {
      recursive: true,
    });
    mkdirSync(join(home, ".sky/codex/plugins/cache/other/review/1"), {
      recursive: true,
    });
    expect(
      missingCodexPluginWarnings(["kru@kru", "empty@kru", "review@kru"], {
        HOME: home,
      }),
    ).toEqual([
      "codex plugin kru@kru is not installed in $HOME/.sky/codex; the session runs without it",
      "codex plugin empty@kru is not installed in $HOME/.sky/codex; the session runs without it",
      "codex plugin review@kru is not installed in $HOME/.sky/codex; the session runs without it",
    ]);
  });

  test("SKY_CODEX_HOME moves where it looks, and the warning names that path", () => {
    const codexHome = join(home, "elsewhere");
    mkdirSync(join(codexHome, "plugins/cache/kru/kru/1"), { recursive: true });
    expect(
      missingCodexPluginWarnings(["kru@kru", "x@y"], {
        HOME: home,
        SKY_CODEX_HOME: codexHome,
      }),
    ).toEqual([
      "codex plugin x@y is not installed in $HOME/elsewhere; the session runs without it",
    ]);
    expect(
      missingCodexPluginWarnings(["x@y"], {
        HOME: home,
        SKY_CODEX_HOME: "/srv/codex",
      }),
    ).toEqual([
      "codex plugin x@y is not installed in /srv/codex; the session runs without it",
    ]);
  });
});
