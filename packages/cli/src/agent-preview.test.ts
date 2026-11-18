import { HttpResponse, http } from "msw";
import { beforeEach, expect, test } from "vitest";
import { server } from "../../../test/msw.js";
import { apiKey, apiUrl, runCli } from "./testing.js";

const link = "https://sky-abc-org.sprites.app/__sky/preview?t=tokentokentoken";
const preview = (over: Record<string, unknown> = {}) => ({
  agentId: "agt_1",
  envId: "env_1",
  port: 5173,
  cmd: "pnpm dev",
  startedAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-01-02T00:00:00.000Z",
  ...over,
});

let sent: { method: string; body: unknown }[];

beforeEach(() => {
  sent = [];
  const record = async (request: Request) => {
    sent.push({
      method: request.method,
      body: request.method === "POST" ? await request.json() : undefined,
    });
    expect(request.headers.get("authorization")).toBe(`Bearer ${apiKey}`);
  };
  server.use(
    http.post(`${apiUrl}/v1/agents/agt_1/preview`, async ({ request }) => {
      await record(request);
      return HttpResponse.json({
        preview: { ...preview(), link, replaced: null },
      });
    }),
    http.delete(`${apiUrl}/v1/agents/agt_1/preview`, async ({ request }) => {
      await record(request);
      return HttpResponse.json({ preview: null, stopped: preview() });
    }),
    http.get(`${apiUrl}/v1/agents/agt_1/preview`, async ({ request }) => {
      await record(request);
      return HttpResponse.json({
        preview: {
          ...preview(),
          services: { app: "running", proxy: "running" },
        },
      });
    }),
  );
});

test("agent preview starts it and prints the link alone on stdout", async () => {
  const r = await runCli([
    "agent",
    "preview",
    "agt_1",
    "--cmd=pnpm dev --host",
    "--port=5173",
  ]);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe(`${link}\n`);
  expect(r.stderr).toBe("the link works until 2026-01-02T00:00:00.000Z\n");
  // no ttl sent: the API's default applies
  expect(sent).toEqual([
    { method: "POST", body: { cmd: "pnpm dev --host", port: 5173 } },
  ]);
});

test.each([
  ["90m", 5400],
  ["24h", 86_400],
  ["7d", 604_800],
  ["300", 300],
  ["60s", 60],
])("--ttl=%s is sent as %i seconds", async (ttl, seconds) => {
  const r = await runCli([
    "agent",
    "preview",
    "agt_1",
    "--cmd=pnpm dev",
    "--port=5173",
    `--ttl=${ttl}`,
  ]);
  expect(r.code).toBe(0);
  expect(sent[0]?.body).toEqual({
    cmd: "pnpm dev",
    port: 5173,
    ttlSeconds: seconds,
  });
});

test("a preview that replaced another's says so on stderr", async () => {
  server.use(
    http.post(`${apiUrl}/v1/agents/agt_1/preview`, () =>
      HttpResponse.json({
        preview: { ...preview(), link, replaced: "agt_old" },
      }),
    ),
  );
  const r = await runCli([
    "agent",
    "preview",
    "agt_1",
    "--cmd=pnpm dev",
    "--port=5173",
  ]);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe(`${link}\n`);
  expect(r.stderr).toContain("replaced the running preview of agt_old");
});

test("--json prints the API's object, link included", async () => {
  const r = await runCli([
    "agent",
    "preview",
    "agt_1",
    "--cmd=pnpm dev",
    "--port=5173",
    "--json",
  ]);
  expect(JSON.parse(r.stdout)).toEqual({
    preview: { ...preview(), link, replaced: null },
  });
});

test("--stop ends the preview", async () => {
  const r = await runCli(["agent", "preview", "agt_1", "--stop"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("stopped the preview of agt_1\n");
  expect(sent).toEqual([{ method: "DELETE", body: undefined }]);
});

test("--stop with nothing running exits 0 and says so, so a retried stop or a cleanup trap doesn't fail", async () => {
  server.use(
    http.delete(`${apiUrl}/v1/agents/agt_1/preview`, () =>
      HttpResponse.json({ preview: null, stopped: null }),
    ),
  );
  const r = await runCli(["agent", "preview", "agt_1", "--stop"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("agt_1 had no running preview\n");
  expect(r.stderr).toBe("");
  const json = await runCli(["agent", "preview", "agt_1", "--stop", "--json"]);
  expect(json.code).toBe(0);
  expect(JSON.parse(json.stdout)).toEqual({ preview: null, stopped: null });
});

test("a command that dies at start prints the API's 422 with its output and exits 1", async () => {
  server.use(
    http.post(`${apiUrl}/v1/agents/agt_1/preview`, () =>
      HttpResponse.json(
        {
          error: {
            code: "preview_failed",
            message:
              "sky-preview-app exited 1 within 2s of starting: sh: pnpm: not found",
          },
        },
        { status: 422 },
      ),
    ),
  );
  const r = await runCli([
    "agent",
    "preview",
    "agt_1",
    "--cmd=pnpm dev",
    "--port=5173",
  ]);
  expect(r.code).toBe(1);
  expect(r.stdout).toBe("");
  expect(r.stderr).toContain(
    "exited 1 within 2s of starting: sh: pnpm: not found",
  );
  expect(r.stderr).toContain("(preview_failed)");
});

test("a start refused because another key's preview runs exits 1 with preview_busy", async () => {
  server.use(
    http.post(`${apiUrl}/v1/agents/agt_1/preview`, () =>
      HttpResponse.json(
        {
          error: {
            code: "preview_busy",
            message: "a preview started by another key is running",
          },
        },
        { status: 409 },
      ),
    ),
  );
  const r = await runCli([
    "agent",
    "preview",
    "agt_1",
    "--cmd=pnpm dev",
    "--port=5173",
  ]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("(preview_busy)");
});

test("with no flags it prints the port, expiry and how the two services are doing", async () => {
  const r = await runCli(["agent", "preview", "agt_1"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("5173 2026-01-02T00:00:00.000Z running running\n");
});

test("with no flags and nothing running it says so on stderr", async () => {
  server.use(
    http.get(`${apiUrl}/v1/agents/agt_1/preview`, () =>
      HttpResponse.json({ preview: null }),
    ),
  );
  const r = await runCli(["agent", "preview", "agt_1"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("\n");
  expect(r.stderr).toBe("agt_1 has no running preview\n");
});

test("an API error is reported with its code, exit 1", async () => {
  server.use(
    http.post(`${apiUrl}/v1/agents/agt_1/preview`, () =>
      HttpResponse.json(
        {
          error: { code: "port_busy", message: "port 5173 is already in use" },
        },
        { status: 409 },
      ),
    ),
  );
  const r = await runCli([
    "agent",
    "preview",
    "agt_1",
    "--cmd=pnpm dev",
    "--port=5173",
  ]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("port 5173 is already in use (port_busy)");
  expect(r.stdout).toBe("");
});

test.each([
  [["agent", "preview"], "agent preview takes <agent>"],
  [
    ["agent", "preview", "agt_1", "--cmd=x"],
    "needs --cmd=<command> and --port=<n>",
  ],
  [
    ["agent", "preview", "agt_1", "--port=5173"],
    "needs --cmd=<command> and --port=<n>",
  ],
  [
    ["agent", "preview", "agt_1", "--ttl=1h"],
    "needs --cmd=<command> and --port=<n>",
  ],
  [["agent", "preview", "agt_1", "--cmd= ", "--port=5173"], "--cmd is empty"],
  [
    ["agent", "preview", "agt_1", "--cmd=x", "--port=8080"],
    "--port takes a whole number",
  ],
  [
    ["agent", "preview", "agt_1", "--cmd=x", "--port=80"],
    "--port takes a whole number",
  ],
  [
    ["agent", "preview", "agt_1", "--cmd=x", "--port=abc"],
    "--port takes a whole number",
  ],
  [
    ["agent", "preview", "agt_1", "--cmd=x", "--port=5173", "--ttl=8d"],
    "--ttl takes a duration",
  ],
  [
    ["agent", "preview", "agt_1", "--cmd=x", "--port=5173", "--ttl=30s"],
    "--ttl takes a duration",
  ],
  [
    ["agent", "preview", "agt_1", "--cmd=x", "--port=5173", "--ttl=soon"],
    "--ttl takes a duration",
  ],
  [
    ["agent", "preview", "agt_1", "--stop", "--port=5173"],
    "--stop takes no --cmd",
  ],
  [["agent", "preview", "agt_1", "agt_2", "--stop"], "takes one agent"],
  [["agent", "preview", "agt_1", "--prompt=x", "--stop"], "takes no --prompt"],
  [
    ["agent", "archive", "agt_1", "--port=5173"],
    "--port only goes with agent preview",
  ],
  [["agent", "list", "--stop"], "--stop only goes with agent preview"],
])(
  "%j is a usage error (exit 2) before any request: %s",
  async (argv, message) => {
    const r = await runCli(argv);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(message);
    expect(sent).toEqual([]);
  },
);
