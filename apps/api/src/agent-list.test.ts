import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpritesClient } from "@fly/sprites";
import {
  agents,
  type Db,
  environments,
  events,
  migrate,
  openDb,
  runRequests,
  runs,
} from "@sky/db";
import {
  type AgentId,
  type ApiKeyId,
  CreatedApiKey,
  type EnvironmentId,
  type EventType,
  type RunId,
  type RunStatus,
} from "@sky/shared";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { AgentPage } from "./agent-list.js";
import { createApp } from "./app.js";
import { mintId } from "./ids.js";
import { spriteNameFor } from "./sprites.js";
import { spritesToken, stubSprites, testConfig } from "./testing/sprites.js";

const config = testConfig();
const admin = config.apiKey;
let dir: string;
let db: Db;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sky-agent-list-"));
  writeFileSync(join(dir, "runner.mjs"), "// runner bundle v1\n");
  db = openDb(":memory:");
  migrate(db);
  stubSprites();
  app = createApp({
    db,
    config: { ...config, runnerBundlePath: join(dir, "runner.mjs") },
    sprites: new SpritesClient(spritesToken),
    log: () => {},
    nudgeDeliveries: () => {},
  });
});
afterEach(() => {
  if (db.$client.open) db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

// every time is fixed, so no test depends on the date or the clock
const at = (minutes: number) =>
  new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString();

const get = (query = "", token = admin) =>
  Promise.resolve(
    app.request(`/v1/agents${query}`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  );

async function page(query = "", token = admin) {
  const res = await get(query, token);
  expect(res.status).toBe(200);
  return (await res.json()) as AgentPage;
}

const ids = (p: AgentPage) => p.data.map((a) => a.id);

function readyEnv(name: string): EnvironmentId {
  const id = mintId("env");
  db.insert(environments)
    .values({
      id,
      name,
      repo: "acme/kru",
      setup: "",
      status: "ready",
      spriteName: spriteNameFor(id),
      checkpointId: "v1",
    })
    .run();
  return id;
}

type Seed = {
  createdAt?: number;
  archivedAt?: string;
  ownerKeyId?: ApiKeyId;
  remoteBranch?: string;
  runs?: {
    status: RunStatus;
    createdAt: number;
    events?: { type: EventType; at: number }[];
    /** An open request of this kind, or a decided one. */
    request?: { kind: "approval" | "question"; decided?: boolean };
  }[];
};

type SeedRun = NonNullable<Seed["runs"]>[number];

/** An agent with the runs given oldest first; returns its id and its runs' ids in that order. */
function seed(envId: EnvironmentId, s: Seed = {}) {
  const id = mintId("agt");
  db.insert(agents)
    .values({
      id,
      envId,
      branch: `claude/${id}`,
      status: "idle",
      createdAt: at(s.createdAt ?? 0),
      archivedAt: s.archivedAt ?? null,
      remoteBranch: s.remoteBranch ?? null,
      ownerKeyId: s.ownerKeyId ?? null,
    })
    .run();
  const runIds: RunId[] = [];
  for (const r of s.runs ?? []) {
    const runId = mintId("run");
    runIds.push(runId);
    db.insert(runs)
      .values({
        id: runId,
        agentId: id,
        status: r.status,
        createdAt: at(r.createdAt),
      })
      .run();
    for (const e of r.events ?? []) {
      db.insert(events)
        .values({ runId, ts: at(e.at), type: e.type, payload: {} })
        .run();
    }
    if (r.request) {
      const requestId = mintId("req");
      const request =
        r.request.kind === "approval"
          ? {
              kind: "approval" as const,
              requestId,
              toolName: "Bash",
              toolSummary: "rm -rf build",
            }
          : { kind: "question" as const, requestId, prompt: "which branch?" };
      db.insert(runRequests)
        .values({
          id: requestId,
          runId,
          kind: r.request.kind,
          request,
          ...(r.request.decided
            ? {
                decision: { requestId, decision: "deny" as const },
                decidedAt: at(r.createdAt + 1),
              }
            : {}),
        })
        .run();
    }
  }
  return { id: id as AgentId, runIds };
}

const stateOf = (p: AgentPage) =>
  Object.fromEntries(p.data.map((a) => [a.id, a.run?.state ?? null]));

test("each agent lists with its env, branch and latest run, newest activity first", async () => {
  const env = readyEnv("trail");
  const quiet = seed(env, {
    createdAt: 1,
    runs: [
      {
        status: "finished",
        createdAt: 2,
        events: [
          { type: "run.started", at: 3 },
          { type: "run.finished", at: 9 },
        ],
      },
    ],
  });
  const busy = seed(env, {
    createdAt: 1,
    remoteBranch: "feature/login",
    runs: [
      {
        status: "failed",
        createdAt: 2,
        events: [{ type: "run.failed", at: 4 }],
      },
      {
        status: "running",
        createdAt: 10,
        events: [
          { type: "run.started", at: 11 },
          { type: "claude.PreToolUse", at: 30 },
        ],
      },
    ],
  });
  const fresh = seed(env, { createdAt: 40 });

  const p = await page();
  expect(ids(p)).toEqual([fresh.id, busy.id, quiet.id]);
  expect(p.nextCursor).toBeUndefined();
  expect(p.data[0]).toEqual({
    id: fresh.id,
    envId: env,
    envName: "trail",
    branch: `claude/${fresh.id}`,
    remoteBranch: null,
    createdAt: at(40),
    archivedAt: null,
    run: null,
  });
  expect(p.data[1]).toMatchObject({
    branch: `claude/${busy.id}`,
    remoteBranch: "feature/login",
  });
  // the latest run is the newest, not an older one that ended
  expect(p.data[1]?.run).toEqual({
    id: busy.runIds[1],
    status: "running",
    state: "running",
    createdAt: at(10),
    lastEventAt: at(30),
    endedAt: null,
    openRequests: 0,
  });
  expect(p.data[2]?.run).toEqual({
    id: quiet.runIds[0],
    status: "finished",
    state: "finished",
    createdAt: at(2),
    lastEventAt: at(9),
    endedAt: at(9),
    openRequests: 0,
  });
});

test("a run with no event yet reports its creation as its last event", async () => {
  const env = readyEnv("trail");
  const a = seed(env, { runs: [{ status: "starting", createdAt: 5 }] });
  const [row] = (await page()).data;
  expect(row?.run).toMatchObject({
    id: a.runIds[0],
    state: "starting",
    lastEventAt: at(5),
    endedAt: null,
  });
});

test("state is the run status, a waiting run split by the kind of its open request", async () => {
  const env = readyEnv("trail");
  const one = (status: RunStatus, request?: SeedRun["request"]) =>
    seed(env, { runs: [{ status, createdAt: 1, request }] }).id;
  const expected = {
    [one("starting")]: "starting",
    [one("running")]: "running",
    [one("waiting", { kind: "approval" })]: "waiting_approval",
    [one("waiting", { kind: "question" })]: "waiting_answer",
    // its request decided and the runner not yet back: nothing is being waited on
    [one("waiting", { kind: "question", decided: true })]: "running",
    [one("finished")]: "finished",
    [one("failed")]: "failed",
    [one("stopped")]: "stopped",
  };
  expect(stateOf(await page())).toEqual(expected);
});

test("openRequests counts only requests still unresolved", async () => {
  const env = readyEnv("trail");
  const open = seed(env, {
    runs: [{ status: "waiting", createdAt: 1, request: { kind: "approval" } }],
  });
  const resolved = seed(env, {
    runs: [
      {
        status: "running",
        createdAt: 1,
        request: { kind: "question", decided: true },
      },
    ],
  });
  const none = seed(env, { runs: [{ status: "running", createdAt: 1 }] });
  const counts = Object.fromEntries(
    (await page()).data.map((a) => [a.id, a.run?.openRequests]),
  );
  expect(counts).toEqual({ [open.id]: 1, [resolved.id]: 0, [none.id]: 0 });
});

test("a run stopped while it waits lists as stopped with no open requests", async () => {
  const env = readyEnv("trail");
  const a = seed(env, {
    runs: [{ status: "waiting", createdAt: 1, request: { kind: "question" } }],
  });
  const res = await app.request(`/v1/agents/${a.id}/stop`, {
    method: "POST",
    headers: { Authorization: `Bearer ${admin}` },
  });
  expect(res.status).toBe(200);
  const [row] = (await page()).data;
  expect(row?.run).toMatchObject({
    id: a.runIds[0],
    state: "stopped",
    openRequests: 0,
  });
});

test("an agent with no runs lists with a null run, and no state filter matches it", async () => {
  const env = readyEnv("trail");
  const bare = seed(env);
  expect((await page()).data).toMatchObject([{ id: bare.id, run: null }]);
  expect(ids(await page("?status=running,finished,failed"))).toEqual([]);
});

test("env filters by id or name, repeated or comma-separated", async () => {
  const trail = readyEnv("trail");
  const sky = readyEnv("sky");
  const other = readyEnv("other");
  const a = seed(trail, { createdAt: 1 });
  const b = seed(sky, { createdAt: 2 });
  const c = seed(other, { createdAt: 3 });

  expect(ids(await page(`?env=${trail}`))).toEqual([a.id]);
  expect(ids(await page("?env=sky"))).toEqual([b.id]);
  expect(ids(await page(`?env=trail,${sky}`))).toEqual([b.id, a.id]);
  expect(ids(await page("?env=trail&env=other"))).toEqual([c.id, a.id]);
  expect(ids(await page("?env=nope"))).toEqual([]);
});

test("status filters by state, repeated or comma-separated, and a bad state is a 400", async () => {
  const env = readyEnv("trail");
  const running = seed(env, {
    createdAt: 1,
    runs: [{ status: "running", createdAt: 1 }],
  });
  const approval = seed(env, {
    createdAt: 2,
    runs: [{ status: "waiting", createdAt: 2, request: { kind: "approval" } }],
  });
  const question = seed(env, {
    createdAt: 3,
    runs: [{ status: "waiting", createdAt: 3, request: { kind: "question" } }],
  });
  seed(env, { createdAt: 4, runs: [{ status: "finished", createdAt: 4 }] });

  expect(ids(await page("?status=waiting_answer"))).toEqual([question.id]);
  expect(ids(await page("?status=waiting_approval,running"))).toEqual([
    approval.id,
    running.id,
  ]);
  expect(
    ids(await page("?status=waiting_answer&status=waiting_approval")),
  ).toEqual([question.id, approval.id]);
  const bad = await get("?status=waiting");
  expect(bad.status).toBe(400);
  expect(await bad.json()).toMatchObject({ error: { code: "invalid_query" } });
});

test("archived lists live agents by default, only archived with true, every one with all", async () => {
  const env = readyEnv("trail");
  const live = seed(env, { createdAt: 1 });
  const gone = seed(env, { createdAt: 2, archivedAt: at(50) });

  expect(ids(await page())).toEqual([live.id]);
  expect(ids(await page("?archived=false"))).toEqual([live.id]);
  expect(ids(await page("?archived=true"))).toEqual([gone.id]);
  expect(ids(await page("?archived=all"))).toEqual([gone.id, live.id]);
  expect((await page("?archived=all")).data[0]?.archivedAt).toBe(at(50));
  expect((await get("?archived=maybe")).status).toBe(400);
});

test("a cursor pages through every agent exactly once, ties on activity included", async () => {
  const env = readyEnv("trail");
  const seeded: AgentId[] = [];
  for (let i = 0; i < 9; i++) {
    // three agents share each activity time
    seeded.push(seed(env, { createdAt: Math.floor(i / 3) }).id);
  }
  const seen: AgentId[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const p = await page(`?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
    expect(p.data.length).toBeLessThanOrEqual(2);
    seen.push(...ids(p));
    cursor = p.nextCursor;
    pages++;
  } while (cursor);
  expect(pages).toBe(5);
  expect(seen).toHaveLength(9);
  expect(new Set(seen)).toEqual(new Set(seeded));
  // the same order as one page
  expect(seen).toEqual(ids(await page()));
});

test("a page that ends exactly at the last agent has no cursor", async () => {
  const env = readyEnv("trail");
  seed(env, { createdAt: 1 });
  seed(env, { createdAt: 2 });
  const p = await page("?limit=2");
  expect(p.data).toHaveLength(2);
  expect(p.nextCursor).toBeUndefined();
});

test("a cursor keeps the filters' result stable when agents are added after it", async () => {
  const env = readyEnv("trail");
  const a = seed(env, { createdAt: 1 });
  const b = seed(env, { createdAt: 2 });
  const first = await page("?limit=1");
  expect(ids(first)).toEqual([b.id]);
  seed(env, { createdAt: 3 });
  const second = await page(`?limit=1&cursor=${first.nextCursor}`);
  expect(ids(second)).toEqual([a.id]);
});

test("limit defaults to 50, caps at 200, and a bad limit or cursor is a 400", async () => {
  const env = readyEnv("trail");
  for (let i = 0; i < 51; i++) seed(env, { createdAt: i });
  const first = await page();
  expect(first.data).toHaveLength(50);
  expect(first.nextCursor).toBeDefined();
  expect((await page("?limit=200")).data).toHaveLength(51);
  for (const bad of ["0", "201", "-1", "ten"]) {
    const res = await get(`?limit=${bad}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: "invalid_query" },
    });
  }
  const res = await get("?cursor=not-a-cursor");
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: { code: "invalid_cursor" } });
});

async function mintKey(environmentIds: EnvironmentId[]) {
  const res = await app.request("/v1/keys", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${admin}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: "pm", role: "runs", environmentIds }),
  });
  expect(res.status).toBe(201);
  return CreatedApiKey.parse(await res.json());
}

test("a runs key lists only its own agents; the admin key lists every agent", async () => {
  const trail = readyEnv("trail");
  const sky = readyEnv("sky");
  const mine = await mintKey([trail]);
  const theirs = await mintKey([trail, sky]);
  const a = seed(trail, { createdAt: 1, ownerKeyId: mine.id });
  const b = seed(trail, { createdAt: 2, ownerKeyId: theirs.id });
  const c = seed(sky, { createdAt: 3, ownerKeyId: theirs.id });
  const d = seed(trail, { createdAt: 4 });

  expect(ids(await page("", mine.secret))).toEqual([a.id]);
  expect(ids(await page("", theirs.secret))).toEqual([c.id, b.id]);
  expect(ids(await page("", admin))).toEqual([d.id, c.id, b.id, a.id]);
  // an env the key may not use matches nothing, whether named by id or name
  expect(ids(await page(`?env=${trail},sky`, mine.secret))).toEqual([a.id]);
  expect(ids(await page("?env=sky", mine.secret))).toEqual([]);
  expect(ids(await page(`?env=${sky}`, mine.secret))).toEqual([]);
  // paging is limited the same way
  const first = await page("?limit=1", theirs.secret);
  expect(ids(first)).toEqual([c.id]);
  expect(
    ids(await page(`?limit=1&cursor=${first.nextCursor}`, theirs.secret)),
  ).toEqual([b.id]);
});

test("the list needs a valid key", async () => {
  const res = await get("", "nope");
  expect(res.status).toBe(401);
});
