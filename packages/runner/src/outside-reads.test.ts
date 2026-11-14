import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import {
  type AddressInfo,
  createServer as createSocketServer,
} from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type Options,
  query,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  outsideRead,
  type RefusedPaths,
  stageRead,
} from "./outside-reads.js";

// the Claude Code binary the Agent SDK ships beside itself: the platform package for this arch and libc
// undefined when the SDK or its platform package isn't installed, so the block skips instead of failing collection
const claudeBinary = (() => {
  let sdk: string;
  try {
    sdk = realpathSync(
      join(
        import.meta.dirname,
        "../node_modules/@anthropic-ai/claude-agent-sdk",
      ),
    );
  } catch {
    return undefined;
  }
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
  // the child must not outlive a failed assertion
  const controller = new AbortController();
  const stream = query({
    prompt: "read it",
    options: {
      cwd: worktree,
      model: "claude-sonnet-5-5",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      settingSources: [],
      abortController: controller,
      // the binary the skip check found, not whichever the SDK would resolve
      ...(claudeBinary && { pathToClaudeCodeExecutable: claudeBinary }),
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
  try {
    for await (const message of stream as AsyncIterable<SDKMessage>)
      if (message.type === "result") break;
  } finally {
    controller.abort();
  }
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
      // refused, whatever Claude Code words it as; the scratch-directory test below is the live read
      expect(toolResults[0]).not.toContain("OUTSIDE");
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
      const copy = await stageRead(
        outside as NonNullable<typeof outside>,
        scratch,
        1,
        { secretDirs: [], secretFiles: [], systemDirs: [] },
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

describe("which reads are outside the worktree", () => {
  /** A worktree two levels under `root`, as `<worktreesDir>/<agent>` sits. */
  let worktree: string;
  let home: string;
  const outsideOf = (toolName: string, input: object) =>
    outsideRead(toolName, input, [worktree], worktree, home);

  beforeEach(() => {
    worktree = join(root, "worktrees", "agt_1");
    mkdirSync(join(worktree, "src"), { recursive: true });
    home = join(root, "home");
    mkdirSync(join(home, "x"), { recursive: true });
  });

  test("a Read of `~/…` is taken from the home it is given", () => {
    expect(outsideOf("Read", { file_path: "~/x" })).toEqual({
      field: "file_path",
      path: join(home, "x"),
    });
    expect(outsideOf("Read", { file_path: "~" })).toEqual({
      field: "file_path",
      path: home,
    });
  });

  test("a Glob whose pattern is absolute, climbs out with `..` or starts with `~` is outside, at its literal prefix", () => {
    expect(outsideOf("Glob", { pattern: "/etc/**" })).toEqual({
      field: "path",
      path: realpathSync("/etc"),
      pattern: "**",
    });
    mkdirSync(join(root, "x"));
    expect(outsideOf("Glob", { pattern: "../../x/*" })).toEqual({
      field: "path",
      path: join(root, "x"),
      pattern: "*",
    });
    expect(outsideOf("Glob", { pattern: "~/x/*" })).toEqual({
      field: "path",
      path: join(home, "x"),
      pattern: "*",
    });
  });

  test("a Glob whose path and pattern prefix are both inside is not outside", () => {
    expect(outsideOf("Glob", { pattern: "src/**/*.ts" })).toBeUndefined();
    expect(outsideOf("Glob", { pattern: "**/*.ts" })).toBeUndefined();
    expect(
      outsideOf("Glob", { path: "src", pattern: "../README*" }),
    ).toBeUndefined();
  });

  test("Grep's `glob` filters names under its search root and is never outside", () => {
    expect(
      outsideOf("Grep", { pattern: "a", glob: "/etc/**" }),
    ).toBeUndefined();
  });

  test("an entry named `..foo` at the top of the worktree is inside", () => {
    mkdirSync(join(worktree, "..foo"));
    expect(
      outsideOf("Read", { file_path: join(worktree, "..foo", "a") }),
    ).toBeUndefined();
    expect(outsideOf("Read", { file_path: "..foo/a" })).toBeUndefined();
    expect(outsideOf("Read", { file_path: "../a" })).toEqual({
      field: "file_path",
      path: join(root, "worktrees", "a"),
    });
  });
});

describe("staging an approved outside read", () => {
  /** A runner's credential directory, holding a nested login file and this run's scratch. */
  let secrets: string;
  let scratch: string;
  let login: string;
  /** Claude Code's config directory and the home holding its account file. */
  let config: string;
  let home: string;
  /** Stands in for /proc, /sys and /dev, which the session hands over. */
  let system: string;
  let refused: RefusedPaths;

  beforeEach(() => {
    secrets = join(root, "sky-runner-1");
    scratch = join(secrets, "scratch-run_1");
    mkdirSync(scratch, { recursive: true });
    login = join(secrets, "sky-nested-claude-run_1-abc");
    writeFileSync(login, "TOKEN");
    config = join(root, "home", ".claude");
    home = join(root, "home");
    mkdirSync(join(config, "projects", "p", "tool-results"), {
      recursive: true,
    });
    writeFileSync(join(config, ".credentials.json"), '{"token":"TOKEN"}');
    writeFileSync(
      join(config, "projects", "p", "tool-results", "out.txt"),
      "large tool output\n",
    );
    writeFileSync(join(home, ".claude.json"), '{"oauthAccount":{}}');
    system = join(root, "system");
    mkdirSync(system);
    writeFileSync(join(system, "environ"), "SECRET=1");
    refused = {
      secretDirs: [secrets],
      secretFiles: [
        join(config, ".credentials.json"),
        join(home, ".claude.json"),
      ],
      systemDirs: [system],
    };
  });

  const slot = () => join(scratch, "approved", "1");
  const stage = (path: string, limits?: Parameters<typeof stageRead>[4]) =>
    stageRead({ field: "file_path", path }, scratch, 1, refused, limits);
  /** Every regular file under `dir`, with its contents. */
  const filesUnder = (dir: string) =>
    readdirSync(dir, { recursive: true })
      .map((name) => join(dir, String(name)))
      .filter((path) => lstatSync(path).isFile())
      .map((path) => readFileSync(path, "utf8"));

  test("an approved file is copied into the run's slot, readable by its owner alone", async () => {
    const outside = join(root, "notes.txt");
    writeFileSync(outside, "notes\n");
    const copy = await stage(outside);
    expect(copy).toBe(join(slot(), "notes.txt"));
    expect(readFileSync(copy, "utf8")).toBe("notes\n");
    expect(statSync(copy).mode & 0o077).toBe(0);
    expect(statSync(slot()).mode & 0o077).toBe(0);
  });

  test.each([
    ["a file in a runner's credential directory", () => login],
    ["a runner's credential directory itself", () => secrets],
    [
      "another run's scratch directory",
      () => {
        const other = join(secrets, "scratch-run_2");
        mkdirSync(other);
        writeFileSync(join(other, "copy.txt"), "theirs");
        return other;
      },
    ],
    ["Claude Code's login file", () => join(config, ".credentials.json")],
    ["Claude Code's account file", () => join(home, ".claude.json")],
    ["a file under a system directory", () => join(system, "environ")],
    ["a system directory itself", () => system],
  ])("%s is refused, approved or not", async (_, pathOf) => {
    const path = pathOf();
    await expect(stage(path)).rejects.toThrow(path);
    expect(existsSync(slot())).toBe(false);
  });

  test("Claude Code's config directory is refused whole for its login file, and its other files are copied", async () => {
    await expect(stage(config)).rejects.toThrow(
      join(config, ".credentials.json"),
    );
    const output = join(config, "projects", "p", "tool-results", "out.txt");
    expect(readFileSync(await stage(output), "utf8")).toBe(
      "large tool output\n",
    );
  });

  test("a path that became a link to the login file while the approval waited is resolved again and refused", async () => {
    const approved = join(root, "approved.txt");
    writeFileSync(approved, "harmless");
    rmSync(approved);
    symlinkSync(login, approved);
    await expect(stage(approved)).rejects.toThrow(login);
    expect(existsSync(slot())).toBe(false);
  });

  test("a hard link to a file in a runner's credential directory is refused, alone or in an approved directory", async () => {
    const link = join(root, "notes.txt");
    linkSync(login, link);
    await expect(stage(link)).rejects.toThrow(link);
    const tree = join(root, "tree");
    mkdirSync(tree);
    writeFileSync(join(tree, "a.txt"), "a");
    linkSync(login, join(tree, "b.txt"));
    await expect(stage(tree)).rejects.toThrow(join(tree, "b.txt"));
    expect(existsSync(slot())).toBe(false);
  });

  test("a hard link to Claude Code's login file is refused", async () => {
    const link = join(root, "creds.txt");
    linkSync(join(config, ".credentials.json"), link);
    await expect(stage(link)).rejects.toThrow(link);
  });

  test("a symlink inside an approved directory that points at the login file is copied as a link, never its contents", async () => {
    const tree = join(root, "tree");
    mkdirSync(tree);
    writeFileSync(join(tree, "a.txt"), "a");
    symlinkSync(login, join(tree, "login"));
    const copy = await stage(tree);
    const link = join(copy, "login");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(login);
    expect(filesUnder(slot())).toEqual(["a"]);
  });

  test("a file with more bytes than the limit is refused and leaves no copy", async () => {
    const big = join(root, "big.log");
    writeFileSync(big, "x".repeat(2048));
    await expect(stage(big, { maxBytes: 1024 })).rejects.toThrow(
      `${big} is larger than 1024 bytes`,
    );
    expect(existsSync(slot())).toBe(false);
  });

  test("the limit counts bytes across the whole tree", async () => {
    const tree = join(root, "tree");
    mkdirSync(tree);
    writeFileSync(join(tree, "a.log"), "x".repeat(600));
    writeFileSync(join(tree, "b.log"), "x".repeat(600));
    await expect(stage(tree, { maxBytes: 1024 })).rejects.toThrow(
      "larger than 1024 bytes",
    );
    expect(existsSync(slot())).toBe(false);
  });

  // a /proc file reports size 0 and reads more, as a file growing between stat and copy does
  test.skipIf(!existsSync("/proc/self/status"))(
    "a file that reads more bytes than its size said is cut off at the limit",
    async () => {
      expect(lstatSync("/proc/self/status").size).toBe(0);
      await expect(
        stageRead(
          { field: "file_path", path: "/proc/self/status" },
          scratch,
          1,
          { secretDirs: [secrets], secretFiles: [], systemDirs: [] },
          { maxBytes: 16 },
        ),
      ).rejects.toThrow("larger than 16 bytes");
      expect(existsSync(slot())).toBe(false);
    },
  );

  test("a tree with more entries than the cap is refused, and what it copied before is removed", async () => {
    const tree = join(root, "tree");
    mkdirSync(tree);
    for (const name of ["a", "b", "c", "d", "e"])
      writeFileSync(join(tree, name), name);
    await expect(stage(tree, { maxEntries: 3 })).rejects.toThrow(
      `${tree} holds more than 3 files and directories`,
    );
    expect(existsSync(slot())).toBe(false);
  });

  test("a copied read-only directory is the owner's alone and can be removed", async () => {
    const tree = join(root, "readonly");
    mkdirSync(join(tree, "sub"), { recursive: true });
    writeFileSync(join(tree, "sub", "a.txt"), "a");
    chmodSync(join(tree, "sub", "a.txt"), 0o444);
    chmodSync(join(tree, "sub"), 0o555);
    chmodSync(tree, 0o555);
    try {
      const copy = await stage(tree);
      for (const path of [
        copy,
        join(copy, "sub"),
        join(copy, "sub", "a.txt"),
      ])
        expect(statSync(path).mode & 0o077).toBe(0);
      rmSync(slot(), { recursive: true });
      expect(existsSync(slot())).toBe(false);
    } finally {
      chmodSync(tree, 0o755);
      chmodSync(join(tree, "sub"), 0o755);
    }
  });

  /** Makes a FIFO at `path`; false where the platform has no `mkfifo`. */
  const makeFifo = (path: string) =>
    process.platform !== "win32" && spawnSync("mkfifo", [path]).status === 0;

  test("a FIFO inside an approved directory is skipped, and its siblings are copied", async (context) => {
    const tree = join(root, "tree");
    mkdirSync(tree);
    writeFileSync(join(tree, "a.txt"), "a");
    if (!makeFifo(join(tree, "pipe"))) return context.skip();
    const copy = await stage(tree);
    expect(readdirSync(copy)).toEqual(["a.txt"]);
  });

  test.skipIf(process.platform === "win32")(
    "a socket inside an approved directory is skipped, and its siblings are copied",
    async () => {
      const tree = join(root, "tree");
      mkdirSync(tree);
      writeFileSync(join(tree, "a.txt"), "a");
      const socket = createSocketServer();
      await new Promise<void>((done) => socket.listen(join(tree, "sock"), done));
      try {
        expect(lstatSync(join(tree, "sock")).isSocket()).toBe(true);
        const copy = await stage(tree);
        expect(readdirSync(copy)).toEqual(["a.txt"]);
      } finally {
        await new Promise((done) => socket.close(done));
      }
    },
  );

  test("a path that no longer exists is refused", async () => {
    const gone = join(root, "gone.txt");
    await expect(stage(gone)).rejects.toThrow(`${gone} does not exist`);
    expect(existsSync(slot())).toBe(false);
  });
});
