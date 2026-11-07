import { SpritesClient } from "@fly/sprites";
import { agents, type Db, environments, migrate, openDb, runs } from "@sky/db";
import type { AgentId, RunId } from "@sky/shared";
import { afterEach, beforeEach, expect, test } from "vitest";
import { mintAgentToken } from "./agent-token.js";
import { createApp } from "./app.js";
import { runEvents } from "./run-events.js";
import { failStaleRuns } from "./runs.js";
import { spriteNameFor } from "./sprites.js";
import {
  type SpritesWire,
  spritesToken,
  stubSprites,
  testConfig,
} from "./testing/sprites.js";
import { type Frame, sseReader } from "./testing/sse.js";

const config = testConfig();
const auth = { Authorization: `Bearer ${config.apiKey}` };
let db: Db;
let app: ReturnType<typeof createApp>;
let wire: SpritesWire;
let closing: AbortController;

beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
  wire = stubSprites();
  closing = new AbortController();
  app = createApp({
    db,
    config,
    sprites: new SpritesClient(spritesToken),
    log: () => {},
    nudgeDeliveries: () => {},
    heartbeatMs: 50,
    closing: closing.signal,
  });
});
afterEach(() => {
  if (db.$client.open) db.$client.close();
});

/** A running run on a fresh agent, inserted directly so no sprite is involved. */
function runningRun() {
  const n = Math.random().toString(36).slice(2);
  const envId = `env_${n}` as const;
  const agentId = `agt_${n}` as AgentId;
  const runId = `run_${n}` as RunId;
  db.insert(environments)
    .values({
      id: envId,
      name: envId,
      repo: "acme/kru",
      setup: "",
      status: "ready",
      spriteName: spriteNameFor(envId),
      checkpointId: "v1",
    })
    .run();
  wire.sprites.add(spriteNameFor(envId));
  db.insert(agents)
    .values({
      id: agentId,
      envId,
      branch: `claude/${agentId}`,
      status: "running",
    })
    .run();
  db.insert(runs).values({ id: runId, agentId, status: "running" }).run();
  return { agentId, envId, runId, token: mintAgentToken(config.apiKey, runId) };
}

async function post(runId: RunId, type: string, payload: object) {
  const res = await app.request("/internal/events", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${mintAgentToken(config.apiKey, runId)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ runId, type, payload }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: number }).id;
}

const say = (runId: RunId, message: string) =>
  post(runId, "claude.Message", { text: message });

const stream = (
  agentId: AgentId,
  runId: RunId,
  headers: Record<string, string> = {},
  query = "",
) =>
  app.request(`/v1/agents/${agentId}/runs/${runId}/stream${query}`, {
    headers: { ...auth, ...headers },
  });

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  expect(check()).toBe(true);
};

test("a reconnect with Last-Event-ID continues at the next event with no gap or duplicate", async () => {
  const { agentId, envId, runId } = runningRun();
  const ids = [];
  for (const m of ["one", "two", "three", "four", "five"]) {
    ids.push(await say(runId, m));
  }
  const first = await stream(agentId, runId);
  expect(first.status).toBe(200);
  expect(first.headers.get("content-type")).toMatch(/^text\/event-stream/);
  const a = sseReader(first);
  const seen: Frame[] = [];
  for (let i = 0; i < 3; i++) seen.push((await a.event()) as Frame);
  await a.cancel();
  expect(seen.map((f) => f.id)).toEqual(ids.slice(0, 3).map(String));

  const second = await stream(agentId, runId, {
    "Last-Event-ID": String(ids[2]),
  });
  const b = sseReader(second);
  const fourth = await b.event();
  expect(fourth).toEqual({
    id: String(ids[3]),
    event: "claude.Message",
    data: expect.any(String),
  });
  expect(JSON.parse(fourth?.data ?? "")).toEqual({
    id: `evt_${ids[3]}`,
    agentId,
    environmentId: envId,
    runId,
    ts: expect.any(String),
    type: "claude.Message",
    payload: { text: "four" },
  });
  expect((await b.event())?.id).toBe(String(ids[4]));
  const live = await say(runId, "six");
  expect((await b.event())?.id).toBe(String(live));
  await b.cancel();
});

test("a client disconnect releases its listener", async () => {
  const { agentId, runId } = runningRun();
  await say(runId, "one");
  const s = sseReader(await stream(agentId, runId));
  await s.event();
  expect(runEvents.listenerCount(runId)).toBe(1);
  await s.cancel();
  await until(() => runEvents.listenerCount(runId) === 0);
});

test("closing ends a live run stream with a shutdown frame and releases its listener", async () => {
  const { agentId, runId } = runningRun();
  const id = await say(runId, "one");
  const s = sseReader(await stream(agentId, runId));
  expect((await s.event())?.id).toBe(String(id));
  closing.abort();
  expect(await s.event()).toEqual({
    event: "server.shutdown",
    retry: "2000",
    data: '{"reason":"shutdown"}',
  });
  expect(await s.next()).toBeNull();
  await until(() => runEvents.listenerCount(runId) === 0);
});

/** An app whose stream-failure log lines land in the returned array; the request logger's lines are left out. */
function loggingApp() {
  const lines: string[] = [];
  app = createApp({
    db,
    config,
    sprites: new SpritesClient(spritesToken),
    log: (line) => {
      if (line.startsWith("streaming ")) lines.push(line);
    },
    nudgeDeliveries: () => {},
    heartbeatMs: 50,
    closing: closing.signal,
  });
  return lines;
}

test("closing after a client has disconnected logs no stream failure and leaves no listener", async () => {
  const lines = loggingApp();
  const { agentId, runId } = runningRun();
  const id = await say(runId, "one");
  const s = sseReader(await stream(agentId, runId));
  expect((await s.event())?.id).toBe(String(id));
  await s.cancel();
  closing.abort();
  await until(() => runEvents.listenerCount(runId) === 0);
  // let the handler's finally block and any late write failure run
  await new Promise((r) => setTimeout(r, 100));
  expect(lines).toEqual([]);
});

test("a read that throws mid-stream is logged against the run", async () => {
  const lines = loggingApp();
  const { agentId, runId } = runningRun();
  const s = sseReader(await stream(agentId, runId));
  await until(() => runEvents.listenerCount(runId) === 1);
  db.$client.close();
  runEvents.publish(runId);
  await until(() => lines.length > 0);
  expect(lines[0]).toMatch(new RegExp(`^streaming ${runId} failed: `));
  await s.cancel();
});

test("a quiet stream sends heartbeat comments", async () => {
  const { agentId, runId } = runningRun();
  const s = sseReader(await stream(agentId, runId));
  expect(await s.next()).toEqual({ comment: "ping" });
  await s.cancel();
});

/** Every event frame until the stream ends. */
async function rest(s: ReturnType<typeof sseReader>) {
  const frames: Frame[] = [];
  for (let f = await s.event(); f; f = await s.event()) frames.push(f);
  return frames;
}

test("the stream closes after the run's terminal event and lets go of its listener", async () => {
  const { agentId, runId } = runningRun();
  const s = sseReader(await stream(agentId, runId));
  await until(() => runEvents.listenerCount(runId) === 1);
  await say(runId, "working");
  await post(runId, "run.finished", {
    summary: "done",
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
      turns: 1,
      durationMs: 1,
    },
  });
  expect((await rest(s)).map((f) => f.event)).toEqual([
    "claude.Message",
    "run.finished",
  ]);
  expect(runEvents.listenerCount(runId)).toBe(0);
});

test("an ended run's stream replays from the cursor and closes", async () => {
  const { agentId, runId } = runningRun();
  const first = await say(runId, "one");
  await say(runId, "two");
  const failed = await post(runId, "run.failed", { error: "boom" });
  const s = sseReader(await stream(agentId, runId, {}, `?after=${first}`));
  expect((await rest(s)).map((f) => f.event)).toEqual([
    "claude.Message",
    "run.failed",
  ]);
  const past = sseReader(
    await stream(agentId, runId, { "Last-Event-ID": String(failed) }),
  );
  expect(await rest(past)).toEqual([]);
});

test("Last-Event-ID wins over a stale ?after= from the original URL", async () => {
  const { agentId, runId } = runningRun();
  const one = await say(runId, "one");
  const two = await say(runId, "two");
  const three = await say(runId, "three");
  const s = sseReader(
    await stream(
      agentId,
      runId,
      { "Last-Event-ID": String(two) },
      `?after=${one}`,
    ),
  );
  expect((await s.event())?.id).toBe(String(three));
  await s.cancel();
});

test("a stop ends a live stream with run.stopped", async () => {
  const { agentId, runId } = runningRun();
  const s = sseReader(await stream(agentId, runId));
  await until(() => runEvents.listenerCount(runId) === 1);
  const res = await app.request(`/v1/agents/${agentId}/stop`, {
    method: "POST",
    headers: auth,
  });
  expect(res.status).toBe(200);
  expect((await rest(s)).map((f) => f.event)).toEqual(["run.stopped"]);
});

test("the inactivity sweep ends a live stream with run.failed", async () => {
  const { agentId, runId } = runningRun();
  const s = sseReader(await stream(agentId, runId));
  await until(() => runEvents.listenerCount(runId) === 1);
  expect(failStaleRuns(db, 0, Date.now() + 1000)).toEqual([runId]);
  const [failed, ...after] = await rest(s);
  expect(failed?.event).toBe("run.failed");
  expect(JSON.parse(failed?.data ?? "").payload).toEqual({
    error: "runner_timeout",
  });
  expect(after).toEqual([]);
});

test("a stream without a bearer gets 401 and subscribes nothing", async () => {
  const { agentId, runId } = runningRun();
  const res = await app.request(`/v1/agents/${agentId}/runs/${runId}/stream`);
  expect(res.status).toBe(401);
  expect(runEvents.listenerCount(runId)).toBe(0);
});

test("a run under another agent gets 404", async () => {
  const { runId } = runningRun();
  const other = runningRun();
  const res = await stream(other.agentId, runId);
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({
    error: { code: "not_found", message: "no such run" },
  });
});

test.each([
  ["a Last-Event-ID", { "Last-Event-ID": "evt_3" }, ""],
  ["an ?after=", {}, "?after=-1"],
])("%s that isn't an event row id gets 400", async (_, headers, query) => {
  const { agentId, runId } = runningRun();
  const res = await stream(agentId, runId, headers, query);
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: { code: "invalid_cursor" } });
});
