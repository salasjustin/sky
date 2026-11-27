import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpritesClient } from "@fly/sprites";
import { type Db, environments, events, migrate, openDb, runs } from "@sky/db";
import type { EnvironmentId, RunId } from "@sky/shared";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createApp } from "./app.js";
import {
  apiKeyAuth,
  apiKeyCredentials,
  markLimited,
  nextApiKey,
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
const PLAIN_KEY = "plain-api-key-opaque-2";
const BACKUP_KEY = "backup-api-key-opaque-3";
const SPARE_KEY = "spare-api-key-opaque-4";
const CREDIT_LOW =
  "Claude Code returned an error result: Credit balance is too low";

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
    anthropicApiKey: PLAIN_KEY,
    // declared out of order: the try order is by name
    anthropicApiKeys: { spare: SPARE_KEY, backup: BACKUP_KEY },
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
  dir = mkdtempSync(join(tmpdir(), "sky-api-keys-"));
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
      ...overrides,
    })
    .run();
  wire.sprites.add(spriteNameFor(id));
  return id;
}

type Launched = { agent: { id: string }; run: { id: string } };

const sessionOpened = (count: number) =>
  vi.waitFor(() => expect(wire.sessions).toHaveLength(count));

/** Launches a run and returns the env file its runner was handed. */
async function launchedRun(envId: EnvironmentId) {
  const before = wire.sessions.length;
  const res = await call("POST", "/v1/agents", { envId, prompt: "go" });
  expect(res.status).toBe(202);
  const ids = (await res.json()) as Launched;
  await sessionOpened(before + 1);
  return { ...ids, file: envFileOf(wire, wire.sessions[before]) };
}

/** A launch whose runner never starts: the run's stored error once it fails. */
async function refused(envId: string) {
  const res = await call("POST", "/v1/agents", { envId, prompt: "go" });
  expect(res.status).toBe(202);
  const { run } = (await res.json()) as Launched;
  await vi.waitFor(() => expect(runRow(run.id)?.status).toBe("failed"));
  return failureOf(run.id);
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

/** A started run reports `error` as its failure. */
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

const failureOf = (runId: string) => {
  const row = db
    .select({ payload: events.payload })
    .from(events)
    .where(and(eq(events.runId, runId as RunId), eq(events.type, "run.failed")))
    .get();
  return String((row?.payload as { error?: string } | undefined)?.error);
};

const credentialsOf = async () => {
  const res = await call("GET", "/v1/claude-credentials");
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Record<string, unknown>[] }).data;
};

const clearCredit = (name: string) =>
  call(
    "POST",
    `/v1/claude-credentials/${encodeURIComponent(name)}/clear-credit`,
  );

// --- the keys ------------------------------------------------------------------------------------------

test("the plain key is tried first, then the named keys by name", () => {
  expect(apiKeyCredentials(config)).toEqual([
    "api-key",
    "api-key:backup",
    "api-key:spare",
  ]);
  expect(apiKeyCredentials({ ...config, anthropicApiKey: undefined })).toEqual([
    "api-key:backup",
    "api-key:spare",
  ]);
  const none = { outOfCredit: () => false };
  expect(nextApiKey(config, none)).toBe("api-key");
  expect(nextApiKey(config, none, ["api-key"])).toBe("api-key:backup");
  expect(nextApiKey(config, none, [], "api-key:spare")).toBe("api-key:spare");
  expect(
    nextApiKey(config, { outOfCredit: (c) => c !== "api-key:spare" }),
  ).toBe("api-key:spare");
  expect(nextApiKey(config, { outOfCredit: () => true })).toBeUndefined();
});

test("an API key is handed over by its name, and a credential no key matches is refused", () => {
  expect(apiKeyAuth(config, "the retry", undefined, "api-key:backup")).toEqual({
    kind: "api-key",
    credential: "api-key:backup",
    key: BACKUP_KEY,
  });
  expect(() =>
    apiKeyAuth(config, "the env", { outOfCredit: () => true }),
  ).toThrow(/^claude_unavailable: .*all Anthropic API keys are out of credit/);
  expect(() =>
    apiKeyAuth(
      { ...config, anthropicApiKey: undefined, anthropicApiKeys: {} },
      "the env",
    ),
  ).toThrow(/^claude_credential_missing: /);
});

test("api-key:default is the plain key: stored as api-key and listed under it", async () => {
  const created = await call("POST", "/v1/environments", {
    name: "kru",
    repo: "acme/kru",
    setup: "true",
    claudeCredential: "api-key:default",
  });
  expect(created.status).toBe(202);
  const made = (await created.json()) as {
    id: string;
    claudeCredential: string;
  };
  expect(made.claudeCredential).toBe("api-key");

  const envId = readyEnv();
  const patched = await call("PATCH", `/v1/environments/${envId}`, {
    claudeCredential: "api-key:default",
  });
  expect(patched.status).toBe(200);
  expect(await patched.json()).toMatchObject({ claudeCredential: "api-key" });
  expect(
    db
      .select({ credential: environments.claudeCredential })
      .from(environments)
      .where(eq(environments.id, envId))
      .get()?.credential,
  ).toBe("api-key");

  const plain = (await credentialsOf()).find((c) => c.name === "api-key");
  if (!plain) throw new Error("the plain key is missing from the list");
  expect(
    (plain.environments as { id: string }[]).map((e) => e.id).sort(),
  ).toEqual([made.id, envId].sort());
});

test("with every key out of credit the error names a clear-credit command for each key", () => {
  const recovery =
    "top the keys up, then clear their marks with sky claude-credentials clear-credit default, sky claude-credentials clear-credit backup and sky claude-credentials clear-credit spare (or restart the API, which a new key secret does)";
  expect(() =>
    apiKeyAuth(config, "the env", { outOfCredit: () => true }),
  ).toThrow(recovery);
  expect(() =>
    apiKeyAuth({ ...config, anthropicApiKeys: {} }, "the env", {
      outOfCredit: () => true,
    }),
  ).toThrow(
    "top the key up, then clear its mark with sky claude-credentials clear-credit default (or restart",
  );
});

test("redaction knows every named API key", () => {
  const known = KnownSecrets.fromConfig(config).values();
  for (const value of [PLAIN_KEY, BACKUP_KEY, SPARE_KEY]) {
    expect(known).toContain(value);
  }
});

test("an environment assigned a named key runs on it, recorded as api-key:<name>", async () => {
  const r = await launchedRun(readyEnv({ claudeCredential: "api-key:backup" }));
  expect(r.file).toMatchObject({
    SKY_CLAUDE_AUTH: "api-key",
    SKY_CLAUDE_API_KEY: BACKUP_KEY,
  });
  expect(JSON.stringify(r.file)).not.toContain(PLAIN_KEY);
  expect(runRow(r.run.id)?.claudeCredential).toBe("api-key:backup");
});

test("assigning a key the server doesn't hold is refused", async () => {
  const envId = readyEnv();
  const res = await call("PATCH", `/v1/environments/${envId}`, {
    claudeCredential: "api-key:missing",
  });
  expect(res.status).toBe(400);
  expect(await res.text()).toContain("SKY_ANTHROPIC_API_KEY_MISSING");
});

// --- moving to the next key ------------------------------------------------------------------------------

test("a credit failure on the first key retries the run on the next key, in the same session", async () => {
  const envId = readyEnv({ claudeCredential: "api-key" });
  const first = await launchedRun(envId);
  expect(first.file.SKY_CLAUDE_API_KEY).toBe(PLAIN_KEY);
  await failWith(first, CREDIT_LOW);

  await sessionOpened(2);
  const second = envFileOf(wire, wire.sessions[1]);
  expect(second).toMatchObject({
    SKY_CLAUDE_AUTH: "api-key",
    SKY_CLAUDE_API_KEY: BACKUP_KEY,
  });
  expect(wire.sessions[1]?.env.SESSION_ID).toBe("sess-1");
  expect(runRow(String(wire.sessions[1]?.env.RUN_ID))).toMatchObject({
    claudeCredential: "api-key:backup",
    retryOf: first.run.id,
  });
  // the failed run keeps its own error: another key took over, so nothing is unavailable
  expect(failureOf(first.run.id)).toBe(CREDIT_LOW);
  const data = await credentialsOf();
  expect(data.map((c) => [c.name, c.outOfCredit])).toEqual([
    ["default", false],
    ["api-key", true],
    ["api-key:backup", false],
    ["api-key:spare", false],
  ]);
});

test("a limited subscription falls back on the first key with credit", async () => {
  const envId = readyEnv();
  markLimited(db, "default", new Date(Date.now() + 3_600_000));
  const a = await launchedRun(readyEnv({ claudeCredential: "api-key" }));
  await failWith(a, CREDIT_LOW);
  await sessionOpened(2);

  const r = await launchedRun(envId);
  expect(r.file.SKY_CLAUDE_API_KEY).toBe(BACKUP_KEY);
  expect(runRow(r.run.id)?.claudeCredential).toBe("api-key:backup");
});

test("with every key out of credit the run fails claude_unavailable with the switch command, and the next launch fails at once", async () => {
  const envId = readyEnv({ claudeCredential: "api-key" });
  const first = await launchedRun(envId);
  await failWith(first, CREDIT_LOW);
  await sessionOpened(2);
  const second = {
    run: { id: String(wire.sessions[1]?.env.RUN_ID) },
    file: envFileOf(wire, wire.sessions[1]),
  };
  await failWith(second as Awaited<ReturnType<typeof launchedRun>>, CREDIT_LOW);
  await sessionOpened(3);
  const third = {
    run: { id: String(wire.sessions[2]?.env.RUN_ID) },
    file: envFileOf(wire, wire.sessions[2]),
  };
  expect(third.file.SKY_CLAUDE_API_KEY).toBe(SPARE_KEY);
  await failWith(third as Awaited<ReturnType<typeof launchedRun>>, CREDIT_LOW);

  const error = failureOf(third.run.id);
  expect(error).toMatch(/^claude_unavailable: /);
  expect(error).toContain("all Anthropic API keys are out of credit");
  expect(error.endsWith(`sky env set-runtime ${envId} codex`)).toBe(true);
  // no fourth runner
  expect(wire.sessions).toHaveLength(3);

  const next = await refused(envId);
  expect(next).toMatch(/^claude_unavailable: /);
  expect(next).toContain("all Anthropic API keys are out of credit");
  expect(next.endsWith(`sky env set-runtime ${envId} codex`)).toBe(true);
  expect(wire.sessions).toHaveLength(3);
  const data = await credentialsOf();
  expect(
    data.filter((c) => c.kind === "api-key").map((c) => c.outOfCredit),
  ).toEqual([true, true, true]);
});

test("a retry skips a key its chain already tried, even once that key's mark is cleared", async () => {
  const envId = readyEnv({ claudeCredential: "api-key" });
  const first = await launchedRun(envId);
  expect(first.file.SKY_CLAUDE_API_KEY).toBe(PLAIN_KEY);
  await failWith(first, CREDIT_LOW);
  await sessionOpened(2);
  const second = {
    run: { id: String(wire.sessions[1]?.env.RUN_ID) },
    file: envFileOf(wire, wire.sessions[1]),
  };
  expect(second.file.SKY_CLAUDE_API_KEY).toBe(BACKUP_KEY);

  // the plain key is topped up and cleared while the retry is running on backup
  expect((await clearCredit("api-key")).status).toBe(200);
  await failWith(second as Awaited<ReturnType<typeof launchedRun>>, CREDIT_LOW);

  await sessionOpened(3);
  expect(envFileOf(wire, wire.sessions[2]).SKY_CLAUDE_API_KEY).toBe(SPARE_KEY);
  expect(wire.sessions).toHaveLength(3);
});

test("a run finishing on a key does not clear its mark, and clear-credit clears only that key", async () => {
  const envId = readyEnv({ claudeCredential: "api-key", concurrency: 2 });
  const old = await launchedRun(envId);
  const failing = await launchedRun(envId);
  await postEvent(old.file.AGENT_TOKEN, {
    runId: old.run.id,
    type: "run.started",
    payload: { sessionId: "sess-old" },
  });
  await failWith(failing, CREDIT_LOW);
  await sessionOpened(3);

  // `old` began on the plain key before it ran out and finishes after
  const finished = await postEvent(old.file.AGENT_TOKEN, {
    runId: old.run.id,
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
  expect(finished.status).toBe(201);
  const marks = async () =>
    (await credentialsOf())
      .filter((c) => c.kind === "api-key")
      .map((c) => [c.name, c.outOfCredit]);
  expect(await marks()).toEqual([
    ["api-key", true],
    ["api-key:backup", false],
    ["api-key:spare", false],
  ]);

  const cleared = await clearCredit("api-key");
  expect(cleared.status).toBe(200);
  expect(await cleared.json()).toEqual({
    name: "api-key",
    outOfCredit: false,
    wasOutOfCredit: true,
  });
  expect((await marks()).map(([, out]) => out)).toEqual([false, false, false]);
  // clearing a key that wasn't marked says so
  expect(await (await clearCredit("api-key")).json()).toMatchObject({
    wasOutOfCredit: false,
  });
});

test("clear-credit takes a named key by its bare name or its credential, and refuses one the server doesn't hold", async () => {
  const envId = readyEnv({ claudeCredential: "api-key:backup" });
  const r = await launchedRun(envId);
  await failWith(r, CREDIT_LOW);
  await sessionOpened(2);
  const marked = async () =>
    (await credentialsOf()).find((c) => c.name === "api-key:backup")
      ?.outOfCredit;
  expect(await marked()).toBe(true);
  expect((await clearCredit("backup")).status).toBe(200);
  expect(await marked()).toBe(false);

  expect(await (await clearCredit("api-key:backup")).json()).toMatchObject({
    name: "api-key:backup",
    wasOutOfCredit: false,
  });
  const unknown = await clearCredit("nope");
  expect(unknown.status).toBe(404);
  expect(await unknown.text()).toContain("api-key:backup");
});

test("no API key value reaches an API response, a stored error or the log", async () => {
  const envId = readyEnv({ claudeCredential: "api-key" });
  const r = await launchedRun(envId);
  await failWith(r, `${CREDIT_LOW} (key ${BACKUP_KEY}, key ${SPARE_KEY})`);
  await sessionOpened(2);
  const second = {
    run: { id: String(wire.sessions[1]?.env.RUN_ID) },
    file: envFileOf(wire, wire.sessions[1]),
  };
  await failWith(
    second as Awaited<ReturnType<typeof launchedRun>>,
    `${CREDIT_LOW} (key ${PLAIN_KEY})`,
  );
  const stored = [failureOf(r.run.id), failureOf(second.run.id)].join("\n");
  const api = [
    JSON.stringify(await credentialsOf()),
    await (await call("GET", "/v1/environments")).text(),
  ].join("\n");
  for (const value of [PLAIN_KEY, BACKUP_KEY, SPARE_KEY]) {
    expect(stored).not.toContain(value);
    expect(api).not.toContain(value);
    expect(logs.join("\n")).not.toContain(value);
  }
});
