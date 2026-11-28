import { execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
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
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import type { SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import type { Decision, RequestId, RunnerEventPost } from "@sky/shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { gatewayUnavailable } from "./codex.js";
import { type Config, loadConfig } from "./config.js";
import type { PostEvent } from "./events.js";
import {
  commandViews,
  DEFAULT_PI_MODEL,
  PI_PROVIDER,
  PiRpc,
  piExtensionSource,
  piHomeOf,
  piInstructions,
  piMcpConfig,
  piOutcome,
  piToolCall,
  piUnavailable,
  resolvePiExecutable,
  runPiSession,
  withdrawGatewayKey,
} from "./pi.js";
import type { AwaitDecision } from "./requests.js";
import type { Seal } from "./seal.js";

// a record the fake pi logged or a tool the extension registered: free-form, read by property
// biome-ignore lint/suspicious/noExplicitAny: free-form test data
type Logged = Record<string, any>;

/** The reference to an environment variable that pi's MCP config takes in place of a value. */
const ref = (name: string) => `\${${name}}`;

const base = {
  AGENT_ID: "agt_1",
  RUN_ID: "run_1",
  PROMPT: "do it",
  API_BASE_URL: "http://api.test",
  AGENT_TOKEN: "tok",
};

describe("SKY_RUNTIME=pi", () => {
  test("needs the AI Gateway key and no Claude credential", () => {
    expect(() => loadConfig({ ...base, SKY_RUNTIME: "pi" })).toThrow(
      /AI_GATEWAY_API_KEY/,
    );
    const config = loadConfig({
      ...base,
      SKY_RUNTIME: "pi",
      AI_GATEWAY_API_KEY: "k",
    });
    expect(config.runtime).toBe("pi");
    expect(config.piModel).toBeUndefined();
    expect(config.piSkills).toBeUndefined();
    expect(config.codexModel).toBeUndefined();
  });

  test("SKY_PI_MODEL names the model, and a Claude Code or Codex run ignores it", () => {
    const pi = { ...base, SKY_RUNTIME: "pi", AI_GATEWAY_API_KEY: "k" };
    expect(
      loadConfig({ ...pi, SKY_PI_MODEL: "openai/gpt-5.4-mini" }).piModel,
    ).toBe("openai/gpt-5.4-mini");
    expect(loadConfig({ ...pi, SKY_PI_MODEL: "" }).piModel).toBeUndefined();
    const codex = { ...base, SKY_RUNTIME: "codex", AI_GATEWAY_API_KEY: "k" };
    expect(
      loadConfig({ ...codex, SKY_PI_MODEL: "x/y" }).piModel,
    ).toBeUndefined();
    expect(
      loadConfig({ ...base, CLAUDE_CODE_OAUTH_TOKEN: "t", SKY_PI_SKILLS: "/s" })
        .piSkills,
    ).toBeUndefined();
  });

  test("SKY_PI_SKILLS lists skill directories, absolute or under the home", () => {
    const pi = { ...base, SKY_RUNTIME: "pi", AI_GATEWAY_API_KEY: "k" };
    expect(
      loadConfig({ ...pi, SKY_PI_SKILLS: " /opt/skills/a, ~/.sky/pi/skills ," })
        .piSkills,
    ).toEqual(["/opt/skills/a", "~/.sky/pi/skills"]);
  });

  test("refuses a skill directory that is relative or could read as a pi flag", () => {
    const pi = { ...base, SKY_RUNTIME: "pi", AI_GATEWAY_API_KEY: "k" };
    for (const bad of ["skills", "--no-approve", "./s", "-e", "/a\n/b"])
      expect(() => loadConfig({ ...pi, SKY_PI_SKILLS: bad })).toThrow(
        /SKY_PI_SKILLS/,
      );
  });
});

describe("withdrawGatewayKey", () => {
  test("is the one Codex uses: takes the gateway key out of the env and returns it", () => {
    const env: NodeJS.ProcessEnv = { AI_GATEWAY_API_KEY: "k", OTHER: "1" };
    expect(withdrawGatewayKey(env)).toEqual({ AI_GATEWAY_API_KEY: "k" });
    expect(env).toEqual({ OTHER: "1" });
    expect(withdrawGatewayKey(env)).toEqual({});
  });
});

describe("resolvePiExecutable", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "runner-pi-bin-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("the npm bin link to cli.js runs that file on node, which the seal copies", () => {
    mkdirSync(join(dir, "pkg/dist/bundle"), { recursive: true });
    mkdirSync(join(dir, "node_modules/.bin"), { recursive: true });
    const cli = join(dir, "pkg/dist/bundle/cli.js");
    writeFileSync(cli, "#!/usr/bin/env node\n");
    const bin = join(dir, "node_modules/.bin/pi");
    symlinkSync(cli, bin);
    expect(resolvePiExecutable(bin, "/usr/bin/node")).toEqual({
      command: "/usr/bin/node",
      args: [realpathSync(cli)],
    });
    expect(resolvePiExecutable(bin).command).toBe(process.execPath);
  });

  test("a file that is not JavaScript is run as it is", () => {
    const bin = join(dir, "pi");
    writeFileSync(bin, "\x7fELF");
    chmodSync(bin, 0o755);
    // a compiled pi finds its themes and package.json beside its binary: pi is told where they are
    expect(resolvePiExecutable(bin, "/usr/bin/node")).toEqual({
      command: realpathSync(bin),
      args: [],
      packageDir: realpathSync(dir),
    });
  });

  test("a launcher that isn't there is an error", () => {
    expect(() => resolvePiExecutable(join(dir, "missing"))).toThrow(/ENOENT/);
  });
});

describe("piToolCall", () => {
  test("bash is Bash, unwrapped from its shell, keeping what the agent wrote", () => {
    expect(
      piToolCall("bash", { command: "bash -lc 'rm -rf x'" }, "/w"),
    ).toEqual({
      toolName: "Bash",
      input: { command: "rm -rf x" },
      targets: [],
      rawCommand: "bash -lc 'rm -rf x'",
    });
    expect(piToolCall("bash", { command: "ls" }, "/w")?.input).toEqual({
      command: "ls",
    });
  });

  test("write and edit are Write and Edit, their paths made absolute from the worktree", () => {
    expect(
      piToolCall("write", { path: "src/a.ts", content: "x" }, "/w"),
    ).toEqual({
      toolName: "Write",
      input: { file_path: "/w/src/a.ts", content: "x" },
      targets: ["/w/src/a.ts"],
    });
    const edit = piToolCall(
      "edit",
      { path: "/etc/hosts", edits: [{ oldText: "a", newText: "b" }] },
      "/w",
    );
    expect(edit?.toolName).toBe("Edit");
    expect(edit?.targets).toEqual(["/etc/hosts"]);
    expect(edit?.input.edits).toEqual([{ oldText: "a", newText: "b" }]);
  });

  test("a leading @ or ~ in a path means what pi's own tools take it to mean", () => {
    expect(
      piToolCall("write", { path: "@a.txt" }, "/w", "/h")?.targets,
    ).toEqual(["/w/a.txt"]);
    expect(piToolCall("edit", { path: "~/x" }, "/w", "/h")?.targets).toEqual([
      "/h/x",
    ]);
  });

  test("reads and the runner's own tools are not asked about", () => {
    for (const tool of [
      "read",
      "grep",
      "find",
      "ls",
      "sky_publish",
      "sky_sync",
    ])
      expect(piToolCall(tool, {}, "/w")).toBeUndefined();
  });

  test("any other tool keeps its name, so a pattern naming it holds it", () => {
    expect(piToolCall("mcp__doop__draw", { a: 1 }, "/w")).toEqual({
      toolName: "mcp__doop__draw",
      input: { a: 1 },
      targets: [],
    });
  });
});

describe("commandViews", () => {
  test.each([
    ["git push", ["git push"]],
    ["cd x && git push", ["cd x && git push", "cd x", "git push"]],
    [
      "sudo -u deploy git push origin",
      ["sudo -u deploy git push origin", "git push origin"],
    ],
    ["sudo git push", ["git push"]],
    ["env FOO=1 BAR=2 git push", ["git push"]],
    ["FOO=1 git push", ["git push"]],
    ["/usr/bin/env -u X git push", ["git push"]],
    ["nohup git push", ["git push"]],
    ["timeout 30 git push", ["git push"]],
    ["nice -n 5 git push", ["git push"]],
    ["sudo -- git push", ["git push"]],
    ["bash -lc 'git push'", ["git push"]],
    ['sh -c "cd x; git push"', ["git push"]],
    ["sudo -u a bash -c 'env A=1 git push'", ["git push"]],
    ["xargs -n 1 git push", ["git push"]],
  ])("%s runs %j", (command, expected) => {
    expect(commandViews(command)).toEqual(expect.arrayContaining(expected));
  });

  test("a command with no wrapper has no extra view, and nesting is bounded", () => {
    expect(commandViews("ls -la")).toEqual(["ls -la"]);
    const deep = `${"bash -c '".repeat(12)}git push${"'".repeat(12)}`;
    expect(() => commandViews(deep)).not.toThrow();
  });
});

describe("piOutcome", () => {
  const cwd = "/w";
  const scope = {
    root: cwd,
    cwd,
    realpath: (p: string) => p,
    isSymlink: () => false,
    home: "/home/u",
    storeHome: undefined,
    scratch: "/tmp/s",
  };
  const outcome = (
    policy: string[],
    tool: string,
    input: unknown,
    autoApprove = { defaults: true, commands: [] as string[] },
  ) => {
    const call = piToolCall(tool, input, cwd);
    if (!call) throw new Error("not a gated call");
    return piOutcome({ approvalPolicy: policy, autoApprove }, call, scope, cwd);
  };

  test("a command no pattern holds runs", () => {
    expect(outcome([], "bash", { command: "rm -rf x" })).toBe("run");
    expect(outcome(["Edit"], "bash", { command: "rm -rf x" })).toBe("run");
  });

  test("a bare Bash pattern holds a command, and lets the read-only ones through", () => {
    expect(outcome(["Bash"], "bash", { command: "touch x" })).toBe("hold");
    expect(outcome(["Bash"], "bash", { command: "ls -la" })).toBe(
      "auto-approved",
    );
    expect(outcome(["Bash"], "bash", { command: "git status" })).toBe(
      "auto-approved",
    );
    expect(outcome(["Bash"], "bash", { command: "cat README && ls" })).toBe(
      "auto-approved",
    );
    expect(outcome(["Bash"], "bash", { command: "ls; rm x" })).toBe("hold");
  });

  test("a read-only command inside the shell wrapper still self-approves", () => {
    expect(
      outcome(["Bash"], "bash", { command: "bash -lc 'git status'" }),
    ).toBe("auto-approved");
  });

  test("auto-approve can be turned off, or extended with the environment's commands", () => {
    expect(
      outcome(
        ["Bash"],
        "bash",
        { command: "ls" },
        { defaults: false, commands: [] },
      ),
    ).toBe("hold");
    expect(
      outcome(
        ["Bash"],
        "bash",
        { command: "make check" },
        { defaults: true, commands: ["make check"] },
      ),
    ).toBe("auto-approved");
  });

  test.each([
    "git push origin main",
    "cd x && git push",
    "sudo git push",
    "sudo -u deploy git push",
    "env GIT_TERMINAL_PROMPT=0 git push",
    "GIT_SSH_COMMAND=x git push",
    "bash -lc 'git push'",
    "sh -c 'cd x; git push origin'",
    "sudo -u a bash -c 'env A=1 git push'",
    "timeout 60 git push",
    "nohup git push &",
    "xargs -n 1 git push",
  ])("a pattern that names git push holds %s", (command) => {
    expect(outcome(["Bash(git push:*)"], "bash", { command })).toBe("hold");
  });

  test("a named pattern does not hold what it doesn't name", () => {
    expect(
      outcome(["Bash(git push:*)"], "bash", { command: "git status" }),
    ).toBe("run");
    expect(
      outcome(["Bash(git push:*)"], "bash", { command: "echo git-push" }),
    ).toBe("run");
  });

  test("an Edit or Write pattern holds a change to a file in the worktree", () => {
    expect(outcome(["Edit"], "edit", { path: "a.ts", edits: [] })).toBe("hold");
    expect(outcome(["Write"], "write", { path: "a.ts", content: "" })).toBe(
      "hold",
    );
    expect(outcome(["Write"], "edit", { path: "a.ts", edits: [] })).toBe("run");
    expect(
      outcome(["Edit(/w/secret.txt)"], "edit", { path: "secret.txt" }),
    ).toBe("hold");
    expect(
      outcome(["Edit(/w/secret.txt)"], "edit", { path: "other.txt" }),
    ).toBe("run");
  });

  test("a change outside the worktree is held whatever the policy says", () => {
    expect(outcome([], "write", { path: "/etc/x", content: "" })).toBe("hold");
    expect(outcome([], "edit", { path: "../up.txt", edits: [] })).toBe("hold");
    expect(outcome([], "write", { path: "~/x", content: "" })).toBe("hold");
    expect(outcome([], "write", { path: "in.txt", content: "" })).toBe("run");
  });

  test("another tool is held by a pattern that names it", () => {
    expect(outcome(["mcp__doop__draw"], "mcp__doop__draw", {})).toBe("hold");
    expect(outcome(["mcp__doop__draw"], "mcp__doop__list", {})).toBe("run");
  });
});

describe("piMcpConfig", () => {
  const profile = {
    doop: { command: "npx", args: ["doop"], env: { API_KEY: "DOOP_KEY" } },
    docs: {
      url: "https://docs.test/mcp",
      headers: { Authorization: "DOCS_TOKEN" },
    },
    gone: { command: "x", args: [], env: { K: "MISSING" } },
  };

  test("writes each secret as a reference to pi's env, never its value, with every tool declared", () => {
    const { mcpServers, unresolved } = piMcpConfig(profile, {
      DOOP_KEY: "s3cret-one",
      DOCS_TOKEN: "s3cret-two",
    });
    expect(mcpServers).toEqual({
      doop: {
        command: "npx",
        args: ["doop"],
        env: { API_KEY: ref("DOOP_KEY") },
        exposure: "direct",
      },
      docs: {
        url: "https://docs.test/mcp",
        headers: { Authorization: ref("DOCS_TOKEN") },
        exposure: "direct",
      },
    });
    expect(JSON.stringify(mcpServers)).not.toContain("s3cret");
    expect(unresolved).toEqual([{ server: "gone", secrets: ["MISSING"] }]);
  });

  test("an empty profile has no servers", () => {
    expect(piMcpConfig({}, {})).toEqual({ mcpServers: {}, unresolved: [] });
  });
});

describe("piInstructions", () => {
  test("is the instructions Codex gets, and says pi has no subagents", () => {
    const text = piInstructions({
      broker: true,
      checks: ["pnpm test"],
      notes: [],
    });
    expect(text).toContain("sky_publish");
    expect(text).toContain("- pnpm test");
    expect(text).toMatch(/no subagents/);
  });
});

describe("gateway errors", () => {
  test("pi's error text is judged by the detection Codex's runs use", () => {
    expect(
      gatewayUnavailable([{ message: "402 Payment Required: out of credits" }]),
    ).toBe("credit");
    expect(gatewayUnavailable([{ message: "429 Too Many Requests" }])).toBe(
      "rate",
    );
    expect(
      gatewayUnavailable([{ message: "context window exceeded" }]),
    ).toBeUndefined();
    expect(
      gatewayUnavailable([{ message: "the model call failed" }], 402),
    ).toBe("credit");
  });

  test("the run's error names the cause and quotes pi", () => {
    expect(piUnavailable("credit", " 402 nope ")).toBe(
      "pi_unavailable: the AI Gateway is out of credit (pi said: 402 nope)",
    );
    expect(piUnavailable("rate", "x")).toMatch(
      /^pi_unavailable: .*rate-limited/,
    );
  });
});

describe("the run's extension", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "runner-pi-ext-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
  async function load(
    tools = [
      { name: "sky_publish", description: "d", parameters: { type: "object" } },
    ],
  ) {
    const file = join(dir, "ext.mjs");
    writeFileSync(
      file,
      piExtensionSource({
        baseUrl: "http://127.0.0.1:9/v1",
        model: "m/x",
        tools,
      }),
    );
    const mod = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as {
      default: (pi: unknown) => void;
    };
    const seen = {
      providers: [] as [string, Record<string, unknown>][],
      tools: [] as Logged[],
      handlers: new Map<string, Handler>(),
    };
    mod.default({
      registerProvider: (name: string, config: Record<string, unknown>) =>
        seen.providers.push([name, config]),
      registerTool: (tool: Record<string, unknown>) => seen.tools.push(tool),
      on: (event: string, handler: Handler) =>
        seen.handlers.set(event, handler),
    });
    return seen;
  }
  const ctxAnswering = (answer: unknown) => {
    const titles: string[] = [];
    return {
      titles,
      ctx: {
        signal: undefined,
        ui: {
          input: async (title: string) => {
            titles.push(title);
            return answer === undefined ? undefined : JSON.stringify(answer);
          },
        },
      },
    };
  };

  test("registers the run's proxy as the provider with the token it read, and clears the token from pi's env", async () => {
    vi.stubEnv("SKY_PI_GATEWAY_TOKEN", "run-token");
    const seen = await load();
    expect(process.env.SKY_PI_GATEWAY_TOKEN).toBeUndefined();
    expect(seen.providers).toHaveLength(1);
    const [name, config] = seen.providers[0] ?? ["", {}];
    expect(name).toBe(PI_PROVIDER);
    expect(config).toMatchObject({
      baseUrl: "http://127.0.0.1:9/v1",
      apiKey: "run-token",
      api: "openai-completions",
      models: [{ id: "m/x", cost: { input: 0, output: 0 } }],
    });
    // the token is in pi's memory, not in the file
    expect(readFileSync(join(dir, "ext.mjs"), "utf8")).not.toContain(
      "run-token",
    );
  });

  test("refuses to load without the token", async () => {
    vi.stubEnv("SKY_PI_GATEWAY_TOKEN", "");
    await expect(load()).rejects.toThrow(/gateway token is missing/);
  });

  test("puts every call that isn't a read to the runner, and runs what it allows", async () => {
    vi.stubEnv("SKY_PI_GATEWAY_TOKEN", "t");
    const seen = await load();
    const gate = seen.handlers.get("tool_call");
    const allowed = ctxAnswering({ allow: true });
    expect(
      await gate?.(
        { toolName: "bash", toolCallId: "c1", input: { command: "ls" } },
        allowed.ctx,
      ),
    ).toBeUndefined();
    expect(allowed.titles).toHaveLength(1);
    expect(allowed.titles[0]).toMatch(/^sky:/);
    expect(JSON.parse((allowed.titles[0] ?? "").slice(4))).toEqual({
      kind: "call",
      id: "c1",
      tool: "bash",
      input: { command: "ls" },
    });
  });

  test("blocks a call the runner refuses, with its reason, and one it doesn't answer", async () => {
    vi.stubEnv("SKY_PI_GATEWAY_TOKEN", "t");
    const gate = (await load()).handlers.get("tool_call");
    const call = { toolName: "write", toolCallId: "c", input: {} };
    expect(
      await gate?.(
        call,
        ctxAnswering({ allow: false, reason: "not that file" }).ctx,
      ),
    ).toEqual({ block: true, reason: "not that file" });
    expect(await gate?.(call, ctxAnswering(undefined).ctx)).toEqual({
      block: true,
      reason: "no one answered in time",
    });
    // an answer that isn't JSON, or a dialog that throws, is no answer
    const garbled = { ui: { input: async () => "{not json" } };
    expect(await gate?.(call, garbled)).toMatchObject({ block: true });
    const throwing = {
      ui: {
        input: async () => {
          throw new Error("closed");
        },
      },
    };
    expect(await gate?.(call, throwing)).toMatchObject({ block: true });
  });

  test("never asks about a read or the runner's own tools", async () => {
    vi.stubEnv("SKY_PI_GATEWAY_TOKEN", "t");
    const gate = (await load()).handlers.get("tool_call");
    const nobody = ctxAnswering({ allow: false });
    for (const toolName of [
      "read",
      "grep",
      "find",
      "ls",
      "sky_publish",
      "sky_sync",
    ])
      expect(
        await gate?.({ toolName, toolCallId: "c", input: {} }, nobody.ctx),
      ).toBeUndefined();
    expect(nobody.titles).toEqual([]);
  });

  test("registers the runner's tools, which return what the runner answers and fail when it doesn't", async () => {
    vi.stubEnv("SKY_PI_GATEWAY_TOKEN", "t");
    const seen = await load();
    expect(seen.tools.map((t) => t.name)).toEqual(["sky_publish"]);
    const tool = seen.tools[0];
    const ok = ctxAnswering({
      success: true,
      text: "https://github.test/pr/1",
    });
    expect(
      await tool?.execute("id1", { title: "T" }, undefined, undefined, ok.ctx),
    ).toEqual({
      content: [{ type: "text", text: "https://github.test/pr/1" }],
      details: {},
    });
    expect(JSON.parse((ok.titles[0] ?? "").slice(4))).toEqual({
      kind: "tool",
      id: "id1",
      tool: "sky_publish",
      args: { title: "T" },
    });
    await expect(
      tool?.execute(
        "id2",
        {},
        undefined,
        undefined,
        ctxAnswering({ success: false, text: "refused" }).ctx,
      ),
    ).rejects.toThrow("refused");
    await expect(
      tool?.execute(
        "id3",
        {},
        undefined,
        undefined,
        ctxAnswering(undefined).ctx,
      ),
    ).rejects.toThrow(/nothing was sent/);
  });

  test("registers no tools for a run with no connector", async () => {
    vi.stubEnv("SKY_PI_GATEWAY_TOKEN", "t");
    expect((await load([])).tools).toEqual([]);
  });
});

describe("PiRpc", () => {
  const fakeChild = () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn(),
    });
    const written: Record<string, unknown>[] = [];
    child.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean))
        written.push(JSON.parse(line));
    });
    return { child, written, rpc: new PiRpc(child as never) };
  };
  const tick = () => new Promise((r) => setTimeout(r, 5));

  test("reads lines that end at LF only, across chunks and multibyte characters", async () => {
    const { child, rpc } = fakeChild();
    const seen: unknown[] = [];
    rpc.onEvent = (type, record) => seen.push([type, record]);
    // U+2028 is valid inside a JSON string and is not a record boundary
    const line = `${JSON.stringify({ type: "message_end", text: "a b é 😀" })}\n`;
    const bytes = Buffer.from(
      `${line}${JSON.stringify({ type: "agent_settled" })}\r\n`,
    );
    child.stdout.write(bytes.subarray(0, 40));
    child.stdout.write(bytes.subarray(40, 41));
    child.stdout.write(bytes.subarray(41));
    await tick();
    expect(seen).toEqual([
      ["message_end", { type: "message_end", text: "a b é 😀" }],
      ["agent_settled", { type: "agent_settled" }],
    ]);
  });

  test("a command resolves to its response's data, and rejects with pi's error", async () => {
    const { child, written, rpc } = fakeChild();
    const state = rpc.command("get_state");
    await tick();
    expect(written[0]).toMatchObject({ type: "get_state" });
    child.stdout.write(
      `${JSON.stringify({ id: written[0]?.id, type: "response", command: "get_state", success: true, data: { sessionId: "s1" } })}\n`,
    );
    expect(await state).toEqual({ sessionId: "s1" });
    const bad = rpc.command("prompt", { message: "x" });
    await tick();
    child.stdout.write(
      `${JSON.stringify({ id: written[1]?.id, type: "response", command: "prompt", success: false, error: "no model" })}\n`,
    );
    await expect(bad).rejects.toThrow("no model");
  });

  test("a command times out, and ends when the process does", async () => {
    const { child, rpc } = fakeChild();
    await expect(rpc.command("get_state", {}, 5)).rejects.toThrow(
      /didn't answer get_state within 5 ms/,
    );
    const pending = rpc.command("get_state");
    child.stderr.write("boom: no model\n");
    await tick();
    child.emit("exit", 3, null);
    await expect(pending).rejects.toThrow(/pi exited \(3\): boom: no model/);
    expect((await rpc.exited).error).toMatch(/exited \(3\)/);
  });

  test("a dialog is answered with what onUiRequest returns, and a notification is not", async () => {
    const { child, written, rpc } = fakeChild();
    rpc.onUiRequest = async (request) => ({ value: `got ${request.title}` });
    child.stdout.write(
      `${JSON.stringify({ type: "extension_ui_request", id: "u1", method: "input", title: "sky:{}" })}\n`,
    );
    child.stdout.write(
      `${JSON.stringify({ type: "extension_ui_request", id: "u2", method: "notify", message: "hi" })}\n`,
    );
    await tick();
    expect(written).toEqual([
      { type: "extension_ui_response", id: "u1", value: "got sky:{}" },
    ]);
  });

  test("a dialog whose handler throws is cancelled, not left open", async () => {
    const { child, written, rpc } = fakeChild();
    rpc.onUiRequest = async () => {
      throw new Error("x");
    };
    child.stdout.write(
      `${JSON.stringify({ type: "extension_ui_request", id: "u1", method: "confirm", title: "t" })}\n`,
    );
    await tick();
    expect(written).toEqual([
      { type: "extension_ui_response", id: "u1", cancelled: true },
    ]);
  });

  test("abort tells pi to stop and cancels the dialogs still open, once", async () => {
    const { child, written, rpc } = fakeChild();
    rpc.onUiRequest = () => new Promise(() => {});
    child.stdout.write(
      `${JSON.stringify({ type: "extension_ui_request", id: "u1", method: "input", title: "sky:{}" })}\n`,
    );
    await tick();
    rpc.abort();
    await tick();
    expect(written.map((m) => m.type)).toEqual([
      "abort",
      "extension_ui_response",
    ]);
    expect(written[1]).toEqual({
      type: "extension_ui_response",
      id: "u1",
      cancelled: true,
    });
  });

  test("a write that fails after pi died ends the process's wait, not the runner", async () => {
    const { child, rpc } = fakeChild();
    child.stdin.emit("error", new Error("write EPIPE"));
    expect((await rpc.exited).error).toMatch(
      /stopped reading its stdin \(write EPIPE\)/,
    );
  });
});

// A stand-in for pi's RPC mode: a Node script that speaks pi's protocol, drives one scenario per prompt,
// and logs what the runner sent it and started it with.
const FAKE_PI = String.raw`
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const log = (m) => appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify(m) + "\n");
const argv = process.argv.slice(2);
const flag = (name) => argv[argv.indexOf(name) + 1];
const extension = flag("--extension");
const agentDir = process.env.PI_CODING_AGENT_DIR;
log({
  start: true,
  argv,
  cwd: process.cwd(),
  env: {
    token: process.env.SKY_PI_GATEWAY_TOKEN,
    key: process.env.AI_GATEWAY_API_KEY,
    agentToken: process.env.AGENT_TOKEN,
    agentDir,
    offline: process.env.PI_OFFLINE,
    secret: process.env.PROJECT_SECRET,
  },
  extension: existsSync(extension) ? readFileSync(extension, "utf8") : null,
  instructions: existsSync(flag("--append-system-prompt")) ? readFileSync(flag("--append-system-prompt"), "utf8") : null,
  settings: existsSync(agentDir + "/settings.json") ? JSON.parse(readFileSync(agentDir + "/settings.json", "utf8")) : null,
  mcp: existsSync(agentDir + "/mcp.json") ? JSON.parse(readFileSync(agentDir + "/mcp.json", "utf8")) : null,
});
if (process.env.FAKE_PI_LOST_SESSION) process.stderr.write("Warning: No project session found with id 'x'; creating a new session with that id.\n");
if (process.env.FAKE_PI_SCENARIO === "exit-early") { process.stderr.write("Error: model not found\n"); process.exit(3); }
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const waiting = new Map();
let n = 0;
const ask = (payload) => new Promise((resolve) => {
  const id = "ui" + ++n;
  waiting.set(id, resolve);
  send({ type: "extension_ui_request", id, method: "input", title: "sky:" + JSON.stringify(payload) });
});
const result = (r) => (r.cancelled ? undefined : JSON.parse(r.value));
const text = (t) => ({ content: [{ type: "text", text: t }] });
const assistant = (message) => send({ type: "message_end", message: { role: "assistant", content: [], stopReason: "stop", ...message } });
const usage = (input, output, extra = {}) => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { total: 0 }, ...extra });
// a tool call as pi runs it: the start event, the extension's dialog, then the end
async function tool(id, name, args, run) {
  send({ type: "tool_execution_start", toolCallId: id, toolName: name, args });
  const gated = !["read", "grep", "find", "ls", "sky_publish", "sky_sync"].includes(name);
  if (gated) {
    const answer = result(await ask({ kind: "call", id, tool: name, input: args }));
    log({ answered: id, answer });
    if (!answer?.allow) {
      send({ type: "tool_execution_end", toolCallId: id, toolName: name, result: text(answer?.reason ?? "blocked"), isError: true });
      return answer;
    }
  }
  const out = await run?.();
  send({ type: "tool_execution_end", toolCallId: id, toolName: name, result: text(out ?? "ok"), isError: false, durationMs: 7 });
  return { allow: true };
}
const settle = (aborted = false) => { send({ type: "agent_end", messages: [], willRetry: false }); send({ type: "agent_settled", aborted }); };
const scenarios = {
  async bash() {
    await tool("t1", "bash", { command: process.env.FAKE_PI_COMMAND ?? "touch made.txt" }, async () => "listing");
    assistant({ content: [{ type: "text", text: "all done" }], usage: usage(100, 10, { cacheRead: 40 }) });
    settle();
  },
  async commands() {
    for (const [i, command] of JSON.parse(process.env.FAKE_PI_COMMANDS).entries())
      await tool("t" + i, "bash", { command });
    assistant({ content: [{ type: "text", text: "ok" }], usage: usage(1, 1) });
    settle();
  },
  async edits() {
    await tool("e1", "edit", { path: "README", edits: [{ oldText: "hi", newText: "ho" }] });
    await tool("e2", "write", { path: "/etc/sky-test", content: "x" });
    await tool("e3", "read", { path: "README" });
    assistant({ content: [{ type: "text", text: "edited" }], usage: usage(5, 5) });
    settle();
  },
  async publish() {
    let out;
    await tool("p1", "sky_publish", { title: "T" }, async () => {
      send({ type: "tool_execution_update", toolCallId: "p1", toolName: "sky_publish", args: {}, partialResult: text("") });
      const answer = result(await ask({ kind: "tool", id: "p1", tool: "sky_publish", args: { title: "T" } }));
      out = answer.text;
      log({ published: answer });
      return answer.text;
    });
    assistant({ content: [{ type: "text", text: out }], usage: usage(1, 1) });
    settle();
  },
  async failing() {
    assistant({ content: [], stopReason: "error", errorMessage: process.env.FAKE_PI_ERROR, usage: usage(10, 1) });
    settle();
  },
  async retried() {
    send({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1, errorMessage: process.env.FAKE_PI_RETRY_ERROR });
    send({ type: "auto_retry_end", success: false, finalError: process.env.FAKE_PI_RETRY_ERROR });
    assistant({ content: [], stopReason: "error", errorMessage: "the model call failed", usage: usage(10, 1) });
    settle();
  },
  async aborted() { assistant({ content: [], stopReason: "aborted", usage: usage(1, 1) }); settle(true); },
  async hang() { await tool("h1", "bash", { command: "touch hang.txt" }); },
  async quiet() { settle(); },
};
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
    const m = JSON.parse(buffer.slice(0, at));
    buffer = buffer.slice(at + 1);
    log(m);
    if (m.type === "extension_ui_response") { const resolve = waiting.get(m.id); waiting.delete(m.id); resolve?.(m); continue; }
    switch (m.type) {
      case "get_state": send({ id: m.id, type: "response", command: "get_state", success: true, data: { sessionId: flag("--session-id") } }); break;
      case "prompt":
        if (process.env.FAKE_PI_SCENARIO === "handled") { send({ id: m.id, type: "response", command: "prompt", success: true, data: { disposition: "handled" } }); break; }
        send({ id: m.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
        send({ type: "agent_start" });
        setTimeout(() => scenarios[process.env.FAKE_PI_SCENARIO ?? "bash"](), 10);
        break;
      case "abort": send({ id: m.id, type: "response", command: "abort", success: true }); settle(true); break;
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("runPiSession", () => {
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
    toolSummary?: string;
  }) => Decision["decision"] | "deny-with-reason" | "expired";

  beforeEach(() => {
    vi.stubEnv("GITHUB_CONNECTOR", undefined);
    root = mkdtempSync(join(tmpdir(), "runner-pi-"));
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
    bin = join(root, "fake-pi.mjs");
    writeFileSync(bin, FAKE_PI);
    logFile = join(root, "pi.log");
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
      runtime: "pi",
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
        FAKE_PI_LOG: logFile,
        FAKE_PI_SCENARIO: "bash",
        SKY_PI_HOME: join(root, "pi-home"),
        PROJECT_SECRET: "project-secret",
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
    if (verdict === "expired") return { kind: "expired" };
    if (verdict === "deny-with-reason")
      return {
        kind: "decided",
        decision: { requestId, decision: "deny", reason: "not that file" },
      };
    if (verdict === "deny")
      return { kind: "decided", decision: { requestId, decision: "deny" } };
    return { kind: "decided", decision: { requestId, decision: "approve" } };
  };
  const depsOf = (over: Partial<Parameters<typeof runPiSession>[1]> = {}) => ({
    post,
    awaitDecision,
    signal: new AbortController().signal,
    warn: () => {},
    gatewayEnv: { AI_GATEWAY_API_KEY: "gw-key" },
    seal,
    bin,
    stopGraceMs: 2_000,
    ...over,
  });
  const run = (scenario?: string, over?: Parameters<typeof depsOf>[0]) => {
    if (scenario) config.sessionEnv.FAKE_PI_SCENARIO = scenario;
    return runPiSession(config, depsOf(over));
  };
  const sent = () =>
    readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Logged);
  const started = () => sent().find((m) => m.start) as Logged;
  const ofType = <T extends RunnerEventPost["type"]>(type: T) =>
    events.filter(
      (e): e is Extract<RunnerEventPost, { type: T }> => e.type === type,
    );
  const answers = () => sent().filter((m) => m.answered);

  test("starts pi on the gateway through the seal, with the proxy's token and not the key, and reports the run", async () => {
    config.sessionEnv.AI_GATEWAY_API_KEY = "gw-key";
    expect(await run()).toBe(0);
    expect(spawned).toHaveLength(1);
    const options = spawned[0];
    expect(options).toMatchObject({
      command: process.execPath,
      name: "pi",
      cwd: join(root, "worktrees", "agt_1"),
    });
    expect(options?.args.slice(0, 7)).toEqual([
      realpathSync(bin),
      "--mode",
      "rpc",
      "--provider",
      PI_PROVIDER,
      "--model",
      DEFAULT_PI_MODEL,
    ]);
    expect(options?.env.SKY_PI_GATEWAY_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    // pi from npm finds its own files: only a compiled pi is told where its package is
    expect(options?.env.PI_PACKAGE_DIR).toBeUndefined();
    for (const name of [
      "AI_GATEWAY_API_KEY",
      "AGENT_TOKEN",
      "GITHUB_CONNECTOR",
    ])
      expect(options?.env[name]).toBeUndefined();
    // the project's own secrets are pi's, and its commands', as Claude Code's commands get them
    expect(started().env).toMatchObject({
      token: options?.env.SKY_PI_GATEWAY_TOKEN,
      secret: "project-secret",
      offline: "1",
    });
    // pi never saw the key or the event token (the log drops what is undefined)
    expect(started().env).not.toHaveProperty("key");
    expect(started().env).not.toHaveProperty("agentToken");
    expect(started().env.agentDir).toBe(join(root, "pi-home", "agent"));
    expect(ofType("run.started")[0]?.payload.sessionId).toMatch(
      /^[0-9a-f-]{36}$/,
    );
    const finished = ofType("run.finished")[0]?.payload;
    expect(finished?.summary).toBe("all done");
    // pi reports tokens and no price: every prompt token counts, and the cost is 0
    expect(finished?.usage).toMatchObject({
      inputTokens: 140,
      outputTokens: 10,
      costUsd: 0,
      turns: 1,
    });
    expect(ofType("claude.Message").map((e) => e.payload.text)).toEqual([
      "all done",
    ]);
  });

  test("loads only what the runner names, from a session in the run's own directories", async () => {
    expect(await run()).toBe(0);
    const { argv } = started();
    const at = (flag: string) => argv[argv.indexOf(flag) + 1];
    for (const flag of [
      "--no-extensions",
      "--no-approve",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-mcp",
    ])
      expect(argv).toContain(flag);
    expect(argv).not.toContain("--no-session");
    expect(at("--session-dir")).toBe(join(root, "pi-home", "sessions"));
    expect(at("--extension")).toMatch(/sky-pi-extension\.mjs$/);
    expect(argv).not.toContain("builtin:mcp");
    expect(started().settings).toMatchObject({
      packages: [],
      extensions: [],
      skills: [],
      defaultProjectTrust: "never",
    });
    expect(started().extension).toContain("registerProvider");
    expect(started().extension).not.toMatch(/[0-9a-f]{64}/);
    expect(started().instructions).toContain("no subagents");
  });

  test("a model and skill directories the environment names are passed on", async () => {
    mkdirSync(join(root, "skills/one"), { recursive: true });
    mkdirSync(join(root, "home/.sky/pi/skills"), { recursive: true });
    config.piModel = "openai/gpt-5.4-mini";
    config.piSkills = [
      join(root, "skills/one"),
      "~/.sky/pi/skills",
      join(root, "skills/gone"),
    ];
    const warnings: string[] = [];
    expect(await run(undefined, { warn: (l) => warnings.push(l) })).toBe(0);
    const { argv } = started();
    expect(argv[argv.indexOf("--model") + 1]).toBe("openai/gpt-5.4-mini");
    const skills = argv.flatMap((a: string, i: number) =>
      a === "--skill" ? [argv[i + 1]] : [],
    );
    expect(skills).toEqual([
      join(root, "skills/one"),
      join(root, "home/.sky/pi/skills"),
    ]);
    expect(warnings.join("\n")).toMatch(
      /skill directory .*gone is not there; skipped/,
    );
    expect(
      ofType("runner.warning")
        .map((e) => e.payload.message)
        .join("\n"),
    ).toMatch(/gone is not there/);
  });

  test("the base profile's MCP servers reach pi through the run's mcp.json, as references", async () => {
    config.mcpServers = {
      doop: { command: "npx", args: ["doop"], env: { API_KEY: "DOOP_KEY" } },
      lost: { command: "x", args: [], env: { K: "NOT_SET" } },
    };
    config.sessionEnv.DOOP_KEY = "doop-secret";
    expect(await run()).toBe(0);
    const { argv, mcp } = started();
    expect(argv).not.toContain("--no-mcp");
    expect(argv.filter((a: string) => a === "--extension")).toHaveLength(2);
    expect(argv).toContain("builtin:mcp");
    expect(mcp).toEqual({
      mcpServers: {
        doop: {
          command: "npx",
          args: ["doop"],
          env: { API_KEY: ref("DOOP_KEY") },
          exposure: "direct",
        },
      },
    });
    expect(JSON.stringify(mcp)).not.toContain("doop-secret");
    expect(
      ofType("runner.warning")
        .map((e) => e.payload.message)
        .join("\n"),
    ).toMatch(/lost \(NOT_SET\)/);
  });

  test("an mcp.json from an earlier run is gone when this run has no servers", async () => {
    mkdirSync(join(root, "pi-home/agent"), { recursive: true });
    writeFileSync(join(root, "pi-home/agent/mcp.json"), "{}");
    expect(await run()).toBe(0);
    expect(started().mcp).toBeNull();
    expect(existsSync(join(root, "pi-home/agent/mcp.json"))).toBe(false);
  });

  test("a command no policy pattern holds runs without asking", async () => {
    config.approvalPolicy = ["Edit"];
    expect(await run()).toBe(0);
    expect(ofType("run.waiting")).toEqual([]);
    expect(answers()[0]?.answer).toEqual({ allow: true });
    expect(ofType("claude.PreToolUse")[0]?.payload).toMatchObject({
      toolName: "Bash",
      toolUseId: "t1",
    });
  });

  test("a read-only command self-approves with the note, and asks no one", async () => {
    config.sessionEnv.FAKE_PI_COMMAND = "git status";
    expect(await run()).toBe(0);
    expect(ofType("run.waiting")).toEqual([]);
    expect(ofType("claude.PreToolUse")[0]?.payload.autoApproved).toMatchObject({
      verdict: "approved",
    });
  });

  test("a held command opens one approval with the real command, and runs when approved", async () => {
    expect(await run()).toBe(0);
    const waiting = ofType("run.waiting");
    expect(waiting).toHaveLength(1);
    expect(waiting[0]?.payload.request).toMatchObject({
      kind: "approval",
      toolName: "Bash",
      toolSummary: "touch made.txt",
      toolInput: JSON.stringify({ command: "touch made.txt" }),
    });
    expect(answers()[0]?.answer).toEqual({ allow: true });
    expect(ofType("claude.PreToolUse")[0]?.payload).toMatchObject({
      toolName: "Bash",
      toolUseId: "t1",
    });
    expect(ofType("claude.PostToolUse")[0]?.payload).toMatchObject({
      toolName: "Bash",
      output: "listing",
      durationMs: 7,
    });
  });

  test("a denial blocks the call, and its reason goes back to the model", async () => {
    decide = () => "deny-with-reason";
    expect(await run()).toBe(0);
    expect(answers()[0]?.answer).toEqual({
      allow: false,
      reason: "not that file",
    });
    const failure = ofType("claude.PostToolUseFailure")[0]?.payload;
    expect(failure).toMatchObject({ toolName: "Bash", error: "not that file" });
    // the call is reported, as a call that failed, once it ends: as Codex's declined ones are
    expect(ofType("claude.PreToolUse").map((e) => e.payload.toolName)).toEqual([
      "Bash",
    ]);
  });

  test("a denial with no reason says the person declined", async () => {
    decide = () => "deny";
    expect(await run()).toBe(0);
    expect(answers()[0]?.answer).toEqual({
      allow: false,
      reason: "The person declined this call.",
    });
  });

  test.each([
    "sudo -u deploy touch made.txt && git push",
    "bash -lc 'git push'",
    "env A=1 git push",
  ])("a pattern naming git push holds %s", async (command) => {
    config.approvalPolicy = ["Bash(git push:*)"];
    config.sessionEnv.FAKE_PI_COMMAND = command;
    expect(await run()).toBe(0);
    expect(ofType("run.waiting")).toHaveLength(1);
  });

  test("edits and writes are held as the policy holds them; a change outside the worktree is held whatever it says; reads are not asked", async () => {
    config.approvalPolicy = ["Edit"];
    expect(await run("edits")).toBe(0);
    const asked = ofType("run.waiting").map((e) => e.payload.request);
    expect(asked).toHaveLength(2);
    expect(asked[0]).toMatchObject({
      toolName: "Edit",
      toolSummary: join(root, "worktrees", "agt_1", "README"),
    });
    expect(asked[1]).toMatchObject({
      toolName: "Write",
      toolSummary: "/etc/sky-test",
    });
    // the read ran with its event and no question
    expect(
      ofType("claude.PreToolUse").map((e) => e.payload.toolName),
    ).toContain("Read");
    expect(answers().map((m) => m.answered)).toEqual(["e1", "e2"]);
  });

  test("sky_publish without the connector sends nothing and says why, and asks no approval of its own", async () => {
    expect(await run("publish")).toBe(0);
    const published = sent().find((m) => m.published)?.published;
    expect(published.success).toBe(false);
    expect(published.text).toMatch(/GitHub connector/);
    expect(ofType("run.waiting")).toEqual([]);
    // run unasked, with its event, as the runner's own tool
    expect(ofType("claude.PreToolUse")[0]?.payload.toolName).toBe(
      "sky_publish",
    );
    expect(ofType("claude.PostToolUseFailure")).toEqual([]);
  });

  test("the extension carries the runner's tools only when the run has a connector", async () => {
    expect(await run()).toBe(0);
    expect(started().extension).toContain('"tools":[]');
    events = [];
    rmSync(logFile);
    expect(
      await run(undefined, {
        connector: { GITHUB_CONNECTOR: "connector-secret" },
      }),
    ).toBe(0);
    expect(started().extension).toContain('"name":"sky_publish"');
    expect(started().extension).toContain('"name":"sky_sync"');
    expect(started().extension).not.toContain("connector-secret");
  });

  test("publish and sync check the seal each time they are asked for", async () => {
    let checks = 0;
    // sound at pi's start, readable by the time the agent asks to publish
    seal = { ...seal, check: () => (checks++ === 0 ? undefined : "readable") };
    expect(
      await run("publish", {
        connector: { GITHUB_CONNECTOR: "connector-secret" },
      }),
    ).toBe(0);
    const published = sent().find((m) => m.published)?.published;
    expect(published.success).toBe(false);
    expect(published.text).toMatch(
      /sky publish refused: the runner can't confirm.*readable.*nothing was sent/,
    );
  });

  test("what the environment's refresh script did rides run.started", async () => {
    const refresh = { outcome: "ran", exitCode: 0, durationMs: 12 } as const;
    expect(await run(undefined, { envRefresh: refresh })).toBe(0);
    expect(ofType("run.started")[0]?.payload.refresh).toEqual(refresh);
    events = [];
    expect(await run()).toBe(0);
    expect(ofType("run.started")[0]?.payload).not.toHaveProperty("refresh");
  });

  test("the run's pi home is SKY_PI_HOME, else under HOME", () => {
    expect(piHomeOf({ SKY_PI_HOME: "/p", HOME: "/h" })).toBe("/p");
    expect(piHomeOf({ HOME: "/h" })).toBe("/h/.sky/pi");
  });

  test("resumes the session it is given, and reports it", async () => {
    config.sessionId = "sess-7";
    expect(await run()).toBe(0);
    const { argv } = started();
    expect(argv[argv.indexOf("--session-id") + 1]).toBe("sess-7");
    expect(ofType("run.started")[0]?.payload.sessionId).toBe("sess-7");
    expect(ofType("runner.warning")).toEqual([]);
  });

  test("a session pi doesn't have is a fresh one, and the run says so", async () => {
    config.sessionId = "gone-1";
    config.sessionEnv.FAKE_PI_LOST_SESSION = "1";
    expect(await run()).toBe(0);
    expect(ofType("runner.warning")[0]?.payload.message).toMatch(
      /no session gone-1 to resume/,
    );
  });

  test("a model call that fails fails the run with the model's error", async () => {
    config.sessionEnv.FAKE_PI_ERROR = "context window exceeded";
    expect(await run("failing")).toBe(1);
    expect(ofType("run.failed")[0]?.payload.error).toBe(
      "context window exceeded",
    );
    expect(ofType("run.finished")).toEqual([]);
  });

  test("a call the gateway refuses for credit fails as pi_unavailable, quoting pi", async () => {
    config.sessionEnv.FAKE_PI_ERROR =
      "402 Payment Required: insufficient credits";
    expect(await run("failing")).toBe(1);
    expect(ofType("run.failed")[0]?.payload.error).toBe(
      "pi_unavailable: the AI Gateway is out of credit (pi said: 402 Payment Required: insufficient credits)",
    );
  });

  test("retries that gave up on 429s fail as rate-limited", async () => {
    config.sessionEnv.FAKE_PI_RETRY_ERROR = "429 Too Many Requests";
    expect(await run("retried")).toBe(1);
    expect(ofType("run.failed")[0]?.payload.error).toMatch(
      /^pi_unavailable: the AI Gateway rate-limited this run \(pi said: the model call failed\)$/,
    );
    expect(
      ofType("runner.warning")
        .map((e) => e.payload.message)
        .join("\n"),
    ).toMatch(/pi is retrying \(1\/3\): 429/);
  });

  test("a bare failure after the proxy saw a 402 is out of credit", async () => {
    config.sessionEnv.FAKE_PI_ERROR = "the model call failed";
    const ran = await run("failing", {
      startProxy: async () => ({
        baseUrl: "http://127.0.0.1:9/v1",
        token: "t".repeat(64),
        close: async () => {},
        limitStatus: () => 402,
      }),
    });
    expect(ran).toBe(1);
    expect(ofType("run.failed")[0]?.payload.error).toMatch(
      /^pi_unavailable: the AI Gateway is out of credit/,
    );
  });

  test("a failure the gateway didn't cause keeps pi's own error, even after a 402", async () => {
    // the proxy's latest answer was a 402, but the run stopped for another reason
    const controller = new AbortController();
    const ran = run("hang", {
      signal: controller.signal,
      startProxy: async () => ({
        baseUrl: "http://127.0.0.1:9/v1",
        token: "t".repeat(64),
        close: async () => {},
        limitStatus: () => 402,
      }),
    });
    await vi.waitFor(() => expect(ofType("run.waiting")).toHaveLength(1));
    controller.abort("SIGTERM");
    expect(await ran).toBe(1);
    expect(ofType("run.failed")[0]?.payload.error).toBe(
      "interrupted by SIGTERM",
    );
  });

  test("an aborted turn nobody stopped fails the run", async () => {
    expect(await run("aborted")).toBe(1);
    expect(ofType("run.failed")[0]?.payload.error).toBe("the turn was aborted");
  });

  test("pi exiting before it is ready fails the run with what it said", async () => {
    expect(await run("exit-early")).toBe(1);
    const error = ofType("run.failed")[0]?.payload.error ?? "";
    expect(error).toMatch(/^pi exited \(3\): Error: model not found$/);
    expect(ofType("run.started")).toEqual([]);
  });

  test("a prompt pi handled without running the agent fails the run", async () => {
    expect(await run("handled")).toBe(1);
    expect(ofType("run.failed")[0]?.payload.error).toMatch(
      /handled the prompt/,
    );
  });

  test("a stop aborts pi and fails the run, and a call waiting on a person ends", async () => {
    const controller = new AbortController();
    // the decision never comes before the stop, which ends the wait as the API's long-poll ends
    const ran = run("hang", {
      signal: controller.signal,
      awaitDecision: (_id, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    });
    await vi.waitFor(() => expect(ofType("run.waiting")).toHaveLength(1));
    controller.abort("SIGTERM");
    expect(await ran).toBe(1);
    expect(sent().some((m) => m.type === "abort")).toBe(true);
    expect(ofType("run.failed")[0]?.payload.error).toBe(
      "interrupted by SIGTERM",
    );
    // the open request was withdrawn, and pi's blocked call was answered so it could end
    expect(ofType("run.withdrawn")).toHaveLength(1);
    expect(sent().some((m) => m.type === "extension_ui_response")).toBe(true);
  });

  test("a decision that never comes fails the run at the wait timeout, not never", async () => {
    decide = () => "expired";
    expect(await run("hang")).toBe(1);
    expect(ofType("run.failed")[0]?.payload.error).toBe("waiting_timeout");
    // pi was told to stop, and its blocked call was answered
    expect(sent().some((m) => m.type === "abort")).toBe(true);
  });

  test("the run's proxy gets the key and the gateway's OpenAI path, and closes when the run ends", async () => {
    let closed = false;
    const given: { upstream?: string; key?: string } = {};
    const ran = await runPiSession(
      config,
      depsOf({
        startProxy: async (options) => {
          given.upstream = options.upstream;
          given.key = options.key;
          return {
            baseUrl: "http://127.0.0.1:9/v1",
            token: "t".repeat(64),
            close: async () => {
              closed = true;
            },
          };
        },
      }),
    );
    expect(ran).toBe(0);
    expect(given).toEqual({
      upstream: "https://ai-gateway.vercel.sh/v1",
      key: "gw-key",
    });
    expect(spawned[0]?.env.SKY_PI_GATEWAY_TOKEN).toBe("t".repeat(64));
    expect(started().extension).toContain('"baseUrl":"http://127.0.0.1:9/v1"');
    expect(closed).toBe(true);
  });

  test("a run with no gateway key fails before pi starts", async () => {
    expect(await run(undefined, { gatewayEnv: {} })).toBe(1);
    expect(ofType("run.failed")[0]?.payload.error).toMatch(
      /AI_GATEWAY_API_KEY is not set/,
    );
    expect(spawned).toEqual([]);
  });

  test("a runner that can't be hidden fails the run before anything starts", async () => {
    seal = { ...seal, problem: "the runner can't change its effective user" };
    expect(await run()).toBe(1);
    expect(ofType("run.failed")[0]?.payload.error).toMatch(
      /^credential_exposed: Sky can't keep its AI Gateway key from this repo's commands \(the runner can't change/,
    );
    expect(spawned).toEqual([]);
    expect(ofType("run.started")).toEqual([]);
  });

  test("a pi process the kernel leaves readable stops the run", async () => {
    seal = {
      ...seal,
      check: () => "the kernel lets the repo's commands read pi's environment",
    };
    expect(await run()).toBe(1);
    expect(ofType("run.failed")[0]?.payload.error).toMatch(
      /^credential_exposed: .*read pi's environment.*the run was stopped/,
    );
    expect(ofType("run.started")).toEqual([]);
  });

  test("the scratch directory, with the extension in it, is gone when the run ends", async () => {
    expect(await run()).toBe(0);
    const extension = started().argv[
      started().argv.indexOf("--extension") + 1
    ] as string;
    expect(existsSync(extension)).toBe(false);
  });

  test("the worktree's changes are committed when the run ends", async () => {
    expect(await run()).toBe(0);
    expect(existsSync(join(root, "worktrees", "agt_1", "README"))).toBe(true);
  });
});
