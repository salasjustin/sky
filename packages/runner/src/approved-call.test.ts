import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Decision, RunnerEventPost } from "@sky/shared";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { server } from "../../../test/msw.js";
import type { Config } from "./config.js";
import { createPoster } from "./events.js";
import { createDecisionWaiter } from "./requests.js";
import type { QueryFn } from "./session.js";
import { hermeticRunSession as runSession } from "./testing/hermetic-run.js";

// the Claude Code binary the Agent SDK ships beside itself: the platform package for this arch and
// libc; undefined when it isn't installed, so the block skips (nested-claude.test.ts fails CI on that)
const claudeBinary = (() => {
  try {
    const sdk = realpathSync(
      join(
        import.meta.dirname,
        "../node_modules/@anthropic-ai/claude-agent-sdk",
      ),
    );
    return ["", "-musl"]
      .map((libc) =>
        join(
          dirname(sdk),
          `claude-agent-sdk-${process.platform}-${process.arch}${libc}`,
          "claude",
        ),
      )
      .find((path) => existsSync(path));
  } catch {
    return undefined;
  }
})();

type Block = { type?: string; text?: string; content?: unknown };
type Body = {
  model?: string;
  stream?: boolean;
  system?: string | Block[];
  tools?: { name: string }[];
  messages?: { content: unknown }[];
};

/**
 * A stand-in for the Anthropic API: the first turn calls Bash with `command(system prompt)`, every
 * later one answers "done". `requests` keeps each model request's body, for what Claude was sent back.
 */
function standIn(command: (system: string) => string) {
  const requests: Body[] = [];
  let called = false;
  const api: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (!req.url?.startsWith("/v1/messages")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as Body;
      requests.push(body);
      const message = {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: body.model ?? "stand-in",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
      if (body.stream === false) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ...message,
            content: [{ type: "text", text: "done" }],
            stop_reason: "end_turn",
          }),
        );
        return;
      }
      const callsBash =
        !called && (body.tools ?? []).some((tool) => tool.name === "Bash");
      if (callsBash) called = true;
      const system =
        typeof body.system === "string"
          ? body.system
          : (body.system ?? []).map((block) => block.text ?? "").join("\n");
      const events: string[] = [];
      const event = (type: string, data: object) =>
        events.push(
          `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
        );
      event("message_start", { message });
      event("content_block_start", {
        index: 0,
        content_block: callsBash
          ? { type: "tool_use", id: "toolu_1", name: "Bash", input: {} }
          : { type: "text", text: "" },
      });
      event("content_block_delta", {
        index: 0,
        delta: callsBash
          ? {
              type: "input_json_delta",
              partial_json: JSON.stringify({
                command: command(system),
                description: "Run the check",
              }),
            }
          : { type: "text_delta", text: "done" },
      });
      event("content_block_stop", { index: 0 });
      event("message_delta", {
        delta: {
          stop_reason: callsBash ? "tool_use" : "end_turn",
          stop_sequence: null,
        },
        usage: { output_tokens: 1 },
      });
      event("message_stop", {});
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(events.join(""));
    });
  });
  return { api, requests };
}

/** The tool results Claude Code sent back to the model, across every request. */
const toolResultsIn = (requests: Body[]) =>
  requests.flatMap((body) =>
    (body.messages ?? []).flatMap((m) =>
      Array.isArray(m.content)
        ? (m.content as Block[]).filter((block) => block.type === "tool_result")
        : [],
    ),
  );

/** The command a check's nested `claude` runs, as the prompt gives it, with `tail` in place of `claude … -p …`. */
const nestedCheck = (tail: string) => (system: string) => {
  const prefix = /as `([^`]*?)claude [^`]*-p …`/.exec(system)?.[1];
  if (!prefix) throw new Error("the prompt names no nested claude command");
  return `${prefix}${tail}`;
};

let root: string;
let home: string;
beforeEach(() => {
  vi.stubEnv("GITHUB_CONNECTOR", undefined);
  root = mkdtempSync(join(tmpdir(), "approved-call-"));
  mkdirSync(join(root, "os-tmp"));
  vi.stubEnv("TMPDIR", join(root, "os-tmp"));
  const origin = join(root, "origin");
  execFileSync("git", ["init", "-q", "-b", "main", origin]);
  writeFileSync(join(origin, "README"), "hi\n");
  execFileSync("git", ["-C", origin, "add", "."]);
  execFileSync("git", [
    "-C",
    origin,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-qm",
    "init",
  ]);
  execFileSync("git", ["clone", "-q", origin, join(root, "repo")]);
  // the machine's own `~/.claude` (its plugins and hooks) stays out of the session
  home = join(root, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

/**
 * A run under a bare Bash policy, on the real binary, against the stand-in API: its one Bash call is
 * `command`, held, and decided `decision` at once.
 */
async function heldRun(
  command: (system: string) => string,
  decision: Omit<Extract<Decision, { decision: "approve" }>, "requestId">,
) {
  const { api, requests } = standIn(command);
  await new Promise<void>((done) => api.listen(0, "127.0.0.1", done));
  const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  const sent: RunnerEventPost[] = [];
  server.use(
    http.post("https://api.test/internal/events", async ({ request }) => {
      sent.push((await request.json()) as RunnerEventPost);
      return HttpResponse.json({ id: "evt_1" }, { status: 201 });
    }),
    http.get(
      "https://api.test/internal/runs/run_1/requests/:requestId",
      ({ params }) =>
        HttpResponse.json({
          status: "decided",
          decision: { requestId: String(params.requestId), ...decision },
        }),
    ),
  );
  // the session's own options on the real binary: the test seal's spawn is replaced by the SDK's,
  // and the stand-in API is the one place the runner lets the session's env name an endpoint
  const real: QueryFn = ({ prompt, options }) => {
    const { spawnClaudeCodeProcess: _, ...rest } = options;
    return query({
      prompt,
      options: {
        ...rest,
        pathToClaudeCodeExecutable: claudeBinary,
        env: {
          ...rest.env,
          HOME: home,
          // a relocated config dir on the host would win over HOME and bring the host's own
          // settings, plugins and hooks into the session; the rest are host credentials or backends
          CLAUDE_CONFIG_DIR: join(home, ".claude"),
          ANTHROPIC_API_KEY: undefined,
          ANTHROPIC_AUTH_TOKEN: undefined,
          CLAUDE_CODE_USE_BEDROCK: undefined,
          CLAUDE_CODE_USE_VERTEX: undefined,
          CLAUDE_CODE_USE_FOUNDRY: undefined,
          ANTHROPIC_BASE_URL: apiUrl,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          DISABLE_AUTOUPDATER: "1",
        },
      },
    });
  };
  const config: Config = {
    agentId: "agt_1",
    runId: "run_1",
    prompt: "run the checks",
    sessionId: undefined,
    apiBaseUrl: "https://api.test",
    agentToken: "agent-secret",
    claudeAuth: "oauth",
    repoDir: join(root, "repo"),
    worktreesDir: join(root, "worktrees"),
    approvalPolicy: ["Bash"],
    autoApprove: { defaults: true, commands: [] },
    sessionEnv: {},
    // a check gives the prompt its nested claude command, and the run its login file
    checks: ["claude -p /kru:reflect"],
    mcpServers: {},
    waitTimeoutMs: 60_000,
    launchDeadlineMs: 15 * 60_000,
    startBranch: undefined,
  };
  const timing = { sleep: async () => {} };
  const warned: string[] = [];
  try {
    const code = await runSession(config, {
      query: real,
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
      credentialEnv: { CLAUDE_CODE_OAUTH_TOKEN: "dummy-oauth-credential-0001" },
      env: { ...process.env, HOME: home },
      warn: (line) => warned.push(line),
    });
    return { code, sent, requests, warned };
  } finally {
    api.closeAllConnections();
    api.close();
  }
}

/**
 * A PreToolUse hook that does what kru's require-lead.sh does from the sprite's own settings: exit 2
 * until its switch is set. It records the switch it saw at `marker`, so a hook that never loaded
 * can't pass for one that did.
 */
const leadHook = (marker: string) => ({
  PreToolUse: [
    {
      matcher: "Bash",
      hooks: [
        {
          type: "command",
          command: `printf %s "$KRU_NO_LEAD_GATE" > '${marker}'; [ -n "$KRU_NO_LEAD_GATE" ] || { echo 'load the lead contract, then take the action again' >&2; exit 2; }`,
        },
      ],
    },
  ],
});

const types = (sent: RunnerEventPost[]) => sent.map((e) => e.type);
const warnings = (sent: RunnerEventPost[]) =>
  sent.flatMap((e) => (e.type === "runner.warning" ? [e.payload.message] : []));

describe.skipIf(!claudeBinary)(
  "an approved held tool call (real binary)",
  () => {
    test("a check's nested claude command, held and approved, runs: its PostToolUse lands and Claude gets its output", async () => {
      const { code, sent, requests } = await heldRun(nestedCheck("echo RAN"), {
        decision: "approve",
      });
      expect(code).toBe(0);
      expect(types(sent)).toEqual([
        "run.started",
        "claude.PreToolUse",
        "run.waiting",
        "claude.PostToolUse",
        "claude.Message",
        "run.finished",
      ]);
      expect(toolResultsIn(requests)).toEqual([
        expect.objectContaining({ content: "RAN", is_error: false }),
      ]);
      expect(warnings(sent)).toEqual([]);
    }, 90_000);

    test("approved with a reason, it runs the same, and Claude gets the reason with its output", async () => {
      const { sent, requests } = await heldRun(nestedCheck("echo RAN"), {
        decision: "approve",
        reason: "the nightly check is fine to run",
      });
      expect(types(sent)).toContain("claude.PostToolUse");
      expect(toolResultsIn(requests)).toEqual([
        expect.objectContaining({ content: "RAN", is_error: false }),
      ]);
      expect(JSON.stringify(requests.at(-1)?.messages)).toContain(
        "The person who approved this tool call noted: the nightly check is fine to run",
      );
    }, 90_000);

    test("an approved call that runs and fails reports through PostToolUseFailure, not as a refusal", async () => {
      const { sent } = await heldRun(() => "echo broke >&2; exit 3", {
        decision: "approve",
      });
      expect(types(sent)).toContain("claude.PostToolUseFailure");
      expect(warnings(sent)).toEqual([]);
    }, 90_000);

    test("with a lead-contract hook installed that refuses unless KRU_NO_LEAD_GATE is set, the approved call runs and Claude is not told to ask again", async () => {
      const marker = join(root, "lead-hook-saw");
      writeFileSync(
        join(home, ".claude", "settings.json"),
        JSON.stringify({ hooks: leadHook(marker) }),
      );
      const { sent, requests } = await heldRun(nestedCheck("echo RAN"), {
        decision: "approve",
      });
      expect(readFileSync(marker, "utf8")).not.toBe("");
      expect(types(sent)).toContain("claude.PostToolUse");
      expect(warnings(sent)).toEqual([]);
      expect(toolResultsIn(requests)).toEqual([
        expect.objectContaining({ content: "RAN", is_error: false }),
      ]);
    }, 90_000);

    test("with user and project settings files whose env sets KRU_NO_LEAD_GATE empty, the lead-contract hook still sees it set and the approved call runs", async () => {
      // a settings file's `env` is written over the env the runner passed; only the session's flag
      // settings outrank it
      const marker = join(root, "lead-hook-saw");
      const unset = { env: { KRU_NO_LEAD_GATE: "" } };
      writeFileSync(
        join(home, ".claude", "settings.json"),
        JSON.stringify({ ...unset, hooks: leadHook(marker) }),
      );
      // the worktree is cut from origin/HEAD, so the project file is committed there and fetched
      const origin = join(root, "origin");
      mkdirSync(join(origin, ".claude"));
      writeFileSync(
        join(origin, ".claude", "settings.json"),
        JSON.stringify(unset),
      );
      execFileSync("git", ["-C", origin, "add", "."]);
      execFileSync("git", [
        "-C",
        origin,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "-qm",
        "project settings",
      ]);
      execFileSync("git", ["-C", join(root, "repo"), "fetch", "-q", "origin"]);
      const { sent, requests } = await heldRun(nestedCheck("echo RAN"), {
        decision: "approve",
      });
      expect(readFileSync(marker, "utf8")).not.toBe("");
      expect(types(sent)).toContain("claude.PostToolUse");
      expect(warnings(sent)).toEqual([]);
      expect(toolResultsIn(requests)).toEqual([
        expect.objectContaining({ content: "RAN", is_error: false }),
      ]);
    }, 90_000);

    test("one a user settings hook blocks after the gate never runs, and the run posts Claude Code's refusal as a warning", async () => {
      // a plugin's gate does this from the sprite's own settings: a PreToolUse command hook exiting 2
      writeFileSync(
        join(home, ".claude", "settings.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                matcher: "Bash",
                hooks: [
                  {
                    type: "command",
                    command: "echo 'load the contract first' >&2; exit 2",
                  },
                ],
              },
            ],
          },
        }),
      );
      const { sent, requests, warned } = await heldRun(
        nestedCheck("echo RAN"),
        { decision: "approve" },
      );
      expect(types(sent)).not.toContain("claude.PostToolUse");
      expect(types(sent)).not.toContain("claude.PostToolUseFailure");
      const [refusal] = toolResultsIn(requests);
      expect(refusal).toEqual(
        expect.objectContaining({
          is_error: true,
          content: expect.stringContaining("load the contract first"),
        }),
      );
      const message = `Claude Code turned down Bash call toolu_1 after the runner let it through: ${String(refusal?.content)}`;
      expect(warnings(sent)).toEqual([message]);
      expect(warned).toContain(`runner: ${message}`);
    }, 90_000);
  },
);
