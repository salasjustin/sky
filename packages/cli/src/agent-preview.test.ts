import { HttpResponse, http } from "msw";
import { beforeEach, expect, test } from "vitest";
import { server } from "../../../test/msw.js";
import { apiKey, apiUrl, runCli } from "./testing.js";

const link = "https://sky-abc-org.sprites.app/__sky/preview?t=tokentokentoken";
const preview = (over: Record<string, unknown> = {}) => ({
  agentId: "agt_1",
  envId: "env_1",
  port: 5173,
  build: "pnpm build",
  start: "pnpm start",
  state: "building",
  detail: null,
  startedAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-01-02T00:00:00.000Z",
  ...over,
});
const failure = (message: string) => ({
  error: { code: "preview_failed", message },
  preview: preview({ state: "failed", detail: message }),
});

let sent: { method: string; body: unknown }[];
/** What each GET answers, in turn; the last repeats. */
let reads: (() => Response)[];
let replaced: string | null;

const answers = (...states: string[]) =>
  states.map(
    (state) => () =>
      HttpResponse.json({
        preview: {
          ...preview({ state }),
          services: { app: "running", proxy: "running" },
        },
      }),
  );

beforeEach(() => {
  sent = [];
  replaced = null;
  reads = answers("ready");
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
      return HttpResponse.json(
        { preview: { ...preview(), link, replaced } },
        { status: 202 },
      );
    }),
    http.delete(`${apiUrl}/v1/agents/agt_1/preview`, async ({ request }) => {
      await record(request);
      return HttpResponse.json({ preview: null, stopped: preview() });
    }),
    http.get(`${apiUrl}/v1/agents/agt_1/preview`, async ({ request }) => {
      await record(request);
      const next = reads.length > 1 ? reads.shift() : reads[0];
      return (next as () => Response)();
    }),
  );
});

const startArgs = ["agent", "preview", "agt_1", "--port=5173"];
const gets = () => sent.filter((s) => s.method === "GET");

test("agent preview prints the link at once, waits through building and starting, and exits 0 once ready", async () => {
  reads = answers("building", "starting", "ready");
  const r = await runCli(startArgs);
  expect(r.code).toBe(0);
  // the link alone on stdout
  expect(r.stdout).toBe(`${link}\n`);
  // each state as it changes, once
  expect(r.stderr).toContain("agt_1 building\n");
  expect(r.stderr).toContain("agt_1 starting\n");
  expect(r.stderr).toContain("agt_1 ready\n");
  expect(r.stderr.indexOf("building")).toBeLessThan(
    r.stderr.indexOf("starting"),
  );
  expect(r.stderr.indexOf("starting")).toBeLessThan(r.stderr.indexOf("ready"));
  expect(r.stderr.match(/agt_1 building/g)).toHaveLength(1);
  expect(r.stderr).toContain("the link works until 2026-01-02T00:00:00.000Z");
  // polled every 3 s, three times
  expect(gets()).toHaveLength(3);
  expect(r.sleeps).toEqual([3000, 3000, 3000]);
  // no commands sent: the API chooses them from the lockfile
  expect(sent[0]).toEqual({ method: "POST", body: { port: 5173 } });
});

test("once ready it says the preview serves this build and a new commit needs a new one", async () => {
  const r = await runCli(startArgs);
  expect(r.stderr).toContain("a new commit needs a new preview");
  expect(r.stderr).toContain("sky agent preview agt_1");
  expect(r.stderr).toContain("rebuilds and replaces this one");
});

test("--build, --start and --ttl are sent as the API's fields; --build=none skips the build", async () => {
  await runCli([
    ...startArgs,
    "--build=pnpm --filter web build",
    "--start=node dist/server.js",
    "--ttl=90m",
  ]);
  await runCli([...startArgs, "--build=none"]);
  expect(sent.filter((s) => s.method === "POST").map((s) => s.body)).toEqual([
    {
      port: 5173,
      build: "pnpm --filter web build",
      start: "node dist/server.js",
      ttlSeconds: 5400,
    },
    { port: 5173, build: "none" },
  ]);
});

test.each([
  ["90m", 5400],
  ["24h", 86_400],
  ["7d", 604_800],
  ["300", 300],
  ["60s", 60],
])("--ttl=%s is sent as %i seconds", async (ttl, seconds) => {
  await runCli([...startArgs, `--ttl=${ttl}`, "--no-wait"]);
  expect(sent[0]?.body).toEqual({ port: 5173, ttlSeconds: seconds });
});

test("--no-wait returns at once, exit 0, with the link and the state it started in", async () => {
  const r = await runCli([...startArgs, "--no-wait"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe(`${link}\n`);
  expect(r.stderr).toContain("agt_1 building");
  expect(r.stderr).toContain(
    "Run sky agent preview agt_1 to see when it is ready",
  );
  expect(sent).toHaveLength(1);
  expect(r.sleeps).toEqual([]);
});

test("a build that fails ends the wait with the API's preview_failed and its output, exit 1", async () => {
  reads = [
    ...answers("building"),
    () =>
      HttpResponse.json(
        failure("the build exited 1: error TS2304: cannot find name"),
        { status: 422 },
      ),
  ];
  const r = await runCli(startArgs);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain(
    "the build exited 1: error TS2304: cannot find name (preview_failed)",
  );
  // the link was printed before the wait; the failure is the exit status
  expect(r.stdout).toBe(`${link}\n`);
});

test("a preview that fails on the sprite's side also exits 1, and the wait does not retry it", async () => {
  reads = [
    () =>
      HttpResponse.json(failure("checking port 5173 on the sprite exited 2"), {
        status: 502,
      }),
  ];
  const r = await runCli(startArgs);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("(preview_failed)");
  expect(gets()).toHaveLength(1);
});

test("an unreachable API or a 5xx during the wait is retried with backoff, and the wait goes on", async () => {
  reads = [
    () => new HttpResponse(null, { status: 503 }),
    ...answers("starting", "ready"),
  ];
  const r = await runCli(startArgs);
  expect(r.code).toBe(0);
  expect(r.stderr).toContain("lost contact with the API");
  // the retry waits longer: 3 s, then twice that, then back to 3 s
  expect(r.sleeps).toEqual([3000, 6000, 3000]);
});

test("a 4xx during the wait ends it", async () => {
  reads = [
    () =>
      HttpResponse.json(
        { error: { code: "not_found", message: "no such agent" } },
        { status: 404 },
      ),
  ];
  const r = await runCli(startArgs);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("no such agent");
});

test("a preview stopped or replaced mid-wait ends it, exit 1", async () => {
  reads = [() => HttpResponse.json({ preview: null })];
  const r = await runCli(startArgs);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("was stopped or replaced before it was ready");
});

test("the wait arms a Ctrl-C note that says the preview keeps building, and disarms it when it ends", async () => {
  reads = answers("building", "ready");
  const r = await runCli(startArgs);
  expect(r.interruptNotes).toEqual([
    "interrupted; the preview of agt_1 keeps building on the server. Run sky agent preview agt_1 to see when it is ready",
  ]);
  expect(r.armedAtExit).toBe(0);
});

test("a preview that replaced another says so on stderr", async () => {
  replaced = "agt_old";
  const r = await runCli([...startArgs, "--no-wait"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe(`${link}\n`);
  expect(r.stderr).toContain("replaced the running preview of agt_old");
});

test("--json prints one object at the end, ready, with the link", async () => {
  reads = answers("building", "ready");
  const r = await runCli([...startArgs, "--json"]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout)).toMatchObject({
    preview: { agentId: "agt_1", state: "ready", link },
  });
});

test("--no-wait --json prints the API's answer", async () => {
  const r = await runCli([...startArgs, "--no-wait", "--json"]);
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

test("with no flags it prints the state, port, expiry and how the two services are doing", async () => {
  reads = answers("starting");
  const r = await runCli(["agent", "preview", "agt_1"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe(
    "starting 5173 2026-01-02T00:00:00.000Z running running\n",
  );
  expect(gets()).toHaveLength(1);
});

test("with no flags and a failed preview it exits 1 with the failure", async () => {
  reads = [
    () =>
      HttpResponse.json(failure("the build exited 1: boom"), { status: 422 }),
  ];
  const r = await runCli(["agent", "preview", "agt_1"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("the build exited 1: boom (preview_failed)");
});

test("with no flags and nothing running it says so on stderr", async () => {
  reads = [() => HttpResponse.json({ preview: null })];
  const r = await runCli(["agent", "preview", "agt_1"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("\n");
  expect(r.stderr).toBe("agt_1 has no running preview\n");
});

test.each([
  [
    "no lockfile and no commands",
    400,
    "preview_commands_needed",
    "the agent's worktree has no lockfile to choose commands from; send `build` and `start`",
  ],
  [
    "another key's preview",
    409,
    "preview_busy",
    "a preview started by another key is running",
  ],
  ["a busy port", 409, "port_busy", "port 5173 is already in use"],
])(
  "a start refused for %s is the API's error with its code, exit 1, no wait",
  async (_, status, code, message) => {
    server.use(
      http.post(`${apiUrl}/v1/agents/agt_1/preview`, () =>
        HttpResponse.json({ error: { code, message } }, { status }),
      ),
    );
    const r = await runCli(startArgs);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`${message} (${code})`);
    expect(r.stdout).toBe("");
    expect(gets()).toEqual([]);
  },
);

test.each([
  [["agent", "preview"], "agent preview takes <agent>"],
  [["agent", "preview", "agt_1", "--build=x"], "needs --port=<n>"],
  [["agent", "preview", "agt_1", "--start=x"], "needs --port=<n>"],
  [["agent", "preview", "agt_1", "--ttl=1h"], "needs --port=<n>"],
  [
    ["agent", "preview", "agt_1", "--no-wait"],
    "--no-wait only goes with starting",
  ],
  [
    ["agent", "preview", "agt_1", "--build= ", "--port=5173"],
    "--build is empty",
  ],
  [
    ["agent", "preview", "agt_1", "--start= ", "--port=5173"],
    "--start is empty",
  ],
  [["agent", "preview", "agt_1", "--port=8080"], "--port takes a whole number"],
  [["agent", "preview", "agt_1", "--port=80"], "--port takes a whole number"],
  [["agent", "preview", "agt_1", "--port=abc"], "--port takes a whole number"],
  [
    ["agent", "preview", "agt_1", "--port=5173", "--ttl=8d"],
    "--ttl takes a duration",
  ],
  [
    ["agent", "preview", "agt_1", "--port=5173", "--ttl=30s"],
    "--ttl takes a duration",
  ],
  [
    ["agent", "preview", "agt_1", "--port=5173", "--ttl=soon"],
    "--ttl takes a duration",
  ],
  [
    ["agent", "preview", "agt_1", "--stop", "--port=5173"],
    "--stop takes no --build",
  ],
  [
    ["agent", "preview", "agt_1", "--stop", "--no-wait"],
    "--stop takes no --build",
  ],
  [["agent", "preview", "agt_1", "agt_2", "--stop"], "takes one agent"],
  [["agent", "preview", "agt_1", "--prompt=x", "--stop"], "takes no --prompt"],
  [
    ["agent", "preview", "agt_1", "--cmd=x", "--port=5173"],
    "Unknown option '--cmd'",
  ],
  [
    ["agent", "archive", "agt_1", "--port=5173"],
    "--port only goes with agent preview",
  ],
  [
    ["agent", "archive", "agt_1", "--build=x"],
    "--build only goes with agent preview",
  ],
  [["agent", "list", "--stop"], "--stop only goes with agent preview"],
  [["agent", "list", "--no-wait"], "--no-wait only goes with agent preview"],
])(
  "%j is a usage error (exit 2) before any request: %s",
  async (argv, message) => {
    const r = await runCli(argv);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(message);
    expect(sent).toEqual([]);
  },
);
