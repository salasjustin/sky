import { delay, HttpResponse, http } from "msw";
import { beforeEach, expect, test, vi } from "vitest";
import { server } from "../../../test/msw.js";
import { apiUrl, runCli } from "./testing.js";

const envJson = (over: Record<string, unknown> = {}) => ({
  id: "env_1",
  name: "web",
  repo: "acme/web",
  setup: "",
  status: "ready",
  spriteName: "sky-env-1",
  checkpointId: "cp_1",
  concurrency: 3,
  approvalPolicy: [],
  autoApprove: { defaults: true, commands: [] },
  failure: null,
  health: null,
  createdAt: "2026-10-30T12:00:00.000Z",
  ...over,
});

const web = envJson();
const rebuilding = envJson({ status: "provisioning", checkpointId: null });

const list = http.get(`${apiUrl}/v1/environments`, () =>
  HttpResponse.json({ data: [web] }),
);

const bodies: unknown[] = [];
beforeEach(() => {
  bodies.length = 0;
});

const rebuild = (
  respond: (body: { force: boolean }) => Response | Promise<Response> = () =>
    HttpResponse.json(rebuilding, { status: 202 }),
) =>
  http.post(`${apiUrl}/v1/environments/:id/rebuild`, async ({ request }) => {
    const body = (await request.json()) as { force: boolean };
    bodies.push(body);
    return respond(body);
  });

const refused = (
  agents: unknown[],
  extra: Record<string, unknown> = { checked: "sprite" },
) =>
  HttpResponse.json(
    {
      error: {
        code: "unpublished_work",
        message: "the API's own words",
        agents,
        ...extra,
      },
    },
    { status: 409 },
  );

const atRisk = [
  {
    agentId: "agt_a",
    branch: "claude/agt_a",
    uncommitted: 2,
    unpublishedCommits: 0,
    neverPublished: false,
  },
  {
    agentId: "agt_b",
    branch: "feature/login",
    uncommitted: 0,
    unpublishedCommits: 3,
    neverPublished: false,
  },
  {
    agentId: "agt_c",
    branch: "claude/agt_c",
    uncommitted: 0,
    unpublishedCommits: 1,
    neverPublished: true,
  },
];
const lines = [
  "agt_a (claude/agt_a): 2 uncommitted files",
  "agt_b (feature/login): 3 commits not on GitHub",
  "agt_c (claude/agt_c): 1 commit on a branch never published",
];

const terminal = (answers: string[], prompts: string[]) => ({
  stderrIsTTY: true,
  stdin: {
    isTTY: true,
    prompt: async (text: string) => {
      prompts.push(text);
      return answers.shift() ?? "";
    },
  },
});

test("env rebuild --yes rebuilds by name and prints the provisioning environment", async () => {
  server.use(list, rebuild());
  const r = await runCli(["env", "rebuild", "web", "--yes"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("env_1 provisioning acme/web web\n");
  expect(bodies).toEqual([{ force: false }]);
});

test("env rebuild --json --yes prints the API's environment object", async () => {
  server.use(list, rebuild());
  const r = await runCli(["env", "rebuild", "env_1", "--json", "--yes"]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual(rebuilding);
});

// no POST handler is registered in these: a request would be reported as a leak
test("env rebuild without --yes and no terminal is refused before any request", async () => {
  for (const opts of [
    {},
    { ...terminal(["y"], []), env: { CI: "true" } },
    { stderrIsTTY: true, stdin: { isTTY: false } },
  ]) {
    const r = await runCli(["env", "rebuild", "web"], opts);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("sky: refusing to rebuild web without --yes\n");
  }
});

test("env rebuild --json without --yes is refused even on a terminal", async () => {
  const prompts: string[] = [];
  const r = await runCli(
    ["env", "rebuild", "web", "--json"],
    terminal(["y"], prompts),
  );
  expect(r.code).toBe(2);
  expect(prompts).toEqual([]);
});

test("env rebuild on a terminal asks, and rebuilds after a yes", async () => {
  for (const answer of ["y", "YES", " y "]) {
    bodies.length = 0;
    const prompts: string[] = [];
    server.use(list, rebuild());
    const r = await runCli(
      ["env", "rebuild", "web"],
      terminal([answer], prompts),
    );
    expect(r.code, answer).toBe(0);
    expect(prompts).toEqual([
      "rebuild web (env_1) from its repo and setup? Its agents are kept and start new worktrees on their next run [y/N] ",
    ]);
    expect(bodies).toEqual([{ force: false }]);
  }
});

test("env rebuild on a terminal aborts on anything but yes, sending nothing", async () => {
  for (const answer of ["", "n", "no", "yep"]) {
    server.use(list);
    const r = await runCli(["env", "rebuild", "web"], terminal([answer], []));
    expect(r.code, answer).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("nothing rebuilt\n");
  }
  expect(bodies).toEqual([]);
});

test("env rebuild of an unknown env exits 1 without a request", async () => {
  server.use(list);
  const r = await runCli(["env", "rebuild", "nope", "--yes"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toBe("sky: no environment named nope\n");
});

test("--force goes only with env rebuild, and --yes only with delete and rebuild", async () => {
  const r = await runCli(["env", "delete", "web", "--force", "--yes"]);
  expect(r.code).toBe(2);
  expect(r.stderr).toBe(
    "sky: --force only goes with env rebuild\nRun 'sky --help' for usage.\n",
  );
});

test("env rebuild refused for unpublished work lists each agent, its branch and what is at risk, and exits 1", async () => {
  server.use(
    list,
    rebuild(() => refused(atRisk)),
  );
  const r = await runCli(["env", "rebuild", "web", "--yes"]);
  expect(r.code).toBe(1);
  expect(r.stdout).toBe("");
  expect(r.stderr).toBe(
    `sky: web (env_1) has work that exists only on its sprite, and a rebuild would lose it\n${lines.map((l) => `  ${l}`).join("\n")}\n  have each agent publish it first (for example sky agent follow-up agt_a --prompt="publish your work"), or run sky env rebuild web --force to rebuild anyway and lose it\n`,
  );
  // asked once, without force
  expect(bodies).toEqual([{ force: false }]);
});

test("env rebuild --json refused for unpublished work keeps the API's error, with the agents at risk and what was checked", async () => {
  for (const extra of [
    { checked: "sprite" },
    { checked: "records", unreachable: "503 Storage not ready" },
  ]) {
    server.use(
      list,
      rebuild(() => refused(atRisk, extra)),
    );
    const r = await runCli(["env", "rebuild", "web", "--json", "--yes"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    // through Output.fail, so the error is the CLI's own, with the API's fields beside it for a script
    expect(JSON.parse(r.stderr)).toEqual({
      error: {
        code: "unpublished_work",
        message:
          "web (env_1) has work that exists only on its sprite, and a rebuild would lose it",
        detail: expect.stringContaining(
          "agt_a (claude/agt_a): 2 uncommitted files",
        ),
        agents: atRisk,
        ...extra,
      },
    });
  }
});

test("a refusal from records lists every agent that has run as unknown, says the sprite could not be read, and says nothing can be published", async () => {
  server.use(
    list,
    rebuild(() =>
      refused(
        [
          {
            agentId: "agt_a",
            branch: "claude/agt_a",
            uncommitted: null,
            unpublishedCommits: null,
            neverPublished: false,
          },
        ],
        { checked: "records", unreachable: "503 Storage not ready" },
      ),
    ),
  );
  const r = await runCli(["env", "rebuild", "web", "--yes"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain(
    "agt_a (claude/agt_a): commits and uncommitted changes unknown (the sprite couldn't be read)",
  );
  expect(r.stderr).toContain(
    "could not read the sprite (503 Storage not ready), so every agent that has run is listed: each may hold commits or uncommitted changes there that no one could see",
  );
  expect(r.stderr).toContain(
    "the sprite isn't answering, so nothing can be published from it; run sky env rebuild web --force",
  );
  expect(r.stderr).not.toContain("publish it first");
  expect(bodies).toEqual([{ force: false }]);
});

const unknownAgents = [
  {
    agentId: "agt_a",
    branch: "claude/agt_a",
    uncommitted: null,
    unpublishedCommits: null,
    neverPublished: false,
  },
];
const recordsOnly = {
  checked: "records",
  unreachable: "503 Storage not ready",
};

test("env rebuild --force on a records-only check lists those agents as possibly losing work, then rebuilds with force", async () => {
  server.use(
    list,
    rebuild((body) =>
      body.force
        ? HttpResponse.json(
            { ...rebuilding, rebuildCheck: recordsOnly },
            { status: 202 },
          )
        : refused(unknownAgents, recordsOnly),
    ),
  );
  const r = await runCli(["env", "rebuild", "web", "--force", "--yes"]);
  expect(r.code).toBe(0);
  expect(r.stderr).toContain("rebuilding web (env_1) may lose this work:");
  expect(r.stderr).toContain(
    "  agt_a (claude/agt_a): commits and uncommitted changes unknown",
  );
  expect(r.stderr).toContain(
    "sky: warning: the sprite didn't answer (503 Storage not ready)",
  );
  expect(bodies).toEqual([{ force: false }, { force: true }]);
});

test("env rebuild --json --yes --force carries the loss list in the JSON, and writes nothing to stderr", async () => {
  server.use(
    list,
    rebuild((body) =>
      body.force
        ? HttpResponse.json(
            { ...rebuilding, rebuildCheck: recordsOnly },
            { status: 202 },
          )
        : refused(unknownAgents, recordsOnly),
    ),
  );
  const r = await runCli([
    "env",
    "rebuild",
    "web",
    "--json",
    "--yes",
    "--force",
  ]);
  expect(r.code).toBe(0);
  expect(r.stderr).toBe("");
  expect(JSON.parse(r.stdout)).toEqual({
    ...rebuilding,
    rebuildCheck: recordsOnly,
    lost: { agents: unknownAgents, ...recordsOnly },
  });
});

test("env rebuild --force --yes lists what is lost, then rebuilds with force", async () => {
  server.use(
    list,
    rebuild((body) =>
      body.force
        ? HttpResponse.json(rebuilding, { status: 202 })
        : refused(atRisk),
    ),
  );
  const r = await runCli(["env", "rebuild", "web", "--force", "--yes"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("env_1 provisioning acme/web web\n");
  expect(r.stderr).toBe(
    `rebuilding web (env_1) loses this work:\n${lines.map((l) => `  ${l}`).join("\n")}\n`,
  );
  expect(bodies).toEqual([{ force: false }, { force: true }]);
});

test("env rebuild --force on a terminal asks again, after the list, and sends force only after a yes", async () => {
  const prompts: string[] = [];
  server.use(
    list,
    rebuild((body) =>
      body.force
        ? HttpResponse.json(rebuilding, { status: 202 })
        : refused(atRisk),
    ),
  );
  const r = await runCli(
    ["env", "rebuild", "web", "--force"],
    terminal(["y", "y"], prompts),
  );
  expect(r.code).toBe(0);
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toBe("lose it and rebuild? [y/N] ");
  expect(bodies).toEqual([{ force: false }, { force: true }]);
});

test("env rebuild --force on a terminal stops at a no to the second question, losing nothing", async () => {
  server.use(
    list,
    rebuild(() => refused(atRisk)),
  );
  const r = await runCli(
    ["env", "rebuild", "web", "--force"],
    terminal(["y", "n"], []),
  );
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("loses this work");
  expect(r.stderr.endsWith("nothing rebuilt\n")).toBe(true);
  expect(bodies).toEqual([{ force: false }]);
});

test("env rebuild --force on an env with nothing at risk rebuilds with no list and no second question", async () => {
  server.use(list, rebuild());
  const r = await runCli(["env", "rebuild", "web", "--force", "--yes"]);
  expect(r.code).toBe(0);
  expect(r.stderr).toBe("");
  expect(bodies).toEqual([{ force: false }]);
});

test("env rebuild waits 3 minutes for the server's work check, so a slow answer still lands; the env lookup keeps 30 s", async () => {
  // the server's check alone may take its 60 s sprite timeout; the clock here runs 100 times fast
  const timeoutOf = AbortSignal.timeout.bind(AbortSignal);
  const spy = vi
    .spyOn(AbortSignal, "timeout")
    .mockImplementation((ms) => timeoutOf(ms / 100));
  server.use(
    list,
    rebuild(async () => {
      await delay(600);
      return HttpResponse.json(rebuilding, { status: 202 });
    }),
  );
  try {
    const r = await runCli(["env", "rebuild", "web", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("env_1 provisioning acme/web web\n");
    expect(spy.mock.calls.map(([ms]) => ms)).toEqual([30_000, 3 * 60_000]);
  } finally {
    spy.mockRestore();
  }
});

test("a timed-out rebuild exits 1 and says it may still have started, and where to look", async () => {
  server.use(list);
  const fetchOf = globalThis.fetch;
  const spy = vi.spyOn(globalThis, "fetch");
  // what undici rejects with when the request's AbortSignal.timeout fires
  spy.mockImplementation(async (input, init) => {
    if (init?.method !== "POST") return fetchOf(input, init);
    throw new DOMException(
      "The operation was aborted due to timeout",
      "TimeoutError",
    );
  });
  try {
    const r = await runCli(["env", "rebuild", "web", "--yes"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      "sky: cannot reach https://sky.test: no response in 3 min; the rebuild may still have started: check with sky env show env_1\n",
    );
  } finally {
    spy.mockRestore();
  }
});

test("a rebuild whose check could only read the run records warns on stderr, and --json passes rebuildCheck through", async () => {
  const rebuildCheck = {
    checked: "records",
    unreachable: "503 Storage not ready",
  };
  const warning =
    "sky: warning: the sprite didn't answer (503 Storage not ready), so the check for unpublished work could only read what the agents' runs recorded, and the rebuild loses any commits or uncommitted changes that were only there\n";
  server.use(
    list,
    rebuild(() =>
      HttpResponse.json({ ...rebuilding, rebuildCheck }, { status: 202 }),
    ),
  );
  const plain = await runCli(["env", "rebuild", "web", "--yes"]);
  expect(plain.code).toBe(0);
  expect(plain.stdout).toBe("env_1 provisioning acme/web web\n");
  expect(plain.stderr).toBe(warning);
  const json = await runCli(["env", "rebuild", "web", "--json", "--yes"]);
  expect(json.code).toBe(0);
  expect(JSON.parse(json.stdout)).toEqual({ ...rebuilding, rebuildCheck });
  // the JSON carries rebuildCheck, so there is no prose beside it
  expect(json.stderr).toBe("");
});

test("env rebuild refused while a run is active exits 1 with the API's message", async () => {
  server.use(
    list,
    rebuild(() =>
      HttpResponse.json(
        {
          error: {
            code: "run_active",
            message:
              "a run on this environment is active; wait for it or stop it",
          },
        },
        { status: 409 },
      ),
    ),
  );
  const r = await runCli(["env", "rebuild", "web", "--yes"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toBe(
    "sky: a run on this environment is active; wait for it or stop it (run_active)\n",
  );
});

test("env show says the sprite isn't answering and what to run", async () => {
  server.use(
    http.get(`${apiUrl}/v1/environments/env_1`, () =>
      HttpResponse.json(
        envJson({
          health: {
            status: "unreachable",
            error: "503 Storage not ready",
            at: "2026-11-26T10:00:00.000Z",
            message:
              "the environment's sprite isn't answering (503 Storage not ready); if it stays that way, sky env rebuild web rebuilds it",
          },
        }),
      ),
    ),
    list,
  );
  const r = await runCli(["env", "show", "env_1"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe(
    "env_1 ready acme/web web\nruntime: default (the SKY_RUNTIME secret, else claude-code)\nhealth: unreachable (last error 2026-11-26T10:00:00.000Z): 503 Storage not ready\n  if it stays that way, sky env rebuild env_1 rebuilds it\n",
  );
});

test("env show of a healthy env has no health line, and --json passes health through", async () => {
  server.use(
    http.get(`${apiUrl}/v1/environments/env_1`, () => HttpResponse.json(web)),
    list,
  );
  expect((await runCli(["env", "show", "env_1"])).stdout).not.toContain(
    "health",
  );
  const json = await runCli(["env", "show", "env_1", "--json"]);
  expect(JSON.parse(json.stdout).health).toBeNull();
});
