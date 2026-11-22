import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpritesClient } from "@fly/sprites";
import { agents, type Db, environments, migrate, openDb, runs } from "@sky/db";
import type { AgentId, EnvironmentId, RunId, RunStatus } from "@sky/shared";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createApp } from "./app.js";
import type { Config } from "./config.js";
import { open, runLaunchAad } from "./crypto.js";
import { spriteNameFor } from "./sprites.js";
import {
  type SpritesWire,
  spritesToken,
  stubSprites,
  testConfig,
} from "./testing/sprites.js";

let dir: string;
let db: Db;
let config: Config;
let logs: string[];
let app: ReturnType<typeof createApp>;
let wire: SpritesWire;

// a restart is a second app over the same database: nothing but the rows carries over
const buildApp = () => {
  config = testConfig({ runnerBundlePath: join(dir, "runner.mjs") });
  app = createApp({
    db,
    config,
    sprites: new SpritesClient(spritesToken),
    log: (line) => logs.push(line),
    nudgeDeliveries: () => {},
    launchWatchMs: 50,
  });
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sky-drain-"));
  writeFileSync(join(dir, "runner.mjs"), "// runner bundle\n");
  db = openDb(":memory:");
  migrate(db);
  wire = stubSprites();
  logs = [];
  buildApp();
});
afterEach(() => {
  vi.useRealTimers();
  if (db.$client.open) db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

const admin = `Bearer ${testConfig().apiKey}`;
const call = (method: string, path: string, body?: unknown, auth = admin) =>
  app.request(path, {
    method,
    headers: {
      Authorization: auth,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

type Drain = {
  draining: boolean;
  since: string | null;
  deadline: string | null;
  active: string[];
  held: number;
  ready: boolean;
};
const drainState = async () =>
  (await call("GET", "/v1/admin/drain")).json() as Promise<Drain>;
const startDrain = async (body: unknown = {}) => {
  const res = await call("POST", "/v1/admin/drain", body);
  expect(res.status).toBe(200);
  return (await res.json()) as Drain;
};

function readyEnv(): EnvironmentId {
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
      claudeCredential: "default",
      concurrency: 10,
    })
    .run();
  wire.sprites.add(spriteNameFor(id));
  return id;
}

/** An agent whose run is already in `status`, as one launched before the drain would be. */
function seedRun(envId: EnvironmentId, status: RunStatus): RunId {
  const suffix = Math.random().toString(36).slice(2);
  const agentId = `agt_${suffix}` as AgentId;
  const runId = `run_${suffix}` as RunId;
  db.insert(agents)
    .values({
      id: agentId,
      envId,
      branch: `claude/${agentId}`,
      status: status === "waiting" ? "waiting" : "running",
    })
    .run();
  db.insert(runs).values({ id: runId, agentId, status }).run();
  return runId;
}

const statusOf = (id: string) =>
  db
    .select({ s: runs.status })
    .from(runs)
    .where(eq(runs.id, id as RunId))
    .get()?.s;

async function launch(envId: EnvironmentId, prompt = "fix the flaky test") {
  const res = await call("POST", "/v1/agents", { envId, prompt });
  expect(res.status).toBe(202);
  return (await res.json()) as {
    agent: { id: string };
    run: { id: string; status: string };
  };
}

// long enough for a launch that wasn't held to have opened its session
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

test("a launch while draining is held as queued, sealed, and started by the API that boots next", async () => {
  const envId = readyEnv();
  await startDrain();
  const first = await launch(envId, "first secret prompt");
  const second = await launch(envId, "second prompt");
  expect(first.run.status).toBe("queued");
  expect(second.run.status).toBe("queued");
  await settle();
  expect(wire.sessions).toHaveLength(0);
  expect(await drainState()).toMatchObject({
    draining: true,
    held: 2,
    active: [],
    ready: true,
  });

  // held durably: sealed on the run's row, the prompt not readable in it
  const row = db
    .select()
    .from(runs)
    .where(eq(runs.id, first.run.id as RunId))
    .get();
  expect(row?.launchCiphertext?.toString("utf8")).not.toContain(
    "first secret prompt",
  );
  const opened = JSON.parse(
    open(
      config.secretEncryptionKey,
      {
        ciphertext: row?.launchCiphertext as Buffer,
        nonce: row?.launchNonce as Buffer,
        keyVersion: row?.launchKeyVersion as number,
      },
      runLaunchAad(first.run.id as RunId),
    ),
  );
  expect(opened.launch.prompt).toBe("first secret prompt");

  buildApp();
  await vi.waitFor(() => expect(wire.sessions).toHaveLength(2));
  expect(statusOf(first.run.id)).toBe("starting");
  expect(statusOf(second.run.id)).toBe("starting");
  expect(wire.sessions.map((s) => s.env.RUN_ID)).toEqual([
    first.run.id,
    second.run.id,
  ]);
  // the new API is not draining
  expect(await drainState()).toMatchObject({ draining: false, held: 0 });
});

test("a follow-up while draining is held too", async () => {
  const envId = readyEnv();
  const started = await launch(envId);
  await vi.waitFor(() => expect(wire.sessions).toHaveLength(1));
  db.update(runs)
    .set({ status: "finished" })
    .where(eq(runs.id, started.run.id as RunId))
    .run();
  db.update(agents)
    .set({ status: "idle" })
    .where(eq(agents.id, started.agent.id as AgentId))
    .run();
  await startDrain();
  const res = await call("POST", `/v1/agents/${started.agent.id}/runs`, {
    prompt: "again",
  });
  expect(res.status).toBe(202);
  expect(((await res.json()) as { run: { status: string } }).run.status).toBe(
    "queued",
  );
  await settle();
  expect(wire.sessions).toHaveLength(1);
});

test("cancelling the drain releases the held launches at once", async () => {
  const envId = readyEnv();
  await startDrain();
  const held = await launch(envId);
  await settle();
  expect(wire.sessions).toHaveLength(0);
  const res = await call("DELETE", "/v1/admin/drain");
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ draining: false, held: 0 });
  await vi.waitFor(() => expect(wire.sessions).toHaveLength(1));
  expect(statusOf(held.run.id)).toBe("starting");
  // not held again
  expect((await launch(envId)).run.status).toBe("starting");
});

test("a drain past its deadline ends and releases what it held", async () => {
  const envId = readyEnv();
  await startDrain({ timeoutSeconds: 60 });
  const held = await launch(envId);
  await settle();
  expect(wire.sessions).toHaveLength(0);

  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 61_000);
  expect(await drainState()).toMatchObject({ draining: false, held: 0 });
  vi.useRealTimers();
  await vi.waitFor(() => expect(wire.sessions).toHaveLength(1));
  expect(statusOf(held.run.id)).toBe("starting");
});

test("a launch after the deadline is not held", async () => {
  const envId = readyEnv();
  await startDrain({ timeoutSeconds: 60 });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 61_000);
  const late = await launch(envId);
  vi.useRealTimers();
  expect(late.run.status).toBe("starting");
});

test("ready ignores runs waiting on a person, and counts only starting and running", async () => {
  const envId = readyEnv();
  const running = seedRun(envId, "running");
  const starting = seedRun(envId, "starting");
  const waiting = seedRun(envId, "waiting");
  const state = await startDrain();
  expect(state.draining).toBe(true);
  expect(state.ready).toBe(false);
  expect([...state.active].sort()).toEqual([running, starting].sort());
  expect(state.active).not.toContain(waiting);

  db.update(runs).set({ status: "finished" }).where(eq(runs.id, running)).run();
  db.update(runs).set({ status: "stopped" }).where(eq(runs.id, starting)).run();
  expect(await drainState()).toMatchObject({ active: [], ready: true });
});

test("a queued launch is not counted as active", async () => {
  const envId = readyEnv();
  await startDrain();
  await launch(envId);
  expect(await drainState()).toMatchObject({
    held: 1,
    active: [],
    ready: true,
  });
});

test("a stopped queued run is not started by the release", async () => {
  const envId = readyEnv();
  await startDrain();
  const held = await launch(envId);
  const stop = await call("POST", `/v1/agents/${held.agent.id}/stop`);
  expect(stop.status).toBe(200);
  await call("DELETE", "/v1/admin/drain");
  await settle();
  expect(wire.sessions).toHaveLength(0);
  expect(statusOf(held.run.id)).toBe("stopped");
});

test("a queued launch is not failed as silent while it waits", async () => {
  const envId = readyEnv();
  await startDrain();
  const held = await launch(envId);
  const { failStaleRuns } = await import("./runs.js");
  expect(failStaleRuns(db, 1_000, Date.now() + 3_600_000)).toEqual([]);
  expect(statusOf(held.run.id)).toBe("queued");
});

test("only the admin key may use the drain", async () => {
  const envId = readyEnv();
  const created = await call("POST", "/v1/keys", {
    name: "ci",
    role: "runs",
    environmentIds: [envId],
  });
  const { secret } = (await created.json()) as { secret: string };
  const issued = `Bearer ${secret}`;
  for (const [method, body] of [
    ["POST", {}],
    ["GET", undefined],
    ["DELETE", undefined],
  ] as const) {
    const res = await call(method, "/v1/admin/drain", body, issued);
    expect(res.status, method).toBe(403);
    const anon = await app.request("/v1/admin/drain", { method });
    expect(anon.status, method).toBe(401);
  }
  expect((await drainState()).draining).toBe(false);
});

test("timeoutSeconds is bounded and defaults to 1800", async () => {
  expect(
    (await call("POST", "/v1/admin/drain", { timeoutSeconds: 7201 })).status,
  ).toBe(400);
  expect(
    (await call("POST", "/v1/admin/drain", { timeoutSeconds: 0 })).status,
  ).toBe(400);
  const state = await startDrain();
  const span =
    Date.parse(state.deadline as string) - Date.parse(state.since as string);
  expect(span).toBe(1_800_000);
});
