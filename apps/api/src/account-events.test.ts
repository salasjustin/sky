import { SpritesClient } from "@fly/sprites";
import { agents, type Db, environments, migrate, openDb, runs } from "@sky/db";
import type { AgentId, RunId } from "@sky/shared";
import {
  afterEach,
  beforeEach,
  expect,
  type MockInstance,
  test,
  vi,
} from "vitest";
import { mintAgentToken } from "./agent-token.js";
import { createApp } from "./app.js";
import { anyRun, runEvents } from "./run-events.js";
import { recordEvent } from "./runs.js";
import { spriteNameFor } from "./sprites.js";
import {
  type SpritesWire,
  spritesToken,
  stubSprites,
  testConfig,
} from "./testing/sprites.js";
import { sseReader } from "./testing/sse.js";

const config = testConfig();
const auth = { Authorization: `Bearer ${config.apiKey}` };
let db: Db;
let app: ReturnType<typeof createApp>;
let wire: SpritesWire;
let closing: AbortController;

const subscriptions: (() => void)[] = [];
let subscribeSpy: MockInstance<typeof runEvents.subscribe>;

beforeEach(() => {
  const subscribe = runEvents.subscribe;
  subscribeSpy = vi
    .spyOn(runEvents, "subscribe")
    .mockImplementation((channel, listener) => {
      const unsubscribe = subscribe(channel, listener);
      subscriptions.push(unsubscribe);
      return unsubscribe;
    });
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
  vi.useRealTimers();
  // a failed test's leaked subscription must not fail the next test's listener count
  for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
  subscribeSpy.mockRestore();
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
  db.insert(agents)
    .values({
      id: agentId,
      envId,
      branch: `claude/${agentId}`,
      status: "running",
    })
    .run();
  db.insert(runs).values({ id: runId, agentId, status: "running" }).run();
  return { agentId, envId, runId };
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

const say = (runId: RunId, text: string) =>
  post(runId, "claude.Message", { text });
const toolUse = (runId: RunId) =>
  post(runId, "claude.PreToolUse", {
    toolName: "Bash",
    toolUseId: "t1",
    input: '{"command":"ls"}',
  });

const stream = (query = "", headers: Record<string, string> = {}) =>
  app.request(`/v1/stream${query}`, { headers: { ...auth, ...headers } });

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  expect(check()).toBe(true);
};

test("the stream delivers new events from every agent in id order", async () => {
  const a = runningRun();
  const b = runningRun();
  await say(a.runId, "before connect");
  const res = await stream();
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
  const s = sseReader(res);
  await until(() => runEvents.listenerCount(anyRun) === 1);
  const ids = [
    await say(a.runId, "a1"),
    await say(b.runId, "b1"),
    await say(a.runId, "a2"),
  ];
  const frames = [await s.event(), await s.event(), await s.event()];
  await s.cancel();
  expect(frames.map((f) => f?.id)).toEqual(ids.map(String));
  expect(frames.map((f) => f?.event)).toEqual(Array(3).fill("claude.Message"));
  expect(JSON.parse(frames[1]?.data ?? "")).toEqual({
    id: `evt_${ids[1]}`,
    agentId: b.agentId,
    environmentId: b.envId,
    runId: b.runId,
    ts: expect.any(String),
    type: "claude.Message",
    payload: { text: "b1" },
  });
});

test("a reconnect with Last-Event-ID gets exactly the events it missed", async () => {
  const a = runningRun();
  const b = runningRun();
  const seen = await say(a.runId, "seen");
  const missed = [await say(b.runId, "m1"), await say(a.runId, "m2")];
  const s = sseReader(await stream("", { "Last-Event-ID": String(seen) }));
  expect((await s.event())?.id).toBe(String(missed[0]));
  expect((await s.event())?.id).toBe(String(missed[1]));
  const live = await say(b.runId, "live");
  expect((await s.event())?.id).toBe(String(live));
  await s.cancel();
});

test("the stream takes ?after= as an event id, and Last-Event-ID over it", async () => {
  const a = runningRun();
  const one = await say(a.runId, "one");
  const two = await say(a.runId, "two");
  const three = await say(a.runId, "three");
  const fromQuery = sseReader(await stream(`?after=evt_${one}`));
  expect((await fromQuery.event())?.id).toBe(String(two));
  await fromQuery.cancel();
  const s = sseReader(
    await stream(`?after=evt_${one}`, { "Last-Event-ID": String(two) }),
  );
  expect((await s.event())?.id).toBe(String(three));
  await s.cancel();
});

test("?types= and ?agentId= filter the stream", async () => {
  const a = runningRun();
  const b = runningRun();
  const start = await say(a.runId, "start");
  await say(a.runId, "not a tool");
  await toolUse(b.runId);
  const wanted = await toolUse(a.runId);
  await say(a.runId, "after");
  const s = sseReader(
    await stream(
      `?after=evt_${start}&types=claude.PreToolUse,run.failed&agentId=${a.agentId}`,
    ),
  );
  expect((await s.event())?.id).toBe(String(wanted));
  const failed = await post(a.runId, "run.failed", { error: "boom" });
  expect((await s.event())?.id).toBe(String(failed));
  await s.cancel();
});

test("a reconnect more than one page behind gets every missed event, in order", async () => {
  const a = runningRun();
  const seen = await say(a.runId, "seen");
  const missed: number[] = [];
  for (let i = 0; i < 250; i++) missed.push(await say(a.runId, `m${i}`));
  const s = sseReader(await stream("", { "Last-Event-ID": String(seen) }));
  const got: (string | undefined)[] = [];
  for (let i = 0; i < missed.length; i++) got.push((await s.event())?.id);
  await s.cancel();
  expect(got).toEqual(missed.map(String));
});

test("a quiet stream pings, and a disconnect releases its listener", async () => {
  const s = sseReader(await stream());
  expect(await s.next()).toEqual({ id: "0" });
  expect(await s.next()).toEqual({ comment: "ping", id: "0" });
  expect(runEvents.listenerCount(anyRun)).toBe(1);
  await s.cancel();
  await until(() => runEvents.listenerCount(anyRun) === 0);
});

const waiting = (runId: RunId) =>
  post(runId, "run.waiting", {
    request: { kind: "question", requestId: "req_1", prompt: "which?" },
  });

/** Resolves true once `count` pings arrive within `ms`, false if the stream ends or time runs out first. */
const pings = (s: ReturnType<typeof sseReader>, count: number, ms: number) =>
  Promise.race([
    (async () => {
      for (let seen = 0; seen < count; ) {
        const frame = await s.next();
        if (!frame) return false;
        if (frame.comment === "ping") seen++;
      }
      return true;
    })(),
    new Promise<boolean>((r) => setTimeout(() => r(false), ms)),
  ]);

test("closing ends the stream with a shutdown frame carrying its cursor, and releases its listener", async () => {
  const a = runningRun();
  const s = sseReader(await stream());
  await until(() => runEvents.listenerCount(anyRun) === 1);
  const id = await say(a.runId, "before shutdown");
  expect((await s.event())?.id).toBe(String(id));
  closing.abort();
  expect(await s.event()).toEqual({
    event: "server.shutdown",
    retry: "2000",
    id: String(id),
    data: '{"reason":"shutdown"}',
  });
  expect(await s.next()).toBeNull();
  await until(() => runEvents.listenerCount(anyRun) === 0);
});

test("a stream opened after closing gets the shutdown frame and ends at once", async () => {
  const a = runningRun();
  const id = await say(a.runId, "before shutdown");
  closing.abort();
  const s = sseReader(await stream("?types=run.waiting"));
  expect(await s.event()).toEqual({
    event: "server.shutdown",
    retry: "2000",
    id: String(id),
    data: '{"reason":"shutdown"}',
  });
  expect(await s.next()).toBeNull();
  expect(runEvents.listenerCount(anyRun)).toBe(0);
});

/** Stores and publishes an event in one synchronous step, so a caller can act in the same tick. */
const publishNow = (runId: RunId, text: string) =>
  db.transaction((tx) => recordEvent(tx, runId, "claude.Message", { text }).id);

/** A fresh app on the same db, standing in for the next process, streaming from `lastEventId`. */
const streamOnNextProcess = (lastEventId: string | undefined) =>
  createApp({
    db,
    config,
    sprites: new SpritesClient(spritesToken),
    log: () => {},
    nudgeDeliveries: () => {},
    heartbeatMs: 50,
  }).request("/v1/stream", {
    headers: { ...auth, "Last-Event-ID": lastEventId ?? "" },
  });

/** Event ids up to the shutdown frame, and that frame. */
async function untilShutdown(s: ReturnType<typeof sseReader>) {
  const ids: string[] = [];
  for (let f = await s.event(); f; f = await s.event()) {
    if (f.event === "server.shutdown") return { ids, shutdown: f };
    ids.push(f.id ?? "");
  }
  throw new Error("the stream ended without a shutdown frame");
}

test.each([2, 120])(
  "a client resuming from the shutdown frame's id on the next process gets each of %i missed events once, then live ones",
  async (count) => {
    const a = runningRun();
    const s = sseReader(await stream());
    await until(() => runEvents.listenerCount(anyRun) === 1);
    const seen = await say(a.runId, "A");
    expect((await s.event())?.id).toBe(String(seen));
    closing.abort();
    const { shutdown: shutdownFrame } = await untilShutdown(s);
    expect(shutdownFrame.id).toBe(String(seen));
    const missed: number[] = [];
    for (let i = 0; i < count; i++) missed.push(publishNow(a.runId, `m${i}`));

    const resumed = sseReader(await streamOnNextProcess(shutdownFrame.id));
    const got: (string | undefined)[] = [];
    for (let i = 0; i < count; i++) got.push((await resumed.event())?.id);
    expect(got).toEqual(missed.map(String));
    // still live after the replay, and nothing was repeated
    const live = await say(a.runId, "live");
    expect((await resumed.event())?.id).toBe(String(live));
    await resumed.cancel();
  },
);

test("an abort that lands in the same tick as publishes loses and repeats none of them across the resume", async () => {
  const a = runningRun();
  const s = sseReader(await stream());
  await until(() => runEvents.listenerCount(anyRun) === 1);
  // no await between the publishes and the abort, so the stream is mid-read when it exits
  const published = [
    publishNow(a.runId, "r1"),
    publishNow(a.runId, "r2"),
    publishNow(a.runId, "r3"),
  ];
  closing.abort();
  const { ids: before, shutdown: shutdownFrame } = await untilShutdown(s);

  const resumed = sseReader(await streamOnNextProcess(shutdownFrame.id));
  const after: (string | undefined)[] = [];
  for (let i = before.length; i < published.length; i++) {
    after.push((await resumed.event())?.id);
  }
  // a live event read right after the replay proves nothing repeated, so the two lists are exact
  const live = await say(a.runId, "live");
  expect((await resumed.event())?.id).toBe(String(live));
  await resumed.cancel();
  expect([...before, ...after]).toEqual(published.map(String));
});

test("a stream filtered to run.waiting keeps pinging every heartbeat while unrelated events flow", async () => {
  const a = runningRun();
  const s = sseReader(await stream("?types=run.waiting"));
  let flowing = true;
  const flow = (async () => {
    while (flowing) {
      await say(a.runId, "busy");
      await new Promise((r) => setTimeout(r, 10));
    }
  })();
  try {
    // heartbeatMs is 50, so three pings fit in 150 ms plus slack
    expect(await pings(s, 3, 400)).toBe(true);
  } finally {
    flowing = false;
    await flow;
    await s.cancel();
  }
});

test("a stream opened with no cursor sends its id before any event and with each ping, past filtered-out rows", async () => {
  const a = runningRun();
  const before = await say(a.runId, "before");
  const s = sseReader(await stream("?types=run.waiting"));
  expect(await s.next()).toEqual({ id: String(before) });
  const skipped = await say(a.runId, "filtered out");
  let ping = await s.next();
  // a ping already due when `skipped` landed may still carry the open cursor
  if (ping?.id === String(before)) ping = await s.next();
  expect(ping).toEqual({ comment: "ping", id: String(skipped) });
  await s.cancel();
});

test("a reconnect with the id from a stream's open gets the events published in between", async () => {
  const a = runningRun();
  await say(a.runId, "before");
  const first = sseReader(await stream("?types=run.waiting"));
  const opened = await first.next();
  await first.cancel();
  await say(a.runId, "while away");
  const missed = await waiting(a.runId);
  const again = sseReader(
    await stream("?types=run.waiting", { "Last-Event-ID": opened?.id ?? "" }),
  );
  expect((await again.event())?.id).toBe(String(missed));
  await again.cancel();
});

const poll = (query = "", signal?: AbortSignal) =>
  app.request(`/v1/events${query}`, { headers: auth, signal });

type Page = { data: { id: string; type: string }[]; cursor: string };

/**
 * Resolves once a poll is subscribed and waiting; setImmediate isn't among the faked timers. The turns a
 * request takes to reach the handler vary with load, so the wait is bounded by wall-clock time (Date isn't
 * faked) and fails here, under the default 5s test timeout, rather than leaving the loop spinning.
 */
const parked = async () => {
  const deadline = Date.now() + 3_000;
  while (runEvents.listenerCount(anyRun) === 0) {
    if (Date.now() > deadline) throw new Error("the poll never subscribed");
    await new Promise((r) => setImmediate(r));
  }
  expect(runEvents.listenerCount(anyRun)).toBe(1);
};

// whether `p` has settled, read without awaiting it; with setTimeout faked, only a wake-up settles a poll early
const settled = (p: unknown) => {
  let done = false;
  void Promise.resolve(p).then(() => {
    done = true;
  });
  return () => done;
};

test("a poll with events already past its cursor returns them at once, oldest first", async () => {
  const a = runningRun();
  const b = runningRun();
  const start = await say(a.runId, "start");
  const ids = [await say(b.runId, "one"), await say(a.runId, "two")];
  const res = await poll(`?after=evt_${start}`);
  expect(res.status).toBe(200);
  const page = (await res.json()) as Page;
  expect(page.data.map((e) => e.id)).toEqual(ids.map((id) => `evt_${id}`));
  expect(page.cursor).toBe(`evt_${ids[1]}`);
});

test("a poll returns a page of 100 and a cursor at its last event", async () => {
  const a = runningRun();
  const start = await say(a.runId, "start");
  const ids = [];
  for (let i = 0; i < 101; i++) ids.push(await say(a.runId, `m${i}`));
  const page = (await (await poll(`?after=evt_${start}`)).json()) as Page;
  expect(page.data).toHaveLength(100);
  expect(page.cursor).toBe(`evt_${ids[99]}`);
  const next = (await (await poll(`?after=${page.cursor}`)).json()) as Page;
  expect(next.data.map((e) => e.id)).toEqual([`evt_${ids[100]}`]);
});

test("a waiting poll returns as soon as a matching event lands", async () => {
  const a = runningRun();
  await say(a.runId, "old");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const pending = poll("?types=claude.PreToolUse");
  const isSettled = settled(pending);
  await parked();
  await vi.advanceTimersByTimeAsync(1000);
  expect(isSettled()).toBe(false);
  await say(a.runId, "not a tool");
  await vi.advanceTimersByTimeAsync(1000);
  expect(isSettled()).toBe(false);
  const id = await toolUse(a.runId);
  // the clock stays well inside the 30 s wait, so only the event can have woken it
  const page = (await (await pending).json()) as Page;
  expect(page).toEqual({
    data: [expect.objectContaining({ id: `evt_${id}` })],
    cursor: `evt_${id}`,
  });
});

test("a poll that times out returns no events and the start as its cursor", async () => {
  const a = runningRun();
  const latest = await say(a.runId, "old");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const pending = poll("?wait=5");
  const isSettled = settled(pending);
  await parked();
  await vi.advanceTimersByTimeAsync(4999);
  expect(isSettled()).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await (await pending).json()).toEqual({
    data: [],
    cursor: `evt_${latest}`,
  });
});

test("closing answers a parked poll at once with no events and its cursor", async () => {
  const a = runningRun();
  const latest = await say(a.runId, "old");
  const pending = poll("?wait=30");
  await parked();
  const started = Date.now();
  closing.abort();
  const res = await pending;
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ data: [], cursor: `evt_${latest}` });
});

test("a poll made after closing answers at once with no events and its cursor", async () => {
  const a = runningRun();
  const latest = await say(a.runId, "old");
  closing.abort();
  const started = Date.now();
  const res = await poll(`?after=evt_${latest}&wait=30`);
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ data: [], cursor: `evt_${latest}` });
  expect(runEvents.listenerCount(anyRun)).toBe(0);
});

test("a timed-out poll's cursor moves past the events its filter skipped", async () => {
  const a = runningRun();
  const b = runningRun();
  const start = await say(a.runId, "start");
  await toolUse(b.runId);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const pending = poll(`?after=evt_${start}&agentId=${a.agentId}`);
  await parked();
  await vi.advanceTimersByTimeAsync(1000);
  const skipped = await say(b.runId, "other agent");
  await vi.advanceTimersByTimeAsync(29_000);
  expect(await (await pending).json()).toEqual({
    data: [],
    cursor: `evt_${skipped}`,
  });
});

test("?wait=0 answers at once", async () => {
  runningRun();
  expect(await (await poll("?wait=0&after=evt_0")).json()).toEqual({
    data: [],
    cursor: "evt_0",
  });
});

test.each([
  ["an after that isn't an event id", "?after=run_1", "invalid_cursor"],
  ["a Last-Event-ID-style negative", "?after=-1", "invalid_cursor"],
  ["a cursor with trailing junk", "?after=evt_1%26x%3D2", "invalid_cursor"],
  ["an unknown type", "?types=claude.Message,run.progress", "invalid_query"],
  ["an empty types", "?types=", "invalid_query"],
])("%s gets 400 on both routes", async (_, query, code) => {
  for (const res of [await poll(query), await stream(query)]) {
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code } });
  }
});

test.each(["?wait=31", "?wait=1.5", "?wait=soon"])(
  "a poll with %s gets 400",
  async (query) => {
    const res = await poll(query);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: "invalid_query" },
    });
  },
);

test("a malformed Last-Event-ID gets 400", async () => {
  const res = await stream("", { "Last-Event-ID": "nope" });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: { code: "invalid_cursor" } });
});

test.each(["agt_missing", "nope"])(
  "an unknown agentId %s gets 404 on both routes",
  async (agentId) => {
    for (const res of [
      await poll(`?agentId=${agentId}`),
      await stream(`?agentId=${agentId}`),
    ]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: { code: "not_found", message: "no such agent" },
      });
    }
  },
);

test("both routes take only the API key", async () => {
  for (const path of ["/v1/events?wait=0", "/v1/stream"]) {
    const res = await app.request(path);
    expect(res.status).toBe(401);
  }
  expect(runEvents.listenerCount(anyRun)).toBe(0);
});

test("reading events makes no sprite call", async () => {
  const a = runningRun();
  const start = await say(a.runId, "start");
  const s = sseReader(await stream(`?after=evt_${start}`));
  await say(a.runId, "live");
  await s.event();
  await s.next();
  await s.cancel();
  await (await poll(`?after=evt_${start}`)).json();
  expect(wire.calls).toEqual([]);
});

test("the stream keeps delivering after an agent waits and is approved", async () => {
  const { agentId, runId } = runningRun();
  const s = sseReader(await stream());
  await until(() => runEvents.listenerCount(anyRun) === 1);
  const types: (string | undefined)[] = [];
  // each step reads its frame, then waits past a heartbeat, as a live client does
  const step = async (act: () => Promise<unknown>) => {
    await act();
    types.push((await s.event())?.event);
    await new Promise((r) => setTimeout(r, 120));
  };
  // Grok Bot's wait_for_events long-poll, open alongside the stream
  const bot = poll("?wait=5");
  await step(() => toolUse(runId));
  await step(() =>
    post(runId, "run.waiting", {
      request: {
        kind: "approval",
        requestId: "req_1",
        toolName: "Bash",
        toolSummary: "ls",
      },
    }),
  );
  // the runner's long-poll for the decision
  const runner = app.request(`/internal/runs/${runId}/requests/req_1`, {
    headers: {
      Authorization: `Bearer ${mintAgentToken(config.apiKey, runId)}`,
    },
  });
  await step(() =>
    post(runId, "claude.Notification", {
      message: "Claude needs your permission to use Bash",
      notificationType: "permission_prompt",
    }),
  );
  await step(async () => {
    const res = await app.request(`/v1/agents/${agentId}/approvals`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "req_1", decision: "approve" }),
    });
    expect(res.status).toBe(200);
    expect((await runner).status).toBe(200);
  });
  await step(() =>
    post(runId, "claude.PostToolUse", {
      toolName: "Bash",
      toolUseId: "t1",
      input: '{"command":"ls"}',
      output: "README.md",
      durationMs: 3,
    }),
  );
  await s.cancel();
  await bot;
  expect(types).toEqual([
    "claude.PreToolUse",
    "run.waiting",
    "claude.Notification",
    "run.resumed",
    "claude.PostToolUse",
  ]);
});

test("the sprite call log sees a sprite lookup and a file read", async () => {
  const client = new SpritesClient(spritesToken);
  await client.getSprite("sky-x").catch(() => {});
  await client
    .sprite("sky-x")
    .filesystem("/")
    .readFile("/f", "utf8")
    .catch(() => {});
  expect(wire.calls).toEqual(["get sky-x", "read sky-x /f"]);
});
