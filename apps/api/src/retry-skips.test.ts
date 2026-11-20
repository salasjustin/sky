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
  runs,
} from "@sky/db";
import type { EnvironmentId, RunId } from "@sky/shared";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createApp } from "./app.js";
import type { Config } from "./config.js";
import { spriteNameFor } from "./sprites.js";
import { fiveHourLimit } from "./testing/limits.js";
import {
  envFileOf,
  type SpritesWire,
  spritesToken,
  stubSprites,
  testConfig,
} from "./testing/sprites.js";

// opaque on purpose, as in the credential tests: only registered values can scrub them
const PERSONAL_TOKEN = "personal-subscription-opaque-2";
const WORK_TOKEN = "work-subscription-opaque-3";
const API_KEY = "anthropic-api-key-opaque-4";

const FIVE_HOUR = fiveHourLimit().text;
const CHALLENGE =
  "Claude Code returned an error result: Failed to authenticate. API Error: 403 Attention Required! | Cloudflare";
const UNRELATED = "Failed to authenticate. API Error: 401 invalid x-api-key";
const CHALLENGE_DELAY_MS = 60_000;

let dir: string;
let db: Db;
let config: Config;
let logs: string[];
let app: ReturnType<typeof createApp>;
let wire: SpritesWire;

const buildApp = (
  over: Partial<Config> = {},
  runnerExitBackoffMs: number[] = [1],
) => {
  config = testConfig({
    runnerBundlePath: join(dir, "runner.mjs"),
    claudeOauthTokens: { personal: PERSONAL_TOKEN, work: WORK_TOKEN },
    anthropicApiKey: API_KEY,
    ...over,
  });
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
  dir = mkdtempSync(join(tmpdir(), "sky-retry-skips-"));
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
const call = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: {
      Authorization: admin,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

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
      claudeCredential: "personal",
      ...overrides,
    })
    .run();
  wire.sprites.add(spriteNameFor(id));
  return id;
}

async function launchedRun(envId: EnvironmentId) {
  const before = wire.sessions.length;
  const res = await call("POST", "/v1/agents", {
    envId,
    prompt: "fix the flaky test",
  });
  expect(res.status).toBe(202);
  const ids = (await res.json()) as {
    agent: { id: string };
    run: { id: string };
  };
  await vi.waitFor(() => expect(wire.sessions).toHaveLength(before + 1));
  const session = wire.sessions[before];
  return { ...ids, file: envFileOf(wire, session) };
}
type Launched = Awaited<ReturnType<typeof launchedRun>>;

const postEvent = (token: string | undefined, event: unknown) =>
  app.request("/internal/events", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(event),
  });

/** A started run reports `error` as its failure. */
async function failWith(r: Launched, error: string) {
  await postEvent(r.file.AGENT_TOKEN, {
    runId: r.run.id,
    type: "run.started",
    payload: { sessionId: "sess-1" },
  });
  const res = await postEvent(r.file.AGENT_TOKEN, {
    runId: r.run.id,
    type: "run.failed",
    payload: { error },
  });
  expect(res.status).toBe(201);
}

const runRow = (id: string) =>
  db
    .select()
    .from(runs)
    .where(eq(runs.id, id as RunId))
    .get();

const retryOf = (failedId: string) =>
  db
    .select()
    .from(runs)
    .where(eq(runs.retryOf, failedId as RunId))
    .get();

/** The `runner.warning` messages recorded on a run. */
const warningsOf = (runId: string) =>
  db
    .select({ payload: events.payload })
    .from(events)
    .where(
      and(eq(events.runId, runId as RunId), eq(events.type, "runner.warning")),
    )
    .all()
    .map((row) => (row.payload as { message: string }).message);

const exitWaits = () =>
  logs.filter((line) => line.includes("await-exit: start")).length;

/** Runs `change` each time the retry of `failedId` asks whether that run's runner exited. */
function onExitWait(failedId: string, change: () => ExitAnswer | undefined) {
  const exec = wire.exec;
  wire.exec = (argv, sprite) => {
    if (argv[0] === "bash" && argv[3] === "_" && argv[4]?.includes(failedId)) {
      return change() ?? exec(argv, sprite);
    }
    return exec(argv, sprite);
  };
}
type ExitAnswer = ReturnType<SpritesWire["exec"]>;

/** Restarts the API on the same database: nothing is held in memory. */
const restartApi = () => buildApp();

// --- a limit failure that is not retried says why ---------------------------------------------------

test("a limit failure whose launch is held nowhere is not retried and says so", async () => {
  const r = await launchedRun(readyEnv());
  db.update(runs)
    .set({ launch: null })
    .where(eq(runs.id, r.run.id as RunId))
    .run();
  restartApi();
  await failWith(r, FIVE_HOUR);
  await vi.waitFor(() => expect(warningsOf(r.run.id)).toHaveLength(1));
  expect(warningsOf(r.run.id)[0]).toMatch(
    /^not retried: no record of this run's launch/,
  );
  expect(wire.sessions).toHaveLength(1);
});

test("a limit failure of a run launched past the remembered window is not retried and says so", async () => {
  const r = await launchedRun(readyEnv());
  const row = runRow(r.run.id);
  const stored = JSON.parse(String(row?.launch)) as {
    launch: unknown;
    at: number;
  };
  db.update(runs)
    .set({
      launch: JSON.stringify({ ...stored, at: Date.now() - 13 * 3_600_000 }),
    })
    .where(eq(runs.id, r.run.id as RunId))
    .run();
  restartApi();
  await failWith(r, FIVE_HOUR);
  await vi.waitFor(() => expect(warningsOf(r.run.id)).toHaveLength(1));
  expect(warningsOf(r.run.id)[0]).toBe(
    "not retried: this run launched more than 12 hours ago",
  );
  expect(wire.sessions).toHaveLength(1);
});

test("a limit failure after an API restart is retried once on the next credential", async () => {
  const r = await launchedRun(readyEnv());
  expect(runRow(r.run.id)?.launch).toEqual(expect.any(String));
  // no secret is stored with the launch
  for (const secret of [
    PERSONAL_TOKEN,
    WORK_TOKEN,
    API_KEY,
    testConfig().apiKey,
  ]) {
    expect(runRow(r.run.id)?.launch).not.toContain(secret);
  }
  restartApi();
  await failWith(r, FIVE_HOUR);
  await vi.waitFor(() => expect(wire.sessions).toHaveLength(2));
  expect(envFileOf(wire, wire.sessions[1])).toMatchObject({
    SKY_CLAUDE_AUTH: "api-key",
  });
  expect(retryOf(r.run.id)).toMatchObject({
    claudeCredential: "api-key",
    agentId: r.agent.id,
  });
  expect(warningsOf(r.run.id)).toEqual([]);
  // once: the stored launch is spent
  expect(runRow(r.run.id)?.launch).toBeNull();
  expect(wire.sessions).toHaveLength(2);
});

test("a limit failure whose environment is no longer ready is not retried and says so", async () => {
  const env = readyEnv();
  const r = await launchedRun(env);
  db.update(environments)
    .set({ status: "failed", failureStep: "create" })
    .where(eq(environments.id, env))
    .run();
  await failWith(r, FIVE_HOUR);
  await vi.waitFor(() => expect(warningsOf(r.run.id)).toHaveLength(1));
  expect(warningsOf(r.run.id)[0]).toBe(
    "not retried: its environment is not ready",
  );
  expect(exitWaits()).toBe(0);
});

test("a limit failure with the API-key fallback off is not retried and says so", async () => {
  const r = await launchedRun(readyEnv({ claudeFallback: "none" }));
  await failWith(r, FIVE_HOUR);
  await vi.waitFor(() => expect(warningsOf(r.run.id)).toHaveLength(1));
  expect(warningsOf(r.run.id)[0]).toContain(
    "not retried: its environment has no other credential to use",
  );
  expect(wire.sessions).toHaveLength(1);
});

test("a runner that exits on the second wait gets its retry", async () => {
  const r = await launchedRun(readyEnv());
  let waits = 0;
  onExitWait(r.run.id, () => (++waits === 1 ? { exitCode: 1 } : undefined));
  await failWith(r, FIVE_HOUR);
  await vi.waitFor(() => expect(wire.sessions).toHaveLength(2));
  expect(waits).toBe(2);
  expect(warningsOf(r.run.id)).toEqual([]);
});

test("a runner that never exits is not retried and the run says it was still exiting", async () => {
  buildApp({}, [1, 1]);
  const r = await launchedRun(readyEnv());
  let waits = 0;
  onExitWait(r.run.id, () => {
    waits++;
    return { exitCode: 1 };
  });
  await failWith(r, FIVE_HOUR);
  await vi.waitFor(() => expect(warningsOf(r.run.id)).toHaveLength(1));
  // the first wait plus one per pause
  expect(waits).toBe(3);
  expect(warningsOf(r.run.id)[0]).toBe(
    "not retried: the runner was still exiting",
  );
  expect(wire.sessions).toHaveLength(1);
});

test("a follow-up that replaced the failed run before its retry says so", async () => {
  const r = await launchedRun(readyEnv());
  onExitWait(r.run.id, () => {
    db.insert(runs)
      .values({
        id: "run_newer" as RunId,
        agentId: r.agent.id as never,
        status: "finished",
      })
      .run();
    return undefined;
  });
  await failWith(r, FIVE_HOUR);
  await vi.waitFor(() => expect(warningsOf(r.run.id)).toHaveLength(1));
  expect(warningsOf(r.run.id)[0]).toBe(
    "not retried: its agent has a newer run",
  );
  expect(retryOf(r.run.id)).toBeUndefined();
});

test("an agent archived before its retry says so", async () => {
  const r = await launchedRun(readyEnv());
  onExitWait(r.run.id, () => {
    db.update(agents)
      .set({ archivedAt: new Date().toISOString() })
      .where(eq(agents.id, r.agent.id as never))
      .run();
    return undefined;
  });
  await failWith(r, FIVE_HOUR);
  await vi.waitFor(() => expect(warningsOf(r.run.id)).toHaveLength(1));
  expect(warningsOf(r.run.id)[0]).toBe(
    "not retried: its agent was archived or already has a run in progress",
  );
  expect(retryOf(r.run.id)).toBeUndefined();
});

// --- a challenge failure that is not retried says why -------------------------------------------------

const fakeDelay = () => vi.useFakeTimers({ toFake: ["setTimeout"] });

test("stopping the agent while a challenge retry waits leaves a warning on the failed run", async () => {
  const r = await launchedRun(readyEnv());
  fakeDelay();
  await failWith(r, CHALLENGE);
  const stop = await call("POST", `/v1/agents/${r.agent.id}/stop`);
  expect(stop.status).toBe(200);
  await vi.advanceTimersByTimeAsync(10 * CHALLENGE_DELAY_MS);
  expect(warningsOf(r.run.id)).toEqual(["not retried: its agent was stopped"]);
  expect(wire.sessions).toHaveLength(1);
});

test("an environment reassigned while a challenge retry waits leaves a warning on the failed run", async () => {
  const env = readyEnv();
  const r = await launchedRun(env);
  fakeDelay();
  await failWith(r, CHALLENGE);
  db.update(environments)
    .set({ claudeCredential: "work" })
    .where(eq(environments.id, env))
    .run();
  await vi.advanceTimersByTimeAsync(10 * CHALLENGE_DELAY_MS);
  await vi.waitFor(() => expect(warningsOf(r.run.id)).toHaveLength(1));
  expect(warningsOf(r.run.id)[0]).toContain(
    "no longer assigns Claude credential personal",
  );
  expect(wire.sessions).toHaveLength(1);
});

// --- failures that were never retry candidates ---------------------------------------------------------

test.each([
  ["an unrelated error", UNRELATED],
  ["a limit-shaped error with no subscription behind it", FIVE_HOUR],
])("%s records no retry warning", async (name, error) => {
  const env = readyEnv(
    name === "an unrelated error" ? {} : { claudeCredential: null },
  );
  const r = await launchedRun(env);
  if (name !== "an unrelated error") {
    // run on the API key, as after a limit retry
    db.update(runs)
      .set({ claudeCredential: "api-key" })
      .where(eq(runs.id, r.run.id as RunId))
      .run();
  }
  await failWith(r, error);
  await vi.waitFor(() => expect(runRow(r.run.id)?.status).toBe("failed"));
  expect(warningsOf(r.run.id)).toEqual([]);
  expect(wire.sessions).toHaveLength(1);
});
