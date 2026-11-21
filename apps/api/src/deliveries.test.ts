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
import type { AgentId, EnvironmentId, RunId, WebhookId } from "@sky/shared";
import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { server } from "../../../test/msw.js";
import { mintAgentToken } from "./agent-token.js";
import { createApp } from "./app.js";
import {
  createDispatcher,
  type Dispatcher,
  errorKind,
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

/** Every stored value of the tables a webhook secret could leak into, as bytes: blobs as they are, text as UTF-8. */
function storedBytes(): Buffer[] {
  const out: Buffer[] = [];
  for (const table of ["webhooks", "events", "webhook_deliveries"]) {
    const rows = db.$client.prepare(`select * from ${table}`).all();
    for (const row of rows as Record<string, unknown>[]) {
      for (const value of Object.values(row)) {
        if (Buffer.isBuffer(value)) out.push(value);
        else if (typeof value === "string") out.push(Buffer.from(value));
      }
    }
  }
  return out;
}

function expectNoneStored(...needles: (string | Buffer)[]) {
  const stored = storedBytes();
  // the sweep reads the rows it claims to: planting what is stored makes it throw
  expect(() => expectNoneStoredIn(stored, [subscriberUrl])).toThrow();
  expect(() => expectNoneStoredIn(stored, ["run.finished"])).toThrow();
  expectNoneStoredIn(stored, needles);
}

function expectNoneStoredIn(stored: Buffer[], needles: (string | Buffer)[]) {
  for (const needle of needles) {
    const bytes = Buffer.from(needle);
    for (const value of stored) expect(value.includes(bytes)).toBe(false);
  }
}

/** The ciphertext is neither the plaintext nor carries its bytes, and is no shorter than it. */
function expectSealed(ciphertext: unknown, plaintext: string) {
  const plain = Buffer.from(plaintext);
  expect(Buffer.isBuffer(ciphertext)).toBe(true);
  const sealed = ciphertext as Buffer;
  expect(sealed.length).toBeGreaterThanOrEqual(plain.length);
  expect(sealed.includes(plain)).toBe(false);
  expect(sealed.subarray(0, plain.length).equals(plain)).toBe(false);
}

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
  expectSealed(row.secret_ciphertext, secret);
  expectNoneStored(
    secret,
    secret.slice("whsec_".length),
    Buffer.from(secret.slice("whsec_".length), "base64"),
  );
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
  expect(received).toHaveLength(1);
  // the retry is not due until the backoff has passed
  await dispatcher.drain();
  expect(received).toHaveLength(1);
  advance(10_000);
  await dispatcher.drain();

  expect(received).toHaveLength(2);
  expect(deliveries().map((d) => [d.status, d.attempts])).toEqual([
    ["delivered", 2],
  ]);
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
    for (const name of [
      "sky-signature",
      "sky-event-id",
      "sky-event-type",
      "webhook-id",
      "webhook-timestamp",
      "webhook-signature",
    ]) {
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
  expectSealed(row.secret_ciphertext, openbotSecret);
  expectNoneStored(openbotSecret);
});

const nonAsciiSecret = "whsec_pässwörd-秘密-🔑";

test("an openbot secret of multi-byte characters signs as its UTF-8 bytes", async () => {
  const webhookId = await subscribe(["run.finished"], subscriberUrl, {
    format: "openbot",
    secret: nonAsciiSecret,
  });
  const received = subscriber([200]);
  const { runId, token } = runningRun();
  const posted = await finish(token, runId);
  const { id: eventId } = (await posted.json()) as { id: number };
  await dispatcher.drain();

  const [only] = received;
  const id = `evt_${eventId}_${webhookId}`;
  expect(only?.headers.get("x-openbot-delivery-id")).toBe(id);
  expect(only?.headers.get("x-openbot-signature")).toBe(
    await openbotExpected(
      nonAsciiSecret,
      only?.headers.get("x-openbot-timestamp") ?? "",
      id,
      only?.body ?? "",
    ),
  );
  expect(deliveries().map((d) => d.status)).toEqual(["delivered"]);
});

const sealedFormats = [
  { format: "openbot", plain: openbotSecret },
  { format: "standard", plain: secret },
] as const;
const sendFailures = [
  "corrupted ciphertext",
  "wrong encryption key",
  "network error",
] as const;

test.each(
  sealedFormats.flatMap((f) =>
    sendFailures.map((failure) => ({ ...f, failure })),
  ),
)(
  "a $format webhook's secret stays out of the logs and last_error on a $failure",
  async ({ format, plain, failure }) => {
    const id = await subscribe(["run.finished"], subscriberUrl, {
      format,
      secret: plain,
    });
    const received = subscriber([200]);
    if (failure === "network error") {
      server.use(http.post(subscriberUrl, () => HttpResponse.error()));
    }
    if (failure === "corrupted ciphertext") {
      const { c } = db.$client
        .prepare("select secret_ciphertext as c from webhooks where id = ?")
        .get(id) as { c: Buffer };
      const flipped = Buffer.from(c);
      flipped[0] = (flipped[0] ?? 0) ^ 0xff;
      db.$client
        .prepare("update webhooks set secret_ciphertext = ? where id = ?")
        .run(flipped, id);
    }
    if (failure === "wrong encryption key") {
      await dispatcher.stop();
      dispatcher = createDispatcher({
        db,
        signingKey: config.webhookSigningKey,
        secretEncryptionKey: Buffer.from(
          config.secretEncryptionKey.map((b) => b ^ 0xff),
        ),
        log: (line) => logs.push(line),
        now: () => clock,
        random: () => 0.5,
      });
    }
    const { runId, token } = runningRun();
    await finish(token, runId);
    await dispatcher.drain();

    // the failing path ran: one failed attempt, nothing sent
    expect(received).toHaveLength(0);
    const [only] = deliveries();
    expect(only).toMatchObject({
      status: "pending",
      attempts: 1,
      lastStatus: null,
      lastError:
        failure === "network error"
          ? expect.any(String)
          : "Error: cannot open the webhook's secret",
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("attempt 1/30 failed");
    for (const text of [...logs, only?.lastError ?? ""]) {
      expect(text).not.toContain(plain);
      expect(text).not.toContain(plain.slice("whsec_".length));
    }
    expectNoneStored(plain, plain.slice("whsec_".length));
  },
);

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

test.each([
  ["sky", {}],
  ["standard", { secret }],
  ["openbot", { secret: openbotSecret }],
] as const)(
  "a run.withdrawn event is delivered in the %s format with its request and reason",
  async (format, extra) => {
    await subscribe(["run.withdrawn"], subscriberUrl, { format, ...extra });
    const received = subscriber([200]);
    const { agentId, envId, runId, token } = runningRun();
    const requestId = "req_withdrawn1";
    await postEvent(token, {
      runId,
      type: "run.waiting",
      payload: { request: { kind: "question", requestId, prompt: "which?" } },
    });
    const posted = await postEvent(token, {
      runId,
      type: "run.withdrawn",
      payload: { requestId, reason: "hook_cancelled" },
    });
    expect(posted.status).toBe(201);
    const { id: eventId } = (await posted.json()) as { id: number };

    await dispatcher.drain();
    // run.waiting isn't subscribed, so the withdrawal is the one delivery
    expect(received).toHaveLength(1);
    const stored = db.$client
      .prepare("select ts from events where id = ?")
      .get(eventId) as { ts: string };
    const event = {
      id: `evt_${eventId}`,
      agentId,
      environmentId: envId,
      runId,
      ts: stored.ts,
      type: "run.withdrawn",
      payload: { requestId, reason: "hook_cancelled" },
    };
    expect(JSON.parse(received[0]?.body ?? "")).toEqual(
      format === "sky"
        ? event
        : format === "standard"
          ? { type: "run.withdrawn", timestamp: stored.ts, data: event }
          : { type: "run.withdrawn", data: event },
    );
    expect(deliveries().map((d) => d.status)).toEqual(["delivered"]);
  },
);

// --- delivery results on a webhook, and its deliveries route ---

type Summary = {
  id: string;
  lastAttempt?: {
    at: string;
    status: number | null;
    error: string | null;
    attempt: number;
  };
  failedStreak?: number;
  failing?: true;
};

async function summaryOf(webhookId: string, token = config.apiKey) {
  const res = await app.request(`/v1/webhooks/${webhookId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Summary;
}

/** An event a run can post any number of times, unlike its finish. */
const chatter = (runId: RunId, token: string) =>
  postEvent(token, {
    runId,
    type: "claude.Message",
    payload: { text: "working" },
  });

const finished = (runId: RunId, token: string) =>
  postEvent(token, {
    runId,
    type: "run.finished",
    payload: { summary: "ok", usage },
  });

test("a webhook shows no results until it has a delivery, then its last attempt and no streak", async () => {
  const id = await subscribe(["run.finished"]);
  const listed = await app.request("/v1/webhooks", { headers: auth });
  const { data } = (await listed.json()) as { data: Summary[] };
  expect(data).toHaveLength(1);
  expect(data[0]).not.toHaveProperty("lastAttempt");
  expect(data[0]).not.toHaveProperty("failedStreak");
  expect(data[0]).not.toHaveProperty("failing");
  expect(await summaryOf(id)).not.toHaveProperty("lastAttempt");

  subscriber([200]);
  const { runId, token } = runningRun();
  await finished(runId, token);
  await dispatcher.drain();
  expect(await summaryOf(id)).toMatchObject({
    lastAttempt: {
      at: clock.toISOString(),
      status: 200,
      error: null,
      attempt: 1,
    },
    failedStreak: 0,
  });
  expect(await summaryOf(id)).not.toHaveProperty("failing");
});

test("the streak counts deliveries failed or retrying since the last delivered one", async () => {
  const id = await subscribe(["claude.Message"]);
  const { runId, token } = runningRun();
  // delivered first, then two events whose first attempt fails and are still retrying
  subscriber([200]);
  await chatter(runId, token);
  await dispatcher.drain();
  advance(1_000);
  subscriber([500, 500]);
  await chatter(runId, token);
  await chatter(runId, token);
  await dispatcher.drain();
  expect(deliveries().map((d) => d.status)).toEqual([
    "delivered",
    "pending",
    "pending",
  ]);
  const summary = await summaryOf(id);
  expect(summary.failedStreak).toBe(2);
  expect(summary.lastAttempt).toMatchObject({
    at: clock.toISOString(),
    status: 500,
    attempt: 1,
  });
  expect(summary).not.toHaveProperty("failing");
  // a later delivered one resets it
  advance(1_000);
  subscriber([200]);
  await chatter(runId, token);
  await dispatcher.drain();
  expect((await summaryOf(id)).failedStreak).toBe(0);
});

test("an attempt with no response shows its error kind, not a status", async () => {
  const id = await subscribe(["run.finished"]);
  server.use(http.post(subscriberUrl, () => HttpResponse.error()));
  const { runId, token } = runningRun();
  await finished(runId, token);
  await dispatcher.drain();
  const { lastAttempt } = await summaryOf(id);
  expect(lastAttempt?.status).toBeNull();
  expect(lastAttempt?.error).toEqual(expect.any(String));
});

test.each([
  ["timed out after 30s", "timeout"],
  [
    "TypeError: fetch failed: connect ECONNREFUSED 10.0.0.1:443",
    "connection_refused",
  ],
  ["TypeError: fetch failed: getaddrinfo ENOTFOUND hooks.example.com", "dns"],
  ["TypeError: fetch failed: read ECONNRESET", "connection_reset"],
  ["TypeError: fetch failed: certificate has expired", "tls"],
  ["TypeError: fetch failed", "other"],
])("the error %j is kind %s", (text, kind) => {
  expect(errorKind(text)).toBe(kind);
  expect(errorKind(null)).toBeNull();
});

/** Fails one event's delivery through all 30 attempts. */
async function giveUp() {
  for (let i = 0; i < 30; i++) {
    await dispatcher.drain();
    advance(3_600_000);
  }
}

const warnings = (runId: RunId) =>
  db.$client
    .prepare(
      "select payload from events where run_id = ? and type = 'runner.warning' order by id",
    )
    .all(runId)
    .map((r) => JSON.parse((r as { payload: string }).payload).message);

test("the 30th failed attempt flags the webhook and warns the run; a delivered one clears the flag", async () => {
  const id = await subscribe(["run.finished"]);
  subscriber(Array(30).fill(401));
  const { runId, token } = runningRun();
  await finished(runId, token);
  for (let i = 0; i < 29; i++) {
    await dispatcher.drain();
    advance(3_600_000);
  }
  expect(await summaryOf(id)).not.toHaveProperty("failing");
  expect(warnings(runId)).toEqual([]);

  await dispatcher.drain();
  const failing = await summaryOf(id);
  expect(failing.failing).toBe(true);
  expect(failing.failedStreak).toBe(1);
  expect(failing.lastAttempt).toMatchObject({ status: 401, attempt: 30 });
  const [message, ...more] = warnings(runId);
  expect(more).toEqual([]);
  expect(message).toContain(id);
  expect(message).toContain("status 401");
  expect(message).not.toContain(subscriberUrl);
  expect(message).not.toContain("hooks.example.com");

  advance(1_000);
  subscriber([200]);
  seedDeliveries(id, 1);
  await dispatcher.drain();
  const cleared = await summaryOf(id);
  expect(cleared).not.toHaveProperty("failing");
  expect(cleared.failedStreak).toBe(0);
});

test("a give-up on a runner.warning delivery flags the webhook but posts no further warning", async () => {
  const id = await subscribe(["run.finished", "runner.warning"]);
  server.use(
    http.post(subscriberUrl, () => new HttpResponse(null, { status: 503 })),
  );
  const { runId, token } = runningRun();
  await finished(runId, token);
  // 30 attempts of the finish; the warning that follows is delivered 30 times too
  for (let i = 0; i < 70; i++) {
    await dispatcher.drain();
    advance(3_600_000);
  }
  expect(warnings(runId)).toHaveLength(1);
  expect(deliveries().map((d) => d.status)).toEqual(["failed", "failed"]);
  expect((await summaryOf(id)).failing).toBe(true);
});

test("a give-up while the webhook is already failing posts no second warning", async () => {
  const id = await subscribe(["run.finished"]);
  subscriber([]);
  const first = runningRun("first");
  await finished(first.runId, first.token);
  await giveUp();
  const second = runningRun("second");
  await finished(second.runId, second.token);
  await giveUp();
  expect(deliveries().map((d) => d.status)).toEqual(["failed", "failed"]);
  expect(warnings(first.runId)).toHaveLength(1);
  expect(warnings(second.runId)).toEqual([]);
  expect((await summaryOf(id)).failing).toBe(true);
});

test("a give-up after a delivered attempt cleared the flag warns again", async () => {
  const id = await subscribe(["run.finished"]);
  subscriber([]);
  const first = runningRun("first");
  await finished(first.runId, first.token);
  await giveUp();

  advance(1_000);
  subscriber([200]);
  seedDeliveries(id, 1);
  await dispatcher.drain();
  expect(await summaryOf(id)).not.toHaveProperty("failing");

  subscriber([]);
  const second = runningRun("second");
  await finished(second.runId, second.token);
  await giveUp();
  expect(warnings(first.runId)).toHaveLength(1);
  expect(warnings(second.runId)).toHaveLength(1);
  expect((await summaryOf(id)).failing).toBe(true);
});

test("a webhook that never gave up isn't flagged by one that did", async () => {
  const bad = await subscribe(["run.finished"], "https://bad.example.com/h");
  const good = await subscribe(["run.finished"], "https://good.example.com/h");
  server.use(
    http.post(
      "https://bad.example.com/h",
      () => new HttpResponse(null, { status: 500 }),
    ),
    http.post(
      "https://good.example.com/h",
      () => new HttpResponse(null, { status: 200 }),
    ),
  );
  const { runId, token } = runningRun();
  await finished(runId, token);
  await giveUp();
  expect((await summaryOf(bad)).failing).toBe(true);
  expect(await summaryOf(good)).not.toHaveProperty("failing");
});

type Page = {
  data: Record<string, unknown>[];
  nextCursor?: string;
};

const getDeliveries = (webhookId: string, query = "", token = config.apiKey) =>
  app.request(`/v1/webhooks/${webhookId}/deliveries${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

/** `n` deliveries of one webhook, each on its own run.finished event, oldest first. */
let seeded = 0;
function seedDeliveries(webhookId: string, n: number) {
  const { runId } = runningRun(`seed${seeded++}`);
  for (let i = 0; i < n; i++) {
    const event = db.$client
      .prepare(
        "insert into events (run_id, ts, type, payload) values (?, ?, 'run.finished', '{}') returning id",
      )
      .get(runId, new Date().toISOString()) as { id: number };
    db.insert(webhookDeliveries)
      .values({
        webhookId: webhookId as WebhookId,
        eventId: event.id,
        status: "pending",
        nextAttemptAt: new Date().toISOString(),
      })
      .run();
  }
  return runId;
}

test("deliveries come newest first, 20 by default, and a cursor pages on", async () => {
  const id = await subscribe(["run.finished"]);
  seedDeliveries(id, 25);
  const ids = deliveries().map((d) => d.id);
  const first = (await (await getDeliveries(id)).json()) as Page;
  expect(first.data.map((d) => d.id)).toEqual(ids.slice(5).reverse());
  expect(first.nextCursor).toBeDefined();
  const second = (await (
    await getDeliveries(id, `?cursor=${first.nextCursor}`)
  ).json()) as Page;
  expect(second.data.map((d) => d.id)).toEqual(ids.slice(0, 5).reverse());
  expect(second).not.toHaveProperty("nextCursor");
  const small = (await (await getDeliveries(id, "?limit=3")).json()) as Page;
  expect(small.data).toHaveLength(3);
});

test("the limit is at most 100, and a bad limit or cursor is a 400", async () => {
  const id = await subscribe(["run.finished"]);
  seedDeliveries(id, 101);
  const all = (await (await getDeliveries(id, "?limit=100")).json()) as Page;
  expect(all.data).toHaveLength(100);
  expect(all.nextCursor).toBeDefined();
  for (const query of ["?limit=101", "?limit=0", "?limit=abc", "?limit=-1"]) {
    const res = await getDeliveries(id, query);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: "invalid_query" },
    });
  }
  expect((await getDeliveries(id, "?cursor=abc")).status).toBe(400);
});

test("a delivery shows its event, run, attempts, status, error and times, and nothing of the request", async () => {
  const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
  const id = await subscribe(["run.finished"], subscriberUrl, {
    format: "standard",
    secret,
  });
  server.use(
    http.post(subscriberUrl, () => new HttpResponse(null, { status: 502 })),
  );
  const { runId, token } = runningRun();
  await finished(runId, token);
  await dispatcher.drain();
  const res = await getDeliveries(id);
  const text = await res.text();
  const { data } = JSON.parse(text) as Page;
  expect(data).toEqual([
    {
      id: expect.any(Number),
      eventType: "run.finished",
      runId,
      status: "pending",
      attempts: 1,
      lastStatus: 502,
      lastError: null,
      lastErrorKind: null,
      createdAt: expect.stringMatching(/Z$/),
      lastAttemptAt: clock.toISOString(),
      nextAttemptAt: expect.stringMatching(/Z$/),
    },
  ]);
  expect(text).not.toContain(secret);
  expect(text).not.toContain("hooks.example.com");
  expect(text).not.toMatch(/signature|payload|body|header/i);
});

test("a delivery's last error is redacted", async () => {
  const id = await subscribe(["run.finished"]);
  seedDeliveries(id, 1);
  const planted = `ghp_${"a1B2".repeat(9)}`;
  db.update(webhookDeliveries)
    .set({
      lastError: `fetch failed: bad token ${planted} and ${config.apiKey}`,
    })
    .run();
  const text = await (await getDeliveries(id)).text();
  expect(text).not.toContain(planted);
  expect(text).not.toContain(config.apiKey);
  expect(text).toContain("[redacted]");
});

test("a runs key reads the deliveries of its own webhooks only", async () => {
  const { envId } = runningRun();
  const created = await app.request("/v1/keys", {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "ci", role: "runs", environmentIds: [envId] }),
  });
  expect(created.status).toBe(201);
  const { secret } = (await created.json()) as { secret: string };
  const make = async (token: string) =>
    (
      (await (
        await app.request("/v1/webhooks", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            url: subscriberUrl,
            eventTypes: ["run.finished"],
          }),
        })
      ).json()) as { id: string }
    ).id;
  const mine = await make(secret);
  const admins = await make(config.apiKey);
  seedDeliveries(mine, 1);
  seedDeliveries(admins, 1);
  expect((await getDeliveries(mine, "", secret)).status).toBe(200);
  const denied = await getDeliveries(admins, "", secret);
  expect(denied.status).toBe(404);
  const missing = await getDeliveries("whk_0000000000000000000000", "", secret);
  expect(await denied.json()).toEqual(await missing.json());
  expect((await getDeliveries(mine)).status).toBe(200);
  expect((await getDeliveries(admins)).status).toBe(200);
});
