import { timingSafeEqual } from "node:crypto";
import { chmodSync, rmSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { SKY_TOOLS_SERVER, tomlString } from "./codex-mcp.js";

/**
 * `sky_publish` and `sky_sync` for Codex runs: tools of a stdio MCP server the runner writes into the
 * run's `config.toml`. The file is rewritten every run, so the tools follow the environment's
 * connector on a resumed thread as on a new one; `thread/resume` takes no tool list, so a thread
 * started without `dynamicTools` could never gain them. (Codex 0.172.0 does restore the `dynamicTools`
 * a thread started with, so a thread started before this server existed has both copies.) The server
 * is the runner's own bundle (`runner.mjs codex-tools`), started by Codex; it holds no connector and no
 * broker token. It forwards each call over the run's tools socket to the runner, which opens the approval,
 * issues a token for that one call and runs it through the broker.
 */

export const PUBLISH_TOOL = "sky_publish";
export const SYNC_TOOL = "sky_sync";
/** The env vars Codex passes the server (`env_vars`), by name, and keeps out of its commands' env. */
export const TOOLS_SOCKET_ENV = "SKY_TOOLS_SOCKET";
export const TOOLS_SECRET_ENV = "SKY_TOOLS_SECRET";

export const toolsSocketIn = (dir: string) => join(dir, "tools.sock");

export const SKY_TOOLS = [
  {
    name: PUBLISH_TOOL,
    description:
      "Publish this worktree's branch to GitHub and open (or update) its pull request, after the person approves. Returns the pull request's URL.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "The pull request's title." },
        body: {
          type: "string",
          description: "The pull request's description, in Markdown.",
        },
        base: {
          type: "string",
          description:
            "The branch to merge into; the default branch when absent.",
        },
        branch: {
          type: "string",
          description:
            "A GitHub branch to publish to instead of the worktree's own.",
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: SYNC_TOOL,
    description:
      "Refresh origin/<default> from GitHub and bring commits pushed to your GitHub branch into the worktree, after the person approves.",
    inputSchema: {
      type: "object",
      properties: {
        branch: {
          type: "string",
          description:
            "The GitHub branch you publish to, if not the worktree's own.",
        },
      },
      additionalProperties: false,
    },
  },
];

/** What the runner answers a tool call with: the text the agent reads, and whether the call worked. */
export type ToolReply = { text: string; success: boolean };

/**
 * The `[mcp_servers.sky]` table for `config.toml`: names only. Codex starts `command args`, passing the
 * two env vars it holds under these names. The tools ask nothing of Codex (`approve`): the approval a
 * person answers is the broker's, one per call, showing what goes out. The tool timeout outlasts the
 * longest wait for that approval.
 */
export function skyToolsTable(options: {
  command: string;
  args: readonly string[];
  toolTimeoutSec: number;
}): string[] {
  return [
    `[mcp_servers.${SKY_TOOLS_SERVER}]`,
    `command = ${tomlString(options.command)}`,
    `args = [${options.args.map(tomlString).join(",")}]`,
    `env_vars = ["${TOOLS_SOCKET_ENV}","${TOOLS_SECRET_ENV}"]`,
    `tool_timeout_sec = ${Math.max(60, Math.ceil(options.toolTimeoutSec))}`,
    'default_tools_approval_mode = "approve"',
    "",
  ];
}

const MAX_LINE = 4 * 1024 * 1024;

/**
 * The runner's end of the tools channel: a socket only the MCP server is told of, with a secret made for
 * the run. A request without the secret is refused before anything is read from it. `call` serves one
 * request; the runner's own rules (approval, token, seal) are in it.
 */
export async function startToolsChannel(options: {
  socketPath: string;
  secret: string;
  call: (tool: string, args: unknown) => Promise<ToolReply>;
}): Promise<{ close: () => Promise<void> }> {
  const { socketPath, secret } = options;
  rmSync(socketPath, { force: true });
  const sockets = new Set<net.Socket>();
  const wanted = Buffer.from(secret);
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setEncoding("utf8");
    let received = "";
    let handled = false;
    const reply = (value: ToolReply) =>
      socket.end(`${JSON.stringify(value)}\n`);
    socket.on("data", (chunk: string) => {
      if (handled) return;
      received += chunk;
      if (received.length > MAX_LINE) {
        handled = true;
        return reply({ text: "request too large", success: false });
      }
      const end = received.indexOf("\n");
      if (end < 0) return;
      handled = true;
      let request: { secret?: unknown; tool?: unknown; arguments?: unknown };
      try {
        request = JSON.parse(received.slice(0, end));
      } catch {
        return reply({ text: "unreadable request", success: false });
      }
      const given = Buffer.from(
        typeof request.secret === "string" ? request.secret : "",
      );
      if (given.length !== wanted.length || !timingSafeEqual(given, wanted))
        return reply({ text: "refused: not the run's secret", success: false });
      if (typeof request.tool !== "string")
        return reply({ text: "no tool named", success: false });
      options.call(request.tool, request.arguments ?? {}).then(reply, (error) =>
        reply({
          text: error instanceof Error ? error.message : String(error),
          success: false,
        }),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  chmodSync(socketPath, 0o600);
  return {
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => {
          rmSync(socketPath, { force: true });
          resolve();
        });
      }),
  };
}

/** One call over the channel; a failure to reach the runner is a failed call, not a crash. */
function callRunner(
  env: NodeJS.ProcessEnv,
  tool: string,
  args: unknown,
): Promise<ToolReply> {
  const socketPath = env[TOOLS_SOCKET_ENV];
  const secret = env[TOOLS_SECRET_ENV];
  if (!socketPath || !secret)
    return Promise.resolve({
      text: `${tool} is only available inside a Sky run's Codex session; nothing was sent`,
      success: false,
    });
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    socket.setEncoding("utf8");
    let received = "";
    let settled = false;
    const done = (value: ToolReply) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    socket.on("connect", () =>
      socket.write(`${JSON.stringify({ secret, tool, arguments: args })}\n`),
    );
    socket.on("data", (chunk: string) => {
      received += chunk;
    });
    socket.on("error", (error: NodeJS.ErrnoException) =>
      done({
        text: `can't reach the run's runner (${error.code ?? error.message}); nothing was sent`,
        success: false,
      }),
    );
    socket.on("close", () => {
      try {
        const reply = JSON.parse(received.trim()) as ToolReply;
        done({ text: String(reply.text), success: reply.success === true });
      } catch {
        done({
          text: "the runner closed the connection without an answer; nothing is known to have been sent",
          success: false,
        });
      }
    });
  });
}

type Rpc = { id?: number | string; method?: string; params?: unknown };

/**
 * `runner.mjs codex-tools`: the stdio MCP server Codex starts. One JSON message per line each way;
 * answers `initialize`, `ping`, `tools/list` and `tools/call` and ignores notifications. Returns when
 * Codex closes its stdin and the calls in flight have been answered.
 */
export async function codexToolsMain(
  _argv: string[],
  env: NodeJS.ProcessEnv,
  io: {
    stdout: (s: string) => void;
    stdin?: NodeJS.ReadableStream;
  },
): Promise<number> {
  const send = (message: object) =>
    io.stdout(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const inflight = new Set<Promise<void>>();
  const lines = createInterface({ input: io.stdin ?? process.stdin });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message: Rpc;
    try {
      message = JSON.parse(line) as Rpc;
    } catch {
      return;
    }
    const { id, method } = message;
    if (id === undefined || method === undefined) return;
    const params = (message.params ?? {}) as {
      protocolVersion?: string;
      name?: string;
      arguments?: unknown;
    };
    switch (method) {
      case "initialize":
        return send({
          id,
          result: {
            protocolVersion: params.protocolVersion ?? "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: SKY_TOOLS_SERVER, version: "1" },
          },
        });
      case "ping":
        return send({ id, result: {} });
      case "tools/list":
        return send({ id, result: { tools: SKY_TOOLS } });
      case "tools/call": {
        const call = callRunner(
          env,
          String(params.name),
          params.arguments,
        ).then((reply) =>
          send({
            id,
            result: {
              content: [{ type: "text", text: reply.text || "(no output)" }],
              isError: !reply.success,
            },
          }),
        );
        const tracked = call.finally(() => inflight.delete(tracked));
        inflight.add(tracked);
        return;
      }
      default:
        return send({
          id,
          error: { code: -32601, message: `no method ${method}` },
        });
    }
  });
  await new Promise<void>((resolve) => lines.once("close", resolve));
  await Promise.all(inflight);
  return 0;
}
