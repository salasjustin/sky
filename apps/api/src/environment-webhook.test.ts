import { randomBytes } from "node:crypto";
import { SpritesClient } from "@fly/sprites";
import {
  apiKeys,
  type Db,
  environments,
  migrate,
  openDb,
  webhooks,
} from "@sky/db";
import type { ApiKeyId, EnvironmentId, WebhookId } from "@sky/shared";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createApp } from "./app.js";
import { applyEnvWebhook } from "./environment-webhook.js";
import { spriteNameFor } from "./sprites.js";
import { spritesToken, stubSprites, testConfig } from "./testing/sprites.js";

const config = testConfig();
const auth = { Authorization: `Bearer ${config.apiKey}` };
const json = { ...auth, "Content-Type": "application/json" };

let db: Db;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
  stubSprites();
  app = createApp({
    db,
    config,
    sprites: new SpritesClient(spritesToken),
    log: () => {},
    nudgeDeliveries: () => {},
  });
});
afterEach(() => {
  if (db.$client.open) db.$client.close();
});

const envId = "env_hooked" as EnvironmentId;
const url = "https://signal.example.com/v1/webhooks/routine";
const fiveEvents = [
  "run.waiting",
  "run.finished",
  "run.failed",
  "run.stopped",
  "runner.warning",
];
// minted per run: a fixture never holds a secret's value
const signingSecret = () => randomBytes(18).toString("hex");

function readyEnv() {
  db.insert(environments)
    .values({
      id: envId,
      name: "hooked",
      repo: "acme/kru",
      setup: "",
      status: "ready",
      spriteName: spriteNameFor(envId),
      checkpointId: "v1",
    })
    .run();
}

const setSecret = async (value = signingSecret()) => {
  const res = await app.request(
    `/v1/environments/${envId}/secrets/SKY_WEBHOOK_SECRET`,
    { method: "PUT", headers: json, body: JSON.stringify({ value }) },
  );
  expect(res.status).toBe(200);
  return value;
};

const patch = (body: unknown, headers = json) =>
  app.request(`/v1/environments/${envId}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
  });

const spec = { url, format: "openbot" };
const rows = () => db.select().from(webhooks).all();
const stored = () =>
  db.select().from(environments).where(eq(environments.id, envId)).get();

test("an apply creates the environment's one webhook with the five default events, and keeps its id on the row", async () => {
  readyEnv();
  await setSecret();
  const res = await patch({ webhook: spec });
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.webhookChange).toBe("created");
  expect(body.webhook).toEqual({
    id: expect.stringMatching(/^whk_/),
    url,
    format: "openbot",
    events: fiveEvents,
  });
  const [row, ...more] = rows();
  expect(more).toEqual([]);
  expect(row).toMatchObject({
    url,
    format: "openbot",
    eventTypes: fiveEvents,
    environmentIds: [envId],
    ownerKeyId: null,
  });
  expect(stored()?.webhookId).toBe(row?.id);
  // the secret is sealed, and nothing the API answers carries it
  expect(row?.secretCiphertext).not.toBeNull();
  expect(JSON.stringify(body)).not.toMatch(/secret/i);
});

test("a second apply with no change is a no-op that keeps the same row", async () => {
  readyEnv();
  await setSecret();
  const first = await (await patch({ webhook: spec })).json();
  const second = (await (await patch({ webhook: spec })).json()) as {
    webhookChange: string;
    webhook: { id: string };
  };
  expect(second.webhookChange).toBe("unchanged");
  expect(second.webhook.id).toBe(
    (first as { webhook: { id: string } }).webhook.id,
  );
  expect(rows()).toHaveLength(1);
});

test("changing the url, the events or the secret updates the same row in place", async () => {
  readyEnv();
  const secret = await setSecret();
  const created = (await (await patch({ webhook: spec })).json()) as {
    webhook: { id: string };
  };
  const id = created.webhook.id;

  const moved = "https://signal.example.com/v1/webhooks/other";
  const byUrl = (await (
    await patch({ webhook: { ...spec, url: moved } })
  ).json()) as { webhookChange: string };
  expect(byUrl.webhookChange).toBe("updated");
  expect(rows().map((r) => [r.id, r.url])).toEqual([[id, moved]]);

  const byEvents = (await (
    await patch({
      webhook: { url: moved, format: "openbot", events: ["run.finished"] },
    })
  ).json()) as { webhookChange: string };
  expect(byEvents.webhookChange).toBe("updated");
  expect(rows().map((r) => [r.id, r.eventTypes])).toEqual([
    [id, ["run.finished"]],
  ]);

  // a rotation: the same file, a new secret
  const before = rows()[0]?.secretCiphertext;
  await setSecret(`${secret}-rotated`);
  const rotated = (await (
    await patch({
      webhook: { url: moved, format: "openbot", events: ["run.finished"] },
    })
  ).json()) as { webhookChange: string };
  expect(rotated.webhookChange).toBe("updated");
  expect(rows()).toHaveLength(1);
  expect(rows()[0]?.secretCiphertext).not.toEqual(before);
});

test("a missing SKY_WEBHOOK_SECRET fails the apply, creates nothing and applies none of the body", async () => {
  readyEnv();
  const res = await patch({ webhook: spec, concurrency: 5 });
  expect(res.status).toBe(400);
  const body = (await res.json()) as {
    error: { code: string; message: string };
  };
  expect(body.error.code).toBe("webhook_secret_missing");
  expect(body.error.message).toContain(
    "sky secret set hooked SKY_WEBHOOK_SECRET",
  );
  expect(rows()).toEqual([]);
  expect(stored()).toMatchObject({ webhookId: null, concurrency: 3 });
});

test("a secret the format can't use fails the apply without quoting it", async () => {
  readyEnv();
  const bad = ` ${signingSecret()} `;
  await setSecret(bad);
  const res = await patch({ webhook: spec });
  expect(res.status).toBe(400);
  expect(await res.text()).not.toContain(bad.trim());
  expect(rows()).toEqual([]);
});

test("a null webhook deletes the environment's webhook, and an environment with none stays as it was", async () => {
  readyEnv();
  const none = await patch({ webhook: null });
  expect(none.status).toBe(200);
  expect(((await none.json()) as { webhookChange: string }).webhookChange).toBe(
    "none",
  );
  await setSecret();
  await patch({ webhook: spec });
  expect(rows()).toHaveLength(1);
  const removed = (await (await patch({ webhook: null })).json()) as {
    webhookChange: string;
    webhook: unknown;
  };
  expect(removed).toMatchObject({ webhookChange: "removed", webhook: null });
  expect(rows()).toEqual([]);
  expect(stored()?.webhookId).toBeNull();
});

test("deleting the environment deletes its webhook with it", async () => {
  readyEnv();
  await setSecret();
  await patch({ webhook: spec });
  const res = await app.request(`/v1/environments/${envId}`, {
    method: "DELETE",
    headers: auth,
  });
  expect(res.status).toBe(204);
  expect(rows()).toEqual([]);
});

test("a webhook row someone else made for this environment and url is adopted, not duplicated", async () => {
  readyEnv();
  await setSecret();
  const keyId = "key_other" as ApiKeyId;
  db.insert(apiKeys)
    .values({
      id: keyId,
      name: "pm",
      keyHash: "0".repeat(64),
      role: "runs",
      environmentIds: [envId],
    })
    .run();
  const made = await app.request("/v1/webhooks", {
    method: "POST",
    headers: json,
    body: JSON.stringify({
      url,
      eventTypes: ["run.finished"],
      format: "openbot",
      secret: signingSecret(),
      environmentIds: [envId],
    }),
  });
  const { id } = (await made.json()) as { id: WebhookId };
  db.update(webhooks)
    .set({ ownerKeyId: keyId })
    .where(eq(webhooks.id, id))
    .run();

  const res = await patch({ webhook: spec });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { webhookChange: string }).webhookChange).toBe(
    "updated",
  );
  expect(rows().map((r) => [r.id, r.ownerKeyId, r.eventTypes])).toEqual([
    [id, null, fiveEvents],
  ]);
  expect(stored()?.webhookId).toBe(id);
});

test("an issued key can't apply an environment, and a non-admin principal is refused another key's webhook by name", async () => {
  readyEnv();
  await setSecret();
  const mine = "key_mine" as ApiKeyId;
  const theirs = "key_theirs" as ApiKeyId;
  for (const [id, name] of [
    [mine, "mine"],
    [theirs, "theirs"],
  ] as const) {
    db.insert(apiKeys)
      .values({
        id,
        name,
        keyHash: id.padEnd(64, "0"),
        role: "runs",
        environmentIds: [envId],
      })
      .run();
  }
  const minted = await app.request("/v1/keys", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ name: "ci", role: "runs", environmentIds: [envId] }),
  });
  const { secret } = (await minted.json()) as { secret: string };
  const forbidden = await patch(
    { webhook: spec },
    { ...json, Authorization: `Bearer ${secret}` },
  );
  expect(forbidden.status).toBe(403);
  expect(rows()).toEqual([]);

  // the route is the admin's; the rule holds for any principal the function is handed
  const made = db.transaction((tx) =>
    applyEnvWebhook(
      tx,
      config.secretEncryptionKey,
      { role: "admin" },
      stored() as typeof environments.$inferSelect,
      { url, format: "openbot", events: ["run.finished"] },
    ),
  );
  expect(made).toEqual({ ok: true, change: "created" });
  db.update(webhooks).set({ ownerKeyId: theirs }).run();
  const before = rows();

  const refused = db.transaction((tx) =>
    applyEnvWebhook(
      tx,
      config.secretEncryptionKey,
      { role: "runs", keyId: mine, environmentIds: [envId] },
      stored() as typeof environments.$inferSelect,
      { url, format: "openbot", events: fiveEvents as never },
    ),
  );
  expect(refused).toMatchObject({
    ok: false,
    code: "webhook_owned",
    message: expect.stringContaining('"theirs"'),
  });
  expect(rows()).toEqual(before);
});
