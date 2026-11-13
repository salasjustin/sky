import { SpritesClient } from "@fly/sprites";
import { type Db, migrate, openDb } from "@sky/db";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createApp } from "./app.js";
import { testConfig } from "./testing/sprites.js";

let db: Db;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
  app = createApp({
    db,
    config: testConfig(),
    sprites: new SpritesClient("unused"),
    log: () => {},
    nudgeDeliveries: () => {},
  });
});
afterEach(() => {
  if (db.$client.open) db.$client.close();
});

const auth = { Authorization: `Bearer ${testConfig().apiKey}` };
const json = { ...auth, "Content-Type": "application/json" };

const subscribe = (body: unknown) =>
  app.request("/v1/webhooks", {
    method: "POST",
    headers: json,
    body: JSON.stringify(body),
  });

const hook = {
  url: "https://hooks.example.com/sky",
  eventTypes: ["run.finished", "run.failed"],
};

test("POST creates a subscription: 201, its Location and the webhook", async () => {
  const res = await subscribe(hook);
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string };
  expect(body).toEqual({
    id: expect.stringMatching(/^whk_[0-9A-Za-z]{22}$/),
    ...hook,
    format: "sky",
    createdAt: expect.stringMatching(/Z$/),
  });
  expect(res.headers.get("location")).toBe(`/v1/webhooks/${body.id}`);
});

test("GET lists subscriptions in creation order and GET /:id reads one", async () => {
  const a = (await (await subscribe(hook)).json()) as { id: string };
  const b = (await (
    await subscribe({ ...hook, eventTypes: ["claude.PostToolUse"] })
  ).json()) as { id: string };

  const list = await app.request("/v1/webhooks", { headers: auth });
  expect(list.status).toBe(200);
  expect(await list.json()).toEqual({ data: [a, b] });

  const one = await app.request(`/v1/webhooks/${b.id}`, { headers: auth });
  expect(one.status).toBe(200);
  expect(await one.json()).toEqual(b);
});

test("GET breaks a same-millisecond tie by insert order, not id", async () => {
  const at = "2026-01-01T00:00:00.000Z";
  const insert = db.$client.prepare(
    "insert into webhooks (id, url, event_types, created_at) values (?, ?, '[\"run.finished\"]', ?)",
  );
  const first = `whk_${"z".repeat(22)}`;
  const second = `whk_${"A".repeat(22)}`;
  insert.run(first, hook.url, at);
  insert.run(second, hook.url, at);
  const list = await app.request("/v1/webhooks", { headers: auth });
  const { data } = (await list.json()) as { data: { id: string }[] };
  expect(data.map((w) => w.id)).toEqual([first, second]);
});

test("DELETE removes the subscription: 204, then 404", async () => {
  const { id } = (await (await subscribe(hook)).json()) as { id: string };
  const del = await app.request(`/v1/webhooks/${id}`, {
    method: "DELETE",
    headers: auth,
  });
  expect(del.status).toBe(204);
  expect(await del.text()).toBe("");
  const again = await app.request(`/v1/webhooks/${id}`, { headers: auth });
  expect(again.status).toBe(404);
  expect(await again.json()).toEqual({
    error: { code: "not_found", message: expect.any(String) },
  });
});

test.each([
  ["GET", "/v1/webhooks/whk_missing"],
  ["DELETE", "/v1/webhooks/whk_missing"],
  ["GET", "/v1/webhooks/not-an-id"],
])("%s %s for no such webhook is a 404 envelope", async (method, path) => {
  const res = await app.request(path, { method, headers: auth });
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({
    error: { code: "not_found", message: expect.any(String) },
  });
});

test.each([
  ["a loopback host", "https://127.0.0.1/hook"],
  ["localhost", "https://localhost:3000/hook"],
  ["cloud metadata", "https://169.254.169.254/latest"],
  ["an IPv6 unique-local host", "https://[fd00::1]/hook"],
])(
  "a URL naming %s is 400 url_not_allowed and stores nothing",
  async (_, url) => {
    const res = await subscribe({ ...hook, url });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "url_not_allowed", message: expect.any(String) },
    });
    expect(db.$client.prepare("select count(*) n from webhooks").get()).toEqual(
      {
        n: 0,
      },
    );
  },
);

test.each([
  ["a non-http URL", { ...hook, url: "file:///etc/passwd" }],
  ["a plain-http URL", { ...hook, url: "http://hooks.example.com/sky" }],
  ["an unknown event type", { ...hook, eventTypes: ["run.exploded"] }],
  ["no event types", { ...hook, eventTypes: [] }],
  ["an unknown field", { ...hook, secret: "x" }],
  ["a missing url", { eventTypes: hook.eventTypes }],
  ["a public IP literal host", { ...hook, url: "https://8.8.8.8/hook" }],
])("%s is 400 invalid_body", async (_, body) => {
  const res = await subscribe(body);
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: { code: "invalid_body", message: expect.any(String) },
  });
});

test("a body without a JSON content type is 415, not an empty subscription", async () => {
  const res = await app.request("/v1/webhooks", {
    method: "POST",
    headers: auth,
    body: JSON.stringify(hook),
  });
  expect(res.status).toBe(415);
});

test.each([
  ["POST", "/v1/webhooks"],
  ["GET", "/v1/webhooks"],
  ["GET", "/v1/webhooks/whk_x"],
  ["DELETE", "/v1/webhooks/whk_x"],
])("%s %s without the API key is 401", async (method, path) => {
  const res = await app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: method === "POST" ? JSON.stringify(hook) : undefined,
  });
  expect(res.status).toBe(401);
});

const whsec = `whsec_${Buffer.from("0123456789abcdef0123456789abcdef").toString("base64")}`;

test("a standard webhook is created with its secret held back: the format comes back, the secret doesn't", async () => {
  const res = await subscribe({ ...hook, format: "standard", secret: whsec });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string };
  expect(body).toEqual({
    id: expect.any(String),
    ...hook,
    format: "standard",
    createdAt: expect.stringMatching(/Z$/),
  });
  expect(JSON.stringify(body)).not.toContain(whsec);
});

test("an openbot webhook takes its secret as is, and hides it", async () => {
  const openbotSecret = "whsec_not+base64/but-fine";
  const res = await subscribe({
    ...hook,
    format: "openbot",
    secret: openbotSecret,
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string };
  expect(body).toEqual({
    id: expect.any(String),
    ...hook,
    format: "openbot",
    createdAt: expect.stringMatching(/Z$/),
  });
  expect(JSON.stringify(body)).not.toContain(openbotSecret);
});

// distinctive, so finding it in a response means the secret was echoed
const rawSecret = "Zq7openbotRaw";

test.each([
  [
    "a leading space",
    ` ${rawSecret}`,
    "an openbot secret has no leading or trailing whitespace",
  ],
  [
    "a trailing newline",
    `${rawSecret}\n`,
    "an openbot secret has no leading or trailing whitespace",
  ],
  [
    "257 characters",
    rawSecret.padEnd(257, "x"),
    "an openbot secret is at most 256 characters",
  ],
])(
  "an openbot secret with %s is 400 invalid_body naming the rule, without the secret",
  async (_, secret, message) => {
    const res = await subscribe({ ...hook, format: "openbot", secret });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      error: { code: "invalid_body", message },
    });
    expect(text).not.toContain(rawSecret);
    expect(db.$client.prepare("select count(*) n from webhooks").get()).toEqual(
      { n: 0 },
    );
  },
);

test("an openbot webhook without a secret is 400 invalid_body saying it needs one", async () => {
  const res = await subscribe({ ...hook, format: "openbot" });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: {
      code: "invalid_body",
      message: expect.stringMatching(/needs a secret/),
    },
  });
});

test("environmentIds of existing environments are stored and returned, duplicates collapsed", async () => {
  db.$client
    .prepare(
      "insert into environments (id, name, repo, setup, status, sprite_name) values ('env_1', 'one', 'a/b', '', 'ready', 's')",
    )
    .run();
  const res = await subscribe({
    ...hook,
    environmentIds: ["env_1", "env_1"],
  });
  expect(res.status).toBe(201);
  expect(await res.json()).toMatchObject({ environmentIds: ["env_1"] });
});

test.each([
  ["a standard format without a secret", { format: "standard" }],
  [
    "a secret without the whsec_ prefix",
    { format: "standard", secret: "MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw" },
  ],
  ["a secret that is not base64", { format: "standard", secret: "whsec_%%%" }],
  ["an empty secret key", { format: "standard", secret: "whsec_" }],
  ["an openbot format without a secret", { format: "openbot" }],
  ["an openbot format with an empty secret", { format: "openbot", secret: "" }],
  ["a secret on a sky webhook", { secret: whsec }],
  ["an unknown format", { format: "svix", secret: whsec }],
  ["an unknown environment", { environmentIds: ["env_missing"] }],
  ["an empty environmentIds", { environmentIds: [] }],
  ["a malformed environment id", { environmentIds: ["nope"] }],
])("%s is 400 invalid_body and stores nothing", async (_, extra) => {
  const res = await subscribe({ ...hook, ...extra });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: { code: "invalid_body", message: expect.any(String) },
  });
  expect(db.$client.prepare("select count(*) n from webhooks").get()).toEqual({
    n: 0,
  });
});
