/**
 * The AI Gateway as Codex reaches it: a proxy on the loopback interface that the runner starts for
 * each Codex run. Codex is given the proxy's URL and a token made for the run, never the gateway key,
 * so nothing Codex starts (the agent's commands, the hooks a plugin brings, an MCP server) inherits
 * the key: each of those starts from Codex's own env. The proxy checks the token, swaps it for the
 * key and passes the request and its streamed answer through unchanged. The token is good only while
 * the run's proxy is up; with it, a process can make model calls through this run, not read the key.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";

export type GatewayProxy = {
  /** What Codex's provider takes as `base_url`: the upstream's path, on the proxy's address. */
  baseUrl: string;
  /** The token Codex sends as its bearer; the proxy refuses any request without it. */
  token: string;
  close: () => Promise<void>;
};

export type GatewayProxyOptions = {
  /** The gateway's base URL, path included, such as `https://ai-gateway.vercel.sh/codex/v1`. */
  upstream: string;
  /** The gateway key; it stays in the runner and goes only to `upstream`. */
  key: string;
  warn?: (line: string) => void;
  /** The upstream request, for tests; `https.request` (or `http.request` for an http upstream) when absent. */
  request?: typeof https.request;
};

// RFC 9110 §7.6.1: never forwarded, in either direction
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const forwardable = (
  headers: IncomingHttpHeaders,
  drop: Set<string>,
): OutgoingHttpHeaders => {
  const named = new Set(
    String(headers.connection ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(name) || named.has(name) || drop.has(name)) continue;
    out[name] = value;
  }
  return out;
};

const sameToken = (sent: string | undefined, token: string) => {
  if (!sent?.startsWith("Bearer ")) return false;
  const a = Buffer.from(sent.slice("Bearer ".length));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** Starts the run's gateway proxy on 127.0.0.1, on a port the kernel picks. */
export async function startGatewayProxy(
  options: GatewayProxyOptions,
): Promise<GatewayProxy> {
  const upstream = new URL(options.upstream);
  const prefix = upstream.pathname.replace(/\/+$/, "");
  const request =
    options.request ??
    (upstream.protocol === "http:" ? http.request : https.request);
  const token = randomBytes(32).toString("hex");
  const warn = options.warn ?? (() => {});

  const refuse = (res: ServerResponse, status: number, message: string) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message } }));
  };

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    if (!sameToken(req.headers.authorization, token)) {
      req.resume();
      return refuse(res, 401, "this run's gateway token is missing or wrong");
    }
    const path = req.url ?? "/";
    // only the gateway's own path, so the key goes to no other route on that host
    if (path !== prefix && !path.startsWith(`${prefix}/`)) {
      req.resume();
      return refuse(res, 404, "not a gateway path");
    }
    const headers = forwardable(req.headers, new Set(["host", "authorization"]));
    headers.authorization = `Bearer ${options.key}`;
    headers.host = upstream.host;
    const out = request(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || undefined,
        method: req.method,
        path,
        headers,
      },
      (answer) => {
        res.writeHead(
          answer.statusCode ?? 502,
          answer.statusMessage,
          forwardable(answer.headers, new Set()),
        );
        answer.pipe(res);
        answer.on("error", () => res.destroy());
      },
    );
    out.on("error", (error) => {
      warn(`the AI Gateway request failed: ${error.message}`);
      if (res.headersSent) res.destroy();
      else refuse(res, 502, "the AI Gateway could not be reached");
    });
    // Codex going away mid-answer ends the upstream request too
    res.on("close", () => {
      if (!res.writableFinished) out.destroy();
    });
    req.pipe(out);
  };

  const server = http.createServer(handle);
  // a WebSocket or other upgrade isn't proxied: Codex then uses plain HTTP
  server.on("upgrade", (_req, socket) => {
    socket.end("HTTP/1.1 501 Not Implemented\r\nconnection: close\r\n\r\n");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}${prefix}`,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
