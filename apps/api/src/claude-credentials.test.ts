import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpritesClient } from "@fly/sprites";
import {
  claudeLimits,
  type Db,
  environments,
  events,
  migrate,
  openDb,
  runs,
} from "@sky/db";
import { CreatedApiKey, type EnvironmentId, type RunId } from "@sky/shared";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createApp } from "./app.js";
import {
  limitedUntil,
  markLimited,
  parseUsageLimit,
  UNKNOWN_RESET_MS,
} from "./claude-credentials.js";
import type { Config } from "./config.js";
import { KnownSecrets } from "./redact.js";
import { spriteNameFor } from "./sprites.js";
import {
  envFileOf,
  type SpritesWire,
  spritesToken,
  stubSprites,
  testConfig,
} from "./testing/sprites.js";

// opaque on purpose: none matches a token pattern `redact` knows, so only the registered values can scrub them
const DEFAULT_TOKEN = "default-subscription-opaque-1";
const PERSONAL_TOKEN = "personal-subscription-opaque-2";
const WORK_TOKEN = "work-subscription-opaque-3";
const API_KEY = "anthropic-api-key-opaque-4";
const ALL_VALUES = [DEFAULT_TOKEN, PERSONAL_TOKEN, WORK_TOKEN, API_KEY];

const FIVE_HOUR = "You've hit your 5-hour limit · resets 10:20am (UTC)";
const WEEKLY = "You've hit your weekly limit · resets Dec 30, 10am (UTC)";

let dir: string;
let db: Db;
let config: Config;
let logs: string[];
let app: ReturnType<typeof createApp>;
let wire: SpritesWire;

const buildApp = (over: Partial<Config> = {}) => {
  config = testConfig({
    runnerBundlePath: join(dir, "runner.mjs"),
    claudeOauthToken: DEFAULT_TOKEN,
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
  });
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sky-claude-credentials-"));
  writeFileSync(join(dir, "runner.mjs"), "// runner bundle\n");
  db = openDb(":memory:");
  migrate(db);
  wire = stubSprites();
  logs = [];
  buildApp();
});
afterEach(() => {
  if (db.$client.open) db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

const admin = `Bearer ${testConfig().apiKey}`;
const call = (bearer: string, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: {
      Authorization: bearer,
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
      ...overrides,
    })
    .run();
  wire.sprites.add(spriteNameFor(id));
  return id;
}

type Launched = {
  agent: { id: string };
  run: { id: string; status: string; claudeCredential: string | null };
};

const launch = async (envId: string, prompt = "fix the flaky test") => {
  const res = await call(admin, "POST", "/v1/agents", { envId, prompt });
  expect(res.status).toBe(202);
  return (await res.json()) as Launched;
};

const sessionOpened = (count = 1) =>
  vi.waitFor(() => expect(wire.sessions).toHaveLength(count));

/** Launches a run and returns the env file its runner was handed. */
async function launchedRun(envId: EnvironmentId) {
  const before = wire.sessions.length;
  const ids = await launch(envId);
  await sessionOpened(before + 1);
  const session = wire.sessions[before];
  return { ...ids, session, file: envFileOf(wire, session) };
}

const postEvent = (token: string | undefined, event: unknown) =>
  app.request("/internal/events", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(event),
  });

const runRow = (id: string) =>
  db
    .select()
    .from(runs)
    .where(eq(runs.id, id as RunId))
    .get();

/** A started run reports `error` as its failure; the API handles it as the runner's `run.failed`. */
async function failWith(
  r: Awaited<ReturnType<typeof launchedRun>>,
  error: string,
) {
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

/** The error the API stored on a failed run. */
const failureOf = (runId: string) => {
  const row = db
    .select({ payload: events.payload })
    .from(events)
    .where(eq(events.runId, runId as RunId))
    .get();
  return String((row?.payload as { error?: string } | undefined)?.error);
};

const credentialsOf = async () => {
  const res = await call(admin, "GET", "/v1/claude-credentials");
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Record<string, unknown>[] }).data;
};

// --- the usage-limit wordings -------------------------------------------------------------------

const NOW = new Date("2026-11-12T08:00:00Z");

test.each([
  [FIVE_HOUR, "5-hour", "2026-11-12T10:20:00.000Z"],
  [
    "You've hit your 5-hour limit · resets 8am (UTC)",
    "5-hour",
    "2026-11-13T08:00:00.000Z",
  ],
  [WEEKLY, "weekly", "2026-12-30T10:00:00.000Z"],
  [
    "You've hit your weekly limit · resets Nov 15 at 3:30pm (UTC)",
    "weekly",
    "2026-11-15T15:30:00.000Z",
  ],
  [
    "5-hour limit reached ∙ resets 3pm (America/New_York)",
    "5-hour",
    "2026-11-12T20:00:00.000Z",
  ],
  [
    "Claude AI usage limit reached|1794484800",
    "5-hour",
    "2026-11-12T12:00:00.000Z",
  ],
  ["You've hit your limit", "5-hour", null],
])("reads %j as a %s limit lifting at %s", (text, window, resets) => {
  const limit = parseUsageLimit(`Error: ${text}`, NOW);
  expect(limit?.window).toBe(window);
  expect(limit?.resetsAt?.toISOString() ?? null).toBe(resets);
});

test.each([
  "worktree setup failed: exit 1",
  "the connection limit was exceeded",
  "launch_failed: sprite_low_memory",
  "",
])("%j is not a usage limit", (text) => {
  expect(parseUsageLimit(text, NOW)).toBeNull();
});

test("a reset time in an unknown zone leaves the reset unread, not guessed", () => {
  expect(
    parseUsageLimit(
      "You've hit your 5-hour limit · resets 3pm (Mars/Olympus)",
      NOW,
    )?.resetsAt,
  ).toBeNull();
});

// --- assignment: which credential a run uses ------------------------------------------------------

test("an environment with no assignment runs on the default token", async () => {
  const r = await launchedRun(readyEnv());
  expect(r.file).toMatchObject({
    SKY_CLAUDE_AUTH: "oauth",
    CLAUDE_CODE_OAUTH_TOKEN: DEFAULT_TOKEN,
  });
  expect(r.file).not.toHaveProperty("SKY_CLAUDE_API_KEY");
  expect(r.file).not.toHaveProperty("ANTHROPIC_API_KEY");
  expect(r.run.claudeCredential).toBeNull();
  expect(runRow(r.run.id)?.claudeCredential).toBe("default");
});

test("an environment assigned a named subscription runs on that token alone", async () => {
  const r = await launchedRun(readyEnv({ claudeCredential: "personal" }));
  expect(r.file.CLAUDE_CODE_OAUTH_TOKEN).toBe(PERSONAL_TOKEN);
  expect(JSON.stringify(r.file)).not.toContain(WORK_TOKEN);
  expect(JSON.stringify(r.file)).not.toContain(DEFAULT_TOKEN);
  expect(JSON.stringify(r.file)).not.toContain(API_KEY);
  expect(runRow(r.run.id)?.claudeCredential).toBe("personal");
});

test("an environment assigned api-key runs on the key, under a name that is not the project's", async () => {
  const r = await launchedRun(readyEnv({ claudeCredential: "api-key" }));
  expect(r.file).toMatchObject({
    SKY_CLAUDE_AUTH: "api-key",
    SKY_CLAUDE_API_KEY: API_KEY,
  });
  expect(r.file).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
  expect(r.file).not.toHaveProperty("ANTHROPIC_API_KEY");
  expect(runRow(r.run.id)?.claudeCredential).toBe("api-key");
});

test("the run API and a follow-up show the credential's name, never a value", async () => {
  const r = await launchedRun(readyEnv({ claudeCredential: "personal" }));
  const res = await call(
    admin,
    "GET",
    `/v1/agents/${r.agent.id}/runs/${r.run.id}`,
  );
  const body = (await res.json()) as Record<string, unknown>;
  expect(body).toMatchObject({ claudeCredential: "personal", retryOf: null });
  const list = await call(admin, "GET", `/v1/agents/${r.agent.id}/runs`);
  expect(await list.json()).toMatchObject({
    data: [{ claudeCredential: "personal" }],
  });
});

test("an environment assigned a credential the server no longer holds fails its launch at once", async () => {
  const envId = readyEnv({ claudeCredential: "gone" });
  const { run } = await launch(envId);
  await vi.waitFor(() => expect(runRow(run.id)?.status).toBe("failed"));
  expect(failureOf(run.id)).toContain("claude_credential_missing");
  expect(wire.sessions).toHaveLength(0);
});

// --- the usage limit and the API key fallback -------------------------------------------------------

test("a limit error marks that subscription limited until its reset and retries the run once on the API key, in the same session", async () => {
  const personal = readyEnv({ claudeCredential: "personal" });
  const r = await launchedRun(personal);
  await failWith(r, FIVE_HOUR);

  await sessionOpened(2);
  const retry = wire.sessions[1];
  const file = envFileOf(wire, retry);
  expect(file).toMatchObject({
    SKY_CLAUDE_AUTH: "api-key",
    SKY_CLAUDE_API_KEY: API_KEY,
  });
  expect(file).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
  expect(retry?.env.SESSION_ID).toBe("sess-1");
  expect(retry?.env.RUN_ID).not.toBe(r.run.id);

  const until = limitedUntil(db, "personal");
  expect(until?.getUTCHours()).toBe(10);
  expect(until?.getUTCMinutes()).toBe(20);
  expect(until && until.getTime() > Date.now()).toBe(true);

  const retried = runRow(String(retry?.env.RUN_ID));
  expect(retried).toMatchObject({
    claudeCredential: "api-key",
    retryOf: r.run.id,
    agentId: r.agent.id,
  });
  expect(runRow(r.run.id)?.status).toBe("failed");
  // the same agent: its worktree and session carry on
  const prompt = wire.files.get(`/workspace/runs/${retried?.id}.prompt`);
  expect(new TextDecoder().decode(prompt)).toContain("fix the flaky test");
});

test("the retry is one: a limit on the API-key run is not retried, and no other subscription is ever tried", async () => {
  const personal = readyEnv({ claudeCredential: "personal" });
  const r = await launchedRun(personal);
  await failWith(r, WEEKLY);
  await sessionOpened(2);
  const retry = wire.sessions[1];

  // the key's own run reports a limit-shaped failure: it is not a subscription's, so nothing is marked or retried
  const retryToken = envFileOf(wire, retry).AGENT_TOKEN;
  await postEvent(retryToken, {
    runId: retry?.env.RUN_ID,
    type: "run.failed",
    payload: { error: FIVE_HOUR },
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(wire.sessions).toHaveLength(2);
  expect(limitedUntil(db, "api-key")).toBeUndefined();
  expect(limitedUntil(db, "default")).toBeUndefined();
  expect(limitedUntil(db, "work")).toBeUndefined();
  for (const session of wire.sessions) {
    expect(JSON.stringify(envFileOf(wire, session))).not.toContain(WORK_TOKEN);
    expect(JSON.stringify(envFileOf(wire, session))).not.toContain(
      DEFAULT_TOKEN,
    );
  }
});

test("a limit on one subscription leaves another environment's subscription alone", async () => {
  const personal = readyEnv({ claudeCredential: "personal" });
  const work = readyEnv({ claudeCredential: "work" });
  const r = await launchedRun(personal);
  await failWith(r, FIVE_HOUR);
  await sessionOpened(2);

  const next = await launchedRun(work);
  expect(next.file.CLAUDE_CODE_OAUTH_TOKEN).toBe(WORK_TOKEN);
  const data = await credentialsOf();
  expect(data.find((c) => c.name === "work")).toMatchObject({
    limitedUntil: null,
  });
  expect(data.find((c) => c.name === "personal")?.limitedUntil).toEqual(
    expect.any(String),
  );
});

test("while a subscription is limited, a new launch in its environment goes to the API key", async () => {
  const personal = readyEnv({ claudeCredential: "personal" });
  markLimited(db, "personal", new Date(Date.now() + 3_600_000));
  const r = await launchedRun(personal);
  expect(r.file).toMatchObject({
    SKY_CLAUDE_AUTH: "api-key",
    SKY_CLAUDE_API_KEY: API_KEY,
  });
  expect(JSON.stringify(r.file)).not.toContain(PERSONAL_TOKEN);
  expect(runRow(r.run.id)?.claudeCredential).toBe("api-key");
});

test("once the reset time passes, launches use the subscription again", async () => {
  const personal = readyEnv({ claudeCredential: "personal" });
  markLimited(db, "personal", new Date(Date.now() - 1_000));
  const r = await launchedRun(personal);
  expect(r.file.CLAUDE_CODE_OAUTH_TOKEN).toBe(PERSONAL_TOKEN);
});

test("with no API key set, a limited subscription fails the launch at once, naming the reset time in UTC", async () => {
  buildApp({ anthropicApiKey: undefined });
  const personal = readyEnv({ claudeCredential: "personal" });
  const until = new Date(Date.now() + 3_600_000);
  markLimited(db, "personal", until);
  const { run } = await launch(personal);
  await vi.waitFor(() => expect(runRow(run.id)?.status).toBe("failed"));
  const error = failureOf(run.id);
  expect(error).toContain("claude_limited");
  expect(error).toContain(until.toISOString());
  expect(error).toContain("UTC");
  // no sprite was touched: nothing was started to die
  expect(wire.sessions).toHaveLength(0);
  expect(wire.calls).toEqual([]);
});

test("claudeFallback none: a limited subscription fails the launch instead of spending the key", async () => {
  const personal = readyEnv({
    claudeCredential: "personal",
    claudeFallback: "none",
  });
  const until = new Date(Date.now() + 3_600_000);
  markLimited(db, "personal", until);
  const { run } = await launch(personal);
  await vi.waitFor(() => expect(runRow(run.id)?.status).toBe("failed"));
  const error = failureOf(run.id);
  expect(error).toContain(until.toISOString());
  expect(error).toContain("fallback is off");
  expect(wire.sessions).toHaveLength(0);
});

test("claudeFallback none: a run that hits its limit is not retried on the key", async () => {
  const personal = readyEnv({
    claudeCredential: "personal",
    claudeFallback: "none",
  });
  const r = await launchedRun(personal);
  await failWith(r, FIVE_HOUR);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(wire.sessions).toHaveLength(1);
  // the limit is still recorded, so the next launch names the reset time
  expect(limitedUntil(db, "personal")).toBeDefined();
});

test("with no API key set, a run that hits its limit is marked, not retried", async () => {
  buildApp({ anthropicApiKey: undefined });
  const r = await launchedRun(readyEnv({ claudeCredential: "personal" }));
  await failWith(r, FIVE_HOUR);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(wire.sessions).toHaveLength(1);
  expect(limitedUntil(db, "personal")).toBeDefined();
});

test("a limit message with no readable reset holds the subscription for a short while", async () => {
  const r = await launchedRun(readyEnv({ claudeCredential: "personal" }));
  const before = Date.now();
  await failWith(r, "You've hit your limit");
  await sessionOpened(2);
  const until = limitedUntil(db, "personal")?.getTime() ?? 0;
  expect(until).toBeGreaterThanOrEqual(before + UNKNOWN_RESET_MS - 1_000);
  expect(until).toBeLessThanOrEqual(Date.now() + UNKNOWN_RESET_MS);
});

test("the limited state survives a restart", async () => {
  const personal = readyEnv({ claudeCredential: "personal" });
  const r = await launchedRun(personal);
  await failWith(r, FIVE_HOUR);
  await sessionOpened(2);
  expect(db.select().from(claudeLimits).all()).toHaveLength(1);

  // a new process over the same database file: nothing in memory carries over
  buildApp();
  const next = await launchedRun(personal);
  expect(next.file).toMatchObject({
    SKY_CLAUDE_AUTH: "api-key",
    SKY_CLAUDE_API_KEY: API_KEY,
  });
  expect(limitedUntil(db, "personal")).toBeDefined();
});

// --- nothing secret leaves ----------------------------------------------------------------------------

test("no token or key appears in logs, events, run output or the credential list", async () => {
  const personal = readyEnv({ claudeCredential: "personal" });
  const r = await launchedRun(personal);
  // Claude echoing its own environment into a message and a failure
  await postEvent(r.file.AGENT_TOKEN, {
    runId: r.run.id,
    type: "claude.Message",
    payload: { text: `env: ${ALL_VALUES.join(" ")}` },
  });
  await failWith(r, `${FIVE_HOUR} ${ALL_VALUES.join(" ")}`);
  await sessionOpened(2);

  const stored = JSON.stringify(db.select().from(events).all());
  const api = [
    await (
      await call(admin, "GET", `/v1/agents/${r.agent.id}/runs/${r.run.id}`)
    ).text(),
    await (await call(admin, "GET", `/v1/agents/${r.agent.id}/runs`)).text(),
    await (await call(admin, "GET", "/v1/claude-credentials")).text(),
    await (await call(admin, "GET", "/v1/environments")).text(),
  ].join("\n");
  for (const value of ALL_VALUES) {
    expect(stored).not.toContain(value);
    expect(api).not.toContain(value);
    expect(logs.join("\n")).not.toContain(value);
  }
});

test("redaction knows every named token and the API key", () => {
  const known = KnownSecrets.fromConfig(config).values();
  for (const value of ALL_VALUES) expect(known).toContain(value);
});

// --- visibility -------------------------------------------------------------------------------------------

test("GET /v1/claude-credentials lists names, kinds, assignments, limits and runs today", async () => {
  const personal = readyEnv({ claudeCredential: "personal", name: "alpha" });
  const unassigned = readyEnv({ name: "beta" });
  readyEnv({ claudeCredential: "api-key", name: "gamma" });
  await launchedRun(personal);
  await launchedRun(unassigned);
  const until = new Date(Date.now() + 3_600_000);
  markLimited(db, "work", until);

  const data = await credentialsOf();
  expect(data.map((c) => [c.name, c.kind])).toEqual([
    ["default", "subscription"],
    ["personal", "subscription"],
    ["work", "subscription"],
    ["api-key", "api-key"],
  ]);
  const by = (name: string) => data.find((c) => c.name === name);
  expect(by("default")).toMatchObject({
    environments: [{ id: unassigned, name: "beta" }],
    runsToday: 1,
    limitedUntil: null,
  });
  expect(by("personal")).toMatchObject({
    environments: [{ id: personal, name: "alpha" }],
    runsToday: 1,
  });
  expect(by("work")).toMatchObject({
    limitedUntil: until.toISOString(),
    runsToday: 0,
  });
  expect(by("api-key")).toMatchObject({
    environments: [{ name: "gamma" }],
    runsToday: 0,
  });
});

test("without an API key the list has no api-key entry", async () => {
  buildApp({ anthropicApiKey: undefined });
  expect((await credentialsOf()).map((c) => c.name)).not.toContain("api-key");
});

// --- the env API ---------------------------------------------------------------------------------------------

test("an admin assigns a credential and the fallback through the env API; default clears it", async () => {
  const envId = readyEnv();
  const set = await call(admin, "PATCH", `/v1/environments/${envId}`, {
    claudeCredential: "personal",
    claudeFallback: "none",
  });
  expect(set.status).toBe(200);
  expect(await set.json()).toMatchObject({
    claudeCredential: "personal",
    claudeFallback: "none",
  });
  const cleared = await call(admin, "PATCH", `/v1/environments/${envId}`, {
    claudeCredential: "default",
  });
  expect(await cleared.json()).toMatchObject({
    claudeCredential: null,
    claudeFallback: "none",
  });
  const key = await call(admin, "PATCH", `/v1/environments/${envId}`, {
    claudeCredential: "api-key",
  });
  expect(await key.json()).toMatchObject({ claudeCredential: "api-key" });
});

test("assigning a credential the server doesn't hold is refused, naming the ones it does", async () => {
  const envId = readyEnv();
  const res = await call(admin, "PATCH", `/v1/environments/${envId}`, {
    claudeCredential: "nobody",
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: {
      code: "unknown_credential",
      message: expect.stringContaining("default, personal, work, api-key"),
    },
  });
  buildApp({ anthropicApiKey: undefined });
  const noKey = await call(admin, "PATCH", `/v1/environments/${envId}`, {
    claudeCredential: "api-key",
  });
  expect(noKey.status).toBe(400);
});

test("creating an environment takes the assignment too", async () => {
  const res = await call(admin, "POST", "/v1/environments", {
    name: "kru",
    repo: "acme/kru",
    setup: "true",
    claudeCredential: "work",
  });
  expect(res.status).toBe(202);
  expect(await res.json()).toMatchObject({
    claudeCredential: "work",
    claudeFallback: "api-key",
  });
});

// --- a runs key -------------------------------------------------------------------------------------------------

async function runsKey(envIds: EnvironmentId[]) {
  const res = await call(admin, "POST", "/v1/keys", {
    name: "ci",
    role: "runs",
    environmentIds: envIds,
  });
  return CreatedApiKey.parse(await res.json()).secret;
}

test("a runs key can't change an environment's credential or fallback", async () => {
  const envId = readyEnv({ claudeCredential: "personal" });
  const key = `Bearer ${await runsKey([envId])}`;
  for (const body of [
    { claudeCredential: "work" },
    { claudeCredential: null },
    { claudeFallback: "none" },
  ]) {
    const res = await call(key, "PATCH", `/v1/environments/${envId}`, body);
    expect(res.status).toBe(403);
  }
  const row = db
    .select()
    .from(environments)
    .where(eq(environments.id, envId))
    .get();
  expect(row).toMatchObject({
    claudeCredential: "personal",
    claudeFallback: "api-key",
  });
});

test("a runs key can't read /v1/claude-credentials", async () => {
  const envId = readyEnv();
  const key = `Bearer ${await runsKey([envId])}`;
  const res = await call(key, "GET", "/v1/claude-credentials");
  expect(res.status).toBe(403);
  expect(await res.text()).not.toContain(DEFAULT_TOKEN);
});

test("a runs key can still read its environment's assignment, a name and no more", async () => {
  const envId = readyEnv({ claudeCredential: "personal" });
  const key = `Bearer ${await runsKey([envId])}`;
  const res = await call(key, "GET", `/v1/environments/${envId}`);
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(JSON.parse(text)).toMatchObject({ claudeCredential: "personal" });
  for (const value of ALL_VALUES) expect(text).not.toContain(value);
});
