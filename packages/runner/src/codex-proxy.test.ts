import type { IncomingHttpHeaders } from "node:http";
import { connect } from "node:net";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { server } from "../../../test/msw.js";
import { type GatewayProxy, startGatewayProxy } from "./codex-proxy.js";

type Seen = {
  method: string;
  path: string;
  headers: Headers;
  body: string;
};

const UPSTREAM = "https://gateway.test/codex/v1";

describe("startGatewayProxy", () => {
  let seen: Seen[];
  let proxy: GatewayProxy;

  beforeEach(async () => {
    seen = [];
    // a stand-in gateway: records each request, and streams its answer in two parts
    server.use(
      http.all("https://gateway.test/*", async ({ request }) => {
        seen.push({
          method: request.method,
          path: new URL(request.url).pathname,
          headers: request.headers,
          body: await request.text(),
        });
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(encoder.encode("data: one\n\n"));
            await new Promise((resolve) => setTimeout(resolve, 20));
            controller.enqueue(encoder.encode("data: two\n\n"));
            controller.close();
          },
        });
        return new HttpResponse(stream, {
          headers: {
            "content-type": "text/event-stream",
            "x-gateway": "yes",
          },
        });
      }),
    );
    proxy = await startGatewayProxy({ upstream: UPSTREAM, key: "gw-key" });
  });
  afterEach(async () => {
    await proxy.close();
  });

  // a raw socket rather than http.request: the test's own request to the loopback proxy would
  // otherwise go through MSW's interceptor, which has no handler for it
  const callProxy = (
    target: GatewayProxy,
    path: string,
    headers: Record<string, string>,
    body = "",
  ): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> =>
    new Promise((resolve, reject) => {
      const url = new URL(target.baseUrl);
      const socket = connect(Number(url.port), url.hostname);
      const chunks: Buffer[] = [];
      socket.on("data", (chunk) => chunks.push(chunk));
      socket.on("error", reject);
      socket.on("close", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        const split = raw.indexOf("\r\n\r\n");
        const [statusLine = "", ...lines] = raw.slice(0, split).split("\r\n");
        const parsed: IncomingHttpHeaders = {};
        for (const line of lines) {
          const colon = line.indexOf(":");
          parsed[line.slice(0, colon).toLowerCase()] = line
            .slice(colon + 1)
            .trim();
        }
        let text = raw.slice(split + 4);
        if (parsed["transfer-encoding"] === "chunked") {
          // decode chunked framing: `<hex size>\r\n<data>\r\n` ... `0\r\n\r\n`
          let decoded = "";
          let rest = text;
          while (rest.length > 0) {
            const eol = rest.indexOf("\r\n");
            const size = Number.parseInt(rest.slice(0, eol), 16);
            if (!size) break;
            decoded += rest.slice(eol + 2, eol + 2 + size);
            rest = rest.slice(eol + 2 + size + 2);
          }
          text = decoded;
        }
        resolve({
          status: Number(statusLine.split(" ")[1]),
          headers: parsed,
          body: text,
        });
      });
      const head = {
        host: `${url.hostname}:${url.port}`,
        connection: "close",
        "content-length": String(Buffer.byteLength(body)),
        ...headers,
      };
      socket.write(
        `POST ${path} HTTP/1.1\r\n${Object.entries(head)
          .map(([name, value]) => `${name}: ${value}`)
          .join("\r\n")}\r\n\r\n${body}`,
      );
    });
  const call = (path: string, headers: Record<string, string>, body?: string) =>
    callProxy(proxy, path, headers, body);

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
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: "POST",
      path: "/codex/v1/responses",
      body: '{"model":"m"}',
    });
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer gw-key");
    expect(seen[0]?.headers.get("x-custom")).toBe("kept");
    expect(seen[0]?.headers.get("proxy-authorization")).toBeNull();
    expect(JSON.stringify([...(seen[0]?.headers ?? [])])).not.toContain(
      proxy.token,
    );
  });

  test("refuses a request without the run's token, and sends nothing on", async () => {
    for (const authorization of [
      undefined,
      "Bearer wrong",
      // as long as the token, so the comparison itself, not the length check, refuses it
      `Bearer ${"0".repeat(proxy.token.length)}`,
      `Basic ${proxy.token}`,
    ]) {
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
    for (const path of [
      "/v1/responses",
      "/codex/v10",
      "/",
      "/codex",
      // under the gateway's path as written, outside it once the gateway resolves the dot segments
      "/codex/v1/../../v1/models",
      "/codex/v1/%2e%2e/%2e%2e/v1/models",
      "/codex/v1/..%2f..%2fv1/models",
      "http://elsewhere.test/codex/v1/responses",
    ]) {
      const answer = await call(path, {
        authorization: `Bearer ${proxy.token}`,
      });
      expect(answer.status, path).toBe(404);
    }
    expect(seen).toEqual([]);
  });

  test("Codex hanging up before the answer starts is no gateway failure", async () => {
    server.use(
      http.all("https://gateway.test/*", async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return HttpResponse.text("late");
      }),
    );
    const warnings: string[] = [];
    const lone = await startGatewayProxy({
      upstream: UPSTREAM,
      key: "gw-key",
      warn: (line) => warnings.push(line),
    });
    const url = new URL(lone.baseUrl);
    const socket = connect(Number(url.port), url.hostname);
    socket.write(
      `POST /codex/v1/responses HTTP/1.1\r\nhost: ${url.host}\r\nauthorization: Bearer ${lone.token}\r\ncontent-length: 0\r\n\r\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await lone.close();
    expect(warnings).toEqual([]);
  });

  test("an unreachable gateway is a 502, not a crash", async () => {
    server.use(http.all("https://gateway.test/*", () => HttpResponse.error()));
    const warnings: string[] = [];
    const lone = await startGatewayProxy({
      upstream: UPSTREAM,
      key: "gw-key",
      warn: (line) => warnings.push(line),
    });
    const answer = await callProxy(lone, "/codex/v1/responses", {
      authorization: `Bearer ${lone.token}`,
    });
    await lone.close();
    expect(answer.status).toBe(502);
    expect(warnings.join("\n")).toMatch(/AI Gateway request failed/);
  });
});
