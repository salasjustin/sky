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
  runEnvVars,
  runs,
} from "@sky/db";
import type { AgentId, EnvironmentId, RunId, RunStatus } from "@sky/shared";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createApp } from "./app.js";
import type { Config } from "./config.js";
import { open, runLaunchAad } from "./crypto.js";
import { KnownSecrets } from "./redact.js";
import { failUnlaunchedRuns } from "./runs.js";
import { purgeExpiredEnvVars, storeRunEnvVars } from "./secrets.js";
import { spriteNameFor } from "./sprites.js";
import { fiveHourLimit } from "./testing/limits.js";
import {
  envFileOf,
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
const buildApp = (
  over: Partial<Config> = {},
  runnerExitBackoffMs?: number[],
) => {
  config = testConfig({ runnerBundlePath: join(dir, "runner.mjs"), ...over });
  app = createApp({
    db,
    config,
    sprites: new SpritesClient(spritesToken),
    log: (line) => logs.push(line),
    nudgeDeliveries: () => {},
    launchWatchMs: 50,
    runnerExitBackoffMs,
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

function readyEnv(concurrency = 10): EnvironmentId {
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
      concurrency,
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

test("a run failed on a usage limit counts as active while its retry is pending, and the retry is held", async () => {
  // a pause the test steps past by hand: until then the retry waits on the failed runner's exit
  const pauseMs = 10 * 60_000;
  buildApp({ anthropicApiKey: "anthropic-api-key-for-drain" }, [pauseMs]);
  const envId = readyEnv();
  const failed = await launch(envId);
  await vi.waitFor(() => expect(wire.sessions).toHaveLength(1));
  const token = envFileOf(wire, wire.sessions[0]).AGENT_TOKEN;
  // the first exit wait finds the failed runner still running; later ones find it gone
  let exitWaits = 0;
  const exec = wire.exec;
  wire.exec = (argv, sprite) =>
    argv[0] === "bash" &&
    argv[3] === "_" &&
    argv[4]?.includes(failed.run.id) &&
    ++exitWaits === 1
      ? { exitCode: 1 }
      : exec(argv, sprite);
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  await startDrain();
  for (const event of [
    { type: "run.started", payload: { sessionId: "sess-1" } },
    { type: "run.failed", payload: { error: fiveHourLimit().text } },
  ]) {
    const res = await app.request("/internal/events", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ runId: failed.run.id, ...event }),
    });
    expect(res.status).toBe(201);
  }
  await vi.waitFor(() => expect(exitWaits).toBe(1));
  expect(statusOf(failed.run.id)).toBe("failed");
  expect(await drainState()).toMatchObject({
    active: [failed.run.id],
    held: 0,
    ready: false,
  });

  await vi.advanceTimersByTimeAsync(pauseMs);
  const retryOf = () =>
    db
      .select({ id: runs.id, status: runs.status })
      .from(runs)
      .where(eq(runs.retryOf, failed.run.id as RunId))
      .get();
  await vi.waitFor(() => expect(retryOf()?.status).toBe("queued"));
  await vi.waitFor(async () =>
    expect(await drainState()).toMatchObject({
      active: [],
      held: 1,
      ready: true,
    }),
  );
  expect(wire.sessions).toHaveLength(1);
});

test("a held launch's envVars keep the lifetime it asked for, counted from its release", async () => {
  const envId = readyEnv();
  await startDrain();
  const ttlSeconds = 4 * 3_600;
  const res = await call("POST", "/v1/agents", {
    envId,
    prompt: "deploy the fix",
    envVars: { DEPLOY_TOKEN: "held-deploy-token" },
    ttlSeconds,
  });
  expect(res.status).toBe(202);
  const { run } = (await res.json()) as { run: { id: string } };

  // held 20 minutes, inside the drain's 30-minute default
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 20 * 60_000);
  const releasedAt = Date.now();
  expect((await call("DELETE", "/v1/admin/drain")).status).toBe(200);
  vi.useRealTimers();

  expect(statusOf(run.id)).toBe("starting");
  const rows = db
    .select({ expiresAt: runEnvVars.expiresAt })
    .from(runEnvVars)
    .where(eq(runEnvVars.runId, run.id as RunId))
    .all();
  expect(rows).toHaveLength(1);
  const expiresAt = Date.parse(rows[0]?.expiresAt as string);
  expect(Math.abs(expiresAt - (releasedAt + ttlSeconds * 1000))).toBeLessThan(
    5_000,
  );
  await vi.waitFor(() => expect(wire.sessions).toHaveLength(1));
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

test("a released launch's clock restarts: createdAt moves to the release and the launch-deadline sweep spares it", async () => {
  const envId = readyEnv();
  await startDrain();
  const held = await launch(envId);
  // held longer than the launch deadline, as a long drain would
  const stale = new Date(
    Date.now() - 2 * config.launchDeadlineMs,
  ).toISOString();
  db.update(runs)
    .set({ createdAt: stale })
    .where(eq(runs.id, held.run.id as RunId))
    .run();

  expect((await call("DELETE", "/v1/admin/drain")).status).toBe(200);

  const row = db
    .select({ createdAt: runs.createdAt })
    .from(runs)
    .where(eq(runs.id, held.run.id as RunId))
    .get();
  expect(
    Math.abs(Date.parse(row?.createdAt as string) - Date.now()),
  ).toBeLessThan(5_000);
  expect(statusOf(held.run.id)).toBe("starting");
  expect(failUnlaunchedRuns(db, config.launchDeadlineMs)).toEqual([]);
  await vi.waitFor(() => expect(wire.sessions).toHaveLength(1));
});

test("a launch held at an environment's concurrency cap counts against it", async () => {
  const envId = readyEnv(1);
  await startDrain();
  const held = await launch(envId);
  const over = await call("POST", "/v1/agents", { envId, prompt: "one more" });
  expect(over.status).toBe(409);
  expect(await over.json()).toMatchObject({
    error: { code: "concurrency_cap", limit: 1 },
  });
  expect(await drainState()).toMatchObject({ held: 1 });

  // the slot frees once the held run ends
  expect((await call("POST", `/v1/agents/${held.agent.id}/stop`)).status).toBe(
    200,
  );
  expect((await launch(envId)).run.status).toBe("queued");
});

test("a follow-up to an agent whose run is queued is refused as busy", async () => {
  const envId = readyEnv();
  await startDrain();
  const held = await launch(envId);
  const again = await call("POST", `/v1/agents/${held.agent.id}/runs`, {
    prompt: "again",
  });
  expect(again.status).toBe(409);
  expect(await again.json()).toMatchObject({ error: { code: "agent_busy" } });
  expect(await drainState()).toMatchObject({ held: 1 });
});

test("an expired envVar of a queued run survives the purge, while an expired one of a running run does not", async () => {
  const envId = readyEnv();
  await startDrain();
  const res = await call("POST", "/v1/agents", {
    envId,
    prompt: "deploy the fix",
    envVars: { DEPLOY_TOKEN: "held-deploy-token" },
  });
  expect(res.status).toBe(202);
  const { run: held } = (await res.json()) as { run: { id: RunId } };
  const running = seedRun(envId, "running");
  db.transaction((tx) =>
    storeRunEnvVars(tx, config.secretEncryptionKey, running, { OLD: "x" }, 60),
  );
  const lapsed = new Date(Date.now() - 60_000).toISOString();
  db.update(runEnvVars).set({ expiresAt: lapsed }).run();

  purgeExpiredEnvVars(db, KnownSecrets.fromConfig(config), new Date());

  const namesOf = (runId: RunId) =>
    db
      .select({ name: runEnvVars.name })
      .from(runEnvVars)
      .where(eq(runEnvVars.runId, runId))
      .all()
      .map((r) => r.name);
  expect(namesOf(held.id)).toEqual(["DEPLOY_TOKEN"]);
  expect(namesOf(running)).toEqual([]);
});

test("a held launch that can't be read after a restart fails with launch_failed instead of sitting queued", async () => {
  const envId = readyEnv();
  await startDrain();
  const held = await launch(envId);
  db.update(runs)
    .set({ launchCiphertext: Buffer.from("not a sealed launch") })
    .where(eq(runs.id, held.run.id as RunId))
    .run();

  buildApp();

  expect(statusOf(held.run.id)).toBe("failed");
  const failed = db
    .select({ payload: events.payload })
    .from(events)
    .where(
      and(
        eq(events.runId, held.run.id as RunId),
        eq(events.type, "run.failed"),
      ),
    )
    .all()
    .map((e) => (e.payload as { error: string }).error);
  expect(failed).toEqual([expect.stringContaining("launch_failed")]);
  await settle();
  expect(wire.sessions).toHaveLength(0);
});

test("the deadline timer alone releases the held launches, with no request to notice it", async () => {
  const envId = readyEnv();
  vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
  await startDrain({ timeoutSeconds: 60 });
  const held = await launch(envId);
  expect(statusOf(held.run.id)).toBe("queued");

  await vi.advanceTimersByTimeAsync(60_000);

  // read from the row: a GET would release it through the lazy deadline check instead
  expect(statusOf(held.run.id)).toBe("starting");
  await vi.waitFor(() => expect(wire.sessions).toHaveLength(1));
});

test("a deadline timer that fires early is set again for the rest, so the release doesn't wait for a request", async () => {
  const envId = readyEnv();
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const realNow = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(realNow);
  await startDrain({ timeoutSeconds: 60 });
  const held = await launch(envId);
  expect(statusOf(held.run.id)).toBe("queued");

  // the timer fires with the clock still 5 ms short of the deadline
  clock.mockReturnValue(realNow + 59_995);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(statusOf(held.run.id)).toBe("queued");

  // the timer set again for those 5 ms fires, and this time the deadline has passed
  clock.mockReturnValue(realNow + 60_001);
  await vi.advanceTimersByTimeAsync(10);

  // read from the row: a GET would release it through the lazy deadline check instead
  expect(statusOf(held.run.id)).toBe("starting");
  clock.mockRestore();
});

test("held launches are released oldest first by createdAt, not by insertion order", async () => {
  const envId = readyEnv();
  await startDrain();
  const inserted = await launch(envId, "inserted first");
  const older = await launch(envId, "inserted second");
  db.update(runs)
    .set({ createdAt: new Date(Date.now() - 60_000).toISOString() })
    .where(eq(runs.id, older.run.id as RunId))
    .run();

  expect((await call("DELETE", "/v1/admin/drain")).status).toBe(200);

  await vi.waitFor(() => expect(wire.sessions).toHaveLength(2));
  expect(wire.sessions.map((s) => s.env.RUN_ID)).toEqual([
    older.run.id,
    inserted.run.id,
  ]);
});

const ms = (iso: string | null) => Date.parse(iso as string);

test("timeoutSeconds accepts 1 and 7200 and rejects a non-integer", async () => {
  expect(
    (await call("POST", "/v1/admin/drain", { timeoutSeconds: 1.5 })).status,
  ).toBe(400);
  for (const seconds of [1, 7200]) {
    const state = await startDrain({ timeoutSeconds: seconds });
    expect(ms(state.deadline) - ms(state.since)).toBe(seconds * 1000);
    expect((await call("DELETE", "/v1/admin/drain")).status).toBe(200);
  }
});

test("starting a drain that is already on keeps its start and moves its deadline", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const first = await startDrain({ timeoutSeconds: 60 });
  vi.setSystemTime(Date.now() + 10_000);
  const second = await startDrain({ timeoutSeconds: 120 });

  expect(second.since).toBe(first.since);
  expect(ms(second.deadline) - ms(first.deadline)).toBe(70_000);
  expect(ms(second.deadline) - ms(second.since)).toBe(130_000);
});
