import { SpritesClient } from "@fly/sprites";
import {
  agents,
  type Db,
  environments,
  migrate,
  openDb,
  runs,
  webhookDeliveries,
} from "@sky/db";
import type { AgentId, EnvironmentId, RunId } from "@sky/shared";
import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { server } from "../../../test/msw.js";
import { mintAgentToken } from "./agent-token.js";
import { createApp } from "./app.js";
import {
  createDispatcher,
  type Dispatcher,
  openbotSignature,
  retryDelayMs,
  signatureHeader,
} from "./deliveries.js";
import { failStaleRuns } from "./runs.js";
import { spritesToken, stubSprites, testConfig } from "./testing/sprites.js";

const key = "webhook-signing-key-for-tests-0123456789";

/** A receiver's check, written from the documented scheme with WebCrypto rather than the sender's code. */
async function verify(
  header: string,
  body: string,
  nowSeconds: number,
): Promise<boolean> {
  const parts = new Map(
    header.split(",").map((p) => p.split("=", 2) as [string, string]),
  );
  const t = Number(parts.get("t"));
  if (!Number.isInteger(t) || Math.abs(nowSeconds - t) > 300) return false;
  const hmac = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const sig = Buffer.from(parts.get("v1") ?? "", "hex");
  return crypto.subtle.verify(
    "HMAC",
    hmac,
    sig,
    new TextEncoder().encode(`${t}.${body}`),
  );
}

test("the signature header verifies under the documented scheme, and only for its own body and time", async () => {
  const body = '{"id":"evt_1","type":"run.finished"}';
  const header = signatureHeader(key, body, 1_800_000_000);
  expect(header).toMatch(/^t=1800000000,v1=[0-9a-f]{64}$/);
  expect(await verify(header, body, 1_800_000_000)).toBe(true);
  expect(await verify(header, `${body} `, 1_800_000_000)).toBe(false);
  expect(await verify(header, body, 1_800_000_000 + 301)).toBe(false);
});

test.each([
  [1, 0.5, 10_000],
  [2, 0.5, 20_000],
  [7, 0.5, 640_000],
  [9, 0.5, 2_560_000],
  [10, 0.5, 3_600_000],
  [20, 0.5, 3_600_000],
  [1, 0, 8_000],
  [1, 1, 12_000],
  [20, 1, 4_320_000],
])(
  "after %i attempts with random %d the next try waits %ims",
  (attempts, random, ms) => {
    expect(retryDelayMs(attempts, random)).toBeCloseTo(ms);
  },
);

const config = testConfig();
const subscriberUrl = "https://hooks.example.com/sky";
let db: Db;
let app: ReturnType<typeof createApp>;
let dispatcher: Dispatcher;
let clock: Date;
let logs: string[];

beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
  logs = [];
  // ahead of the real time ingestion stamps next_attempt_at with, so a fresh delivery is due
  clock = new Date(Date.now() + 60_000);
  dispatcher = createDispatcher({
    db,
    signingKey: config.webhookSigningKey,
    secretEncryptionKey: config.secretEncryptionKey,
    log: (line) => logs.push(line),
    now: () => clock,
    random: () => 0.5,
  });
  stubSprites();
  app = createApp({
    db,
    config,
    sprites: new SpritesClient(spritesToken),
    log: () => {},
    nudgeDeliveries: dispatcher.nudge,
  });
});
afterEach(async () => {
  await dispatcher.stop();
  if (db.$client.open) db.$client.close();
});

const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};

const auth = { Authorization: `Bearer ${config.apiKey}` };

async function subscribe(
  eventTypes: string[],
  url = subscriberUrl,
  extra: Record<string, unknown> = {},
) {
  const res = await app.request("/v1/webhooks", {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ url, eventTypes, ...extra }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

function runningRun(name = "test") {
  const envId = `env_${name}` as EnvironmentId;
  const agentId = `agt_${name}` as AgentId;
  const runId = `run_${name}` as RunId;
  db.insert(environments)
    .values({
      id: envId,
      name: `e-${name}`,
      repo: "acme/kru",
      setup: "",
      status: "ready",
      spriteName: `sky-env_${name}`,
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
  return {
    agentId,
    envId,
    runId,
    token: mintAgentToken(config.apiKey, runId),
  };
}

const postEvent = (token: string, event: unknown) =>
  app.request("/internal/events", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(event),
  });

const usage = {
  inputTokens: 1,
  outputTokens: 1,
  costUsd: 0,
  turns: 1,
  durationMs: 1,
};

type Received = { headers: Headers; body: string };

/** A subscriber answering each POST with the next status in `statuses`. */
function subscriber(statuses: number[], url = subscriberUrl) {
  const received: Received[] = [];
  server.use(
    http.post(url, async ({ request }) => {
      received.push({ headers: request.headers, body: await request.text() });
      return new HttpResponse(null, { status: statuses.shift() ?? 599 });
    }),
  );
  return received;
}

const deliveries = () => db.select().from(webhookDeliveries).all();

test("a subscriber answering 500, 500, 200 gets three signed attempts of one event, then it is delivered", async () => {
  await subscribe(["run.finished"]);
  const received = subscriber([500, 500, 200]);
  const { agentId, runId, token } = runningRun();
  const planted = [
    config.claudeOauthToken,
    config.spritesToken,
    config.webhookSigningKey,
    `ghp_${"a1B2".repeat(9)}`,
  ];

  // claude.Message isn't subscribed, so only the finish is enqueued
  expect(
    (
      await postEvent(token, {
        runId,
        type: "claude.Message",
        payload: { text: "working" },
      })
    ).status,
  ).toBe(201);
  const posted = await postEvent(token, {
    runId,
    type: "run.finished",
    payload: { summary: `done; leaked ${planted.join(" and ")}`, usage },
  });
  expect(posted.status).toBe(201);
  const { id: eventId } = (await posted.json()) as { id: number };

  await dispatcher.drain();
  expect(received).toHaveLength(1);
  // not due until the backoff has passed
  await dispatcher.drain();
  expect(received).toHaveLength(1);
  advance(10_000);
  await dispatcher.drain();
  expect(received).toHaveLength(2);
  advance(20_000);
  await dispatcher.drain();
  expect(received).toHaveLength(3);
  const lastSentAt = Math.floor(clock.getTime() / 1000);
  advance(3_600_000);
  await dispatcher.drain();
  expect(received).toHaveLength(3);

  expect(deliveries()).toEqual([
    expect.objectContaining({
      eventId,
      status: "delivered",
      attempts: 3,
      lastStatus: 200,
    }),
  ]);
  for (const { headers, body } of received) {
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("sky-event-id")).toBe(`evt_${eventId}`);
    expect(headers.get("sky-event-type")).toBe("run.finished");
    const signature = headers.get("sky-signature") ?? "";
    expect(await verify(signature, body, lastSentAt)).toBe(true);
    expect(JSON.parse(body)).toEqual({
      id: `evt_${eventId}`,
      agentId,
      environmentId: "env_test",
      runId,
      ts: expect.stringMatching(/Z$/),
      type: "run.finished",
      payload: { summary: expect.stringContaining("[redacted]"), usage },
    });
    for (const secret of planted) expect(body).not.toContain(secret);
  }
});

test("each attempt is signed with its own clock second, so a retry after 300 s still verifies", async () => {
  await subscribe(["run.finished"]);
  const sentAt: number[] = [];
  const received: Received[] = [];
  const statuses = [500, 500, 500, 500, 500, 200];
  server.use(
    http.post(subscriberUrl, async ({ request }) => {
      sentAt.push(Math.floor(clock.getTime() / 1000));
      received.push({ headers: request.headers, body: await request.text() });
      return new HttpResponse(null, { status: statuses.shift() ?? 599 });
    }),
  );
  const { runId, token } = runningRun();
  await postEvent(token, {
    runId,
    type: "run.finished",
    payload: { summary: "done", usage },
  });

  // 10, 20, 40, 80, 160 s backoffs: the sixth attempt lands 310 s after the first
  await dispatcher.drain();
  for (const wait of [10_000, 20_000, 40_000, 80_000, 160_000]) {
    advance(wait);
    await dispatcher.drain();
  }

  expect(received).toHaveLength(6);
  expect(sentAt.at(-1)).toBeGreaterThan((sentAt[0] ?? 0) + 300);
  for (const [i, { headers, body }] of received.entries()) {
    const signature = headers.get("sky-signature") ?? "";
    expect(signature.split(",")[0]).toBe(`t=${sentAt[i]}`);
    expect(await verify(signature, body, sentAt[i] ?? 0)).toBe(true);
  }
});

test("each matching subscription gets its own delivery of the event", async () => {
  await subscribe(["run.finished"]);
  await subscribe(
    ["claude.Message", "run.finished"],
    "https://b.example.com/h",
  );
  await subscribe(["claude.Message"], "https://c.example.com/h");
  const a = subscriber([200]);
  const b = subscriber([200], "https://b.example.com/h");
  const { runId, token } = runningRun();
  await postEvent(token, {
    runId,
    type: "run.finished",
    payload: { summary: "ok", usage },
  });
  await dispatcher.drain();
  expect([a.length, b.length]).toEqual([1, 1]);
  expect(deliveries().map((d) => d.status)).toEqual(["delivered", "delivered"]);
});

test("a claude.PostToolUse event reaches a webhook subscribed to it, redacted and trimmed", async () => {
  await subscribe(["claude.PostToolUse"]);
  const received = subscriber([200]);
  const { agentId, runId, token } = runningRun();
  const payload = {
    toolName: "Bash",
    toolUseId: "tu_1",
    input: '{"command":"env"}',
    output: `SIGNING=${config.webhookSigningKey}\n${"a".repeat(5_000)}`,
  };
  expect(
    (await postEvent(token, { runId, type: "claude.PostToolUse", payload }))
      .status,
  ).toBe(201);
  await dispatcher.drain();
  expect(received).toHaveLength(1);
  const body = JSON.parse(received[0]?.body ?? "") as {
    agentId: string;
    type: string;
    payload: { output: string };
  };
  expect(body).toMatchObject({ agentId, runId, type: "claude.PostToolUse" });
  expect(body.payload.output).toMatch(
    /^SIGNING=\[redacted\]\na+\n…\[truncated \d+ chars\]$/,
  );
  expect(received[0]?.body).not.toContain(config.webhookSigningKey);
});

test("a slow subscriber never holds up the runner's post", async () => {
  await subscribe(["run.finished"]);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached = false;
  server.use(
    http.post(subscriberUrl, async () => {
      reached = true;
      await gate;
      return new HttpResponse(null, { status: 200 });
    }),
  );
  const { runId, token } = runningRun();
  const posted = await postEvent(token, {
    runId,
    type: "run.finished",
    payload: { summary: "ok", usage },
  });
  expect(posted.status).toBe(201);
  await expect.poll(() => reached).toBe(true);
  expect(deliveries()[0]?.status).toBe("pending");
  release();
  await dispatcher.drain();
  expect(deliveries()[0]?.status).toBe("delivered");
});

test("a network error records no status, the reason, and a retry", async () => {
  await subscribe(["run.finished"]);
  server.use(http.post(subscriberUrl, () => HttpResponse.error()));
  const { runId, token } = runningRun();
  await postEvent(token, {
    runId,
    type: "run.finished",
    payload: { summary: "ok", usage },
  });
  await dispatcher.drain();
  expect(deliveries()).toEqual([
    expect.objectContaining({
      status: "pending",
      attempts: 1,
      lastStatus: null,
      lastError: expect.any(String),
      nextAttemptAt: new Date(clock.getTime() + 10_000).toISOString(),
    }),
  ]);
});

test("a redirect is a failed attempt, never followed", async () => {
  await subscribe(["run.finished"]);
  server.use(
    http.post(
      subscriberUrl,
      () =>
        new HttpResponse(null, {
          status: 302,
          headers: { Location: "https://elsewhere.example.com/" },
        }),
    ),
  );
  const { runId, token } = runningRun();
  await postEvent(token, {
    runId,
    type: "run.finished",
    payload: { summary: "ok", usage },
  });
  await dispatcher.drain();
  expect(deliveries()).toEqual([
    expect.objectContaining({
      status: "pending",
      attempts: 1,
      lastStatus: 302,
    }),
  ]);
});

test("an attempt is cut off after 30 s and recorded as a timeout", async () => {
  await subscribe(["run.finished"]);
  subscriber([200]);
  const { runId, token } = runningRun();
  // AbortSignal.timeout runs on Node's own timers, out of reach of fake ones
  const timeout = vi
    .spyOn(AbortSignal, "timeout")
    .mockImplementation(() =>
      AbortSignal.abort(new DOMException("timed out", "TimeoutError")),
    );
  let timeouts: unknown[][];
  try {
    // ingestion nudges the dispatcher, so the attempt may start before drain() is called
    await postEvent(token, {
      runId,
      type: "run.finished",
      payload: { summary: "ok", usage },
    });
    await dispatcher.drain();
  } finally {
    timeouts = [...timeout.mock.calls];
    timeout.mockRestore();
  }
  expect(timeouts).toEqual([[30_000]]);
  expect(deliveries()).toEqual([
    expect.objectContaining({
      status: "pending",
      attempts: 1,
      lastError: "timed out after 30s",
    }),
  ]);
});

test("each failed attempt logs one line naming the webhook, event, attempt and status", async () => {
  const webhookId = await subscribe(["run.finished"]);
  server.use(http.post(subscriberUrl, () => HttpResponse.error()));
  const { runId, token } = runningRun();
  await postEvent(token, {
    runId,
    type: "run.finished",
    payload: { summary: "ok", usage },
  });
  await dispatcher.drain();
  subscriber([500]);
  advance(3_600_000);
  await dispatcher.drain();
  const eventId = `evt_${deliveries()[0]?.eventId}`;
  expect(logs).toEqual([
    expect.stringMatching(
      new RegExp(`^webhook ${webhookId} ${eventId}: attempt 1/30 failed: \\S`),
    ),
    `webhook ${webhookId} ${eventId}: attempt 2/30 failed: status 500`,
  ]);
});

test("after 30 failed attempts the delivery is failed and never tried again", async () => {
  await subscribe(["run.finished"]);
  const received = subscriber(Array(31).fill(503));
  const { runId, token } = runningRun();
  await postEvent(token, {
    runId,
    type: "run.finished",
    payload: { summary: "ok", usage },
  });
  for (let i = 0; i < 31; i++) {
    await dispatcher.drain();
    advance(3_600_000);
  }
  expect(received).toHaveLength(30);
  expect(deliveries()).toEqual([
    expect.objectContaining({
      status: "failed",
      attempts: 30,
      lastStatus: 503,
    }),
  ]);
  expect(logs).toHaveLength(30);
  expect(logs.at(-1)).toMatch(
    /^warn: webhook whk_\w+ evt_\d+: attempt 30\/30 failed: status 503; giving up$/,
  );
});

/** A subscriber answering every POST with a 429, carrying `retryAfter` when given. */
function rateLimited(retryAfter?: string, url = subscriberUrl) {
  const received: string[] = [];
  server.use(
    http.post(url, async ({ request }) => {
      received.push(await request.text());
      return new HttpResponse(null, {
        status: 429,
        headers: retryAfter === undefined ? {} : { "Retry-After": retryAfter },
      });
    }),
  );
  return received;
}

const finishRun = async () => {
  const { runId, token } = runningRun();
  await postEvent(token, {
    runId,
    type: "run.finished",
    payload: { summary: "ok", usage },
  });
  await dispatcher.drain();
};

test.each([
  ["delta-seconds", () => "120", () => 120_000],
  [
    "an HTTP-date",
    () => new Date(clock.getTime() + 300_000).toUTCString(),
    () =>
      Date.parse(new Date(clock.getTime() + 300_000).toUTCString()) -
      clock.getTime(),
  ],
  ["a value past the 1 h cap", () => "86400", () => 3_600_000],
  ["a date in the past", () => new Date(0).toUTCString(), () => 5_000],
  ["zero", () => "0", () => 5_000],
  ["an unparseable value", () => "soon", () => 10_000],
])(
  "a 429 with Retry-After as %s sets the next attempt from it",
  async (_, header, delayMs) => {
    await subscribe(["run.finished"]);
    rateLimited(header());
    await finishRun();
    expect(deliveries()).toEqual([
      expect.objectContaining({
        status: "pending",
        attempts: 1,
        lastStatus: 429,
        nextAttemptAt: new Date(clock.getTime() + delayMs()).toISOString(),
      }),
    ]);
  },
);

test("a 429 without Retry-After backs off as any failed attempt does", async () => {
  await subscribe(["run.finished"]);
  rateLimited();
  await finishRun();
  expect(deliveries()).toEqual([
    expect.objectContaining({
      attempts: 1,
      lastStatus: 429,
      nextAttemptAt: new Date(clock.getTime() + 10_000).toISOString(),
    }),
  ]);
});

test("a 429 holds the webhook's other pending deliveries, without spending their attempts, while another webhook's are still sent", async () => {
  const limited = await subscribe(["claude.PostToolUse"]);
  const other = await subscribe(
    ["claude.PostToolUse"],
    "https://b.example.com/h",
  );
  await dispatcher.stop();
  const { runId, token } = runningRun();
  for (const toolUseId of ["tu_1", "tu_2"]) {
    const payload = { toolName: "Bash", toolUseId, input: "{}", output: "" };
    await postEvent(token, { runId, type: "claude.PostToolUse", payload });
  }
  // the second of the limited webhook's deliveries comes due after the 429 lands, before it expires
  const [, held] = deliveries().filter((d) => d.webhookId === limited);
  db.update(webhookDeliveries)
    .set({ nextAttemptAt: new Date(clock.getTime() + 30_000).toISOString() })
    .where(eq(webhookDeliveries.id, held?.id ?? -1))
    .run();
  const a = rateLimited("120");
  const b = subscriber([200, 200], "https://b.example.com/h");
  dispatcher = createDispatcher({
    db,
    signingKey: config.webhookSigningKey,
    secretEncryptionKey: config.secretEncryptionKey,
    log: () => {},
    now: () => clock,
    random: () => 0.5,
  });
  await dispatcher.drain();
  expect([a.length, b.length]).toEqual([1, 2]);
  const retryAt = new Date(clock.getTime() + 120_000).toISOString();
  expect(
    deliveries().map((d) => [
      d.webhookId,
      d.status,
      d.attempts,
      d.nextAttemptAt,
    ]),
  ).toEqual([
    [limited, "pending", 1, retryAt],
    [other, "delivered", 1, expect.any(String)],
    [limited, "pending", 0, retryAt],
    [other, "delivered", 1, expect.any(String)],
  ]);
  advance(60_000);
  await dispatcher.drain();
  expect(a).toHaveLength(1);
});

test("pending deliveries left by a previous process are sent once a dispatcher starts", async () => {
  await subscribe(["run.finished"]);
  const received = subscriber([200]);
  const { runId, token } = runningRun();
  await dispatcher.stop();
  await postEvent(token, {
    runId,
    type: "run.finished",
    payload: { summary: "ok", usage },
  });
  expect(received).toHaveLength(0);

  dispatcher = createDispatcher({
    db,
    signingKey: config.webhookSigningKey,
    secretEncryptionKey: config.secretEncryptionKey,
    log: () => {},
    now: () => clock,
  });
  dispatcher.start();
  await dispatcher.drain();
  expect(received).toHaveLength(1);
  expect(deliveries()[0]?.status).toBe("delivered");
});

test("stopping a run delivers its run.stopped event to a subscriber", async () => {
  await subscribe(["run.stopped"]);
  const received = subscriber([200]);
  const { runId } = runningRun();
  const res = await app.request("/v1/agents/agt_test/stop", {
    method: "POST",
    headers: auth,
  });
  expect(res.status).toBe(200);
  // no drain: the stop itself wakes the dispatcher
  await expect.poll(() => received.length).toBe(1);
  expect(JSON.parse(received[0]?.body ?? "")).toMatchObject({
    runId,
    type: "run.stopped",
  });
});

test("a run the sweep times out delivers its run.failed event to a subscriber", async () => {
  await subscribe(["run.failed"]);
  const received = subscriber([200]);
  const { runId } = runningRun();
  expect(failStaleRuns(db, 0, Date.now() + 1000)).toEqual([runId]);
  await dispatcher.drain();
  expect(received.map((r) => JSON.parse(r.body))).toEqual([
    expect.objectContaining({
      runId,
      type: "run.failed",
      payload: { error: "runner_timeout" },
    }),
  ]);
});

const secret = `whsec_${Buffer.from("0123456789abcdef0123456789abcdef").toString("base64")}`;

/** A Standard Webhooks receiver's check, written from the spec with WebCrypto rather than the sender's code. */
async function verifyStandard(
  headers: Headers,
  body: string,
  nowSeconds: number,
): Promise<boolean> {
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signatures = headers.get("webhook-signature");
  if (!id || !timestamp || !signatures) return false;
  if (!/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > 300) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    Buffer.from(secret.slice("whsec_".length), "base64"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = Buffer.from(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${id}.${timestamp}.${body}`),
    ),
  ).toString("base64");
  return signatures.split(" ").some((s) => s === `v1,${expected}`);
}

const finish = (token: string, runId: RunId, summary = "done") =>
  postEvent(token, {
    runId,
    type: "run.finished",
    payload: { summary, usage },
  });

test("a standard delivery carries the Standard Webhooks headers and body, verifies, and keeps its id across retries", async () => {
  await subscribe(["run.finished"], subscriberUrl, {
    format: "standard",
    secret,
  });
  const received: Received[] = [];
  const statuses = [500, 200];
  const sentAt: number[] = [];
  server.use(
    http.post(subscriberUrl, async ({ request }) => {
      sentAt.push(Math.floor(clock.getTime() / 1000));
      received.push({ headers: request.headers, body: await request.text() });
      return new HttpResponse(null, { status: statuses.shift() ?? 599 });
    }),
  );
  const { agentId, envId, runId, token } = runningRun();
  const posted = await finish(token, runId);
  const { id: eventId } = (await posted.json()) as { id: number };

  await dispatcher.drain();
  advance(10_000);
  await dispatcher.drain();

  expect(received).toHaveLength(2);
  for (const [i, { headers, body }] of received.entries()) {
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("webhook-id")).toBe(`evt_${eventId}`);
    expect(headers.get("webhook-timestamp")).toBe(String(sentAt[i]));
    expect(headers.get("webhook-signature")).toMatch(/^v1,[A-Za-z0-9+/]+=*$/);
    expect(headers.has("sky-signature")).toBe(false);
    expect(await verifyStandard(headers, body, sentAt[i] ?? 0)).toBe(true);
    expect(await verifyStandard(headers, `${body} `, sentAt[i] ?? 0)).toBe(
      false,
    );
    const parsed = JSON.parse(body);
    expect(Object.keys(parsed)).toEqual(["type", "timestamp", "data"]);
    expect(parsed).toEqual({
      type: "run.finished",
      timestamp: parsed.data.ts,
      data: {
        id: `evt_${eventId}`,
        agentId,
        environmentId: envId,
        runId,
        ts: expect.stringMatching(/Z$/),
        type: "run.finished",
        payload: { summary: "done", usage },
      },
    });
  }
  // a retry is a new attempt: the timestamp and so the signature move, the id and the body don't
  expect(sentAt[1]).toBeGreaterThan(sentAt[0] ?? 0);
  expect(received[1]?.body).toBe(received[0]?.body);
  expect(received[1]?.headers.get("webhook-signature")).not.toBe(
    received[0]?.headers.get("webhook-signature"),
  );
});

test("the secret of a standard webhook is stored sealed and never appears in a GET or a log line", async () => {
  const id = await subscribe(["run.finished"], subscriberUrl, {
    format: "standard",
    secret,
  });
  subscriber([500, 599, 599]);
  const { runId, token } = runningRun();
  await finish(token, runId);
  await dispatcher.drain();
  expect(logs.length).toBeGreaterThan(0);

  const list = await app.request("/v1/webhooks", { headers: auth });
  const one = await app.request(`/v1/webhooks/${id}`, { headers: auth });
  const listed = await list.text();
  const read = await one.text();
  for (const text of [listed, read, ...logs]) {
    expect(text).not.toContain(secret);
    expect(text).not.toContain(secret.slice("whsec_".length));
  }
  expect(JSON.parse(read)).toMatchObject({
    id,
    format: "standard",
  });
  expect(JSON.parse(read)).not.toHaveProperty("secret");
  const row = db.$client
    .prepare("select * from webhooks where id = ?")
    .get(id) as Record<string, Buffer | string | number | null>;
  expect(JSON.stringify(row)).not.toContain(secret.slice("whsec_".length));
  expect(Buffer.isBuffer(row.secret_ciphertext)).toBe(true);
});

// an OpenBot secret is used as raw bytes, whsec_ prefix and all
const openbotSecret = "whsec_not+base64/but-fine";

/** The OpenBot signature header, computed with WebCrypto from the raw secret bytes and "<ts>.<id>.<body>". */
async function openbotExpected(
  secret: string,
  t: string | number,
  id: string,
  body: string,
): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(`${t}.${id}.${body}`),
  );
  return `sha256=${Buffer.from(mac).toString("hex")}`;
}

test("an openbot delivery matches a fixed signature vector, carries the OpenBot headers and body, and keeps its id across retries", async () => {
  const webhookId = await subscribe(["run.finished"], subscriberUrl, {
    format: "openbot",
    secret: openbotSecret,
  });
  const received: Received[] = [];
  const statuses = [500, 200];
  const sentAt: number[] = [];
  server.use(
    http.post(subscriberUrl, async ({ request }) => {
      sentAt.push(Math.floor(clock.getTime() / 1000));
      received.push({ headers: request.headers, body: await request.text() });
      return new HttpResponse(null, { status: statuses.shift() ?? 599 });
    }),
  );
  const { agentId, envId, runId, token } = runningRun();
  const posted = await finish(token, runId);
  const { id: eventId } = (await posted.json()) as { id: number };

  await dispatcher.drain();
  advance(10_000);
  await dispatcher.drain();

  expect(received).toHaveLength(2);
  for (const [i, { headers, body }] of received.entries()) {
    const t = sentAt[i] ?? 0;
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-openbot-timestamp")).toBe(String(t));
    const deliveryId = `evt_${eventId}_${webhookId}`;
    expect(headers.get("x-openbot-delivery-id")).toBe(deliveryId);
    expect(headers.get("x-openbot-signature")).toBe(
      await openbotExpected(openbotSecret, t, deliveryId, body),
    );
    expect(headers.get("x-openbot-signature")).toMatch(/^sha256=[0-9a-f]{64}$/);
    for (const name of ["sky-signature", "webhook-id", "webhook-signature"]) {
      expect(headers.has(name)).toBe(false);
    }
    const parsed = JSON.parse(body);
    expect(Object.keys(parsed)).toEqual(["type", "data"]);
    expect(parsed).toEqual({
      type: "run.finished",
      data: {
        id: `evt_${eventId}`,
        agentId,
        environmentId: envId,
        runId,
        ts: expect.stringMatching(/Z$/),
        type: "run.finished",
        payload: { summary: "done", usage },
      },
    });
  }
  expect(sentAt[1]).toBeGreaterThan(sentAt[0] ?? 0);
  expect(received[1]?.body).toBe(received[0]?.body);
  expect(received[1]?.headers.get("x-openbot-signature")).not.toBe(
    received[0]?.headers.get("x-openbot-signature"),
  );
});

test("one event to two openbot webhooks goes out under two delivery ids, each signed with its own webhook's secret", async () => {
  const other = "https://hooks.example.com/other";
  const otherSecret = "a-different-openbot-secret";
  const firstId = await subscribe(["run.finished"], subscriberUrl, {
    format: "openbot",
    secret: openbotSecret,
  });
  const secondId = await subscribe(["run.finished"], other, {
    format: "openbot",
    secret: otherSecret,
  });
  const first = subscriber([200]);
  const second = subscriber([200], other);
  const { runId, token } = runningRun();
  const posted = await finish(token, runId);
  const { id: eventId } = (await posted.json()) as { id: number };

  await dispatcher.drain();

  expect(first).toHaveLength(1);
  expect(second).toHaveLength(1);
  const deliveries = [
    { received: first[0], secret: openbotSecret, webhookId: firstId },
    { received: second[0], secret: otherSecret, webhookId: secondId },
  ];
  for (const { received, secret, webhookId } of deliveries) {
    const headers = received?.headers ?? new Headers();
    const body = received?.body ?? "";
    const id = headers.get("x-openbot-delivery-id") ?? "";
    expect(id).toBe(`evt_${eventId}_${webhookId}`);
    // header-safe, and no "." to split the signed "<ts>.<id>.<body>" on
    expect(id).toMatch(/^[0-9A-Za-z_]+$/);
    expect(headers.get("x-openbot-signature")).toBe(
      await openbotExpected(
        secret,
        headers.get("x-openbot-timestamp") ?? "",
        id,
        body,
      ),
    );
    // the event itself, its id included, is the same for every webhook
    expect(JSON.parse(body).data.id).toBe(`evt_${eventId}`);
  }
  expect(first[0]?.headers.get("x-openbot-delivery-id")).not.toBe(
    second[0]?.headers.get("x-openbot-delivery-id"),
  );
});

test("openbotSignature matches a hard-coded vector", () => {
  // HMAC-SHA256, key "secret", message "1700000000.evt_1.{}", computed independently with openssl
  expect(openbotSignature("secret", "evt_1", 1700000000, "{}")).toBe(
    "sha256=26d77ca6a783c304147f4d1df6c77f9055350d43a20070ae3c2fbc598bb3bec4",
  );
});

test("the secret of an openbot webhook is stored sealed and never appears in a GET or a log line", async () => {
  const id = await subscribe(["run.finished"], subscriberUrl, {
    format: "openbot",
    secret: openbotSecret,
  });
  subscriber([500, 599, 599]);
  const { runId, token } = runningRun();
  await finish(token, runId);
  await dispatcher.drain();
  expect(logs.length).toBeGreaterThan(0);

  const list = await app.request("/v1/webhooks", { headers: auth });
  const one = await app.request(`/v1/webhooks/${id}`, { headers: auth });
  const listed = await list.text();
  const read = await one.text();
  for (const text of [listed, read, ...logs]) {
    expect(text).not.toContain(openbotSecret);
  }
  expect(JSON.parse(read)).toMatchObject({ id, format: "openbot" });
  expect(JSON.parse(read)).not.toHaveProperty("secret");
  const row = db.$client
    .prepare("select * from webhooks where id = ?")
    .get(id) as Record<string, Buffer | string | number | null>;
  expect(JSON.stringify(row)).not.toContain(openbotSecret);
  expect(Buffer.isBuffer(row.secret_ciphertext)).toBe(true);
});

test("an openbot webhook with environmentIds receives only events of agents in those environments", async () => {
  const a = runningRun("a");
  const b = runningRun("b");
  await subscribe(["run.finished"], subscriberUrl, {
    format: "openbot",
    secret: openbotSecret,
    environmentIds: [a.envId],
  });
  const received = subscriber([200, 200]);

  await finish(b.token, b.runId, "from b");
  await dispatcher.drain();
  expect(received).toHaveLength(0);

  await finish(a.token, a.runId, "from a");
  await dispatcher.drain();
  expect(received.map((r) => JSON.parse(r.body).data.environmentId)).toEqual([
    a.envId,
  ]);
});

test("a webhook with environmentIds receives only events of agents in those environments", async () => {
  const a = runningRun("a");
  const b = runningRun("b");
  await subscribe(["run.finished"], subscriberUrl, {
    environmentIds: [a.envId],
  });
  const everything = "https://hooks.example.com/all";
  await subscribe(["run.finished"], everything);
  const filtered = subscriber([200, 200]);
  const unfiltered = subscriber([200, 200], everything);

  await finish(b.token, b.runId, "from b");
  await dispatcher.drain();
  expect(filtered).toHaveLength(0);
  expect(unfiltered).toHaveLength(1);

  await finish(a.token, a.runId, "from a");
  await dispatcher.drain();
  expect(filtered.map((r) => JSON.parse(r.body).environmentId)).toEqual([
    a.envId,
  ]);
  expect(unfiltered).toHaveLength(2);
  expect(deliveries()).toHaveLength(3);
});

test("a sky delivery keeps its headers, signature and body shape", async () => {
  await subscribe(["run.finished"]);
  const received = subscriber([200]);
  const { agentId, envId, runId, token } = runningRun();
  const posted = await finish(token, runId);
  const { id: eventId } = (await posted.json()) as { id: number };
  await dispatcher.drain();

  const [only] = received;
  const stored = db.$client
    .prepare("select ts from events where id = ?")
    .get(eventId) as { ts: string };
  // the exact bytes: key order is part of what a receiver signs over
  const body = `{"id":"evt_${eventId}","agentId":"${agentId}","environmentId":"${envId}","runId":"${runId}","ts":"${stored.ts}","type":"run.finished","payload":{"summary":"done","usage":{"inputTokens":1,"outputTokens":1,"costUsd":0,"turns":1,"durationMs":1}}}`;
  expect(only?.body).toBe(body);
  const t = Math.floor(clock.getTime() / 1000);
  expect(only?.headers.get("content-type")).toBe("application/json");
  expect(only?.headers.get("sky-event-id")).toBe(`evt_${eventId}`);
  expect(only?.headers.get("sky-event-type")).toBe("run.finished");
  expect(only?.headers.get("sky-signature")).toBe(
    signatureHeader(key, body, t),
  );
  for (const name of ["webhook-id", "webhook-timestamp", "webhook-signature"]) {
    expect(only?.headers.has(name)).toBe(false);
  }
});
