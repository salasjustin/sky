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
  /** The app's port on this sprite. */
  upstreamPort: number;
  /** When the token stops working, whatever the API has or hasn't done by then. */
  expiresAt: Date;
  /** The clock; `Date.now` unless a test sets one. */
  now?: () => number;
};

const NOT_FOUND = "<!doctype html><title>Not found</title><h1>Not found</h1>\n";

const REFRESH_SECONDS = 3;
// what a browser with the cookie sees while the app isn't listening yet: a page that reloads itself
const BUILDING = `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="${REFRESH_SECONDS}"><title>Building preview…</title><h1>Building preview…</h1><p>This page refreshes by itself.</p>\n`;
// what it sees once the app was up and stopped listening: it crashed or is restarting, not building
const notAnswering = (port: number) =>
  `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="${REFRESH_SECONDS}"><title>The app isn't answering</title><h1>The app isn't answering</h1><p>It was up, and nothing listens on port ${port} now: it crashed or is restarting. This page refreshes by itself.</p>\n`;

const sha256 = (value: string) => createHash("sha256").update(value).digest();

/**
 * The request target as a path, or `null` for one the proxy never forwards: absolute-form, `*`, or
 * anything the parser rejects. The base is prefixed rather than passed as `new URL`'s second argument,
 * which would read `//host:port/` as an authority and throw on a bad port.
 */
const originForm = (target: string | undefined): URL | null =>
  target?.startsWith("/") ? URL.parse(`http://preview.invalid${target}`) : null;

/** The `Cookie` header as the browser sent it, less the preview cookie, which is the proxy's and not the app's; `undefined` when nothing else is left. */
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

/** `https://<host>` as a URL origin for the `Host` the proxy received, or `undefined` when there is none or it doesn't parse. */
const previewOrigin = (host: string | undefined): string | undefined => {
  const url = host ? URL.parse(`https://${host}`) : null;
  return url && url.origin !== "null" ? url.origin : undefined;
};

/** `value`, an absolute URL, with its origin `from` replaced by `to`; path, query and fragment kept. Any other value comes back as it was. */
function swapOrigin(value: string, from: string, to: string): string {
  const url = URL.parse(value);
  if (url === null || url.origin !== from) return value;
  const target = new URL(to);
  url.protocol = target.protocol;
  url.hostname = target.hostname;
  url.port = target.port;
  return url.href;
}

/**
 * The sprite's HTTP port, with the app behind it. It answers a browser only once that browser
 * holds the preview's token as a cookie, which the link's one path hands out; everything else gets a
 * plain 404 that names nothing. The app sees the request as if it came from localhost: the
 * `Host` is rewritten, since app servers refuse a host they weren't told of, and the preview cookie is
 * stripped. An `Origin` or `Referer` that is the preview's own (`https://` plus the `Host` received) is
 * rewritten to `http://localhost:<port>` as well: frameworks compare `Origin` with the host of the
 * request URL built from `Host` (React Router, SvelteKit, Next.js, Astro) and refuse a form post when
 * they differ. Any other `Origin` or `Referer` goes through untouched, so the app's cross-site checks
 * still turn other sites away. A response `Location` back to `http://localhost:<port>` is pointed at
 * the preview's own origin, so a redirect stays on the preview.
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

  const upstreamOrigin = `http://localhost:${upstreamPort}`;

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
    // the preview's own origin is what the browser sent as Host, which the app never sees
    const own = previewOrigin(req.headers.host);
    if (own !== undefined) {
      if (headers.origin === own) headers.origin = upstreamOrigin;
      if (headers.referer !== undefined) {
        headers.referer = swapOrigin(headers.referer, own, upstreamOrigin);
      }
    }
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

  const page = (res: ServerResponse, status: number, html: string) => {
    res.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(html),
      "retry-after": String(REFRESH_SECONDS),
      "cache-control": "no-store",
    });
    res.end(html);
  };

  let appHasAnswered = false;
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
        appHasAnswered = true;
        const own = previewOrigin(req.headers.host);
        const rawHeaders = [...answer.rawHeaders];
        if (own !== undefined) {
          for (let i = 0; i < rawHeaders.length; i += 2) {
            if (rawHeaders[i]?.toLowerCase() === "location") {
              rawHeaders[i + 1] = swapOrigin(
                rawHeaders[i + 1] ?? "",
                upstreamOrigin,
                own,
              );
            }
          }
        }
        res.writeHead(
          answer.statusCode ?? 502,
          answer.statusMessage,
          rawHeaders,
        );
        // not pipe(): an upstream cut off mid-body must end the browser's response, not leave it open
        pipeline(answer, res, () => {});
      },
    );
    upstream.on("error", (error: NodeJS.ErrnoException) => {
      if (res.headersSent) return res.destroy();
      // nothing listens: before the app's first answer it is still being built or started; after, it died.
      // Only a browser holding the cookie gets to hear either
      if (error.code === "ECONNREFUSED") {
        return appHasAnswered
          ? page(res, 502, notAnswering(upstreamPort))
          : page(res, 503, BUILDING);
      }
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end("Bad gateway\n");
    });
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });

  // a websocket upgrade (the app's hot reload): the same check, then the bytes go through untouched
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

/** `runner.mjs preview-proxy`, run as a sprite service: 2 at once on a bad argv or env, else serves until the server closes (0) or errors (1). */
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
