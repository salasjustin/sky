import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpritesClient } from "@fly/sprites";
import {
  agents,
  apiKeys,
  type Db,
  environments,
  events,
  migrate,
  openDb,
  runRequests,
  runs,
  webhookDeliveries,
  webhooks,
} from "@sky/db";
import {
  type AgentId,
  ApiKey,
  type ApiKeyId,
  CreatedApiKey,
  type EnvironmentId,
  type RunId,
  type RunStatus,
  type WebhookId,
} from "@sky/shared";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createApp } from "./app.js";
import { mintId } from "./ids.js";
import { isActive, recordEvent } from "./runs.js";
import { spriteNameFor } from "./sprites.js";
import {
  type SpritesWire,
  spritesToken,
  stubSprites,
  testConfig,
} from "./testing/sprites.js";
import { sseReader } from "./testing/sse.js";

const config = testConfig();
let dir: string;
let db: Db;
let logs: string[];
let app: ReturnType<typeof createApp>;
let wire: SpritesWire;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sky-keys-"));
  writeFileSync(join(dir, "runner.mjs"), "// runner bundle v1\n");
  db = openDb(":memory:");
  migrate(db);
  wire = stubSprites();
  logs = [];
  app = createApp({
    db,
    config: { ...config, runnerBundlePath: join(dir, "runner.mjs") },
    sprites: new SpritesClient(spritesToken),
    log: (line) => logs.push(line),
    nudgeDeliveries: () => {},
  });
});
afterEach(() => {
  if (db.$client.open) db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

const admin = config.apiKey;

const call = (
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> =>
  Promise.resolve(
    app.request(path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

function readyEnv(): EnvironmentId {
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
    })
    .run();
  wire.sprites.add(spriteNameFor(id));
  return id;
}

async function mintKey(environmentIds: EnvironmentId[], name = "ci") {
  const res = await call(admin, "POST", "/v1/keys", {
    name,
    role: "runs",
    environmentIds,
  });
  expect(res.status).toBe(201);
  return CreatedApiKey.parse(await res.json());
}

const forbidden = {
  error: { code: "forbidden", message: expect.any(String) },
};
const unauthorized = {
  error: { code: "unauthorized", message: "invalid bearer token" },
};

test("admin mints a runs key: 201, the secret once, no Location, and only its sha-256 stored", async () => {
  const envId = readyEnv();
  const res = await call(admin, "POST", "/v1/keys", {
    name: "ci",
    role: "runs",
    environmentIds: [envId],
  });
  expect(res.status).toBe(201);
  const created = CreatedApiKey.parse(await res.json());
  expect(created).toMatchObject({
    name: "ci",
    role: "runs",
    environmentIds: [envId],
    revokedAt: null,
    lastUsedAt: null,
  });
  expect(created.id).toMatch(/^key_/);
  // no GET /v1/keys/:id to point at
  expect(res.headers.get("location")).toBeNull();
  const row = db.select().from(apiKeys).get();
  expect(row?.keyHash).toBe(
    createHash("sha256").update(created.secret).digest("hex"),
  );
  expect(JSON.stringify(row)).not.toContain(created.secret);
});

test("the list shows keys oldest first with neither secret nor hash", async () => {
  const envId = readyEnv();
  const first = await mintKey([envId], "first");
  const second = await mintKey([envId], "second");
  const res = await call(admin, "GET", "/v1/keys");
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).not.toContain(first.secret);
  expect(text).not.toContain("keyHash");
  const { data } = JSON.parse(text) as { data: unknown[] };
  expect(data.map((k) => ApiKey.strict().parse(k).id)).toEqual([
    first.id,
    second.id,
  ]);
});

test("minting refuses an unknown environment and an admin role", async () => {
  const envId = readyEnv();
  const unknown = await call(admin, "POST", "/v1/keys", {
    name: "ci",
    role: "runs",
    environmentIds: [envId, "env_nope"],
  });
  expect(unknown.status).toBe(400);
  expect(await unknown.json()).toEqual({
    error: { code: "invalid_body", message: "no such environment: env_nope" },
  });
  const adminRole = await call(admin, "POST", "/v1/keys", {
    name: "ci",
    role: "admin",
    environmentIds: [envId],
  });
  expect(adminRole.status).toBe(400);
  expect(db.select().from(apiKeys).all()).toEqual([]);
});

test("an issued key authenticates and records last use at most once a minute", async () => {
  const key = await mintKey([readyEnv()]);
  expect((await call(key.secret, "GET", "/v1/environments")).status).toBe(200);
  const first = db.select().from(apiKeys).get()?.lastUsedAt;
  expect(first).toEqual(expect.any(String));
  await new Promise((r) => setTimeout(r, 5));
  await call(key.secret, "GET", "/v1/environments");
  expect(db.select().from(apiKeys).get()?.lastUsedAt).toBe(first);
});

test("revoking answers the key with revokedAt, keeps the first time, and the key stops working", async () => {
  const key = await mintKey([readyEnv()]);
  const res = await call(admin, "DELETE", `/v1/keys/${key.id}`);
  expect(res.status).toBe(200);
  const revoked = ApiKey.strict().parse(await res.json());
  expect(revoked.revokedAt).toEqual(expect.any(String));
  const again = ApiKey.parse(
    await (await call(admin, "DELETE", `/v1/keys/${key.id}`)).json(),
  );
  expect(again.revokedAt).toBe(revoked.revokedAt);
  const refused = await call(key.secret, "GET", "/v1/environments");
  expect(refused.status).toBe(401);
  expect(await refused.json()).toEqual(unauthorized);
});

test("revoking an unknown or malformed key id is 404", async () => {
  for (const id of ["key_0000000000000000000000", "nope"]) {
    const res = await call(admin, "DELETE", `/v1/keys/${id}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
  }
});

test("an unknown sky_ key is the same 401 as any invalid token", async () => {
  const res = await call(`sky_${"A".repeat(43)}`, "GET", "/v1/environments");
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual(unauthorized);
});

test("revoking deletes the key's webhooks and leaves admin's", async () => {
  const envId = readyEnv();
  const key = await mintKey([envId]);
  const hook = {
    url: "https://hooks.example.com/a",
    eventTypes: ["run.started"],
  };
  expect((await call(key.secret, "POST", "/v1/webhooks", hook)).status).toBe(
    201,
  );
  expect((await call(admin, "POST", "/v1/webhooks", hook)).status).toBe(201);
  await call(admin, "DELETE", `/v1/keys/${key.id}`);
  expect(
    db.select({ owner: webhooks.ownerKeyId }).from(webhooks).all(),
  ).toEqual([{ owner: null }]);
});

test.each([
  ["POST", "/v1/keys"],
  ["GET", "/v1/keys"],
  ["DELETE", "/v1/keys/key_0000000000000000000000"],
])("a runs key gets 403 on %s %s", async (method, path) => {
  const envId = readyEnv();
  const key = await mintKey([envId]);
  const res = await call(
    key.secret,
    method,
    path,
    method === "POST"
      ? { name: "x", role: "runs", environmentIds: [envId] }
      : undefined,
  );
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual(forbidden);
  expect(db.select().from(apiKeys).all()).toHaveLength(1);
});

test("no log line carries an issued key's secret or hash", async () => {
  const key = await mintKey([readyEnv()]);
  await call(key.secret, "GET", "/v1/environments");
  await call(admin, "DELETE", `/v1/keys/${key.id}`);
  await call(key.secret, "GET", "/v1/environments");
  const hash = createHash("sha256").update(key.secret).digest("hex");
  const log = logs.join("\n");
  expect(log).not.toContain(key.secret);
  expect(log).not.toContain(hash);
});

/** An agent with one run in `status`, started by `owner` (null: admin). */
function seedAgent(
  envId: EnvironmentId,
  owner: ApiKeyId | null,
  status: RunStatus = "running",
) {
  const agentId = mintId("agt");
  const runId = mintId("run");
  db.insert(agents)
    .values({
      id: agentId,
      envId,
      branch: `claude/${agentId}`,
      status: isActive(status) ? "running" : "idle",
      ownerKeyId: owner,
    })
    .run();
  db.insert(runs).values({ id: runId, agentId, status }).run();
  return { agentId, runId };
}

const hook = (fields: object = {}) => ({
  url: "https://hooks.example.com/a",
  eventTypes: ["claude.Message"],
  ...fields,
});

test("a runs key sees and deletes only the webhooks it created; admin sees all", async () => {
  const envId = readyEnv();
  const key = await mintKey([envId]);
  const other = await mintKey([envId], "other");
  const mine = (await (
    await call(key.secret, "POST", "/v1/webhooks", hook())
  ).json()) as { id: WebhookId };
  const theirs = (await (
    await call(other.secret, "POST", "/v1/webhooks", hook())
  ).json()) as { id: WebhookId };
  const admins = (await (
    await call(admin, "POST", "/v1/webhooks", hook())
  ).json()) as {
    id: WebhookId;
  };
  const listed = (await (
    await call(key.secret, "GET", "/v1/webhooks")
  ).json()) as {
    data: { id: string }[];
  };
  expect(listed.data.map((w) => w.id)).toEqual([mine.id]);
  const all = (await (await call(admin, "GET", "/v1/webhooks")).json()) as {
    data: { id: string }[];
  };
  expect(all.data).toHaveLength(3);
  const realMiss = await call(
    key.secret,
    "GET",
    "/v1/webhooks/whk_0000000000000000000000",
  );
  const realBody = await realMiss.json();
  for (const id of [theirs.id, admins.id]) {
    const get = await call(key.secret, "GET", `/v1/webhooks/${id}`);
    expect(get.status).toBe(404);
    expect(await get.json()).toEqual(realBody);
    const del = await call(key.secret, "DELETE", `/v1/webhooks/${id}`);
    expect(del.status).toBe(404);
  }
  expect(
    (await call(key.secret, "GET", `/v1/webhooks/${mine.id}`)).status,
  ).toBe(200);
  expect(
    (await call(key.secret, "DELETE", `/v1/webhooks/${mine.id}`)).status,
  ).toBe(204);
  expect(db.select().from(webhooks).all()).toHaveLength(2);
});

test("a runs key's webhook may filter only on its own environments", async () => {
  const envId = readyEnv();
  const elsewhere = readyEnv();
  const key = await mintKey([envId]);
  const res = await call(
    key.secret,
    "POST",
    "/v1/webhooks",
    hook({ environmentIds: [envId, elsewhere] }),
  );
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: {
      code: "invalid_body",
      message: `no such environment: ${elsewhere}`,
    },
  });
  const ok = await call(
    key.secret,
    "POST",
    "/v1/webhooks",
    hook({ environmentIds: [envId] }),
  );
  expect(ok.status).toBe(201);
});

test("a key's webhook gets only its own agents' events; an admin webhook gets every one", async () => {
  const envId = readyEnv();
  const key = await mintKey([envId]);
  const other = await mintKey([envId], "other");
  const mine = (await (
    await call(key.secret, "POST", "/v1/webhooks", hook())
  ).json()) as { id: WebhookId };
  const admins = (await (
    await call(admin, "POST", "/v1/webhooks", hook())
  ).json()) as {
    id: WebhookId;
  };
  const own = seedAgent(envId, key.id);
  const foreign = seedAgent(envId, other.id);
  const adminAgent = seedAgent(envId, null);
  for (const { runId } of [own, foreign, adminAgent]) {
    db.transaction((tx) =>
      recordEvent(tx, runId, "claude.Message", { text: "hi" }),
    );
  }
  const deliveredTo = (id: WebhookId) =>
    db
      .select({ runId: events.runId })
      .from(webhookDeliveries)
      .innerJoin(events, eq(events.id, webhookDeliveries.eventId))
      .where(eq(webhookDeliveries.webhookId, id))
      .all()
      .map((r) => r.runId);
  expect(deliveredTo(mine.id)).toEqual([own.runId]);
  expect(deliveredTo(admins.id)).toEqual([
    own.runId,
    foreign.runId,
    adminAgent.runId,
  ]);
});

test("a webhook left owned by a revoked key gets no deliveries; an active key's still does", async () => {
  const envId = readyEnv();
  const active = await mintKey([envId]);
  const revoked = await mintKey([envId], "revoked");
  const activeHook = (await (
    await call(active.secret, "POST", "/v1/webhooks", hook())
  ).json()) as { id: WebhookId };
  expect((await call(admin, "DELETE", `/v1/keys/${revoked.id}`)).status).toBe(
    200,
  );
  // a create authenticated before the revoke committed, inserting after it
  const orphan = mintId("whk");
  db.insert(webhooks)
    .values({
      id: orphan,
      url: "https://hooks.example.com/a",
      eventTypes: ["claude.Message"],
      ownerKeyId: revoked.id,
    })
    .run();
  const activeAgent = seedAgent(envId, active.id);
  const revokedAgent = seedAgent(envId, revoked.id);
  for (const { runId } of [activeAgent, revokedAgent]) {
    db.transaction((tx) =>
      recordEvent(tx, runId, "claude.Message", { text: "hi" }),
    );
  }
  const deliveriesTo = (id: WebhookId) =>
    db
      .select({ runId: events.runId })
      .from(webhookDeliveries)
      .innerJoin(events, eq(events.id, webhookDeliveries.eventId))
      .where(eq(webhookDeliveries.webhookId, id))
      .all()
      .map((r) => r.runId);
  expect(deliveriesTo(orphan)).toEqual([]);
  expect(deliveriesTo(activeHook.id)).toEqual([activeAgent.runId]);
});

/** Parks the agent's run on an approval request, as the runner's run.waiting would. */
function waitingOn(runId: RunId, agentId: AgentId) {
  const requestId = mintId("req");
  const request = {
    kind: "approval" as const,
    requestId,
    toolName: "Bash",
    toolSummary: "rm -rf build",
  };
  db.update(runs).set({ status: "waiting" }).where(eq(runs.id, runId)).run();
  db.update(agents)
    .set({ status: "waiting" })
    .where(eq(agents.id, agentId))
    .run();
  db.insert(runRequests)
    .values({ id: requestId, runId, kind: "approval", request })
    .run();
  return requestId;
}

test("a runs key starts an agent on its environment and owns it", async () => {
  const envId = readyEnv();
  const key = await mintKey([envId]);
  const res = await call(key.secret, "POST", "/v1/agents", {
    envId,
    prompt: "fix the flaky test",
  });
  expect(res.status).toBe(202);
  const { agent, run } = (await res.json()) as {
    agent: { id: AgentId };
    run: { id: RunId };
  };
  expect(
    db.select({ owner: agents.ownerKeyId }).from(agents).get()?.owner,
  ).toBe(key.id);
  for (const path of [
    `/v1/agents/${agent.id}`,
    `/v1/agents/${agent.id}/runs`,
    `/v1/agents/${agent.id}/runs/${run.id}`,
  ]) {
    expect((await call(key.secret, "GET", path)).status).toBe(200);
  }
});

test("an admin-started agent records no owner", async () => {
  const envId = readyEnv();
  const res = await call(admin, "POST", "/v1/agents", {
    envId,
    prompt: "fix the flaky test",
  });
  expect(res.status).toBe(202);
  expect(
    db.select({ owner: agents.ownerKeyId }).from(agents).get()?.owner,
  ).toBeNull();
});

test("a runs key launching on an environment not on its list gets the unknown environment's 404", async () => {
  const mine = readyEnv();
  const elsewhere = readyEnv();
  const key = await mintKey([mine]);
  const body = (envId: string) => ({ envId, prompt: "p" });
  const unknown = await call(admin, "POST", "/v1/agents", body("env_nope"));
  expect(unknown.status).toBe(404);
  for (const extra of [{}, { branch: "feature/x" }]) {
    const res = await call(key.secret, "POST", "/v1/agents", {
      ...body(elsewhere),
      ...extra,
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(await unknown.clone().json());
  }
  expect(db.select().from(agents).all()).toEqual([]);
  expect(wire.calls).toEqual([]);
});

test("a runs key approves, stops, follows up and streams its own agent", async () => {
  const envId = readyEnv();
  const key = await mintKey([envId]);
  const { agentId, runId } = seedAgent(envId, key.id);
  const requestId = waitingOn(runId, agentId);
  const approved = await call(
    key.secret,
    "POST",
    `/v1/agents/${agentId}/approvals`,
    { requestId, decision: "approve" },
  );
  expect(approved.status).toBe(200);
  const stream = await call(
    key.secret,
    "GET",
    `/v1/agents/${agentId}/runs/${runId}/stream`,
  );
  expect(stream.status).toBe(200);
  await stream.body?.cancel();
  expect(
    (await call(key.secret, "POST", `/v1/agents/${agentId}/stop`)).status,
  ).toBe(200);
  const followUp = await call(
    key.secret,
    "POST",
    `/v1/agents/${agentId}/runs`,
    { prompt: "and the other one" },
  );
  expect(followUp.status).toBe(202);
});

test.each([
  ["another key's", "other"],
  ["an admin's", "admin"],
] as const)(
  "%s agent is a 404 to a runs key on every agent route, before any change or sprite call",
  async (_, ownedBy) => {
    const envId = readyEnv();
    const key = await mintKey([envId]);
    const other = await mintKey([envId], "other");
    const { agentId, runId } = seedAgent(
      envId,
      ownedBy === "admin" ? null : other.id,
    );
    const requestId = waitingOn(runId, agentId);
    const ghost = { agentId: mintId("agt"), runId: mintId("run") };
    const routes = ({ agentId: a, runId: r }: typeof ghost) =>
      [
        [
          "POST",
          `/v1/agents/${a}/approvals`,
          { requestId, decision: "approve" },
        ],
        ["POST", `/v1/agents/${a}/approvals`, { requestId, decision: "deny" }],
        ["POST", `/v1/agents/${a}/answers`, { requestId, answer: "yes" }],
        ["POST", `/v1/agents/${a}/stop`],
        ["POST", `/v1/agents/${a}/archive`],
        ["POST", `/v1/agents/${a}/runs`, { prompt: "more" }],
        ["GET", `/v1/agents/${a}`],
        ["GET", `/v1/agents/${a}/runs`],
        ["GET", `/v1/agents/${a}/runs/${r}`],
        ["GET", `/v1/agents/${a}/runs/${r}/stream`],
      ] as const;
    const real = routes(ghost);
    const foreign = routes({ agentId, runId });
    const before = wire.calls.length;
    for (const [i, [method, path, body]] of foreign.entries()) {
      const res = await call(key.secret, method, path, body);
      const [, ghostPath, ghostBody] = real[i] ?? [];
      const miss = await call(key.secret, method, ghostPath ?? "", ghostBody);
      expect([path, res.status]).toEqual([path, 404]);
      expect(await res.json()).toEqual(await miss.json());
    }
    expect(wire.calls.length).toBe(before);
    expect(db.select().from(runs).all()).toEqual([
      expect.objectContaining({ id: runId, status: "waiting" }),
    ]);
    expect(db.select().from(agents).get()?.archivedAt).toBeNull();
    expect(db.select().from(runRequests).get()?.decision).toBeNull();
  },
);

test("admin still acts on a key's agent", async () => {
  const envId = readyEnv();
  const key = await mintKey([envId]);
  const { agentId, runId } = seedAgent(envId, key.id);
  const requestId = waitingOn(runId, agentId);
  const res = await call(admin, "POST", `/v1/agents/${agentId}/approvals`, {
    requestId,
    decision: "deny",
  });
  expect(res.status).toBe(200);
  expect((await call(admin, "GET", `/v1/agents/${agentId}`)).status).toBe(200);
});

test("a runs key lists only its environments and gets 404 for another", async () => {
  const mine = readyEnv();
  const elsewhere = readyEnv();
  const key = await mintKey([mine]);
  const list = (await (
    await call(key.secret, "GET", "/v1/environments")
  ).json()) as { data: { id: string }[] };
  expect(list.data.map((e) => e.id)).toEqual([mine]);
  expect(
    (await call(key.secret, "GET", `/v1/environments/${mine}`)).status,
  ).toBe(200);
  const res = await call(key.secret, "GET", `/v1/environments/${elsewhere}`);
  expect(res.status).toBe(404);
  const miss = await call(key.secret, "GET", "/v1/environments/env_nope");
  expect(await res.json()).toEqual(await miss.json());
});

test.each([
  ["POST", "/v1/environments", { name: "x", repo: "acme/kru", setup: "" }],
  ["PATCH", "/v1/environments/:env", { concurrency: 1 }],
  ["DELETE", "/v1/environments/:env"],
  ["POST", "/v1/environments/:env/retry"],
  ["GET", "/v1/environments/:env/secrets"],
  ["PUT", "/v1/environments/:env/secrets/TOKEN", { value: "v" }],
  ["DELETE", "/v1/environments/:env/secrets/TOKEN"],
] as const)(
  "a runs key gets 403 on %s %s, even on its own environment",
  async (method, path, body?: object) => {
    const envId = readyEnv();
    const key = await mintKey([envId]);
    const res = await call(
      key.secret,
      method,
      path.replace(":env", envId),
      body,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(forbidden);
    expect(db.select().from(environments).all()).toEqual([
      expect.objectContaining({ id: envId, status: "ready", concurrency: 3 }),
    ]);
    expect(wire.calls).toEqual([]);
  },
);

const say = (runId: RunId, text: string) =>
  db.transaction((tx) => recordEvent(tx, runId, "claude.Message", { text }).id);

test("account-wide events and the stream show a runs key only its own agents' events", async () => {
  const envId = readyEnv();
  const key = await mintKey([envId]);
  const own = seedAgent(envId, key.id);
  const foreign = seedAgent(envId, null);
  say(foreign.runId, "theirs");
  const mine = say(own.runId, "mine");
  say(foreign.runId, "theirs again");
  const page = (await (
    await call(key.secret, "GET", "/v1/events?after=evt_0&wait=0")
  ).json()) as { data: { id: string }[] };
  expect(page.data.map((e) => e.id)).toEqual([`evt_${mine}`]);
  const res = await call(key.secret, "GET", "/v1/stream?after=evt_0");
  const s = sseReader(res);
  expect((await s.event())?.id).toBe(String(mine));
  const next = say(own.runId, "mine again");
  say(foreign.runId, "theirs once more");
  expect((await s.event())?.id).toBe(String(next));
  await s.cancel();
});

test("naming an agent a runs key doesn't own is the unknown agent's 404 on events and stream", async () => {
  const envId = readyEnv();
  const key = await mintKey([envId]);
  const foreign = seedAgent(envId, null);
  for (const path of ["/v1/events?wait=0&agentId=", "/v1/stream?agentId="]) {
    const res = await call(key.secret, "GET", `${path}${foreign.agentId}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "not_found", message: "no such agent" },
    });
  }
});
