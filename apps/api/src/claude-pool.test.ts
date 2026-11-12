import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpritesClient } from "@fly/sprites";
import {
  claudeUsage,
  type Db,
  environments,
  events,
  migrate,
  openDb,
  runs,
} from "@sky/db";
import { CreatedApiKey, type EnvironmentId, type RunId } from "@sky/shared";
import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { server } from "../../../test/msw.js";
import { createApp } from "./app.js";
import { limitedUntil, markLimited } from "./claude-credentials.js";
import {
  PROBE_MODEL,
  parseUsageHeaders,
  storedUsage,
  USAGE_STALE_MS,
  usageScore,
} from "./claude-usage.js";
import { type Config, loadConfig } from "./config.js";
import { spriteNameFor } from "./sprites.js";
import {
  envFileOf,
  type SpritesWire,
  spritesToken,
  stubSprites,
  testConfig,
} from "./testing/sprites.js";

// opaque, so only registered values could be scrubbed from anything
const DEFAULT_TOKEN = "default-subscription-opaque-1";
const PERSONAL_TOKEN = "personal-subscription-opaque-2";
const WORK_TOKEN = "work-subscription-opaque-3";
const API_KEY = "anthropic-api-key-opaque-4";

const FIVE_HOUR = "You've hit your 5-hour limit · resets 10:20am (UTC)";
const WEEKLY = "You've hit your weekly limit · resets Dec 30, 10am (UTC)";

type Reading = { h5: number; h5Reset?: number; d7: number; d7Reset?: number };
const inHours = (h: number) => Math.floor(Date.now() / 1000) + h * 3600;

let dir: string;
let db: Db;
let config: Config;
let logs: string[];
let app: ReturnType<typeof createApp>;
let wire: SpritesWire;
/** What the stand-in for Anthropic answers each token's probe with. */
let readings: Record<string, Reading | "broken">;
let probes: {
  token: string;
  body: Record<string, unknown>;
  beta: string | null;
}[];

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
  dir = mkdtempSync(join(tmpdir(), "sky-claude-pool-"));
  writeFileSync(join(dir, "runner.mjs"), "// runner bundle\n");
  db = openDb(":memory:");
  migrate(db);
  wire = stubSprites();
  logs = [];
  probes = [];
  readings = {};
  server.use(
    http.post("https://api.anthropic.com/v1/messages", async ({ request }) => {
      const token = (request.headers.get("authorization") ?? "").replace(
        "Bearer ",
        "",
      );
      probes.push({
        token,
        body: (await request.json()) as Record<string, unknown>,
        beta: request.headers.get("anthropic-beta"),
      });
      const reading = readings[token];
      if (!reading || reading === "broken") {
        return HttpResponse.json({ error: "overloaded" }, { status: 529 });
      }
      return HttpResponse.json(
        { id: "msg_1", content: [{ type: "text", text: "." }] },
        {
          headers: {
            "anthropic-ratelimit-unified-5h-utilization": String(reading.h5),
            "anthropic-ratelimit-unified-5h-reset": String(
              reading.h5Reset ?? inHours(3),
            ),
            "anthropic-ratelimit-unified-7d-utilization": String(reading.d7),
            "anthropic-ratelimit-unified-7d-reset": String(
              reading.d7Reset ?? inHours(100),
            ),
          },
        },
      );
    }),
  );
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

const poolEnv = (
  claudePool: string[] | null = null,
  over: Partial<typeof environments.$inferInsert> = {},
) => readyEnv({ claudeCredential: "pool", claudePool, ...over });

type Launched = { agent: { id: string }; run: { id: string } };

const sessionOpened = (count = 1) =>
  vi.waitFor(() => expect(wire.sessions).toHaveLength(count));

async function launchedRun(envId: EnvironmentId) {
  const before = wire.sessions.length;
  const res = await call(admin, "POST", "/v1/agents", {
    envId,
    prompt: "fix the flaky test",
  });
  expect(res.status).toBe(202);
  const ids = (await res.json()) as Launched;
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

/** The credential name each launched session was recorded on, oldest first. */
const credentialsUsed = () =>
  wire.sessions.map((s) => runRow(String(s.env.RUN_ID))?.claudeCredential);

const tokenOfFile = (file: Record<string, string>) =>
  file.CLAUDE_CODE_OAUTH_TOKEN ?? file.SKY_CLAUDE_API_KEY;

const warningsOf = (runId: string) =>
  db
    .select({ payload: events.payload })
    .from(events)
    .where(eq(events.runId, runId as RunId))
    .all()
    .map((e) => e.payload as { message?: string })
    .map((p) => p.message)
    .filter((m): m is string => m !== undefined);

const failureOf = (runId: string) => {
  const row = db
    .select({ payload: events.payload })
    .from(events)
    .where(eq(events.runId, runId as RunId))
    .get();
  return String((row?.payload as { error?: string } | undefined)?.error);
};

// --- the usage headers ------------------------------------------------------------------------------

test("usage is read from the unified rate-limit headers, resets as epoch seconds", () => {
  const usage = parseUsageHeaders(
    new Headers({
      "anthropic-ratelimit-unified-5h-utilization": "0.25",
      "anthropic-ratelimit-unified-5h-reset": "1794484800",
      "anthropic-ratelimit-unified-7d-utilization": "0.5",
      "anthropic-ratelimit-unified-7d-reset": "2026-11-20T00:00:00Z",
    }),
    new Date("2026-11-12T08:00:00Z"),
  );
  expect(usage).toEqual({
    fiveHour: { utilization: 0.25, resetsAt: "2026-11-12T12:00:00.000Z" },
    sevenDay: { utilization: 0.5, resetsAt: "2026-11-20T00:00:00.000Z" },
    probedAt: "2026-11-12T08:00:00.000Z",
  });
  expect(parseUsageHeaders(new Headers({ "content-type": "x" }))).toBeNull();
});

test("a window whose reset has passed counts as unused, and an unprobed subscription has no score", () => {
  const now = new Date("2026-11-12T08:00:00Z");
  const usage = {
    fiveHour: { utilization: 0.9, resetsAt: "2026-11-12T07:00:00.000Z" },
    sevenDay: { utilization: 0.3, resetsAt: "2026-11-15T00:00:00.000Z" },
    probedAt: now.toISOString(),
  };
  expect(usageScore(usage, now)).toBe(0.3);
  expect(usageScore(undefined, now)).toBeUndefined();
});

// --- the pick ---------------------------------------------------------------------------------------------

test("a pool launch picks the subscription with the most headroom, the lower of its 5-hour and 7-day use being what counts", async () => {
  readings[DEFAULT_TOKEN] = { h5: 0.9, d7: 0.1 };
  readings[PERSONAL_TOKEN] = { h5: 0.8, d7: 0.1 };
  readings[WORK_TOKEN] = { h5: 0.2, d7: 0.5 };
  const r = await launchedRun(poolEnv());
  expect(r.file.CLAUDE_CODE_OAUTH_TOKEN).toBe(WORK_TOKEN);
  expect(JSON.stringify(r.file)).not.toContain(PERSONAL_TOKEN);
  expect(JSON.stringify(r.file)).not.toContain(API_KEY);
  expect(runRow(r.run.id)?.claudeCredential).toBe("work");
});

test("the probe is a one-token message from Claude Code on the OAuth beta, and its reading is stored", async () => {
  readings[DEFAULT_TOKEN] = { h5: 0.1, d7: 0.1 };
  readings[PERSONAL_TOKEN] = { h5: 0.3, d7: 0.2 };
  readings[WORK_TOKEN] = { h5: 0.4, d7: 0.2 };
  await launchedRun(poolEnv());
  expect(probes.map((p) => p.token).sort()).toEqual(
    [DEFAULT_TOKEN, PERSONAL_TOKEN, WORK_TOKEN].sort(),
  );
  const probe = probes[0];
  expect(probe?.beta).toBe("oauth-2025-04-20");
  expect(probe?.body).toMatchObject({
    model: PROBE_MODEL,
    max_tokens: 1,
    system: [{ type: "text", text: expect.stringContaining("Claude Code") }],
  });
  expect(storedUsage(db, "personal")).toMatchObject({
    fiveHour: { utilization: 0.3 },
    sevenDay: { utilization: 0.2 },
  });
  expect(db.select().from(claudeUsage).all()).toHaveLength(3);
});

test("a subscription the pool is limited on is skipped, however much headroom it shows", async () => {
  readings[DEFAULT_TOKEN] = { h5: 0.9, d7: 0.9 };
  readings[PERSONAL_TOKEN] = { h5: 0.7, d7: 0.7 };
  readings[WORK_TOKEN] = { h5: 0.0, d7: 0.0 };
  markLimited(db, "work", new Date(Date.now() + 3_600_000));
  const r = await launchedRun(poolEnv());
  expect(r.file.CLAUDE_CODE_OAUTH_TOKEN).toBe(PERSONAL_TOKEN);
  // a limited subscription isn't asked
  expect(probes.map((p) => p.token)).not.toContain(WORK_TOKEN);
});

test("a subscription the probe finds full is marked limited until its window resets, and skipped", async () => {
  readings[DEFAULT_TOKEN] = { h5: 1, h5Reset: inHours(2), d7: 0.2 };
  readings[PERSONAL_TOKEN] = { h5: 0.6, d7: 0.6 };
  readings[WORK_TOKEN] = { h5: 0.7, d7: 0.7 };
  const r = await launchedRun(poolEnv());
  expect(r.file.CLAUDE_CODE_OAUTH_TOKEN).toBe(PERSONAL_TOKEN);
  expect(limitedUntil(db, "default")).toBeDefined();
});

test("an explicit pool list is the only subscriptions used, and the order breaks a tie", async () => {
  readings[DEFAULT_TOKEN] = { h5: 0, d7: 0 };
  readings[PERSONAL_TOKEN] = { h5: 0.3, d7: 0.3 };
  readings[WORK_TOKEN] = { h5: 0.3, d7: 0.3 };
  const r = await launchedRun(poolEnv(["work", "personal"]));
  expect(r.file.CLAUDE_CODE_OAUTH_TOKEN).toBe(WORK_TOKEN);
  expect(probes.map((p) => p.token)).not.toContain(DEFAULT_TOKEN);
});

test("usage newer than a few minutes is reused, and older is asked for again", async () => {
  readings[PERSONAL_TOKEN] = { h5: 0.2, d7: 0.2 };
  readings[WORK_TOKEN] = { h5: 0.4, d7: 0.4 };
  const env = poolEnv(["personal", "work"]);
  await launchedRun(env);
  expect(probes).toHaveLength(2);
  await launchedRun(env);
  expect(probes).toHaveLength(2);
  db.update(claudeUsage)
    .set({
      probedAt: new Date(Date.now() - USAGE_STALE_MS - 1_000).toISOString(),
    })
    .run();
  await launchedRun(env);
  expect(probes).toHaveLength(4);
});

test("a probe that fails never fails the launch: that subscription just ranks after the ones that answered", async () => {
  readings[PERSONAL_TOKEN] = "broken";
  readings[WORK_TOKEN] = { h5: 0.95, d7: 0.5 };
  const r = await launchedRun(poolEnv(["personal", "work"]));
  expect(r.file.CLAUDE_CODE_OAUTH_TOKEN).toBe(WORK_TOKEN);
  expect(logs.join("\n")).toContain(
    "probing the usage of Claude credential personal failed",
  );
  expect(logs.join("\n")).not.toContain(PERSONAL_TOKEN);
});

// --- failover ---------------------------------------------------------------------------------------------

test.each([
  ["a 5-hour limit", FIVE_HOUR],
  ["a weekly limit", WEEKLY],
])(
  "%s fails the run over once to the next subscription, in the same session",
  async (_name, limit) => {
    readings[PERSONAL_TOKEN] = { h5: 0.1, d7: 0.1 };
    readings[WORK_TOKEN] = { h5: 0.5, d7: 0.5 };
    const r = await launchedRun(poolEnv(["personal", "work"]));
    expect(r.file.CLAUDE_CODE_OAUTH_TOKEN).toBe(PERSONAL_TOKEN);
    await failWith(r, limit);

    await sessionOpened(2);
    const retry = wire.sessions[1];
    const file = envFileOf(wire, retry);
    expect(file).toMatchObject({
      SKY_CLAUDE_AUTH: "oauth",
      CLAUDE_CODE_OAUTH_TOKEN: WORK_TOKEN,
    });
    expect(JSON.stringify(file)).not.toContain(API_KEY);
    expect(retry?.env.SESSION_ID).toBe("sess-1");
    expect(runRow(String(retry?.env.RUN_ID))).toMatchObject({
      claudeCredential: "work",
      retryOf: r.run.id,
      agentId: r.agent.id,
    });
    expect(limitedUntil(db, "personal")).toBeDefined();
    expect(limitedUntil(db, "work")).toBeUndefined();
  },
);

test("failover goes in the pool's order, and a limited subscription is not gone on to", async () => {
  readings[PERSONAL_TOKEN] = { h5: 0.1, d7: 0.1 };
  readings[WORK_TOKEN] = { h5: 0.2, d7: 0.2 };
  readings[DEFAULT_TOKEN] = { h5: 0.3, d7: 0.3 };
  const r = await launchedRun(poolEnv(["personal", "work", "default"]));
  markLimited(db, "work", new Date(Date.now() + 3_600_000));
  await failWith(r, FIVE_HOUR);
  await sessionOpened(2);
  expect(tokenOfFile(envFileOf(wire, wire.sessions[1]))).toBe(DEFAULT_TOKEN);
});

test("each subscription is tried once and the chain ends on the API key", async () => {
  readings[PERSONAL_TOKEN] = { h5: 0.1, d7: 0.1 };
  readings[WORK_TOKEN] = { h5: 0.2, d7: 0.2 };
  const r1 = await launchedRun(poolEnv(["personal", "work"]));
  await failWith(r1, FIVE_HOUR);
  await sessionOpened(2);
  const r2 = {
    run: { id: String(wire.sessions[1]?.env.RUN_ID) },
    file: envFileOf(wire, wire.sessions[1]),
  };
  await failWith(r2 as Awaited<ReturnType<typeof launchedRun>>, WEEKLY);
  await sessionOpened(3);
  expect(credentialsUsed()).toEqual(["personal", "work", "api-key"]);
  const last = envFileOf(wire, wire.sessions[2]);
  expect(last).toMatchObject({
    SKY_CLAUDE_AUTH: "api-key",
    SKY_CLAUDE_API_KEY: API_KEY,
  });
  expect(last).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");

  // a limit-shaped failure of the key's own run goes nowhere
  await postEvent(last.AGENT_TOKEN, {
    runId: wire.sessions[2]?.env.RUN_ID,
    type: "run.failed",
    payload: { error: FIVE_HOUR },
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(wire.sessions).toHaveLength(3);
  expect(runRow(String(wire.sessions[2]?.env.RUN_ID))?.retryOf).toBe(
    wire.sessions[1]?.env.RUN_ID,
  );
});

test("with no API key, the end of the pool is the failed run noting the earliest reset in UTC", async () => {
  buildApp({ anthropicApiKey: undefined });
  readings[PERSONAL_TOKEN] = { h5: 0.1, d7: 0.1 };
  readings[WORK_TOKEN] = { h5: 0.2, d7: 0.2 };
  const env = poolEnv(["personal", "work"]);
  const r1 = await launchedRun(env);
  await failWith(r1, "You've hit your 5-hour limit · resets Dec 29, 9am (UTC)");
  await sessionOpened(2);
  const second = String(wire.sessions[1]?.env.RUN_ID);
  await postEvent(envFileOf(wire, wire.sessions[1]).AGENT_TOKEN, {
    runId: second,
    type: "run.failed",
    payload: { error: WEEKLY },
  });
  await vi.waitFor(() => expect(warningsOf(second)).toHaveLength(1));
  const [warning] = warningsOf(second);
  expect(warning).toContain("pool is at its usage limit");
  expect(warning).toMatch(/earliest resets \d{4}-12-29T09:00:00\.000Z \(UTC\)/);
  expect(wire.sessions).toHaveLength(2);
});

test("claudeFallback none ends the pool without spending the key", async () => {
  readings[PERSONAL_TOKEN] = { h5: 0.1, d7: 0.1 };
  const r = await launchedRun(
    poolEnv(["personal"], { claudeFallback: "none" }),
  );
  await failWith(r, FIVE_HOUR);
  await vi.waitFor(() => expect(warningsOf(r.run.id)).toHaveLength(1));
  expect(wire.sessions).toHaveLength(1);
});

// --- launch with the pool used up ------------------------------------------------------------------------

test("with every subscription limited, a pool launch goes to the API key", async () => {
  const env = poolEnv(["personal", "work"]);
  markLimited(db, "personal", new Date(Date.now() + 3_600_000));
  markLimited(db, "work", new Date(Date.now() + 7_200_000));
  const r = await launchedRun(env);
  expect(r.file).toMatchObject({
    SKY_CLAUDE_AUTH: "api-key",
    SKY_CLAUDE_API_KEY: API_KEY,
  });
  expect(runRow(r.run.id)?.claudeCredential).toBe("api-key");
  expect(probes).toHaveLength(0);
});

test("with every subscription limited and no key, the launch fails at once naming the earliest reset", async () => {
  buildApp({ anthropicApiKey: undefined });
  const env = poolEnv(["personal", "work"]);
  const soon = new Date(Date.now() + 3_600_000);
  markLimited(db, "personal", new Date(Date.now() + 7_200_000));
  markLimited(db, "work", soon);
  const res = await call(admin, "POST", "/v1/agents", {
    envId: env,
    prompt: "go",
  });
  const { run } = (await res.json()) as Launched;
  await vi.waitFor(() => expect(runRow(run.id)?.status).toBe("failed"));
  const error = failureOf(run.id);
  expect(error).toContain("claude_limited");
  expect(error).toContain(soon.toISOString());
  expect(wire.sessions).toHaveLength(0);
});

// --- only a pool moves ---------------------------------------------------------------------------------------

test("an environment that isn't a pool never uses another subscription, however much headroom one has", async () => {
  readings[WORK_TOKEN] = { h5: 0, d7: 0 };
  readings[DEFAULT_TOKEN] = { h5: 0, d7: 0 };
  poolEnv();
  const env = readyEnv({ claudeCredential: "personal" });
  const r = await launchedRun(env);
  expect(r.file.CLAUDE_CODE_OAUTH_TOKEN).toBe(PERSONAL_TOKEN);

  await failWith(r, FIVE_HOUR);
  await sessionOpened(2);
  // the retry is on the key, as before, and a second limit goes nowhere
  expect(credentialsUsed()).toEqual(["personal", "api-key"]);

  markLimited(db, "personal", new Date(Date.now() + 3_600_000));
  const next = await launchedRun(env);
  expect(next.file.SKY_CLAUDE_API_KEY).toBe(API_KEY);
  for (const session of wire.sessions) {
    const text = JSON.stringify(envFileOf(wire, session));
    expect(text).not.toContain(WORK_TOKEN);
    expect(text).not.toContain(DEFAULT_TOKEN);
  }
  // no pool, no probe
  expect(probes).toHaveLength(0);
});

test("a non-pool environment with no key fails a limited launch rather than move to another subscription", async () => {
  buildApp({ anthropicApiKey: undefined });
  const env = readyEnv({ claudeCredential: "personal" });
  markLimited(db, "personal", new Date(Date.now() + 3_600_000));
  const res = await call(admin, "POST", "/v1/agents", {
    envId: env,
    prompt: "go",
  });
  const { run } = (await res.json()) as Launched;
  await vi.waitFor(() => expect(runRow(run.id)?.status).toBe("failed"));
  expect(failureOf(run.id)).toContain("claude_limited");
  expect(wire.sessions).toHaveLength(0);
  expect(probes).toHaveLength(0);
});

// --- the env API and the list ----------------------------------------------------------------------------------

test("an admin makes an environment a pool, with or without a list; leaving the pool drops the list", async () => {
  const id = readyEnv();
  const set = await call(admin, "PATCH", `/v1/environments/${id}`, {
    claudeCredential: "pool",
    claudePool: ["work", "personal"],
  });
  expect(await set.json()).toMatchObject({
    claudeCredential: "pool",
    claudePool: ["work", "personal"],
  });
  const all = await call(admin, "PATCH", `/v1/environments/${id}`, {
    claudePool: null,
  });
  expect(await all.json()).toMatchObject({
    claudeCredential: "pool",
    claudePool: null,
  });
  await call(admin, "PATCH", `/v1/environments/${id}`, {
    claudePool: ["work"],
  });
  const left = await call(admin, "PATCH", `/v1/environments/${id}`, {
    claudeCredential: "personal",
  });
  expect(await left.json()).toMatchObject({
    claudeCredential: "personal",
    claudePool: null,
  });
});

test("a pool list without the pool assignment, or naming a subscription the server lacks, is refused", async () => {
  const id = readyEnv();
  const noPool = await call(admin, "PATCH", `/v1/environments/${id}`, {
    claudePool: ["work"],
  });
  expect(noPool.status).toBe(400);
  expect(await noPool.json()).toMatchObject({
    error: { code: "invalid_pool" },
  });
  const unknown = await call(admin, "PATCH", `/v1/environments/${id}`, {
    claudeCredential: "pool",
    claudePool: ["work", "nobody"],
  });
  expect(unknown.status).toBe(400);
  const created = await call(admin, "POST", "/v1/environments", {
    name: "kru",
    repo: "acme/kru",
    setup: "true",
    claudeCredential: "pool",
    claudePool: ["personal"],
  });
  expect(created.status).toBe(202);
  expect(await created.json()).toMatchObject({
    claudeCredential: "pool",
    claudePool: ["personal"],
  });
});

test("a runs key can't make an environment a pool", async () => {
  const id = readyEnv();
  const minted = await call(admin, "POST", "/v1/keys", {
    name: "ci",
    role: "runs",
    environmentIds: [id],
  });
  const key = `Bearer ${CreatedApiKey.parse(await minted.json()).secret}`;
  const res = await call(key, "PATCH", `/v1/environments/${id}`, {
    claudeCredential: "pool",
  });
  expect(res.status).toBe(403);
});

test("a token variable named pool is refused by the config", () => {
  const result = loadConfig({
    SKY_API_KEY: "k".repeat(40),
    SPRITES_TOKEN: "t",
    DATA_DIR: "/d",
    CLAUDE_CODE_OAUTH_TOKEN: "x",
    PUBLIC_BASE_URL: "https://sky.example.com",
    WEBHOOK_SIGNING_KEY: "w".repeat(32),
    SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    CLAUDE_OAUTH_TOKEN_POOL: "never-echoed",
  });
  expect(result).toEqual({
    ok: false,
    message: expect.stringContaining("CLAUDE_OAUTH_TOKEN_POOL is invalid"),
  });
});

test("the credential list shows each subscription's last-seen usage and the pool environments that may use it", async () => {
  readings[PERSONAL_TOKEN] = { h5: 0.25, d7: 0.5 };
  readings[WORK_TOKEN] = { h5: 0.75, d7: 0.5 };
  const pooled = poolEnv(["personal", "work"], { name: "pooled" });
  poolEnv(["work"], { name: "narrow" });
  await launchedRun(pooled);
  const res = await call(admin, "GET", "/v1/claude-credentials");
  const data = ((await res.json()) as { data: Record<string, unknown>[] }).data;
  const by = (name: string) => data.find((c) => c.name === name);
  expect(by("personal")).toMatchObject({
    usage: {
      fiveHour: { utilization: 0.25 },
      sevenDay: { utilization: 0.5 },
    },
    poolEnvironments: [{ id: pooled, name: "pooled" }],
  });
  expect(by("work")?.poolEnvironments).toHaveLength(2);
  expect(by("default")).toMatchObject({ usage: null, poolEnvironments: [] });
  expect(by("api-key")).toMatchObject({ usage: null, poolEnvironments: [] });
  expect(JSON.stringify(data)).not.toContain(PERSONAL_TOKEN);
});

test("no token or key appears in the logs, events or API output of a pool run", async () => {
  readings[PERSONAL_TOKEN] = { h5: 0.1, d7: 0.1 };
  readings[WORK_TOKEN] = "broken";
  const r = await launchedRun(poolEnv(["personal", "work"]));
  await failWith(r, `${FIVE_HOUR} ${PERSONAL_TOKEN} ${WORK_TOKEN} ${API_KEY}`);
  await sessionOpened(2);
  const stored = JSON.stringify(db.select().from(events).all());
  const api = await (
    await call(admin, "GET", `/v1/agents/${r.agent.id}/runs/${r.run.id}`)
  ).text();
  for (const value of [PERSONAL_TOKEN, WORK_TOKEN, API_KEY, DEFAULT_TOKEN]) {
    expect(stored).not.toContain(value);
    expect(api).not.toContain(value);
    expect(logs.join("\n")).not.toContain(value);
  }
});

/** Runs `change` while the retry of `failedId` waits for that run's runner to exit. */
function duringRetryWait(failedId: string, change: () => void) {
  const exec = wire.exec;
  wire.exec = (argv) => {
    // awaitRunnerExit's `bash -c <script> _ <pattern naming the run>`
    if (argv[0] === "bash" && argv[3] === "_" && argv[4]?.includes(failedId)) {
      change();
    }
    return exec(argv);
  };
}

const retryOf = (failedId: string) =>
  db
    .select()
    .from(runs)
    .where(eq(runs.retryOf, failedId as RunId))
    .get();

test("a pool environment switched to its own subscription while a retry waits retries on that one, not the next in the old pool", async () => {
  readings[PERSONAL_TOKEN] = { h5: 0.1, d7: 0.1 };
  readings[WORK_TOKEN] = { h5: 0.2, d7: 0.2 };
  const env = poolEnv(["personal", "work"]);
  const r = await launchedRun(env);
  duringRetryWait(r.run.id, () =>
    db
      .update(environments)
      .set({ claudeCredential: "default", claudePool: null })
      .where(eq(environments.id, env))
      .run(),
  );
  await failWith(r, FIVE_HOUR);
  await sessionOpened(2);
  expect(credentialsUsed()).toEqual(["personal", "default"]);
  expect(JSON.stringify(envFileOf(wire, wire.sessions[1]))).not.toContain(
    WORK_TOKEN,
  );
});

test("a pool environment whose pool drops the next subscription while a retry waits does not retry on it", async () => {
  readings[PERSONAL_TOKEN] = { h5: 0.1, d7: 0.1 };
  readings[WORK_TOKEN] = { h5: 0.2, d7: 0.2 };
  readings[DEFAULT_TOKEN] = { h5: 0.3, d7: 0.3 };
  const env = poolEnv(["personal", "work"]);
  const r = await launchedRun(env);
  duringRetryWait(r.run.id, () =>
    db
      .update(environments)
      .set({ claudePool: ["personal", "default"] })
      .where(eq(environments.id, env))
      .run(),
  );
  await failWith(r, FIVE_HOUR);
  await sessionOpened(2);
  expect(credentialsUsed()).toEqual(["personal", "default"]);
});

test("an environment whose API key fallback is turned off while a retry waits does not retry on the key", async () => {
  const env = readyEnv({ claudeCredential: "personal" });
  const r = await launchedRun(env);
  duringRetryWait(r.run.id, () =>
    db
      .update(environments)
      .set({ claudeFallback: "none" })
      .where(eq(environments.id, env))
      .run(),
  );
  await failWith(r, FIVE_HOUR);
  // the retry is refused as a fresh launch would be: personal is limited and the key is off
  await vi.waitFor(() => expect(retryOf(r.run.id)?.status).toBe("failed"));
  const retry = retryOf(r.run.id);
  expect(failureOf(String(retry?.id))).toContain("claude_limited");
  expect(wire.sessions).toHaveLength(1);
});

test("a subscription already tried in a run's chain is not tried again, even once its limit has lifted", async () => {
  readings[PERSONAL_TOKEN] = { h5: 0.1, d7: 0.1 };
  readings[WORK_TOKEN] = { h5: 0.2, d7: 0.2 };
  const r1 = await launchedRun(poolEnv(["personal", "work"]));
  await failWith(r1, FIVE_HOUR);
  await sessionOpened(2);
  // personal's window resets while the retry on work runs
  markLimited(db, "personal", new Date(Date.now() - 1_000));
  await failWith(
    {
      run: { id: String(wire.sessions[1]?.env.RUN_ID) },
      file: envFileOf(wire, wire.sessions[1]),
    } as Awaited<ReturnType<typeof launchedRun>>,
    FIVE_HOUR,
  );
  await sessionOpened(3);
  expect(credentialsUsed()).toEqual(["personal", "work", "api-key"]);
});
