import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpritesClient } from "@fly/sprites";
import {
  agents,
  type Db,
  environments,
  migrate,
  openDb,
  previews,
} from "@sky/db";
import type { AgentId, EnvironmentId } from "@sky/shared";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createApp } from "./app.js";
import { KnownSecrets } from "./redact.js";
import { createSpriteHealth } from "./sprite-health.js";
import { execInSprite, type SpriteOps, spriteNameFor } from "./sprites.js";
import {
  envFileOf,
  type SpritesWire,
  spritesToken,
  stubSprites,
  testConfig,
} from "./testing/sprites.js";
import { WORK_CHECK } from "./unpublished.js";

let dir: string;
let db: Db;
let app: ReturnType<typeof createApp>;
let wire: SpritesWire;
let logs: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sky-rebuild-"));
  writeFileSync(join(dir, "runner.mjs"), "// runner bundle\n");
  db = openDb(":memory:");
  migrate(db);
  wire = stubSprites();
  logs = [];
  app = createApp({
    db,
    config: testConfig({ runnerBundlePath: join(dir, "runner.mjs") }),
    sprites: new SpritesClient(spritesToken),
    log: (line) => logs.push(line),
    nudgeDeliveries: () => {},
    launchWatchMs: 50,
    // a sprite that hangs answers its 503 at once
    spritesTimeoutMs: 2_000,
  });
});
afterEach(async () => {
  await wire.cleanedUp();
  if (db.$client.open) db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

const auth = { Authorization: `Bearer ${testConfig().apiKey}` };
const json = { ...auth, "Content-Type": "application/json" };
const sha = (c: string) => c.repeat(40);
const usage = {
  inputTokens: 1,
  outputTokens: 1,
  costUsd: 0.01,
  turns: 1,
  durationMs: 1,
};

function readyEnv(
  overrides: Partial<typeof environments.$inferInsert> = {},
): EnvironmentId {
  const id = `env_${Math.random().toString(36).slice(2)}` as EnvironmentId;
  db.insert(environments)
    .values({
      id,
      name: id,
      repo: "acme/kru",
      setup: "",
      status: "ready",
      spriteName: spriteNameFor(id),
      checkpointId: "v1",
      ...overrides,
    })
    .run();
  wire.sprites.add(spriteNameFor(id));
  return id;
}

const rebuild = (
  id: string,
  body: unknown = {},
  headers: Record<string, string> = json,
) =>
  app.request(`/v1/environments/${id}/rebuild`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

const getEnv = async (id: string) =>
  (await (
    await app.request(`/v1/environments/${id}`, { headers: auth })
  ).json()) as Record<string, unknown>;

const settled = (id: string) =>
  vi.waitFor(
    async () => {
      const env = await getEnv(id);
      expect(env.status).not.toBe("provisioning");
      return env;
    },
    { timeout: 10_000 },
  );

const sessionOpened = (count: number) =>
  vi.waitFor(() => expect(wire.sessions).toHaveLength(count));

type Launched = { agent: { id: AgentId }; run: { id: string } };

const postEvent = (token: string, event: unknown) =>
  app.request("/internal/events", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(event),
  });

const rollupOf = (
  commits: string[],
  published?: { head: string; branch: string },
) => ({
  base: sha("b"),
  run: { commits: [], files: 0, added: 0, removed: 0 },
  cumulative: {
    commits: commits.map((c) => ({ sha: sha(c), subject: `commit ${c}` })),
    files: commits.length,
    added: commits.length,
    removed: 0,
  },
  ...(published && { published }),
});

/** Launches an agent, runs it to a finish with `rollup` and a session, and returns it. */
async function agentWith(envId: string, rollup?: unknown, prompt = "go") {
  const before = wire.sessions.length;
  const res = await app.request("/v1/agents", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ envId, prompt }),
  });
  expect(res.status).toBe(202);
  const { agent, run } = (await res.json()) as Launched;
  await sessionOpened(before + 1);
  const token = envFileOf(wire, wire.sessions[before]).AGENT_TOKEN ?? "";
  await postEvent(token, {
    runId: run.id,
    type: "run.started",
    payload: { sessionId: `session-${agent.id}` },
  });
  await postEvent(token, {
    runId: run.id,
    type: "run.finished",
    payload: { summary: "done", usage, ...(rollup ? { rollup } : {}) },
  });
  return { agent, run, token };
}

const agentRow = (id: string) =>
  db
    .select()
    .from(agents)
    .where(eq(agents.id, id as never))
    .get();

/** What the worktree check prints for the agents it is asked about; `lines` by agent id. */
function worktreeCheck(lines: Record<string, string>) {
  const fallback = wire.exec;
  const asked: string[][] = [];
  wire.exec = (argv, sprite) => {
    if (argv[0] !== "bash" || argv[2] !== WORK_CHECK) {
      return fallback(argv, sprite);
    }
    asked.push(argv.slice(5));
    return {
      exitCode: 0,
      stdout: argv
        .slice(5)
        .map((id) => `${id}\t${lines[id] ?? "none"}\n`)
        .join(""),
    };
  };
  return asked;
}

const workChecks = () => wire.calls.filter((c) => c.includes("sky-published"));

// ——— what a rebuild does ———

test.each([
  ["ready", {}],
  [
    "failed",
    { status: "failed", failureStep: "setup", failureStderr: "it broke" },
  ],
] as const)(
  "rebuild of a %s env reprovisions it, keeps its agents and drops their sessions",
  async (_, overrides) => {
    const envId = readyEnv();
    const { agent } = await agentWith(envId);
    const archived = await agentWith(envId);
    await app.request(`/v1/agents/${archived.agent.id}/archive`, {
      method: "POST",
      headers: auth,
    });
    if (Object.keys(overrides).length > 0) {
      db.update(environments)
        .set(overrides)
        .where(eq(environments.id, envId))
        .run();
    }
    expect(agentRow(agent.id)?.sessionId).toBe(`session-${agent.id}`);

    const res = await rebuild(envId);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      id: envId,
      status: "provisioning",
      checkpointId: null,
      failure: null,
      health: null,
    });
    expect(await settled(envId)).toMatchObject({
      status: "ready",
      failure: null,
    });

    const kept = agentRow(agent.id);
    expect(kept).toMatchObject({ archivedAt: null, sessionId: null });
    expect(kept?.rebuiltAt).toEqual(expect.any(String));
    // the archived one has no worktree to start again, but its session is gone with the sprite's
    expect(agentRow(archived.agent.id)).toMatchObject({
      sessionId: null,
      rebuiltAt: null,
    });
    // the sprite is reprovisioned from scratch, the same steps as provisioning
    expect(wire.calls).toContain(
      `exec ${spriteNameFor(envId)} - rm -rf /workspace/repo /workspace/worktrees`,
    );
  },
);

test("rebuild is admin only, and 404 for an unknown env", async () => {
  const envId = readyEnv();
  expect(
    (await rebuild(envId, {}, { "Content-Type": "application/json" })).status,
  ).toBe(401);
  expect((await rebuild("env_nope")).status).toBe(404);
});

test("rebuild is refused while the env provisions, and while a run on it is active", async () => {
  const provisioning = readyEnv({ status: "provisioning" });
  const refusedProvisioning = await rebuild(provisioning);
  expect(refusedProvisioning.status).toBe(409);
  expect(await refusedProvisioning.json()).toMatchObject({
    error: { code: "provisioning" },
  });

  const envId = readyEnv();
  const res = await app.request("/v1/agents", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ envId, prompt: "go" }),
  });
  expect(res.status).toBe(202);
  await sessionOpened(1);
  const refusedRun = await rebuild(envId, { force: true });
  expect(refusedRun.status).toBe(409);
  expect(await refusedRun.json()).toMatchObject({
    error: { code: "run_active" },
  });
  expect((await getEnv(envId)).status).toBe("ready");
});

async function previewOf(envId: EnvironmentId) {
  const { agent } = await agentWith(envId);
  db.insert(previews)
    .values({
      envId,
      agentId: agent.id,
      port: 3000,
      startCmd: "node server.js",
      state: "ready",
      tokenHash: "a".repeat(64),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    .run();
}

test("rebuild ends the env's preview first", async () => {
  const envId = readyEnv();
  await previewOf(envId);
  expect((await rebuild(envId)).status).toBe(202);
  await settled(envId);
  expect(db.select().from(previews).all()).toEqual([]);
});

test("rebuild goes on when the sprite can't end the preview, leaving it for the sweep", async () => {
  const envId = readyEnv();
  await previewOf(envId);
  wire.serviceDeleteStatus = 503;
  expect((await rebuild(envId)).status).toBe(202);
  await settled(envId);
  expect(logs.some((l) => l.includes("preview of"))).toBe(true);
  expect(db.select().from(previews).all()).toHaveLength(1);
});

// ——— unpublished work ———

test("a reachable sprite's uncommitted changes, unpublished commits and never-published branch are each refused as unpublished_work", async () => {
  const envId = readyEnv();
  const dirty = await agentWith(envId);
  const ahead = await agentWith(envId);
  const never = await agentWith(envId);
  const clean = await agentWith(envId);
  const gone = await agentWith(envId);
  worktreeCheck({
    [dirty.agent.id]: "ok\t3\t0\t0\t",
    [ahead.agent.id]: "ok\t0\t2\t0\tfeature/login",
    [never.agent.id]: "ok\t0\t4\t1\t",
    [clean.agent.id]: "ok\t0\t0\t0\tfeature/clean",
    [gone.agent.id]: "none",
  });

  const res = await rebuild(envId);
  expect(res.status).toBe(409);
  const { error } = (await res.json()) as { error: Record<string, unknown> };
  expect(error).toMatchObject({
    code: "unpublished_work",
    checked: "sprite",
    agents: [
      {
        agentId: dirty.agent.id,
        branch: `claude/${dirty.agent.id}`,
        uncommitted: 3,
        unpublishedCommits: 0,
        neverPublished: false,
      },
      {
        agentId: ahead.agent.id,
        branch: "feature/login",
        uncommitted: 0,
        unpublishedCommits: 2,
        neverPublished: false,
      },
      {
        agentId: never.agent.id,
        branch: `claude/${never.agent.id}`,
        uncommitted: 0,
        unpublishedCommits: 4,
        neverPublished: true,
      },
    ],
  });
  expect(error.unreachable).toBeUndefined();
  expect(String(error.message)).toContain(
    `${dirty.agent.id} (claude/${dirty.agent.id}): 3 uncommitted files`,
  );
  expect(String(error.message)).toContain(
    `${ahead.agent.id} (feature/login): 2 commits not on GitHub`,
  );
  expect(String(error.message)).toContain(
    `${never.agent.id} (claude/${never.agent.id}): 4 commits on a branch never published`,
  );
  expect(String(error.message)).not.toContain(clean.agent.id);
  // nothing was reprovisioned
  expect(await getEnv(envId)).toMatchObject({ status: "ready" });
  expect(agentRow(dirty.agent.id)?.sessionId).not.toBeNull();
});

test("a reachable sprite with nothing at risk rebuilds without asking for force", async () => {
  const envId = readyEnv();
  const { agent } = await agentWith(envId);
  const asked = worktreeCheck({ [agent.id]: "ok\t0\t0\t0\tfeature/done" });
  expect((await rebuild(envId)).status).toBe(202);
  expect(asked).toEqual([[agent.id]]);
  await settled(envId);
});

test("an agent whose worktree is gone is not at risk", async () => {
  const envId = readyEnv();
  const { agent } = await agentWith(envId);
  worktreeCheck({ [agent.id]: "none" });
  expect((await rebuild(envId)).status).toBe(202);
  await settled(envId);
});

test("the worktree check is read-only git, run in the sprite's worktrees directory", async () => {
  expect(WORK_CHECK).not.toMatch(
    /\b(reset|checkout|clean|rm|commit|add|fetch|push|rebase|update-ref|gc)\b/,
  );
  const envId = readyEnv();
  const { agent } = await agentWith(envId);
  const asked = worktreeCheck({ [agent.id]: "none" });
  await rebuild(envId);
  await settled(envId);
  expect(asked).toHaveLength(1);
  expect(
    wire.calls.some((c) => c.includes(`/workspace/worktrees ${agent.id}`)),
  ).toBe(true);
});

/** A sprite that answers every exec with a 503, as one stuck on "Storage not ready" does. */
function sprite503() {
  wire.hangMs = 1;
  wire.hangs = (call) => call.startsWith("exec ") && call.includes("bash -c");
}

test.each([
  [
    "commits never published",
    rollupOf(["2", "1"]),
    { uncommitted: null, unpublishedCommits: 2, neverPublished: true },
  ],
  [
    "commits past the last published head",
    rollupOf(["3", "2", "1"], { head: sha("2"), branch: "feature/login" }),
    { uncommitted: null, unpublishedCommits: 1, neverPublished: false },
  ],
  [
    "a published head the rollup no longer lists",
    rollupOf(["3", "2"], { head: sha("9"), branch: "feature/login" }),
    { uncommitted: null, unpublishedCommits: 2, neverPublished: false },
  ],
])(
  "a sprite that doesn't answer falls back to what the runs recorded: %s",
  async (_, rollup, risk) => {
    const envId = readyEnv();
    const { agent } = await agentWith(envId, rollup);
    sprite503();
    const res = await rebuild(envId);
    expect(res.status).toBe(409);
    const { error } = (await res.json()) as { error: Record<string, unknown> };
    expect(error).toMatchObject({
      code: "unpublished_work",
      checked: "records",
      unreachable: expect.any(String),
      agents: [{ agentId: agent.id, ...risk }],
    });
    expect(String(error.message)).toContain("the sprite could not be asked");
    expect(String(error.message)).toContain("uncommitted changes unknown");
    expect(await getEnv(envId)).toMatchObject({ status: "ready" });
  },
);

test("a sprite that doesn't answer rebuilds when the records show everything published, or nothing committed", async () => {
  const envId = readyEnv();
  await agentWith(
    envId,
    rollupOf(["2", "1"], { head: sha("2"), branch: "feature/login" }),
  );
  await agentWith(envId, rollupOf([]));
  await agentWith(envId);
  sprite503();
  const res = await rebuild(envId);
  expect(res.status).toBe(202);
});

test("the branch of an agent started on one is the one it publishes to in the records", async () => {
  const envId = readyEnv();
  const { agent } = await agentWith(envId, rollupOf(["1"]));
  db.update(agents)
    .set({ remoteBranch: "feature/started" })
    .where(eq(agents.id, agent.id))
    .run();
  sprite503();
  const { error } = (await (await rebuild(envId)).json()) as {
    error: Record<string, unknown>;
  };
  expect(error.agents).toMatchObject([{ branch: "feature/started" }]);
});

test("force rebuilds without checking, keeping the agents with their sessions dropped", async () => {
  const envId = readyEnv();
  const { agent } = await agentWith(envId);
  const asked = worktreeCheck({ [agent.id]: "ok\t5\t3\t1\t" });
  const res = await rebuild(envId, { force: true });
  expect(res.status).toBe(202);
  expect(asked).toEqual([]);
  expect(workChecks()).toEqual([]);
  await settled(envId);
  expect(agentRow(agent.id)).toMatchObject({
    sessionId: null,
    archivedAt: null,
  });
});

test("force works on a sprite that doesn't answer the check", async () => {
  const envId = readyEnv();
  await agentWith(envId, rollupOf(["1"]));
  sprite503();
  expect((await rebuild(envId, { force: true })).status).toBe(202);
});

test("the body takes only force, as a boolean", async () => {
  const envId = readyEnv();
  expect((await rebuild(envId, { force: "yes" })).status).toBe(400);
  expect((await rebuild(envId, { everything: true })).status).toBe(400);
});

// ——— the next run starts cleanly ———

async function connect(envId: string) {
  const res = await app.request(
    `/v1/environments/${envId}/secrets/GITHUB_CONNECTOR`,
    {
      method: "PUT",
      headers: json,
      body: JSON.stringify({ connector: "VPpb7x" }),
    },
  );
  expect(res.status).toBe(200);
}

const isBranchCheck = (argv: string[]) =>
  argv[0] === "sh" && argv[2]?.includes(" branch-check ") === true;

function branchCheckAnswers(outcome: { exitCode: number; stderr?: string }) {
  const fallback = wire.exec;
  const checks: string[][] = [];
  wire.exec = (argv, sprite) => {
    if (!isBranchCheck(argv)) return fallback(argv, sprite);
    checks.push(argv);
    return outcome;
  };
  return checks;
}

const followUp = (agentId: string, prompt = "carry on") =>
  app.request(`/v1/agents/${agentId}/runs`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ prompt }),
  });

const promptOf = (runId: string) =>
  new TextDecoder().decode(wire.files.get(`/workspace/runs/${runId}.prompt`));

/** An agent that finished with `rollup`, whose env was then rebuilt and is ready again. */
async function rebuilt(rollup: unknown) {
  const envId = readyEnv();
  await connect(envId);
  const { agent } = await agentWith(envId, rollup);
  expect((await rebuild(envId, { force: true })).status).toBe(202);
  await settled(envId);
  return { envId, agent };
}

test("a follow-up after a rebuild starts a new worktree from the branch the agent published to, and says so", async () => {
  const { agent } = await rebuilt(
    rollupOf(["2", "1"], { head: sha("2"), branch: "feature/login" }),
  );
  const checks = branchCheckAnswers({ exitCode: 0 });
  const res = await followUp(agent.id, "add the missing test");
  expect(res.status).toBe(202);
  const { run } = (await res.json()) as Launched;
  await sessionOpened(2);
  expect(checks).toHaveLength(1);
  expect(checks[0]?.at(-1)).toBe("feature/login");
  const [, session] = wire.sessions;
  // the same path as `sky agent start --branch`: the runner makes the worktree from the branch
  expect(session?.env.START_BRANCH).toBe("feature/login");
  // the sprite's sessions are gone, so none is resumed
  expect(session?.env).not.toHaveProperty("SESSION_ID");
  const prompt = promptOf(run.id);
  expect(prompt).toContain("The environment was rebuilt");
  expect(prompt).toContain("your worktree is new");
  expect(prompt).toContain("`feature/login` branch on GitHub");
  expect(prompt.endsWith("add the missing test")).toBe(true);
  // kept, so a second rebuild finds the branch again; the note is said once
  expect(agentRow(agent.id)).toMatchObject({
    remoteBranch: "feature/login",
    rebuiltAt: null,
  });
});

test("a follow-up after a rebuild of an agent that never published starts from the default branch, and says so", async () => {
  const { agent } = await rebuilt(rollupOf(["1"]));
  const checks = branchCheckAnswers({ exitCode: 0 });
  const res = await followUp(agent.id, "start over");
  expect(res.status).toBe(202);
  const { run } = (await res.json()) as Launched;
  await sessionOpened(2);
  expect(checks).toHaveLength(0);
  const [, session] = wire.sessions;
  expect(session?.env).not.toHaveProperty("START_BRANCH");
  expect(session?.env).not.toHaveProperty("SESSION_ID");
  const prompt = promptOf(run.id);
  expect(prompt).toContain("The environment was rebuilt");
  expect(prompt).toContain("your worktree is new");
  expect(prompt).toContain("from the repository's default branch");
  expect(agentRow(agent.id)).toMatchObject({
    remoteBranch: null,
    rebuiltAt: null,
  });
});

test("a published branch that is gone from GitHub starts from the default branch", async () => {
  const { agent } = await rebuilt(
    rollupOf(["1"], { head: sha("1"), branch: "feature/merged" }),
  );
  branchCheckAnswers({
    exitCode: 3,
    stderr: "branch-check: feature/merged doesn't exist\n",
  });
  expect((await followUp(agent.id)).status).toBe(202);
  await sessionOpened(2);
  expect(wire.sessions[1]?.env).not.toHaveProperty("START_BRANCH");
  expect(agentRow(agent.id)?.remoteBranch).toBeNull();
});

test("an agent started on a branch starts its new worktree from it again", async () => {
  const envId = readyEnv();
  await connect(envId);
  const { agent } = await agentWith(envId, rollupOf(["1"]));
  db.update(agents)
    .set({ remoteBranch: "feature/started" })
    .where(eq(agents.id, agent.id))
    .run();
  expect((await rebuild(envId, { force: true })).status).toBe(202);
  await settled(envId);
  expect((await followUp(agent.id)).status).toBe(202);
  await sessionOpened(2);
  expect(wire.sessions[1]?.env.START_BRANCH).toBe("feature/started");
});

test("a follow-up that can't ask GitHub whether the branch exists is refused to retry, and keeps the rebuild's note for the retry", async () => {
  const { agent } = await rebuilt(
    rollupOf(["1"], { head: sha("1"), branch: "feature/login" }),
  );
  branchCheckAnswers({ exitCode: 1, stderr: "branch-check: GitHub is down\n" });
  const res = await followUp(agent.id);
  expect(res.status).toBe(502);
  expect(await res.json()).toMatchObject({
    error: { code: "branch_check_failed" },
  });
  expect(agentRow(agent.id)?.rebuiltAt).toEqual(expect.any(String));
  expect(db.$client.prepare("select count(*) n from runs").get()).toEqual({
    n: 1,
  });
});

test("a follow-up on an agent that was not rebuilt is as it always was", async () => {
  const envId = readyEnv();
  await connect(envId);
  const { agent, run } = await agentWith(
    envId,
    rollupOf(["1"], { head: sha("1"), branch: "feature/login" }),
  );
  const checks = branchCheckAnswers({ exitCode: 0 });
  const res = await followUp(agent.id, "more");
  expect(res.status).toBe(202);
  await sessionOpened(2);
  expect(checks).toHaveLength(0);
  expect(wire.sessions[1]?.env).toMatchObject({
    SESSION_ID: `session-${agent.id}`,
  });
  expect(wire.sessions[1]?.env).not.toHaveProperty("START_BRANCH");
  const { run: next } = (await res.json()) as Launched;
  expect(promptOf(next.id)).toBe("more");
  expect(run.id).not.toBe(next.id);
});

// ——— a sprite that doesn't answer ———

function opsWithHealth(markAfter?: number) {
  const secrets = KnownSecrets.fromConfig(testConfig());
  const health = createSpriteHealth({
    db,
    secrets,
    log: (l) => logs.push(l),
    markAfter,
  });
  const ops: SpriteOps = {
    client: new SpritesClient(spritesToken),
    log: () => {},
    secrets,
    timeoutMs: 2_000,
    longTimeoutMs: 5_000,
    health,
  };
  return ops;
}

const exec = (ops: SpriteOps, envId: EnvironmentId) =>
  execInSprite(ops, spriteNameFor(envId), ["true"], { op: "probe" }).then(
    () => "ok",
    () => "failed",
  );

test("three failed calls in a row mark the env unreachable with the error and its time, shown on the env; the next answer clears it", async () => {
  const envId = readyEnv();
  const ops = opsWithHealth();
  wire.hangMs = 1;
  wire.hangs = () => true;
  expect(await exec(ops, envId)).toBe("failed");
  expect(await exec(ops, envId)).toBe("failed");
  // two blips are not an outage
  expect(await getEnv(envId)).toMatchObject({ health: null });
  expect(await exec(ops, envId)).toBe("failed");

  const env = await getEnv(envId);
  // `ready` is still the provisioning status
  expect(env).toMatchObject({
    status: "ready",
    health: {
      status: "unreachable",
      error: expect.stringMatching(/\S/),
      at: expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/),
      message: expect.stringContaining(`sky env rebuild ${envId}`),
    },
  });
  expect(logs.some((l) => l.includes("stopped answering"))).toBe(true);

  wire.hangs = () => false;
  expect(await exec(ops, envId)).toBe("ok");
  expect(await getEnv(envId)).toMatchObject({ status: "ready", health: null });
  expect(logs.some((l) => l.includes("answers again"))).toBe(true);
});

test("an answer between failures keeps the count from reaching the mark", async () => {
  const envId = readyEnv();
  const ops = opsWithHealth();
  wire.hangMs = 1;
  for (const hung of [true, true, false, true, true]) {
    wire.hangs = () => hung;
    await exec(ops, envId);
  }
  expect(await getEnv(envId)).toMatchObject({ health: null });
});

test("an error the sprite answered with, a 404 for one that is gone included, is contact rather than silence", async () => {
  const envId = readyEnv();
  const ops = opsWithHealth(1);
  wire.sprites.delete(spriteNameFor(envId));
  expect(await exec(ops, envId)).toBe("failed");
  expect(await getEnv(envId)).toMatchObject({ health: null });
});

test("a mark outlives the process, and the first answer after a restart clears it", async () => {
  const envId = readyEnv({
    health: "unreachable",
    healthError: "503 Storage not ready",
    healthAt: "2026-11-26T10:00:00.000Z",
  });
  expect(await getEnv(envId)).toMatchObject({
    health: {
      status: "unreachable",
      error: "503 Storage not ready",
      at: "2026-11-26T10:00:00.000Z",
    },
  });
  expect(await exec(opsWithHealth(), envId)).toBe("ok");
  expect(await getEnv(envId)).toMatchObject({ health: null });
});

test("a rebuild clears the mark: it is the answer to a sprite that wasn't answering", async () => {
  const envId = readyEnv({
    health: "unreachable",
    healthError: "503 Storage not ready",
    healthAt: "2026-11-26T10:00:00.000Z",
  });
  const res = await rebuild(envId);
  expect(res.status).toBe(202);
  expect(await res.json()).toMatchObject({ health: null });
  await settled(envId);
});

test("health is on the env list too", async () => {
  const envId = readyEnv({
    health: "unreachable",
    healthError: "503",
    healthAt: "2026-11-26T10:00:00.000Z",
  });
  const res = await app.request("/v1/environments", { headers: auth });
  const { data } = (await res.json()) as { data: Record<string, unknown>[] };
  expect(data.find((e) => e.id === envId)?.health).toMatchObject({
    status: "unreachable",
  });
});

test("a retry of a failed env marks its agents too: their sessions are gone and the next run makes a worktree", async () => {
  const envId = readyEnv();
  const { agent } = await agentWith(envId);
  db.update(environments)
    .set({ status: "failed", failureStep: "setup", failureStderr: "broke" })
    .where(eq(environments.id, envId))
    .run();
  const res = await app.request(`/v1/environments/${envId}/retry`, {
    method: "POST",
    headers: auth,
  });
  expect(res.status).toBe(202);
  await settled(envId);
  expect(agentRow(agent.id)).toMatchObject({ sessionId: null });
  expect(agentRow(agent.id)?.rebuiltAt).toEqual(expect.any(String));
});
