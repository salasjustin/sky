import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { beforeEach, expect, test } from "vitest";
import { server } from "../../../test/msw.js";
import { apiKey, apiUrl, type Captured, runCli } from "./testing.js";

const agentId = "agt_1";
const agent = {
  id: agentId,
  envId: "env_1",
  sessionId: null,
  branch: `claude/${agentId}`,
  status: "active",
  createdAt: "2026-10-30T00:00:00.000Z",
  archivedAt: null,
};
const run = (over: Record<string, unknown> = {}) => ({
  id: "run_1",
  agentId,
  status: "running",
  summary: null,
  usage: null,
  error: null,
  createdAt: "2026-10-30T00:00:00.000Z",
  branch: agent.branch,
  diff: null,
  pendingRequest: null,
  rollup: null,
  compareUrl: null,
  ...over,
});

const writes: { path: string; body: unknown }[] = [];
beforeEach(() => {
  writes.length = 0;
});

const authed = (request: Request) =>
  request.headers.get("authorization") === `Bearer ${apiKey}`;

const post = (
  path: string,
  status: number,
  response: Record<string, unknown>,
) =>
  http.post(`${apiUrl}${path}`, async ({ request }) => {
    if (!authed(request)) return new HttpResponse(null, { status: 401 });
    writes.push({
      path: new URL(request.url).pathname,
      body: await request.json().catch(() => null),
    });
    return HttpResponse.json(response, { status });
  });

const envList = http.get(`${apiUrl}/v1/environments`, () =>
  HttpResponse.json({
    data: [
      {
        id: "env_1",
        name: "web",
        repo: "acme/web",
        setup: "",
        status: "ready",
        spriteName: "s",
        checkpointId: null,
        concurrency: 3,
        approvalPolicy: [],
        failure: null,
      },
    ],
  }),
);

const noKeyLeak = (r: Captured) => {
  expect(r.stdout).not.toContain(apiKey);
  expect(r.stderr).not.toContain(apiKey);
};

test("agent start launches on an env id and prints the agent and run ids", async () => {
  server.use(
    envList,
    post("/v1/agents", 202, { agent, run: run({ status: "starting" }) }),
  );
  const r = await runCli(["agent", "start", "env_1", "--prompt=fix the bug"]);
  expect(r.code).toBe(0);
  expect(writes).toEqual([
    { path: "/v1/agents", body: { envId: "env_1", prompt: "fix the bug" } },
  ]);
  expect(r.stdout).toBe("agt_1 run_1\n");
  noKeyLeak(r);
});

test("agent start resolves an env name and reads an @file prompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sky-agent-"));
  const file = join(dir, "prompt.md");
  writeFileSync(file, "line one\nline two\n");
  server.use(envList, post("/v1/agents", 202, { agent, run: run() }));
  const r = await runCli(["agent", "start", "web", `--prompt=@${file}`]);
  expect(r.code).toBe(0);
  expect(writes[0]?.body).toEqual({
    envId: "env_1",
    prompt: "line one\nline two\n",
  });
});

test("agent start --json prints the API's object", async () => {
  const body = { agent, run: run({ status: "starting" }) };
  server.use(envList, post("/v1/agents", 202, body));
  const r = await runCli(["agent", "start", "env_1", "--prompt=x", "--json"]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual(body);
});

test("agent follow-up queues a run on the agent", async () => {
  server.use(
    post("/v1/agents/:id/runs", 202, { agent, run: run({ id: "run_2" }) }),
  );
  const r = await runCli(["agent", "follow-up", agentId, "--prompt=again"]);
  expect(r.code).toBe(0);
  expect(writes).toEqual([
    { path: "/v1/agents/agt_1/runs", body: { prompt: "again" } },
  ]);
  expect(r.stdout).toBe("agt_1 run_2\n");
});

test("a busy agent's follow-up exits 1 with the API's code", async () => {
  server.use(
    post("/v1/agents/:id/runs", 409, {
      error: { code: "agent_busy", message: "the agent has an active run" },
    }),
  );
  const r = await runCli(["agent", "follow-up", agentId, "--prompt=again"]);
  expect(r.code).toBe(1);
  expect(r.stdout).toBe("");
  expect(r.stderr).toContain("(agent_busy)");
});

test("agent archive prints the archived id, or the API object with --json", async () => {
  const archived = { agent: { ...agent, status: "archived" } };
  server.use(post("/v1/agents/:id/archive", 200, archived));
  const r = await runCli(["agent", "archive", agentId]);
  expect(r.code).toBe(0);
  expect(writes[0]?.path).toBe("/v1/agents/agt_1/archive");
  expect(r.stdout).toBe("archived agt_1\n");
  const j = await runCli(["agent", "archive", agentId, "--json"]);
  expect(JSON.parse(j.stdout)).toEqual(archived);
});

test("agent argv mistakes are usage errors with no request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sky-agent-"));
  const empty = join(dir, "empty.md");
  writeFileSync(empty, "\n");
  for (const argv of [
    ["agent"],
    ["agent", "launch", "env_1"],
    ["agent", "start", "env_1"],
    ["agent", "start", "--prompt=x"],
    ["agent", "start", "env_1", "extra", "--prompt=x"],
    ["agent", "start", "env_1", "--prompt="],
    ["agent", "start", "env_1", `--prompt=@${empty}`],
    ["agent", "start", "env_1", `--prompt=@${join(dir, "missing.md")}`],
    ["agent", "follow-up", agentId],
    ["agent", "archive"],
    ["agent", "archive", agentId, "--timeout=3"],
  ]) {
    const r = await runCli(argv);
    expect(r.code, argv.join(" ")).toBe(2);
    expect(r.stdout, argv.join(" ")).toBe("");
  }
  expect(writes).toEqual([]);
});

const runs = (...data: Record<string, unknown>[]) =>
  http.get(`${apiUrl}/v1/agents/:id/runs`, ({ request }) => {
    if (!authed(request)) return new HttpResponse(null, { status: 401 });
    return HttpResponse.json({ data });
  });

const question = {
  kind: "question",
  requestId: "req_q",
  prompt: "Which branch?\nmain or dev",
};
const approval = {
  kind: "approval",
  requestId: "req_a",
  toolName: "Bash",
  toolSummary: "rm -rf dist",
};

test("inbox prints the newest run's question and exits 3", async () => {
  server.use(
    runs(
      run({ id: "run_2", status: "waiting", pendingRequest: question }),
      run({ id: "run_1", status: "finished" }),
    ),
  );
  const r = await runCli(["inbox", agentId]);
  expect(r.code).toBe(3);
  expect(r.stdout).toBe("question req_q\nWhich branch?\nmain or dev\n");
  expect(r.stderr).toBe("run_2 waiting\n");
  noKeyLeak(r);
});

test("inbox prints an approval's tool and summary", async () => {
  server.use(runs(run({ status: "waiting", pendingRequest: approval })));
  const r = await runCli(["inbox", agentId]);
  expect(r.code).toBe(3);
  expect(r.stdout).toBe("approval req_a Bash\nrm -rf dist\n");
});

test("inbox exits with the newest run's state and prints nothing when nothing is pending", async () => {
  for (const [state, code] of [
    ["finished", 0],
    ["starting", 4],
    ["running", 4],
    ["failed", 5],
    ["stopped", 6],
  ] as const) {
    server.use(runs(run({ status: state })));
    const r = await runCli(["inbox", agentId]);
    expect(r.code, state).toBe(code);
    expect(r.stdout, state).toBe("");
    expect(r.stderr, state).toBe(`run_1 ${state}\n`);
  }
});

test("inbox --json prints the newest run as the API returned it", async () => {
  const newest = run({ status: "waiting", pendingRequest: question, extra: 1 });
  server.use(runs(newest, run({ id: "run_0" })));
  const r = await runCli(["inbox", agentId, "--json"]);
  expect(r.code).toBe(3);
  expect(JSON.parse(r.stdout)).toEqual(newest);
});

test("an agent with no runs fails no_runs", async () => {
  server.use(runs());
  for (const command of ["inbox", "status", "wait"]) {
    const r = await runCli([command, agentId, "--json"]);
    expect(r.code, command).toBe(1);
    expect(r.stdout, command).toBe("");
    expect(JSON.parse(r.stderr).error.code, command).toBe("no_runs");
  }
});

test("status prints the run, its summary, error and compare link", async () => {
  server.use(
    runs(
      run({
        status: "failed",
        summary: "half done",
        error: "runner crashed",
        compareUrl: "https://github.com/acme/web/compare/main...claude/agt_1",
      }),
    ),
  );
  const r = await runCli(["status", agentId]);
  expect(r.code).toBe(5);
  expect(r.stdout).toBe(
    "run_1 failed\nsummary: half done\nerror: runner crashed\ncompare: https://github.com/acme/web/compare/main...claude/agt_1\n",
  );
});

test("status exits with every run state's code", async () => {
  for (const [state, code] of [
    ["finished", 0],
    ["waiting", 3],
    ["starting", 4],
    ["running", 4],
    ["failed", 5],
    ["stopped", 6],
  ] as const) {
    server.use(runs(run({ status: state })));
    const r = await runCli(["status", agentId]);
    expect(r.code, state).toBe(code);
    expect(r.stdout, state).toBe(`run_1 ${state}\n`);
  }
});

test("status --json prints the run object", async () => {
  const newest = run({ status: "finished", summary: "done" });
  server.use(runs(newest));
  const r = await runCli(["status", agentId, "--json"]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual(newest);
});

/** GET runs answers with each list in turn, then repeats the last. */
function runsSequence(...lists: Record<string, unknown>[][]) {
  let i = 0;
  return http.get(`${apiUrl}/v1/agents/:id/runs`, () =>
    HttpResponse.json({ data: lists[Math.min(i++, lists.length - 1)] }),
  );
}

test("wait polls until the run waits, then prints what inbox prints", async () => {
  server.use(
    runsSequence(
      [run({ status: "starting" })],
      [run({ status: "running" })],
      [run({ status: "waiting", pendingRequest: question })],
    ),
  );
  const r = await runCli(["wait", agentId]);
  expect(r.code).toBe(3);
  expect(r.sleeps).toEqual([3000, 3000]);
  expect(r.stdout).toBe("question req_q\nWhich branch?\nmain or dev\n");
  expect(r.stderr).toBe("run_1 waiting\n");
  expect(r.interruptNotes).toEqual([
    "interrupted; agt_1 keeps running on the server. Run sky wait agt_1 to keep waiting",
  ]);
  expect(r.armedAtExit).toBe(0);
});

test("wait returns at once on an ended run", async () => {
  server.use(runs(run({ status: "stopped" })));
  const r = await runCli(["wait", agentId]);
  expect(r.code).toBe(6);
  expect(r.sleeps).toEqual([]);
});

test("wait retries a 5xx with backoff", async () => {
  let i = 0;
  server.use(
    http.get(`${apiUrl}/v1/agents/:id/runs`, () => {
      i++;
      if (i === 2 || i === 3) {
        return HttpResponse.json(
          { error: { code: "internal", message: "boom" } },
          { status: 503 },
        );
      }
      return HttpResponse.json({
        data: [run({ status: i < 4 ? "running" : "finished" })],
      });
    }),
  );
  const r = await runCli(["wait", agentId]);
  expect(r.code).toBe(0);
  expect(r.sleeps).toEqual([3000, 6000, 12000]);
  expect(r.stderr).toMatch(/lost contact with the API \(boom\); retrying/);
});

test("wait retries its first request after a dropped connection or a 503", async () => {
  let i = 0;
  server.use(
    http.get(`${apiUrl}/v1/agents/:id/runs`, () => {
      i++;
      if (i === 1) return HttpResponse.error();
      if (i === 2) {
        return HttpResponse.json(
          { error: { code: "internal", message: "boom" } },
          { status: 503 },
        );
      }
      return HttpResponse.json({ data: [run({ status: "finished" })] });
    }),
  );
  const r = await runCli(["wait", agentId]);
  expect(r.code).toBe(0);
  expect(r.sleeps).toEqual([6000, 12000]);
  expect(r.stderr).toMatch(/^lost contact with the API \(.+\); retrying\n/);
  expect(r.stderr).toMatch(/run_1 finished\n$/);
  expect(r.armedAtExit).toBe(0);
});

test("wait --timeout gives up with exit 4 and the inbox output", async () => {
  server.use(runs(run({ status: "running" })));
  const r = await runCli(["wait", agentId, "--timeout=10"]);
  expect(r.code).toBe(4);
  expect(r.sleeps).toEqual([3000, 3000, 3000, 1000]);
  expect(r.stdout).toBe("");
  expect(r.stderr).toBe("sky: still running after 10s\nrun_1 running\n");
  expect(r.armedAtExit).toBe(0);
});

const failingRuns = (status: number, code: string) =>
  http.get(`${apiUrl}/v1/agents/:id/runs`, () =>
    HttpResponse.json({ error: { code, message: code } }, { status }),
  );

test("wait ends at once on an error a retry can't fix", async () => {
  for (const [status, code, exit] of [
    [404, "not_found", 1],
    [401, "unauthorized", 2],
  ] as const) {
    server.use(failingRuns(status, code));
    const r = await runCli(["wait", agentId]);
    expect(r.code, code).toBe(exit);
    expect(r.sleeps).toEqual([]);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(new RegExp(`\\(${code}\\)`));
    expect(r.armedAtExit).toBe(0);
  }
});

test("wait --timeout bounds the retries of a first request that never succeeds", async () => {
  server.use(failingRuns(503, "internal"));
  const r = await runCli(["wait", agentId, "--timeout=60"]);
  expect(r.code).toBe(4);
  expect(r.sleeps).toEqual([6000, 12000, 24000, 18000]);
  expect(r.stdout).toBe("");
  expect(r.stderr).toBe(
    "lost contact with the API (internal); retrying\nsky: the API did not answer within 60s\n",
  );
  expect(r.armedAtExit).toBe(0);
});

test("wait --timeout while out of contact prints the last run fetched, marked as such", async () => {
  let i = 0;
  server.use(
    http.get(`${apiUrl}/v1/agents/:id/runs`, () =>
      i++ === 0
        ? HttpResponse.json({ data: [run({ status: "running" })] })
        : HttpResponse.error(),
    ),
  );
  const r = await runCli(["wait", agentId, "--timeout=120", "--json"]);
  expect(r.code).toBe(4);
  expect(r.sleeps).toEqual([3000, 6000, 12000, 24000, 30000, 30000, 15000]);
  expect(JSON.parse(r.stdout)).toEqual(run({ status: "running" }));
  expect(r.stderr).toMatch(
    /sky: still running after 120s as of the last answer from the API\nrun_1 running\n$/,
  );
});

test("run-state command argv mistakes are usage errors", async () => {
  for (const argv of [
    ["inbox"],
    ["inbox", agentId, "extra"],
    ["status"],
    ["wait"],
    ["wait", agentId, "--timeout=soon"],
    ["wait", agentId, "--timeout=0"],
    ["wait", agentId, "--timeout=-5"],
    ["inbox", agentId, "--prompt=x"],
  ]) {
    const r = await runCli(argv);
    expect(r.code, argv.join(" ")).toBe(2);
  }
});

const decided = { run: run({ status: "running" }) };
const alreadyDecided = (decision: string) =>
  post("/v1/agents/:id/:kind", 409, {
    error: {
      code: "already_decided",
      message: "the request is already decided",
      decision,
    },
  });

test("approve, deny and answer post the decision and confirm it", async () => {
  server.use(
    post("/v1/agents/:id/approvals", 200, decided),
    post("/v1/agents/:id/answers", 200, decided),
  );
  const cases = [
    [["approve", agentId, "req_a"], "approved req_a\n"],
    [["approve", agentId, "req_a", "--reason=fine"], "approved req_a\n"],
    [["deny", agentId, "req_a", "--reason=too risky"], "denied req_a\n"],
    [["answer", agentId, "req_q", "use main"], "answered req_q\n"],
  ] as const;
  for (const [argv, line] of cases) {
    const r = await runCli([...argv]);
    expect(r.code, argv.join(" ")).toBe(0);
    expect(r.stdout).toBe(line);
    noKeyLeak(r);
  }
  expect(writes).toEqual([
    {
      path: "/v1/agents/agt_1/approvals",
      body: { requestId: "req_a", decision: "approve" },
    },
    {
      path: "/v1/agents/agt_1/approvals",
      body: { requestId: "req_a", decision: "approve", reason: "fine" },
    },
    {
      path: "/v1/agents/agt_1/approvals",
      body: { requestId: "req_a", decision: "deny", reason: "too risky" },
    },
    {
      path: "/v1/agents/agt_1/answers",
      body: { requestId: "req_q", answer: "use main" },
    },
  ]);
});

test("a decision --json prints the API's object", async () => {
  server.use(post("/v1/agents/:id/approvals", 200, decided));
  const r = await runCli(["approve", agentId, "req_a", "--json"]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual(decided);
});

test("an exact repeat the API accepts again exits 0 like the first", async () => {
  server.use(post("/v1/agents/:id/answers", 200, decided));
  for (let i = 0; i < 2; i++) {
    const r = await runCli(["answer", agentId, "req_q", "main"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("answered req_q\n");
  }
});

test("already_decided exits 1: the earlier decision stands and this one was not applied", async () => {
  for (const [argv, decision] of [
    [["approve", agentId, "req_a"], "denied"],
    [["deny", agentId, "req_a", "--reason=no"], "denied"],
    [["answer", agentId, "req_q", "dev"], "answered"],
  ] as const) {
    server.use(alreadyDecided(decision));
    const message = `${argv[2]} was already ${decision}; this ${argv[0]} was not applied`;
    const r = await runCli([...argv]);
    expect(r.code, argv[0]).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(`sky: ${message}\n`);
    const j = await runCli([...argv, "--json"]);
    expect(j.code).toBe(1);
    expect(j.stdout).toBe("");
    expect(JSON.parse(j.stderr)).toEqual({
      error: { code: "already_decided", message },
    });
  }
});

test("already_decided with no recorded decision reports the API's own error", async () => {
  server.use(
    post("/v1/agents/:id/approvals", 409, {
      error: { code: "already_decided", message: "the request is decided" },
    }),
  );
  const r = await runCli(["approve", agentId, "req_a"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toBe("sky: the request is decided (already_decided)\n");
});

test("a request whose run ended exits 1 with request_closed", async () => {
  server.use(
    post("/v1/agents/:id/approvals", 409, {
      error: {
        code: "request_closed",
        message: "the request's run is no longer waiting",
      },
    }),
  );
  const r = await runCli(["approve", agentId, "req_a"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toBe(
    "sky: the request's run is no longer waiting (request_closed)\n",
  );
});

test("decision argv mistakes are usage errors with no request", async () => {
  for (const argv of [
    ["approve", agentId],
    ["approve", agentId, "req_a", "--reason="],
    ["approve", agentId, "req_a", "extra"],
    ["deny", agentId, "req_a"],
    ["deny", agentId, "req_a", "--reason="],
    ["answer", agentId, "req_q"],
    ["answer", agentId, "req_q", ""],
    ["answer", agentId, "req_q", "a", "b"],
    ["answer", agentId, "req_q", "a", "--reason=x"],
  ]) {
    const r = await runCli(argv);
    expect(r.code, argv.join(" ")).toBe(2);
  }
  expect(writes).toEqual([]);
});

test("an answer after -- is sent verbatim, even one starting with a dash", async () => {
  server.use(post("/v1/agents/:id/answers", 200, decided));
  for (const text of ["- staging", "-1", "--force"]) {
    const r = await runCli(["answer", agentId, "req_q", "--json", "--", text]);
    expect(r.code, text).toBe(0);
  }
  expect(writes.map((w) => w.body)).toEqual([
    { requestId: "req_q", answer: "- staging" },
    { requestId: "req_q", answer: "-1" },
    { requestId: "req_q", answer: "--force" },
  ]);
});

test("a dash-leading answer without -- points at the -- form", async () => {
  for (const text of ["- staging", "-1"]) {
    const r = await runCli(["answer", agentId, "req_q", text]);
    expect(r.code, text).toBe(2);
    expect(r.stderr, text).toMatch(/sky answer <agent> <requestId> -- <text>/);
  }
  expect(writes).toEqual([]);
});

test("--help shows the -- form for answer", async () => {
  const r = await runCli(["answer", "--help"]);
  expect(r.stdout).toContain("sky answer <agent> <requestId> -- <text>");
});

test("--help documents the run-state exit codes", async () => {
  for (const argv of [["--help"], ["inbox", "--help"], ["agent", "--help"]]) {
    const r = await runCli(argv);
    expect(r.code, argv.join(" ")).toBe(0);
    expect(r.stdout).toMatch(
      /0 finished; 3 waiting \(needs input\); 4 starting or running \(wait: timed\s+out\); 5 failed; 6 stopped/,
    );
  }
});
