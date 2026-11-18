import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingHttpHeaders,
  request,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import { PREVIEW_COOKIE, PREVIEW_LINK_PATH } from "@sky/shared";
import { afterEach, expect, test } from "vitest";
import { createPreviewProxy, previewProxyMain } from "./preview-proxy.js";

const TOKEN = "t".repeat(43);
const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections();
          s.close(() => resolve());
        }),
    ),
  );
});

const listen = (server: Server) =>
  new Promise<number>((resolve) => {
    servers.push(server);
    server.listen(0, () => resolve((server.address() as AddressInfo).port));
  });

type Seen = { headers: IncomingHttpHeaders; url: string | undefined };

/** A dev server: pages over HTTP, and a websocket-style upgrade that echoes what it is sent. */
async function devServer() {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    seen.push({ headers: req.headers, url: req.url });
    res.setHeader("content-type", "text/plain");
    res.end(`app ${req.url}`);
  });
  server.on("upgrade", (req, socket) => {
    seen.push({ headers: req.headers, url: req.url });
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
    );
    socket.on("data", (chunk) => socket.write(`echo:${chunk}`));
    // an HTTP server's sockets are half-open: without this one stays until the test's hook gives up
    socket.on("end", () => socket.end());
  });
  const port = await listen(server);
  return { port, seen };
}

async function proxyTo(
  upstreamPort: number,
  { now = Date.now, expiresAt = new Date(Date.now() + 3_600_000) } = {},
) {
  const proxy = createPreviewProxy({
    tokenHash: hash(TOKEN),
    upstreamPort,
    expiresAt,
    now,
  });
  return { port: await listen(proxy) };
}

function get(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        body += c;
      });
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

const cookie = `${PREVIEW_COOKIE}=${TOKEN}`;

test("a browser with no cookie gets a plain 404 that names nothing", async () => {
  const app = await devServer();
  const { port } = await proxyTo(app.port);
  const res = await get(port, "/");
  expect(res.status).toBe(404);
  expect(res.body).toBe(
    "<!doctype html><title>Not found</title><h1>Not found</h1>\n",
  );
  // the same answer for any path, and the dev server was never asked
  expect((await get(port, "/anything/else")).body).toBe(res.body);
  expect(app.seen).toEqual([]);
});

test("a bad token, a missing one and a wrong cookie all get the 404", async () => {
  const app = await devServer();
  const { port } = await proxyTo(app.port);
  for (const path of [
    `${PREVIEW_LINK_PATH}?t=wrong`,
    `${PREVIEW_LINK_PATH}?t=`,
    PREVIEW_LINK_PATH,
  ]) {
    const res = await get(port, path);
    expect(res.status).toBe(404);
    expect(res.headers["set-cookie"]).toBeUndefined();
  }
  expect(
    (await get(port, "/", { cookie: `${PREVIEW_COOKIE}=wrong` })).status,
  ).toBe(404);
  expect(app.seen).toEqual([]);
});

test("an expired token gives 404 on the link and on the cookie", async () => {
  const app = await devServer();
  let clock = Date.now();
  const { port } = await proxyTo(app.port, {
    now: () => clock,
    expiresAt: new Date(clock + 60_000),
  });
  expect((await get(port, `${PREVIEW_LINK_PATH}?t=${TOKEN}`)).status).toBe(302);
  expect((await get(port, "/", { cookie })).status).toBe(200);
  clock += 61_000;
  expect((await get(port, `${PREVIEW_LINK_PATH}?t=${TOKEN}`)).status).toBe(404);
  expect((await get(port, "/", { cookie })).status).toBe(404);
});

test("a good token sets the cookie, HttpOnly, Secure and SameSite=Lax, and redirects to /", async () => {
  const app = await devServer();
  const { port } = await proxyTo(app.port);
  const res = await get(port, `${PREVIEW_LINK_PATH}?t=${TOKEN}`);
  expect(res.status).toBe(302);
  expect(res.headers.location).toBe("/");
  const set = res.headers["set-cookie"]?.[0] ?? "";
  expect(set).toMatch(new RegExp(`^${PREVIEW_COOKIE}=${TOKEN}; Path=/; `));
  expect(set).toContain("HttpOnly");
  expect(set).toContain("Secure");
  expect(set).toContain("SameSite=Lax");
  // lasts as long as the preview: an hour here
  expect(Number(/Max-Age=(\d+)/.exec(set)?.[1])).toBeGreaterThan(3_590);
  expect(Number(/Max-Age=(\d+)/.exec(set)?.[1])).toBeLessThanOrEqual(3_600);
  expect(app.seen).toEqual([]);
});

test("with the cookie, HTTP reaches the dev server at the root path, as if from localhost", async () => {
  const app = await devServer();
  const { port } = await proxyTo(app.port);
  const res = await get(port, "/assets/main.js?v=1", {
    cookie: `theme=dark; ${cookie}`,
    host: "spr-org.sprites.app",
    "x-forwarded-for": "6.6.6.6",
  });
  expect(res.status).toBe(200);
  expect(res.body).toBe("app /assets/main.js?v=1");
  const seen = app.seen[0];
  // the app's own cookies pass; the preview's token does not
  expect(seen?.headers.cookie).toBe("theme=dark");
  expect(seen?.headers.host).toBe(`localhost:${app.port}`);
  expect(seen?.headers["x-forwarded-host"]).toBe("spr-org.sprites.app");
  expect(seen?.headers["x-forwarded-proto"]).toBe("https");
  // the proxy's own peer, the test's loopback client, never the client's claim
  expect(seen?.headers["x-forwarded-for"]).toMatch(/^(::ffff:)?127\.0\.0\.1$/);
});

test("a request target the WHATWG parser rejects gets the 404, and the proxy keeps serving", async () => {
  const app = await devServer();
  const { port } = await proxyTo(app.port);
  // http.request sends the path verbatim: `//a:99999` reads as an authority with an out-of-range port
  const res = await get(port, "//a:99999/");
  expect(res.status).toBe(404);
  expect(res.body).toBe(
    "<!doctype html><title>Not found</title><h1>Not found</h1>\n",
  );
  expect((await get(port, "/after", { cookie })).body).toBe("app /after");
  expect(app.seen.map((s) => s.url)).toEqual(["/after"]);
});

test("an absolute-form target gets the 404 even with the cookie, and never reaches the dev server", async () => {
  const app = await devServer();
  const { port } = await proxyTo(app.port);
  // a valid absolute URL: MSW's interceptor parses the test's own outgoing request, and throws on an
  // invalid one (a port past 65535) before it is sent
  expect((await get(port, "http://a/", { cookie })).status).toBe(404);
  expect((await get(port, "/after", { cookie })).status).toBe(200);
  expect(app.seen.map((s) => s.url)).toEqual(["/after"]);
});

test("a dev server that dies mid-response ends the browser's response instead of leaving it open", async () => {
  const dying = createServer((_req, res) => {
    res.setHeader("content-type", "text/plain");
    res.write("part", () => res.socket?.destroy());
  });
  const { port } = await proxyTo(await listen(dying));
  const outcome = await new Promise<string>((resolve) => {
    const timer = setTimeout(() => resolve("still open"), 2_000);
    const req = request(
      { host: "127.0.0.1", port, path: "/", headers: { cookie } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          body += c;
        });
        res.on("error", () => {});
        res.on("close", () => {
          clearTimeout(timer);
          resolve(`closed complete=${res.complete} body=${body}`);
        });
      },
    );
    req.on("error", () => {});
    req.end();
  });
  expect(outcome).toBe("closed complete=false body=part");
});

test("a dev server that is down answers a signed-in browser 502", async () => {
  const dead = createServer();
  const deadPort = await listen(dead);
  await new Promise((r) => dead.close(r));
  const { port } = await proxyTo(deadPort);
  expect((await get(port, "/", { cookie })).status).toBe(502);
});

function upgrade(
  port: number,
  headers: string,
  target = "/hmr?token=abc",
): Promise<{ head: string; echoed: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port }, () => {
      socket.write(
        `GET ${target} HTTP/1.1\r\nHost: spr-org.sprites.app\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n${headers}\r\n`,
      );
    });
    let received = "";
    let sent = false;
    socket.on("data", (chunk) => {
      received += chunk.toString();
      if (received.startsWith("HTTP/1.1 101") && !sent) {
        sent = true;
        socket.write("ping");
      }
      if (
        received.includes("echo:ping") ||
        received.startsWith("HTTP/1.1 404")
      ) {
        socket.destroy();
        resolve({
          head: received.split("\r\n")[0] ?? "",
          echoed: received.includes("echo:ping") ? "echo:ping" : "",
        });
      }
    });
    socket.on("error", reject);
  });
}

test("with the cookie a websocket upgrade reaches the dev server and carries data both ways", async () => {
  const app = await devServer();
  const { port } = await proxyTo(app.port);
  const out = await upgrade(port, `Cookie: ${cookie}\r\n`);
  expect(out.head).toBe("HTTP/1.1 101 Switching Protocols");
  expect(out.echoed).toBe("echo:ping");
  expect(app.seen[0]?.url).toBe("/hmr?token=abc");
  expect(app.seen[0]?.headers.cookie).toBeUndefined();
  expect(app.seen[0]?.headers.host).toBe(`localhost:${app.port}`);
});

test("a websocket upgrade without the cookie gets a 404 and never reaches the dev server", async () => {
  const app = await devServer();
  const { port } = await proxyTo(app.port);
  expect((await upgrade(port, "")).head).toBe("HTTP/1.1 404 Not Found");
  expect(
    (await upgrade(port, `Cookie: ${PREVIEW_COOKIE}=wrong\r\n`)).head,
  ).toBe("HTTP/1.1 404 Not Found");
  expect(app.seen).toEqual([]);
});

test("a websocket upgrade to an odd target gets a 404, even with the cookie, and the proxy keeps serving", async () => {
  const app = await devServer();
  const { port } = await proxyTo(app.port);
  // `//a:99999/` is a path to the dev server, as the HTTP route treats it; absolute-form is never forwarded
  for (const target of ["http://a/"]) {
    expect((await upgrade(port, "", target)).head).toBe(
      "HTTP/1.1 404 Not Found",
    );
    expect((await upgrade(port, `Cookie: ${cookie}\r\n`, target)).head).toBe(
      "HTTP/1.1 404 Not Found",
    );
  }
  expect(app.seen).toEqual([]);
  expect((await upgrade(port, `Cookie: ${cookie}\r\n`)).echoed).toBe(
    "echo:ping",
  );
});

test("preview-proxy refuses to start without its env, naming the variables and no value", async () => {
  const lines: string[] = [];
  const code = await previewProxyMain(
    [],
    { PREVIEW_TOKEN_HASH: "not-a-hash" },
    { stderr: (s) => lines.push(s) },
  );
  expect(code).toBe(2);
  const text = lines.join("");
  expect(text).toContain("PREVIEW_TOKEN_HASH");
  expect(text).toContain("PREVIEW_UPSTREAM_PORT");
  expect(text).not.toContain("not-a-hash");
});
