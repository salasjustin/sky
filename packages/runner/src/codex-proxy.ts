/**
 * The AI Gateway as Codex reaches it: a proxy on the loopback interface that the runner starts for
 * each Codex run. Codex is given the proxy's URL and a token made for the run, never the gateway key,
 * so nothing Codex starts (the agent's commands, the hooks a plugin brings, an MCP server) can inherit
 * the key: none of those gets more than Codex's own env. The proxy checks the token, swaps it for the
 * key, sends the request on and streams the answer back as it comes. The token is good only while
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
  /**
   * The gateway's latest answer when it was a 402 (out of credit) or 429 (rate-limited), status only;
   * undefined before any answer or when the latest was anything else. Absent on a proxy that doesn't
   * track it.
   */
  limitStatus?: () => 402 | 429 | undefined;
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

/**
 * The path and query to send upstream for a request's `url`, as the gateway will read it: dot
 * segments resolved, so `/codex/v1/../../x` is `/x`. Undefined when that path leaves `prefix`, the
 * URL names another host, or the path holds an encoded `.`, `/` or `\` the gateway might decode.
 */
const gatewayPath = (url: string, upstream: URL, prefix: string) => {
  let target: URL;
  try {
    target = new URL(url, upstream);
  } catch {
    return undefined;
  }
  const { pathname, search } = target;
  if (target.origin !== upstream.origin) return undefined;
  if (/%(2e|2f|5c)/i.test(pathname)) return undefined;
  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`))
    return undefined;
  return `${pathname}${search}`;
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
  let limitStatus: 402 | 429 | undefined;

  const refuse = (res: ServerResponse, status: number, message: string) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message } }));
  };

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    if (!sameToken(req.headers.authorization, token)) {
      req.resume();
      return refuse(res, 401, "this run's gateway token is missing or wrong");
    }
    // only the gateway's own path, so the key goes to no other route on that host
    const path = gatewayPath(req.url ?? "/", upstream, prefix);
    if (path === undefined) {
      req.resume();
      return refuse(res, 404, "not a gateway path");
    }
    const headers = forwardable(
      req.headers,
      new Set(["host", "authorization"]),
    );
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
        // the latest answer only, so a 429 Codex retried past doesn't outlive the success after it
        limitStatus =
          answer.statusCode === 402 || answer.statusCode === 429
            ? answer.statusCode
            : undefined;
        res.writeHead(
          answer.statusCode ?? 502,
          answer.statusMessage,
          forwardable(answer.headers, new Set()),
        );
        answer.pipe(res);
        answer.on("error", () => res.destroy());
      },
    );
    let hungUp = false;
    out.on("error", (error) => {
      // Codex hanging up ends the upstream request with an error of its own; the gateway didn't fail
      if (hungUp) return;
      warn(`the AI Gateway request failed: ${error.message}`);
      if (res.headersSent) res.destroy();
      else refuse(res, 502, "the AI Gateway could not be reached");
    });
    // Codex going away mid-answer ends the upstream request too
    res.on("close", () => {
      if (res.writableFinished) return;
      hungUp = true;
      out.destroy();
    });
    req.pipe(out);
  };

  const server = http.createServer(handle);
  // a WebSocket or other upgrade isn't proxied, only plain HTTP
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
    limitStatus: () => limitStatus,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
