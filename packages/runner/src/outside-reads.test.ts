import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type Options,
  query,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { outsideRead, stageRead } from "./outside-reads.js";

// the Claude Code binary the Agent SDK ships beside itself: the platform package for this arch and libc
const claudeBinary = (() => {
  const sdk = realpathSync(
    join(import.meta.dirname, "../node_modules/@anthropic-ai/claude-agent-sdk"),
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
})();

let root: string;
let api: Server;
let apiUrl: string;
/** What each Read the fake model asked for returned, as the model saw it. */
let toolResults: string[];
let readTarget: string;

/** A model that reads `readTarget` once, then says it is done; it records the tool result it was given. */
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "outside-reads-")));
  toolResults = [];
  let turn = 0;
  const stream = (events: [string, object][]) =>
    events
      .map(
        ([t, d]) =>
          `event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`,
      )
      .join("");
  api = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (!req.url?.startsWith("/v1/messages")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end("{}");
      }
      const message = {
        id: `msg_${turn}`,
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-sonnet-5-5",
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (turn++ === 0)
        return res.end(
          stream([
            ["message_start", { message }],
            [
              "content_block_start",
              {
                index: 0,
                content_block: {
                  type: "tool_use",
                  id: "toolu_1",
                  name: "Read",
                  input: {},
                },
              },
            ],
            [
              "content_block_delta",
              {
                index: 0,
                delta: {
                  type: "input_json_delta",
                  partial_json: JSON.stringify({ file_path: readTarget }),
                },
              },
            ],
            ["content_block_stop", { index: 0 }],
            [
              "message_delta",
              {
                delta: { stop_reason: "tool_use" },
                usage: { output_tokens: 2 },
              },
            ],
            ["message_stop", {}],
          ]),
        );
      for (const m of JSON.parse(body).messages as { content: unknown }[])
        for (const block of Array.isArray(m.content) ? m.content : [])
          if ((block as { type?: string }).type === "tool_result")
            toolResults.push(String((block as { content: unknown }).content));
      res.end(
        stream([
          ["message_start", { message }],
          [
            "content_block_start",
            { index: 0, content_block: { type: "text", text: "" } },
          ],
          [
            "content_block_delta",
            { index: 0, delta: { type: "text_delta", text: "done" } },
          ],
          ["content_block_stop", { index: 0 }],
          [
            "message_delta",
            { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
          ],
          ["message_stop", {}],
        ]),
      );
    });
  });
  await new Promise<void>((done) => api.listen(0, "127.0.0.1", done));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});
afterEach(() => {
  api.closeAllConnections();
  api.close();
  rmSync(root, { recursive: true, force: true });
});

/** Runs the real Claude Code, in bypass mode as a Sky run is, to its Read of `readTarget`. */
async function run(options: Options): Promise<{ asked: string[] }> {
  const worktree = join(root, "worktree");
  mkdirSync(worktree, { recursive: true });
  mkdirSync(join(root, "home"), { recursive: true });
  const asked: string[] = [];
  const stream = query({
    prompt: "read it",
    options: {
      cwd: worktree,
      model: "claude-sonnet-5-5",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      settingSources: [],
      env: {
        PATH: process.env.PATH,
        HOME: join(root, "home"),
        ANTHROPIC_API_KEY: "key",
        ANTHROPIC_BASE_URL: apiUrl,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_AUTOUPDATER: "1",
      },
      canUseTool: async (tool, input) => {
        asked.push(tool);
        return { behavior: "allow", updatedInput: input };
      },
      ...options,
    },
  });
  for await (const message of stream as AsyncIterable<SDKMessage>)
    if (message.type === "result") break;
  return { asked };
}

// the setting a sprite's own settings file can hold; with it, Claude Code refuses every Read outside
// its working directories, in bypass mode too, and never asks the permission callback
const BLOCKED = { permissions: { blockReadsOutsideWorkingDirectories: true } };

describe.skipIf(!claudeBinary)(
  "reads outside the working directories (real binary)",
  () => {
    beforeEach(() => {
      readTarget = join(root, "outside.log");
      writeFileSync(readTarget, "OUTSIDE\n");
    });

    test("with reads outside the working directories blocked, the Read is declined and nothing is asked", async () => {
      const { asked } = await run({ settings: BLOCKED });
      expect(toolResults).toHaveLength(1);
      expect(toolResults[0]).toContain("blockReadsOutsideWorkingDirectories");
      expect(asked).toEqual([]);
    }, 90_000);

    test("a scratch directory added to the working directories is read despite the block", async () => {
      const scratch = join(root, "scratch");
      mkdirSync(scratch);
      readTarget = join(scratch, "reflect.log");
      writeFileSync(readTarget, "NESTED LOG\n");
      await run({ settings: BLOCKED, additionalDirectories: [scratch] });
      expect(toolResults[0]).toContain("NESTED LOG");
    }, 90_000);

    test("an approved outside file, copied into the scratch directory and the call pointed at the copy, is read despite the block", async () => {
      const scratch = join(root, "scratch");
      mkdirSync(scratch);
      const outside = outsideRead(
        "Read",
        { file_path: readTarget },
        [join(root, "worktree"), scratch],
        join(root, "worktree"),
      );
      expect(outside).toEqual({ field: "file_path", path: readTarget });
      const copy = stageRead(
        outside as NonNullable<typeof outside>,
        scratch,
        1,
      );
      await run({
        settings: BLOCKED,
        additionalDirectories: [scratch],
        hooks: {
          PreToolUse: [
            {
              hooks: [
                async () => ({
                  continue: true,
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: "allow",
                    updatedInput: { file_path: copy },
                  },
                }),
              ],
            },
          ],
        },
      });
      expect(toolResults[0]).toContain("OUTSIDE");
    }, 90_000);
  },
);
