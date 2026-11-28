import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  brokerPublishMain,
  brokerSyncMain,
  CODEX_RUN_ENV,
} from "./broker-client.js";
import { CODEX_BIN, codexConfigToml } from "./codex.js";
import { codexMcpTables } from "./codex-mcp.js";
import {
  codexToolsMain,
  skyToolsTable,
  startToolsChannel,
  TOOLS_SECRET_ENV,
  TOOLS_SOCKET_ENV,
  type ToolReply,
  toolsSocketIn,
} from "./codex-tools.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "runner-tools-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const sendLine = (socketPath: string, line: string) =>
  new Promise<string>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let received = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${line}\n`));
    socket.on("data", (chunk: string) => {
      received += chunk;
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(received));
  });

const send = (socketPath: string, request: object) =>
  sendLine(socketPath, JSON.stringify(request));

describe("the tools channel", () => {
  test("serves a request with the run's secret and refuses one without it, running nothing", async () => {
    const calls: unknown[] = [];
    const socketPath = toolsSocketIn(dir);
    const channel = await startToolsChannel({
      socketPath,
      secret: "s".repeat(64),
      call: async (tool, args) => {
        calls.push([tool, args]);
        return { text: "done", success: true };
      },
    });
    try {
      const good = await send(socketPath, {
        secret: "s".repeat(64),
        tool: "sky_sync",
        arguments: { branch: "b" },
      });
      expect(JSON.parse(good)).toEqual({ text: "done", success: true });
      for (const secret of ["", "x".repeat(64), "s".repeat(63), undefined]) {
        const refused = JSON.parse(
          await send(socketPath, {
            secret,
            tool: "sky_publish",
            arguments: {},
          }),
        );
        expect(refused.success).toBe(false);
      }
      expect(calls).toEqual([["sky_sync", { branch: "b" }]]);
    } finally {
      await channel.close();
    }
    expect(existsSync(socketPath)).toBe(false);
  });

  describe("a request it can't serve", () => {
    const secret = "s".repeat(64);
    const MAX_LINE = 4 * 1024 * 1024;
    // `call` throws unless a test gives it a body: a refused request must never get that far
    const refusing = async (
      bad: (socketPath: string) => Promise<string>,
      call: (tool: string, args: unknown) => Promise<ToolReply> = async () => {
        throw new Error("called");
      },
    ) => {
      const calls: string[] = [];
      const socketPath = toolsSocketIn(dir);
      const channel = await startToolsChannel({
        socketPath,
        secret,
        call: (tool, args) => {
          calls.push(tool);
          return call(tool, args);
        },
      });
      try {
        const reply = JSON.parse(await bad(socketPath));
        return { reply, calls };
      } finally {
        await channel.close();
      }
    };

    test("an oversized line is refused as too large, running nothing", async () => {
      const { reply, calls } = await refusing((socketPath) =>
        send(socketPath, {
          secret,
          tool: "sky_sync",
          arguments: { pad: "x".repeat(MAX_LINE) },
        }),
      );
      expect(reply).toEqual({ text: "request too large", success: false });
      expect(calls).toEqual([]);
    });

    test("unreadable JSON is refused, running nothing", async () => {
      const { reply, calls } = await refusing((socketPath) =>
        sendLine(socketPath, `{"secret":"${secret}","tool":`),
      );
      expect(reply).toEqual({ text: "unreadable request", success: false });
      expect(calls).toEqual([]);
    });

    test.each([
      ["no tool", { secret }],
      ["a tool that isn't a string", { secret, tool: 7 }],
    ])("%s is refused as naming none, running nothing", async (_, request) => {
      const { reply, calls } = await refusing((socketPath) =>
        send(socketPath, request),
      );
      expect(reply).toEqual({ text: "no tool named", success: false });
      expect(calls).toEqual([]);
    });

    test("a call that rejects answers with its message, as a failure", async () => {
      const { reply, calls } = await refusing(
        (socketPath) =>
          send(socketPath, { secret, tool: "sky_publish", arguments: {} }),
        async () => {
          throw new Error("the broker went away");
        },
      );
      expect(reply).toEqual({ text: "the broker went away", success: false });
      expect(calls).toEqual(["sky_publish"]);
    });
  });
});

describe("the sky MCP server", () => {
  const talk = async (env: NodeJS.ProcessEnv, requests: object[]) => {
    const stdin = new PassThrough();
    let out = "";
    const done = codexToolsMain([], env, {
      stdin,
      stdout: (s) => {
        out += s;
      },
    });
    for (const request of requests)
      stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...request })}\n`);
    stdin.end();
    expect(await done).toBe(0);
    return out
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  };

  test("lists both tools with the schemas of today's sky_publish and sky_sync", async () => {
    const [, listed] = await talk({}, [
      {
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      },
      { method: "notifications/initialized" },
      { id: 2, method: "tools/list" },
    ]);
    expect(listed.result.tools.map((t: { name: string }) => t.name)).toEqual([
      "sky_publish",
      "sky_sync",
    ]);
    expect(listed.result.tools[0].inputSchema.required).toEqual(["title"]);
  });

  test("outside a run's Codex, a call fails and says nothing was sent", async () => {
    const [reply] = await talk({}, [
      {
        id: 1,
        method: "tools/call",
        params: { name: "sky_publish", arguments: { title: "T" } },
      },
    ]);
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0].text).toContain("nothing was sent");
  });

  test("a runner that is gone is a failed call, not a crash", async () => {
    const [reply] = await talk(
      {
        [TOOLS_SOCKET_ENV]: join(dir, "gone.sock"),
        [TOOLS_SECRET_ENV]: "x",
      },
      [{ id: 1, method: "tools/call", params: { name: "sky_sync" } }],
    );
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0].text).toMatch(
      /can't reach the run's runner/,
    );
  });
});

describe("codexMcpTables", () => {
  test("leaves out a base-profile server named sky, which is Sky's own", () => {
    const result = codexMcpTables(
      { sky: { url: "https://x.test/", headers: {} } },
      {},
    );
    expect(result.tables).toEqual([]);
    expect(result.refused).toEqual([
      {
        server: "sky",
        why: "its name, which Sky's own publish and sync tools hold",
      },
    ]);
  });
});

// the written config is Codex's to read: the installed Codex lists the server from a copy of it
const codex = process.env.SKY_CODEX_BIN ?? CODEX_BIN;
describe.skipIf(!existsSync(codex))("codex mcp list", () => {
  test("a temp Codex home holding the written config lists the sky server, passing the two names", () => {
    const home = join(dir, "codex-home");
    mkdirSync(home);
    const table = skyToolsTable({
      command: process.execPath,
      args: ["/opt/sky/runner.mjs", "codex-tools"],
      toolTimeoutSec: 900,
    });
    writeFileSync(
      join(home, "config.toml"),
      codexConfigToml("http://127.0.0.1:1/v1", [], [table]),
    );
    const listed = execFileSync(codex, ["mcp", "list"], {
      env: { PATH: process.env.PATH, HOME: dir, CODEX_HOME: home },
      encoding: "utf8",
    });
    expect(listed).toMatch(
      /sky\s+\S*node\S*\s+\/opt\/sky\/runner\.mjs codex-tools/,
    );
    expect(listed).toContain("enabled");
    expect(listed).toContain(`${TOOLS_SOCKET_ENV}=*****`);
    expect(listed).toContain(`${TOOLS_SECRET_ENV}=*****`);
    const got = execFileSync(codex, ["mcp", "get", "sky"], {
      env: { PATH: process.env.PATH, HOME: dir, CODEX_HOME: home },
      encoding: "utf8",
    });
    expect(got).toContain("tool_timeout_sec: 900");
    expect(got).toContain("default_tools_approval_mode: approve");
  }, 60_000);
});

describe("publish and sync from a Codex command's shell", () => {
  const run = async (
    main: typeof brokerPublishMain | typeof brokerSyncMain,
    argv: string[],
    env: NodeJS.ProcessEnv,
  ) => {
    let stderr = "";
    let stdout = "";
    const code = await main(argv, env, {
      cwd: dir,
      stdout: (s) => {
        stdout += s;
      },
      stderr: (s) => {
        stderr += s;
      },
    });
    return { code, stderr, stdout };
  };

  test.each([
    ["publish", brokerPublishMain, ["--title", "T"]],
    ["sync", brokerSyncMain, []],
  ] as const)(
    "%s points to the tool and sends nothing",
    async (op, main, argv) => {
      const out = await run(main, [...argv], { [CODEX_RUN_ENV]: "1" });
      expect(out.code).toBe(2);
      expect(out.stdout).toBe("");
      expect(out.stderr).toBe(
        `sky ${op}: on Codex runs, publish with the sky_publish tool (and sync with sky_sync); runner.mjs ${op} works only in Claude Code runs. Nothing was sent.\n`,
      );
    },
  );

  test("outside a Codex run the shell form is as it was", async () => {
    const out = await run(brokerPublishMain, ["--title", "T"], {});
    expect(out.code).toBe(2);
    expect(out.stderr).toContain("SKY_BROKER_SOCKET is not set");
  });
});
