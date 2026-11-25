import http, { type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type GatewayProxy, startGatewayProxy } from "./codex-proxy.js";

type Seen = { method?: string; url?: string; headers: IncomingHttpHeaders; body: string };

describe("startGatewayProxy", () => {
  let upstream: http.Server;
  let upstreamUrl: string;
  let seen: Seen[];
  let proxy: GatewayProxy;

  beforeEach(async () => {
    seen = [];
    // a stand-in gateway: records each request, and streams its answer in two parts
    upstream = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "x-gateway": "yes",
          connection: "keep-alive, x-private",
          "x-private": "hop",
        });
        res.write("data: one\n\n");
        setTimeout(() => res.end("data: two\n\n"), 20);
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const { port } = upstream.address() as AddressInfo;
    upstreamUrl = `http://127.0.0.1:${port}/codex/v1`;
    proxy = await startGatewayProxy({ upstream: upstreamUrl, key: "gw-key" });
  });
  afterEach(async () => {
    await proxy.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  const call = (
    path: string,
    headers: Record<string, string>,
    body = "",
  ): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> =>
    new Promise((resolve, reject) => {
      const url = new URL(proxy.baseUrl);
      const req = http.request(
        { host: url.hostname, port: url.port, method: "POST", path, headers },
        (res) => {
          let text = "";
          res.on("data", (chunk) => {
            text += chunk;
          });
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }),
          );
        },
      );
      req.on("error", reject);
      req.end(body);
    });

  test("listens on the loopback interface, at the gateway's path, with a fresh token", () => {
    expect(proxy.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/codex\/v1$/);
    expect(proxy.token).toMatch(/^[0-9a-f]{64}$/);
  });

  test("swaps the run's token for the key and streams the answer through", async () => {
    const answer = await call(
      "/codex/v1/responses",
      {
        authorization: `Bearer ${proxy.token}`,
        "content-type": "application/json",
        "x-custom": "kept",
        "proxy-authorization": "Basic dropped",
      },
      '{"model":"m"}',
    );
    expect(answer.status).toBe(200);
    expect(answer.body).toBe("data: one\n\ndata: two\n\n");
    expect(answer.headers["x-gateway"]).toBe("yes");
    // hop-by-hop headers, and those the upstream's connection header names, stay on their hop
    expect(answer.headers["x-private"]).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: "POST",
      url: "/codex/v1/responses",
      body: '{"model":"m"}',
    });
    expect(seen[0]?.headers.authorization).toBe("Bearer gw-key");
    expect(seen[0]?.headers["x-custom"]).toBe("kept");
    expect(seen[0]?.headers["proxy-authorization"]).toBeUndefined();
    expect(JSON.stringify(seen[0]?.headers)).not.toContain(proxy.token);
  });

  test("refuses a request without the run's token, and sends nothing on", async () => {
    for (const authorization of [undefined, "Bearer wrong", `Basic ${proxy.token}`]) {
      const answer = await call(
        "/codex/v1/responses",
        authorization ? { authorization } : {},
      );
      expect(answer.status).toBe(401);
      expect(answer.body).not.toContain("gw-key");
    }
    expect(seen).toEqual([]);
  });

  test("sends the key to the gateway's own path only", async () => {
    for (const path of ["/v1/responses", "/codex/v10", "/", "/codex"]) {
      const answer = await call(path, { authorization: `Bearer ${proxy.token}` });
      expect(answer.status, path).toBe(404);
    }
    expect(seen).toEqual([]);
  });

  test("an unreachable gateway is a 502, not a crash", async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    const warnings: string[] = [];
    const lone = await startGatewayProxy({
      upstream: upstreamUrl,
      key: "gw-key",
      warn: (line) => warnings.push(line),
    });
    const url = new URL(lone.baseUrl);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: url.hostname,
          port: url.port,
          method: "POST",
          path: "/codex/v1/responses",
          headers: { authorization: `Bearer ${lone.token}` },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    await lone.close();
    expect(status).toBe(502);
    expect(warnings.join("\n")).toMatch(/AI Gateway request failed/);
    // restart the stand-in so afterEach's close has a server to close
    upstream = http.createServer();
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  });
});
