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
import { open, runLaunchAad, seal } from "./crypto.js";
import { failUnlaunchedRuns } from "./runs.js";
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
// long enough that the clock's small steps in `vi.waitFor` never reach it
const PAUSE_MS = 10 * 60_000;
const NO_RECORD =
  "not retried: no record of this run's launch is held (the API restarted since this run launched and it was not recorded, it launched more than 12 hours ago, or it was already retried)";
const STOPPED = "not retried: its agent was stopped";

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

/** The error the API stored on a failed run. */
const failureOf = (runId: string) => {
  const row = db
    .select({ payload: events.payload })
    .from(events)
    .where(and(eq(events.runId, runId as RunId), eq(events.type, "run.failed")))
    .get();
  return String((row?.payload as { error?: string } | undefined)?.error);
};

const retriesOf = (failedId: string) =>
  db
    .select()
    .from(runs)
    .where(eq(runs.retryOf, failedId as RunId))
    .all();

const backoffLogged = () =>
  logs.some((line) => line.includes("is still exiting; waiting again in"));

/** Lets the I/O and continuations already under way run out; only `setTimeout` may be faked. */
async function settle() {
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
}

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

/** Fails a run that already failed once, as a second failure of it would arrive. */
async function failAgain(r: Launched, error: string) {
  db.update(runs)
    .set({ status: "running" })
    .where(eq(runs.id, r.run.id as RunId))
    .run();
  const res = await postEvent(r.file.AGENT_TOKEN, {
    runId: r.run.id,
    type: "run.failed",
    payload: { error },
  });
  expect(res.status).toBe(201);
}

// --- a limit failure that is not retried says why ---------------------------------------------------

/** Whether a launch is kept on the run's row. */
const launchKept = (id: string) => runRow(id)?.launchCiphertext != null;

/** The launch kept on the run's row, opened. */
function keptLaunch(id: string) {
  const row = runRow(id);
  if (!row?.launchCiphertext || !row.launchNonce || !row.launchKeyVersion) {
    throw new Error(`no launch kept for ${id}`);
  }
  const sealed = {
    ciphertext: row.launchCiphertext,
    nonce: row.launchNonce,
    keyVersion: row.launchKeyVersion,
  };
  return JSON.parse(
    open(config.secretEncryptionKey, sealed, runLaunchAad(id)),
  ) as {
    launch: {
      prompt: string;
      sessionId: string | null;
      remoteBranch: string | null;
      forceCredential?: string;
      keepCredential?: boolean;
    };
    at: number;
  };
}

/** Keeps `value` as the run's launch, sealed as the API does. */
function keepLaunch(id: string, value: unknown) {
  const sealed = seal(
    config.secretEncryptionKey,
    JSON.stringify(value),
    runLaunchAad(id),
  );
  db.update(runs)
    .set({
      launchCiphertext: sealed.ciphertext,
      launchNonce: sealed.nonce,
      launchKeyVersion: sealed.keyVersion,
    })
    .where(eq(runs.id, id as RunId))
    .run();
}

test("a limit failure whose launch is held nowhere is not retried and says so", async () => {
  const r = await launchedRun(readyEnv());
  db.update(runs)
    .set({
      launchCiphertext: null,
      launchNonce: null,
      launchKeyVersion: null,
    })
    .where(eq(runs.id, r.run.id as RunId))
    .run();
  restartApi();
  await failWith(r, FIVE_HOUR);
  await vi.waitFor(() => expect(warningsOf(r.run.id)).toHaveLength(1));
  expect(warningsOf(r.run.id)).toEqual([NO_RECORD]);
  expect(wire.sessions).toHaveLength(1);
});

test("a limit failure of a run launched past the remembered window is not retried and says so", async () => {
  const r = await launchedRun(readyEnv());
  keepLaunch(r.run.id, {
    ...keptLaunch(r.run.id),
    at: Date.now() - 13 * 3_600_000,
  });
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
  expect(launchKept(r.run.id)).toBe(true);
  // no secret is stored with the launch, even opened
  const opened = JSON.stringify(keptLaunch(r.run.id));
  for (const secret of [
    PERSONAL_TOKEN,
    WORK_TOKEN,
    API_KEY,
    testConfig().apiKey,
  ]) {
    expect(opened).not.toContain(secret);
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
  expect(launchKept(r.run.id)).toBe(false);
  expect(wire.sessions).toHaveLength(2);
});

test("the stored launch is sealed: the prompt is in no column of the raw row, each run has its own nonce, and it opens only for its own run", async () => {
  const r = await launchedRun(readyEnv());
  const other = await launchedRun(readyEnv());
  // every column of the row, a blob read as bytes, so a plaintext copy anywhere shows up
  const wholeRow = (id: string) =>
    Object.values(
      db.$client.prepare("select * from runs where id = ?").get(id) as Record<
        string,
        unknown
      >,
    )
      .map((value) =>
        Buffer.isBuffer(value) ? value.toString("latin1") : String(value),
      )
      .join("\n");
  expect(wholeRow(r.run.id)).toContain(r.run.id);
  expect(wholeRow(r.run.id)).not.toContain("fix the flaky test");
  // the same prompt twice, and different nonces
  const nonceOf = (id: string) => runRow(id)?.launchNonce?.toString("hex");
  expect(nonceOf(r.run.id)).toHaveLength(24);
  expect(nonceOf(other.run.id)).toHaveLength(24);
  expect(nonceOf(r.run.id)).not.toBe(nonceOf(other.run.id));
  const raw = db.$client
    .prepare(
      "select launch_ciphertext, launch_nonce, launch_key_version from runs where id = ?",
    )
    .get(r.run.id) as {
    launch_ciphertext: Buffer;
    launch_nonce: Buffer;
    launch_key_version: number;
  };
  expect(raw.launch_ciphertext.toString("latin1")).not.toContain(
    "fix the flaky test",
  );
  expect(raw.launch_nonce).toHaveLength(12);
  expect(raw.launch_key_version).toBe(1);
  expect(keptLaunch(r.run.id).launch.prompt).toBe("fix the flaky test");
  // its own AAD only
  expect(() =>
    open(
      config.secretEncryptionKey,
      {
        ciphertext: raw.launch_ciphertext,
        nonce: raw.launch_nonce,
        keyVersion: raw.launch_key_version,
      },
      runLaunchAad("run_other"),
    ),
  ).toThrow();
});

test("a launch copied from another run's row won't open and counts as no record", async () => {
  const a = await launchedRun(readyEnv());
  const b = await launchedRun(readyEnv());
  const rowA = runRow(a.run.id);
  db.update(runs)
    .set({
      launchCiphertext: rowA?.launchCiphertext,
      launchNonce: rowA?.launchNonce,
      launchKeyVersion: rowA?.launchKeyVersion,
    })
    .where(eq(runs.id, b.run.id as RunId))
    .run();
  restartApi();
  await failWith(b, FIVE_HOUR);
  await vi.waitFor(() => expect(warningsOf(b.run.id)).toHaveLength(1));
  expect(warningsOf(b.run.id)).toEqual([NO_RECORD]);
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

test("a limit failure with the API-key fallback off is not retried and says so in its error", async () => {
  const envId = readyEnv({ claudeFallback: "none" });
  const r = await launchedRun(envId);
  await failWith(r, FIVE_HOUR);
  const error = failureOf(r.run.id);
  expect(error).toMatch(
    /^claude_unavailable: the Claude credential "\w+" is at its usage limit and resets .* \(UTC\); this environment's API key fallback is off/,
  );
  expect(error).toContain(`sky env set-runtime ${envId} codex`);
  expect(exitWaits()).toBe(0);
  expect(wire.sessions).toHaveLength(1);
});

test("a runner that exits on the second wait gets its retry", async () => {
  const r = await launchedRun(readyEnv());
  let waits = 0;
  onExitWait(r.run.id, () => (++waits === 1 ? { exitCode: 1 } : undefined));
  await failWith(r, FIVE_HOUR);
  await vi.waitFor(() => expect(wire.sessions).toHaveLength(2));
  expect(waits).toBe(2);
  // the log line the "no wait was made" checks read is live: each wait logs one
  expect(exitWaits()).toBe(waits);
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

test("a second failure of a retried run is not retried again and says no record is held", async () => {
  const r = await launchedRun(readyEnv());
  await failWith(r, FIVE_HOUR);
  await vi.waitFor(() => expect(wire.sessions).toHaveLength(2));
  expect(retriesOf(r.run.id)).toHaveLength(1);
  expect(warningsOf(r.run.id)).toEqual([]);
  await failAgain(r, FIVE_HOUR);
  await vi.waitFor(() => expect(warningsOf(r.run.id)).toHaveLength(1));
  expect(warningsOf(r.run.id)).toEqual([NO_RECORD]);
  expect(retriesOf(r.run.id)).toHaveLength(1);
  expect(wire.sessions).toHaveLength(2);
});

test("a second failure of a retried run after an API restart is not retried again and says no record is held", async () => {
  const r = await launchedRun(readyEnv());
  await failWith(r, FIVE_HOUR);
  await vi.waitFor(() => expect(wire.sessions).toHaveLength(2));
  expect(warningsOf(r.run.id)).toEqual([]);
  restartApi();
  await failAgain(r, FIVE_HOUR);
  await vi.waitFor(() => expect(warningsOf(r.run.id)).toHaveLength(1));
  expect(warningsOf(r.run.id)).toEqual([NO_RECORD]);
  expect(retriesOf(r.run.id)).toHaveLength(1);
  expect(wire.sessions).toHaveLength(2);
});

// --- a usage-limit retry waits out the failed runner's exit ------------------------------------------

/** The first exit wait of `failedId` reports its runner still running; later ones report it gone. */
function runnerExitsOnSecondWait(failedId: string) {
  const seen = { waits: 0 };
  onExitWait(failedId, () =>
    ++seen.waits === 1 ? { exitCode: 1 } : undefined,
  );
  return seen;
}

test("a runner still exiting is waited on for the full pause before the next wait", async () => {
  buildApp({}, [PAUSE_MS]);
  const r = await launchedRun(readyEnv());
  const seen = runnerExitsOnSecondWait(r.run.id);
  fakeDelay();
  await failWith(r, FIVE_HOUR);
  await vi.waitFor(() => expect(backoffLogged()).toBe(true));
  expect(logs.join("\n")).toContain(
    `the runner of ${r.run.id} is still exiting; waiting again in 600s`,
  );
  await vi.advanceTimersByTimeAsync(PAUSE_MS / 2);
  expect(seen.waits).toBe(1);
  expect(retryOf(r.run.id)).toBeUndefined();
  await vi.advanceTimersByTimeAsync(PAUSE_MS);
  await vi.waitFor(() => expect(retryOf(r.run.id)).toBeDefined());
  expect(seen.waits).toBe(2);
  expect(warningsOf(r.run.id)).toEqual([]);
});

test("stopping the agent while a limit retry waits on its runner cancels the retry and says so once", async () => {
  buildApp({}, [PAUSE_MS]);
  const r = await launchedRun(readyEnv());
  const seen = runnerExitsOnSecondWait(r.run.id);
  fakeDelay();
  await failWith(r, FIVE_HOUR);
  await vi.waitFor(() => expect(backoffLogged()).toBe(true));
  const stop = await call("POST", `/v1/agents/${r.agent.id}/stop`);
  expect(stop.status).toBe(200);
  // the runner exits after the stop: the retry the stop cancelled must not go ahead
  await vi.advanceTimersByTimeAsync(2 * PAUSE_MS);
  await vi.waitFor(() => expect(seen.waits).toBe(2));
  await settle();
  expect(retriesOf(r.run.id)).toEqual([]);
  expect(wire.sessions).toHaveLength(1);
  expect(warningsOf(r.run.id)).toEqual([STOPPED]);
});

test("stopping another agent while a limit retry waits on its runner still lets the retry happen", async () => {
  buildApp({}, [PAUSE_MS]);
  const r = await launchedRun(readyEnv());
  const other = await launchedRun(readyEnv());
  runnerExitsOnSecondWait(r.run.id);
  fakeDelay();
  await failWith(r, FIVE_HOUR);
  await vi.waitFor(() => expect(backoffLogged()).toBe(true));
  // the stop execs on the sprite and its stub streams frames on faked timers: waiting on the state
  // steps them, where awaiting the response would not
  let stopStatus: number | undefined;
  void Promise.resolve(call("POST", `/v1/agents/${other.agent.id}/stop`)).then(
    (res) => {
      stopStatus = res.status;
    },
  );
  await vi.waitFor(() => expect(stopStatus).toBe(200));
  await vi.advanceTimersByTimeAsync(2 * PAUSE_MS);
  await vi.waitFor(() => expect(retryOf(r.run.id)).toBeDefined());
  expect(warningsOf(r.run.id)).toEqual([]);
});

// --- a challenge failure that is not retried says why -------------------------------------------------

const fakeDelay = () => vi.useFakeTimers({ toFake: ["setTimeout"] });

test("stopping the agent while a challenge retry waits leaves a warning on the failed run", async () => {
  const r = await launchedRun(readyEnv());
  fakeDelay();
  await failWith(r, CHALLENGE);
  // held for the retry until the stop drops it
  expect(launchKept(r.run.id)).toBe(true);
  const stop = await call("POST", `/v1/agents/${r.agent.id}/stop`);
  expect(stop.status).toBe(200);
  // read before the delay passes: the stop itself clears it, not the timer firing
  expect(launchKept(r.run.id)).toBe(false);
  await vi.advanceTimersByTimeAsync(10 * CHALLENGE_DELAY_MS);
  expect(warningsOf(r.run.id)).toEqual([STOPPED]);
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
  expect(warningsOf(r.run.id)).toEqual([
    "not retried after the Cloudflare challenge: its environment is not ready or no longer assigns Claude credential personal",
  ]);
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
  // a failure that is a retry candidate, handled after the one under test
  const sentinel = await launchedRun(readyEnv());
  if (name !== "an unrelated error") {
    // run on the API key, as after a limit retry
    db.update(runs)
      .set({ claudeCredential: "api-key" })
      .where(eq(runs.id, r.run.id as RunId))
      .run();
  }
  await failWith(r, error);
  await failWith(sentinel, FIVE_HOUR);
  // the sentinel's retry launching shows failures are being acted on, so an absent retry is a decision
  await vi.waitFor(() => expect(wire.sessions).toHaveLength(3));
  expect(retryOf(sentinel.run.id)).toBeDefined();
  expect(runRow(r.run.id)?.status).toBe("failed");
  expect(warningsOf(r.run.id)).toEqual([]);
  expect(retryOf(r.run.id)).toBeUndefined();
});

// --- the stored launch is kept only while a retry is still possible ---------------------------------

test("a run that finishes keeps no launch", async () => {
  const r = await launchedRun(readyEnv());
  expect(launchKept(r.run.id)).toBe(true);
  await postEvent(r.file.AGENT_TOKEN, {
    runId: r.run.id,
    type: "run.started",
    payload: { sessionId: "sess-1" },
  });
  const res = await postEvent(r.file.AGENT_TOKEN, {
    runId: r.run.id,
    type: "run.finished",
    payload: {
      summary: "done",
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
        turns: 1,
        durationMs: 1,
      },
    },
  });
  expect(res.status).toBe(201);
  expect(launchKept(r.run.id)).toBe(false);
});

test("a stopped run keeps no launch", async () => {
  const r = await launchedRun(readyEnv());
  expect(launchKept(r.run.id)).toBe(true);
  const stop = await call("POST", `/v1/agents/${r.agent.id}/stop`);
  expect(stop.status).toBe(200);
  expect(runRow(r.run.id)?.status).toBe("stopped");
  expect(launchKept(r.run.id)).toBe(false);
});

test("a run whose launcher fails keeps no launch", async () => {
  wire.sessionExit = { output: "node: bad option\r\n", code: 1 };
  const r = await launchedRun(readyEnv());
  await vi.waitFor(() => expect(runRow(r.run.id)?.status).toBe("failed"));
  expect(runRow(r.run.id)).toMatchObject({
    launchCiphertext: null,
    launchNonce: null,
    launchKeyVersion: null,
  });
});

test("a run failed by the launch deadline keeps no launch", async () => {
  const r = await launchedRun(readyEnv());
  expect(launchKept(r.run.id)).toBe(true);
  const deadline = config.launchDeadlineMs;
  expect(
    failUnlaunchedRuns(db, deadline, Date.now() + deadline + 1000),
  ).toHaveLength(1);
  expect(runRow(r.run.id)?.status).toBe("failed");
  expect(runRow(r.run.id)).toMatchObject({
    launchCiphertext: null,
    launchNonce: null,
    launchKeyVersion: null,
  });
});

test.each([
  ["no credential recorded", null],
  ["the API key", "api-key"],
])(
  "a limit failure of a run with %s keeps no launch",
  async (_name, credential) => {
    const r = await launchedRun(readyEnv());
    db.update(runs)
      .set({ claudeCredential: credential })
      .where(eq(runs.id, r.run.id as RunId))
      .run();
    expect(launchKept(r.run.id)).toBe(true);
    await failWith(r, FIVE_HOUR);
    await vi.waitFor(() => expect(runRow(r.run.id)?.status).toBe("failed"));
    expect(launchKept(r.run.id)).toBe(false);
    expect(retryOf(r.run.id)).toBeUndefined();
    expect(wire.sessions).toHaveLength(1);
  },
);

test.each([
  ["an unrelated error", UNRELATED],
  ["a challenge on a run with no credential recorded", CHALLENGE],
])(
  "a failure that is not a retry candidate (%s) keeps no launch",
  async (name, error) => {
    const r = await launchedRun(readyEnv());
    if (name !== "an unrelated error") {
      db.update(runs)
        .set({ claudeCredential: null })
        .where(eq(runs.id, r.run.id as RunId))
        .run();
    }
    expect(launchKept(r.run.id)).toBe(true);
    await failWith(r, error);
    await vi.waitFor(() => expect(runRow(r.run.id)?.status).toBe("failed"));
    expect(launchKept(r.run.id)).toBe(false);
  },
);

test("a limit failure keeps the launch only until its retry takes it", async () => {
  const r = await launchedRun(readyEnv());
  await failWith(r, FIVE_HOUR);
  await vi.waitFor(() => expect(wire.sessions).toHaveLength(2));
  expect(launchKept(r.run.id)).toBe(false);
  // the retry run holds its own, for a retry of its own
  const retry = retryOf(r.run.id);
  expect(launchKept(String(retry?.id))).toBe(true);
});

test.each([
  ["JSON that is not a launch", { launch: { prompt: 5 }, at: "now" }],
  ["a launch missing its environment", { launch: { prompt: "x" }, at: 1 }],
  ["a bare string", "fix the flaky test"],
])(
  "a stored launch that opens as %s counts as no record",
  async (_name, value) => {
    const r = await launchedRun(readyEnv());
    keepLaunch(r.run.id, value);
    restartApi();
    await failWith(r, FIVE_HOUR);
    await vi.waitFor(() => expect(warningsOf(r.run.id)).toHaveLength(1));
    expect(warningsOf(r.run.id)).toEqual([NO_RECORD]);
    expect(wire.sessions).toHaveLength(1);
  },
);

test.each([2, 0])(
  "a stored launch under key version %i counts as no record",
  async (keyVersion) => {
    const r = await launchedRun(readyEnv());
    expect(launchKept(r.run.id)).toBe(true);
    db.update(runs)
      .set({ launchKeyVersion: keyVersion })
      .where(eq(runs.id, r.run.id as RunId))
      .run();
    restartApi();
    await failWith(r, FIVE_HOUR);
    await vi.waitFor(() => expect(warningsOf(r.run.id)).toHaveLength(1));
    expect(warningsOf(r.run.id)).toEqual([NO_RECORD]);
    expect(wire.sessions).toHaveLength(1);
  },
);

test("a stored launch with every optional field set opens after a restart and is retried from", async () => {
  const r = await launchedRun(readyEnv());
  const kept = keptLaunch(r.run.id);
  keepLaunch(r.run.id, {
    ...kept,
    launch: {
      ...kept.launch,
      sessionId: "sess-0",
      remoteBranch: "feature/retry-me",
      forceCredential: "work",
      keepCredential: true,
    },
  });
  restartApi();
  await failWith(r, FIVE_HOUR);
  await vi.waitFor(() => expect(wire.sessions).toHaveLength(2));
  expect(warningsOf(r.run.id)).toEqual([]);
  // the branch rides on to the retry's own launch, which the agent's resumed session now leads
  const retry = retryOf(r.run.id);
  expect(keptLaunch(String(retry?.id)).launch).toMatchObject({
    remoteBranch: "feature/retry-me",
    sessionId: "sess-1",
    forceCredential: "api-key",
    keepCredential: false,
  });
});

test("a launch kept for a retry that launched more than 12 hours before the next launch is dropped, a younger one is kept", async () => {
  const old = await launchedRun(readyEnv());
  const young = await launchedRun(readyEnv());
  const hoursAgo = (h: number) =>
    new Date(Date.now() - h * 3_600_000).toISOString();
  db.update(runs)
    .set({ createdAt: hoursAgo(13) })
    .where(eq(runs.id, old.run.id as RunId))
    .run();
  db.update(runs)
    .set({ createdAt: hoursAgo(11) })
    .where(eq(runs.id, young.run.id as RunId))
    .run();
  expect(launchKept(old.run.id)).toBe(true);
  expect(launchKept(young.run.id)).toBe(true);
  const next = await launchedRun(readyEnv());
  expect(launchKept(old.run.id)).toBe(false);
  expect(launchKept(young.run.id)).toBe(true);
  expect(launchKept(next.run.id)).toBe(true);
});

test("a launch whose write fails still starts its run, and only loses the retry after a restart", async () => {
  db.$client.exec(
    "create trigger refuse_launch before update of launch_ciphertext on runs when new.launch_ciphertext is not null begin select raise(abort, 'disk full'); end",
  );
  const r = await launchedRun(readyEnv());
  expect(runRow(r.run.id)?.status).not.toBe("failed");
  expect(launchKept(r.run.id)).toBe(false);
  expect(
    logs.some((line) => line.includes(`keeping the launch of ${r.run.id}`)),
  ).toBe(true);
  // the log line above is the one that carries the failure: it must not carry the task
  expect(logs.join("\n")).not.toContain("fix the flaky test");
  // the map still holds it: a failure without a restart is retried
  await failWith(r, FIVE_HOUR);
  await vi.waitFor(() => expect(wire.sessions).toHaveLength(2));
  expect(warningsOf(r.run.id)).toEqual([]);
});

test("a launch whose write fails leaves a restarted API with no record to retry from", async () => {
  db.$client.exec(
    "create trigger refuse_launch before update of launch_ciphertext on runs when new.launch_ciphertext is not null begin select raise(abort, 'disk full'); end",
  );
  const r = await launchedRun(readyEnv());
  restartApi();
  await failWith(r, FIVE_HOUR);
  await vi.waitFor(() => expect(warningsOf(r.run.id)).toEqual([NO_RECORD]));
  expect(wire.sessions).toHaveLength(1);
});
