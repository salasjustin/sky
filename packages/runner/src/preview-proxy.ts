import { createHash, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  request,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect, type Socket } from "node:net";
import { pipeline } from "node:stream";
import {
  PREVIEW_COOKIE,
  PREVIEW_LINK_PATH,
  PREVIEW_PROXY_PORT,
  PreviewPort,
} from "@sky/shared";
import { z } from "zod";

export type PreviewProxyOptions = {
  /** Lowercase-hex sha-256 of the preview's token: all the proxy ever holds of it. */
  tokenHash: string;
  /** The dev server's port on this sprite. */
  upstreamPort: number;
  /** When the token stops working, whatever the API has or hasn't done by then. */
  expiresAt: Date;
  /** The clock; `Date.now` unless a test sets one. */
  now?: () => number;
};

const NOT_FOUND = "<!doctype html><title>Not found</title><h1>Not found</h1>\n";

const sha256 = (value: string) => createHash("sha256").update(value).digest();

/**
 * The request target as a path, or `null` for one the proxy never forwards: absolute-form, `*`, or
 * anything the parser rejects. The base is prefixed rather than passed as `new URL`'s second argument,
 * which would read `//host:port/` as an authority and throw on a bad port.
 */
const originForm = (target: string | undefined): URL | null =>
  target?.startsWith("/") ? URL.parse(`http://preview.invalid${target}`) : null;

/** The headers of `req` as a browser sent them, less the preview cookie, which is the proxy's and not the app's. */
function withoutPreviewCookie(
  headers: IncomingHttpHeaders,
): string | undefined {
  const kept = (headers.cookie ?? "")
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair !== "" && !pair.startsWith(`${PREVIEW_COOKIE}=`));
  return kept.length > 0 ? kept.join("; ") : undefined;
}

function cookieOf(headers: IncomingHttpHeaders): string | undefined {
  for (const pair of (headers.cookie ?? "").split(";")) {
    const trimmed = pair.trim();
    if (trimmed.startsWith(`${PREVIEW_COOKIE}=`)) {
      return trimmed.slice(PREVIEW_COOKIE.length + 1);
    }
  }
  return undefined;
}

/**
 * The sprite's HTTP port, with the dev server behind it. It answers a browser only once that browser
 * holds the preview's token as a cookie, which the link's one path hands out; everything else gets a
 * plain 404 that names nothing. The dev server sees the request as if it came from localhost: the
 * `Host` is rewritten, since dev servers refuse a host they weren't told of, and the preview cookie is
 * stripped.
 */
export function createPreviewProxy({
  tokenHash,
  upstreamPort,
  expiresAt,
  now = Date.now,
}: PreviewProxyOptions): Server {
  const expected = Buffer.from(tokenHash, "hex");
  const valid = (token: string | undefined) => {
    if (token === undefined || token === "" || now() >= expiresAt.getTime()) {
      return false;
    }
    const digest = sha256(token);
    return (
      digest.length === expected.length && timingSafeEqual(digest, expected)
    );
  };

  const forwardedHeaders = (req: IncomingMessage): Record<string, string> => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || name === "cookie") continue;
      if (name.startsWith("x-forwarded-")) continue;
      headers[name] = Array.isArray(value) ? value.join(", ") : value;
    }
    const cookie = withoutPreviewCookie(req.headers);
    if (cookie !== undefined) headers.cookie = cookie;
    headers.host = `localhost:${upstreamPort}`;
    if (req.headers.host) headers["x-forwarded-host"] = req.headers.host;
    headers["x-forwarded-proto"] = "https";
    if (req.socket.remoteAddress) {
      headers["x-forwarded-for"] = req.socket.remoteAddress;
    }
    return headers;
  };

  const notFound = (res: ServerResponse) => {
    res.writeHead(404, {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(NOT_FOUND),
      "cache-control": "no-store",
    });
    res.end(NOT_FOUND);
  };

  const server = createServer((req, res) => {
    const url = originForm(req.url);
    if (url === null) return notFound(res);
    if (url.pathname === PREVIEW_LINK_PATH) {
      const token = url.searchParams.get("t") ?? undefined;
      if (req.method !== "GET" || !valid(token)) return notFound(res);
      const seconds = Math.max(
        1,
        Math.floor((expiresAt.getTime() - now()) / 1000),
      );
      res.writeHead(302, {
        "set-cookie": `${PREVIEW_COOKIE}=${token}; Path=/; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Lax`,
        location: "/",
        "cache-control": "no-store",
      });
      res.end();
      return;
    }
    if (!valid(cookieOf(req.headers))) return notFound(res);
    const upstream = request(
      {
        host: "localhost",
        port: upstreamPort,
        method: req.method,
        path: req.url,
        headers: forwardedHeaders(req),
        agent: false,
      },
      (answer) => {
        res.writeHead(
          answer.statusCode ?? 502,
          answer.statusMessage,
          answer.rawHeaders,
        );
        // not pipe(): an upstream cut off mid-body must end the browser's response, not leave it open
        pipeline(answer, res, () => {});
      },
    );
    upstream.on("error", () => {
      if (res.headersSent) return res.destroy();
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end("Bad gateway\n");
    });
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });

  // a websocket upgrade (the dev server's hot reload): the same check, then the bytes go through untouched
  server.on("upgrade", (req: IncomingMessage, client: Socket, head: Buffer) => {
    client.on("error", () => client.destroy());
    if (originForm(req.url) === null || !valid(cookieOf(req.headers))) {
      client.end(
        "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
      );
      return;
    }
    const upstream = connect({ host: "localhost", port: upstreamPort });
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    upstream.on("connect", () => {
      const headers = forwardedHeaders(req);
      const lines = Object.entries(headers).map(
        ([name, value]) => `${name}: ${value}`,
      );
      upstream.write(
        `${req.method} ${req.url} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`,
      );
      if (head.length > 0) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
  });
  return server;
}

export const PREVIEW_PROXY_USAGE = "preview-proxy";

const Env = z.object({
  PREVIEW_TOKEN_HASH: z.string().regex(/^[0-9a-f]{64}$/),
  PREVIEW_UPSTREAM_PORT: z.coerce.number().pipe(PreviewPort),
  PREVIEW_EXPIRES_AT: z.iso.datetime().transform((s) => new Date(s)),
  PREVIEW_LISTEN_PORT: z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(PREVIEW_PROXY_PORT),
});

/** `runner.mjs preview-proxy`, run as a sprite service; resolves only if the server stops. */
export async function previewProxyMain(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: { stderr: (s: string) => void },
): Promise<number> {
  const parsed = Env.safeParse(env);
  if (argv.length > 0 || !parsed.success) {
    // names only: a value here is the token's hash
    const keys = parsed.success
      ? []
      : [...new Set(parsed.error.issues.map((i) => String(i.path[0])))];
    io.stderr(
      `usage: ${PREVIEW_PROXY_USAGE}${keys.length > 0 ? `; missing or invalid env: ${keys.join(", ")}` : ""}\n`,
    );
    return 2;
  }
  const e = parsed.data;
  const server = createPreviewProxy({
    tokenHash: e.PREVIEW_TOKEN_HASH,
    upstreamPort: e.PREVIEW_UPSTREAM_PORT,
    expiresAt: e.PREVIEW_EXPIRES_AT,
  });
  return await new Promise<number>((resolve) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      io.stderr(`preview-proxy: ${error.message}\n`);
      resolve(1);
    });
    server.once("close", () => resolve(0));
    server.listen(e.PREVIEW_LISTEN_PORT);
  });
}
