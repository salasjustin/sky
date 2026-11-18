import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpritesClient } from "@fly/sprites";
import {
  agents,
  type Db,
  environments,
  migrate,
  openDb,
  previews,
  runs,
  secrets,
} from "@sky/db";
import {
  type AgentId,
  BaseProfile,
  CreatedApiKey,
  type EnvironmentId,
  PREVIEW_APP_SERVICE,
  PREVIEW_PROXY_SERVICE,
  type RunId,
} from "@sky/shared";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test } from "vitest";
import { mintAgentToken } from "./agent-token.js";
import { createApp } from "./app.js";
import type { Config } from "./config.js";
import { envSecretAad, seal } from "./crypto.js";
import { sweepExpiredPreviews } from "./previews.js";
import { RUNNER } from "./provision.js";
import { spriteNameFor } from "./sprites.js";
import {
  type ServiceRecord,
  type SpritesWire,
  spritesToken,
  spriteUrlOf,
  stubSprites,
  testConfig,
} from "./testing/sprites.js";

let dir: string;
let db: Db;
let config: Config;
let logs: string[];
let app: ReturnType<typeof createApp>;
let wire: SpritesWire;

const team = BaseProfile.parse({ sessionEnv: { PLUGIN_SWITCH: "1" } });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sky-previews-"));
  writeFileSync(join(dir, "runner.mjs"), "// runner bundle\n");
  db = openDb(":memory:");
  migrate(db);
  wire = stubSprites();
  logs = [];
  config = testConfig({
    runnerBundlePath: join(dir, "runner.mjs"),
    baseProfiles: { team },
    anthropicApiKey: "sk-ant-api03-the-pay-per-use-key",
  });
  app = createApp({
    db,
    config,
    sprites: new SpritesClient(spritesToken),
    log: (line) => logs.push(line),
    nudgeDeliveries: () => {},
  });
});
afterEach(async () => {
  await wire.cleanedUp();
  if (db.$client.open) db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

const admin = testConfig().apiKey;
const headers = (key = admin) => ({
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
});

function readyEnv(overrides: Partial<typeof environments.$inferInsert> = {}) {
  const id = `env_${Math.random().toString(36).slice(2)}` as EnvironmentId;
  db.insert(environments)
    .values({
      id,
      name: id,
      repo: "acme/web",
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

let counter = 0;
function seedAgent(
  envId: EnvironmentId,
  extra: Partial<typeof agents.$inferInsert> = {},
) {
  const id = `agt_seed${++counter}` as AgentId;
  db.insert(agents)
    .values({
      id,
      envId,
      branch: `claude/${id}`,
      status: "idle",
      ...extra,
    })
    .run();
  return id;
}

const start = (
  agentId: string,
  body: unknown = { cmd: "pnpm dev --host", port: 5173 },
  key = admin,
) =>
  app.request(`/v1/agents/${agentId}/preview`, {
    method: "POST",
    headers: headers(key),
    body: JSON.stringify(body),
  });
const stop = (agentId: string, key = admin) =>
  app.request(`/v1/agents/${agentId}/preview`, {
    method: "DELETE",
    headers: headers(key),
  });
const state = (agentId: string, key = admin) =>
  app.request(`/v1/agents/${agentId}/preview`, { headers: headers(key) });

type Started = {
  preview: {
    agentId: string;
    envId: string;
    port: number;
    cmd: string;
    link: string;
    startedAt: string;
    expiresAt: string;
    replaced: string | null;
  };
};
const started = async (agentId: string, body?: unknown, key?: string) => {
  const res = await start(agentId, body, key);
  expect(res.status).toBe(200);
  return (await res.json()) as Started;
};

const sprite = (envId: string) => spriteNameFor(envId);
const servicesOf = (envId: string) =>
  wire.services.get(sprite(envId)) ?? new Map<string, ServiceRecord>();
const authOf = (envId: string) => wire.stored.get(sprite(envId))?.url_settings;
const tokenOf = (link: string) => new URL(link).searchParams.get("t") ?? "";
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

test("starting a preview creates the proxy and the dev server, flips the URL public and returns the link", async () => {
  const envId = readyEnv();
  const agentId = seedAgent(envId);
  const { preview } = await started(agentId, {
    cmd: "pnpm dev --host",
    port: 5173,
  });

  const proxy = servicesOf(envId).get(PREVIEW_PROXY_SERVICE);
  const appService = servicesOf(envId).get(PREVIEW_APP_SERVICE);
  expect(proxy).toMatchObject({
    cmd: "bash",
    args: [
      expect.any(String),
      expect.stringContaining(`node ${RUNNER} preview-proxy`),
    ].flat(),
    http_port: 8080,
    env: {
      PREVIEW_UPSTREAM_PORT: "5173",
      PREVIEW_LISTEN_PORT: "8080",
      PREVIEW_EXPIRES_AT: preview.expiresAt,
    },
  });
  expect(appService).toMatchObject({
    cmd: "bash",
    dir: `/workspace/worktrees/${agentId}`,
    needs: [PREVIEW_PROXY_SERVICE],
    env: { PORT: "5173" },
  });
  expect(appService?.args?.[0]).toBe("-c");
  expect(appService?.args?.[1]).toMatch(/&& exec pnpm dev --host$/);

  // the proxy holds 8080 before the dev server opens its own port
  const created = wire.calls.filter((c) => c.startsWith("service-create"));
  expect(created).toEqual([
    `service-create ${sprite(envId)} ${PREVIEW_PROXY_SERVICE}`,
    `service-create ${sprite(envId)} ${PREVIEW_APP_SERVICE}`,
  ]);
  expect(authOf(envId)).toEqual({ auth: "public" });

  expect(preview).toMatchObject({ agentId, envId, port: 5173 });
  expect(preview.link).toMatch(
    new RegExp(
      `^${spriteUrlOf(sprite(envId))}/__sky/preview\\?t=[A-Za-z0-9_-]{43}$`,
    ),
  );
  expect(preview.replaced).toBeNull();
});

test("only the token's hash is kept: in the row and on the proxy, never the token", async () => {
  const envId = readyEnv();
  const agentId = seedAgent(envId);
  const { preview } = await started(agentId);
  const token = tokenOf(preview.link);
  // 32 random bytes, base64url
  expect(Buffer.from(token, "base64url")).toHaveLength(32);

  const [row] = db.select().from(previews).all();
  expect(row?.tokenHash).toBe(sha256(token));
  expect(JSON.stringify(row)).not.toContain(token);
  expect(
    servicesOf(envId).get(PREVIEW_PROXY_SERVICE)?.env?.PREVIEW_TOKEN_HASH,
  ).toBe(sha256(token));
  // nothing sent to the sprite carries the token, nor does a log line
  expect(JSON.stringify([...servicesOf(envId)])).not.toContain(token);
  expect(logs.join("\n")).not.toContain(token);
  // and the state read back has no link to give
  const read = (await (await state(agentId)).json()) as { preview: object };
  expect(JSON.stringify(read)).not.toContain(token);
  expect(read.preview).not.toHaveProperty("link");
});

test("the TTL defaults to 24 hours and takes up to 7 days; the proxy is given the same expiry", async () => {
  const envId = readyEnv();
  const agentId = seedAgent(envId);
  const before = Date.now();
  const day = await started(agentId);
  const at = Date.parse(day.preview.expiresAt);
  expect(at).toBeGreaterThanOrEqual(before + 24 * 3600_000 - 1000);
  expect(at).toBeLessThanOrEqual(Date.now() + 24 * 3600_000);
  expect(
    servicesOf(envId).get(PREVIEW_PROXY_SERVICE)?.env?.PREVIEW_EXPIRES_AT,
  ).toBe(day.preview.expiresAt);

  const week = await started(agentId, {
    cmd: "pnpm dev",
    port: 5173,
    ttlSeconds: 7 * 24 * 3600,
  });
  expect(Date.parse(week.preview.expiresAt)).toBeGreaterThan(
    before + 6.9 * 24 * 3600_000,
  );
});

test.each([
  ["no command", { port: 5173 }],
  ["a blank command", { cmd: "  ", port: 5173 }],
  ["no port", { cmd: "pnpm dev" }],
  ["the proxy's own port", { cmd: "pnpm dev", port: 8080 }],
  ["a privileged port", { cmd: "pnpm dev", port: 80 }],
  ["a port past 65535", { cmd: "pnpm dev", port: 70000 }],
  [
    "a TTL over 7 days",
    { cmd: "pnpm dev", port: 5173, ttlSeconds: 7 * 24 * 3600 + 1 },
  ],
  ["a TTL under a minute", { cmd: "pnpm dev", port: 5173, ttlSeconds: 5 }],
  ["an unknown field", { cmd: "pnpm dev", port: 5173, public: true }],
])(
  "a start with %s is refused before anything reaches the sprite",
  async (_, body) => {
    const envId = readyEnv();
    const agentId = seedAgent(envId);
    const res = await start(agentId, body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "invalid_body" } });
    expect(wire.calls).toEqual([]);
    expect(authOf(envId)).toBeUndefined();
  },
);

test("the dev server's env is the environment's secrets and profile, with no Claude credential and no Sky token", async () => {
  const envId = readyEnv({ base: "team" });
  const agentId = seedAgent(envId);
  const seedSecret = (name: string, value: string) =>
    db
      .insert(secrets)
      .values({
        envId,
        name,
        kind: "value",
        connector: null,
        ...seal(config.secretEncryptionKey, value, envSecretAad(envId, name)),
      })
      .run();
  seedSecret("DATABASE_URL", "postgres://db.test/app");
  seedSecret("STRIPE_KEY", "sk_test_stripe_value");
  // names Sky reserves for itself, as an older version could have stored them
  seedSecret("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-stored-oauth-value");
  seedSecret("AGENT_TOKEN", "stored-agent-token-value");
  seedSecret("SKY_CLAUDE_API_KEY", "stored-claude-key-value");
  seedSecret("PATH", "/evil/bin");
  await started(agentId, { cmd: "pnpm dev", port: 3000 });

  const env = servicesOf(envId).get(PREVIEW_APP_SERVICE)?.env ?? {};
  expect(env).toEqual({
    DATABASE_URL: "postgres://db.test/app",
    STRIPE_KEY: "sk_test_stripe_value",
    PLUGIN_SWITCH: "1",
    PORT: "3000",
  });
  const everything = JSON.stringify([...servicesOf(envId)]);
  const sky = [
    config.claudeOauthToken,
    config.anthropicApiKey,
    config.apiKey,
    config.spritesToken,
    config.webhookSigningKey,
    // a run's own token, which the runner holds and its commands never do
    mintAgentToken(config.apiKey, "run_anything" as RunId),
  ];
  for (const secret of sky) {
    expect(everything).not.toContain(secret as string);
  }
  for (const name of [
    "CLAUDE_CODE_OAUTH_TOKEN",
    "SKY_CLAUDE_API_KEY",
    "SKY_CLAUDE_AUTH",
    "ANTHROPIC_API_KEY",
    "AGENT_TOKEN",
    "RUN_ID",
    "ENV_FILE",
  ]) {
    expect(env).not.toHaveProperty(name);
  }
  // the proxy holds the token's hash and ports, no secret of the environment's
  expect(
    JSON.stringify(servicesOf(envId).get(PREVIEW_PROXY_SERVICE)?.env),
  ).not.toContain("postgres://");
});

test("a second preview in the environment replaces the first and names the agent it replaced", async () => {
  const envId = readyEnv();
  const first = seedAgent(envId);
  const second = seedAgent(envId);
  const one = await started(first);
  const two = await started(second, { cmd: "npm run dev", port: 4000 });

  expect(two.preview.replaced).toBe(first);
  expect(tokenOf(two.preview.link)).not.toBe(tokenOf(one.preview.link));
  // one preview per environment: the first's services were deleted before the second's were made
  const calls = wire.calls.filter((c) => /^service-(create|delete)/.test(c));
  const deletes = calls.filter((c) => c.startsWith("service-delete"));
  expect(deletes).toHaveLength(2);
  expect(calls.indexOf(deletes[1] as string)).toBeLessThan(
    calls.lastIndexOf(
      `service-create ${sprite(envId)} ${PREVIEW_PROXY_SERVICE}`,
    ),
  );
  expect(servicesOf(envId).size).toBe(2);
  expect(servicesOf(envId).get(PREVIEW_APP_SERVICE)?.dir).toBe(
    `/workspace/worktrees/${second}`,
  );
  expect(db.select().from(previews).all()).toHaveLength(1);
  expect(db.select().from(previews).get()?.agentId).toBe(second);
  expect(authOf(envId)).toEqual({ auth: "public" });
  // the first agent has none now
  expect(await (await state(first)).json()).toEqual({ preview: null });
  expect((await stop(first)).status).toBe(404);
});

test("restarting an agent's own preview replaces it without naming anyone", async () => {
  const envId = readyEnv();
  const agentId = seedAgent(envId);
  const one = await started(agentId);
  const two = await started(agentId, { cmd: "pnpm dev", port: 4000 });
  expect(two.preview.replaced).toBeNull();
  expect(tokenOf(two.preview.link)).not.toBe(tokenOf(one.preview.link));
  expect(db.select().from(previews).all()).toHaveLength(1);
});

test("a preview in another environment is not replaced", async () => {
  const a = readyEnv();
  const b = readyEnv();
  const agentA = seedAgent(a);
  const agentB = seedAgent(b);
  await started(agentA);
  const two = await started(agentB);
  expect(two.preview.replaced).toBeNull();
  expect(db.select().from(previews).all()).toHaveLength(2);
  expect(servicesOf(a).size).toBe(2);
  expect(servicesOf(b).size).toBe(2);
});

test("stopping removes both services, sets the URL back to sprite auth and ends the token", async () => {
  const envId = readyEnv();
  const agentId = seedAgent(envId);
  await started(agentId);
  const res = await stop(agentId);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    preview: null,
    stopped: { agentId, port: 5173 },
  });
  expect(servicesOf(envId).size).toBe(0);
  expect(authOf(envId)).toEqual({ auth: "sprite" });
  expect(db.select().from(previews).all()).toEqual([]);
  expect(await (await state(agentId)).json()).toEqual({ preview: null });
  // nothing left to stop
  const again = await stop(agentId);
  expect(again.status).toBe(404);
  expect(await again.json()).toMatchObject({ error: { code: "no_preview" } });
});

test("the URL goes private before the services go, so it is public no longer than it must be", async () => {
  const envId = readyEnv();
  const agentId = seedAgent(envId);
  await started(agentId);
  wire.calls.length = 0;
  await stop(agentId);
  expect(wire.calls).toEqual([
    `label ${sprite(envId)}`,
    `service-delete ${sprite(envId)} ${PREVIEW_PROXY_SERVICE}`,
    `service-delete ${sprite(envId)} ${PREVIEW_APP_SERVICE}`,
  ]);
  expect(wire.updates.get(sprite(envId))).toEqual({
    url_settings: { auth: "sprite" },
  });
});

test("a stop the sprite can't finish keeps the preview, so a retry finishes it", async () => {
  const envId = readyEnv();
  const agentId = seedAgent(envId);
  await started(agentId);
  wire.serviceDeleteStatus = 503;
  const res = await stop(agentId);
  expect(res.status).toBe(502);
  expect(await res.json()).toMatchObject({
    error: { code: "preview_stop_failed" },
  });
  expect(db.select().from(previews).all()).toHaveLength(1);
  wire.serviceDeleteStatus = 204;
  expect((await stop(agentId)).status).toBe(200);
  expect(servicesOf(envId).size).toBe(0);
  expect(db.select().from(previews).all()).toEqual([]);
});

test("an expired preview is ended by the sweep: services removed, URL private, token dead", async () => {
  const envId = readyEnv();
  const other = readyEnv();
  const agentId = seedAgent(envId);
  const keeps = seedAgent(other);
  const { preview } = await started(agentId, {
    cmd: "pnpm dev",
    port: 5173,
    ttlSeconds: 60,
  });
  await started(keeps);
  const ops = {
    client: new SpritesClient(spritesToken),
    log: (line: string) => logs.push(line),
    secrets: new (await import("./redact.js")).KnownSecrets(),
    timeoutMs: 5_000,
    longTimeoutMs: 5_000,
  };

  // not yet due
  expect(await sweepExpiredPreviews(db, ops, ops.log, new Date())).toBe(0);
  expect(servicesOf(envId).size).toBe(2);

  const later = new Date(Date.parse(preview.expiresAt) + 1000);
  expect(await sweepExpiredPreviews(db, ops, ops.log, later)).toBe(1);
  expect(servicesOf(envId).size).toBe(0);
  expect(authOf(envId)).toEqual({ auth: "sprite" });
  expect(
    db.select().from(previews).where(eq(previews.envId, envId)).all(),
  ).toEqual([]);
  // another environment's preview, not yet due, is untouched
  expect(servicesOf(other).size).toBe(2);
  expect(authOf(other)).toEqual({ auth: "public" });
  expect(logs.join("\n")).toContain(
    `preview of ${agentId} ended: its TTL passed`,
  );
});

test("archiving the agent ends its preview before its worktree goes", async () => {
  const envId = readyEnv();
  const agentId = seedAgent(envId);
  await started(agentId);
  wire.calls.length = 0;
  const res = await app.request(`/v1/agents/${agentId}/archive`, {
    method: "POST",
    headers: headers(),
  });
  expect(res.status).toBe(200);
  expect(servicesOf(envId).size).toBe(0);
  expect(authOf(envId)).toEqual({ auth: "sprite" });
  expect(db.select().from(previews).all()).toEqual([]);
  const worktree = wire.calls.findIndex((c) => c.includes("worktree remove"));
  const lastDelete = wire.calls.findLastIndex((c) =>
    c.startsWith("service-delete"),
  );
  expect(lastDelete).toBeGreaterThanOrEqual(0);
  expect(lastDelete).toBeLessThan(worktree);
});

test("archiving an agent whose environment hosts another agent's preview leaves it running", async () => {
  const envId = readyEnv();
  const other = seedAgent(envId);
  const mine = seedAgent(envId);
  await started(other);
  const res = await app.request(`/v1/agents/${mine}/archive`, {
    method: "POST",
    headers: headers(),
  });
  expect(res.status).toBe(200);
  expect(servicesOf(envId).size).toBe(2);
  expect(authOf(envId)).toEqual({ auth: "public" });
});

test("deleting the environment ends its preview, the URL, the services and the token", async () => {
  const envId = readyEnv();
  const agentId = seedAgent(envId);
  await started(agentId);
  const res = await app.request(`/v1/environments/${envId}`, {
    method: "DELETE",
    headers: headers(),
  });
  expect(res.status).toBe(204);
  expect(servicesOf(envId).size).toBe(0);
  expect(authOf(envId)).toEqual({ auth: "sprite" });
  expect(db.select().from(previews).all()).toEqual([]);
  // the services and the URL go before the sprite does
  const del = wire.calls.indexOf(`delete ${sprite(envId)}`);
  expect(
    wire.calls.lastIndexOf(
      `service-delete ${sprite(envId)} ${PREVIEW_APP_SERVICE}`,
    ),
  ).toBeLessThan(del);
});

test("a preview that can't be stopped holds the environment's delete, and nothing is destroyed", async () => {
  const envId = readyEnv();
  const agentId = seedAgent(envId);
  await started(agentId);
  wire.serviceDeleteStatus = 503;
  const res = await app.request(`/v1/environments/${envId}`, {
    method: "DELETE",
    headers: headers(),
  });
  expect(res.status).toBe(502);
  expect(wire.calls).not.toContain(`delete ${sprite(envId)}`);
  expect(
    db.select().from(environments).where(eq(environments.id, envId)).all(),
  ).toHaveLength(1);
});

async function mintKey(environmentIds: EnvironmentId[]) {
  const res = await app.request("/v1/keys", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ name: "pm", role: "runs", environmentIds }),
  });
  expect(res.status).toBe(201);
  return CreatedApiKey.parse(await res.json());
}

test("a runs key can't preview, read or stop an agent outside its own", async () => {
  const mineEnv = readyEnv();
  const otherEnv = readyEnv();
  const key = await mintKey([mineEnv]);
  const mine = seedAgent(mineEnv, { ownerKeyId: key.id });
  // an agent in an environment the key can't use, and one in its own environment started by someone else
  const outside = seedAgent(otherEnv, { ownerKeyId: key.id });
  const notMine = seedAgent(mineEnv);
  const theirs = await mintKey([otherEnv]);
  const strangers = seedAgent(otherEnv, { ownerKeyId: theirs.id });
  await started(strangers);
  wire.calls.length = 0;

  for (const agentId of [outside, notMine]) {
    const res = await start(agentId, undefined, key.secret);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
  }
  expect((await state(strangers, key.secret)).status).toBe(404);
  expect((await stop(strangers, key.secret)).status).toBe(404);
  // nothing reached any sprite, and the stranger's preview still runs
  expect(wire.calls).toEqual([]);
  expect(servicesOf(otherEnv).size).toBe(2);
  expect(
    db.select().from(previews).where(eq(previews.agentId, strangers)).all(),
  ).toHaveLength(1);

  // its own agent works
  const ok = await started(mine, undefined, key.secret);
  expect(ok.preview.agentId).toBe(mine);
  expect((await state(mine, key.secret)).status).toBe(200);
  expect((await stop(mine, key.secret)).status).toBe(200);
});

test("an agent that doesn't exist, or is archived, can't be previewed", async () => {
  const envId = readyEnv();
  const gone = seedAgent(envId, { archivedAt: new Date().toISOString() });
  expect((await start("agt_nope")).status).toBe(404);
  expect((await state("agt_nope")).status).toBe(404);
  const res = await start(gone);
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ error: { code: "agent_archived" } });
  expect(wire.calls).toEqual([]);
});

test("an agent with no worktree yet is refused and the running preview is left alone", async () => {
  const envId = readyEnv();
  const agentId = seedAgent(envId);
  const running = seedAgent(envId);
  await started(running);
  wire.exec = (argv) =>
    argv[0] === "test" ? { exitCode: 1 } : { exitCode: 0 };
  const res = await start(agentId);
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ error: { code: "no_worktree" } });
  expect(db.select().from(previews).get()?.agentId).toBe(running);
  expect(servicesOf(envId).size).toBe(2);
});

test("something already holding the sprite's port 8080 is not broken: nothing is started", async () => {
  const envId = readyEnv();
  const agentId = seedAgent(envId);
  wire.exec = (argv) =>
    argv[0] === "sh" && argv.at(-1) === "8080"
      ? { exitCode: 10 }
      : { exitCode: 0 };
  const res = await start(agentId);
  expect(res.status).toBe(409);
  const { error } = (await res.json()) as {
    error: { code: string; message: string };
  };
  expect(error.code).toBe("port_busy");
  expect(error.message).toContain("8080");
  expect(wire.calls.filter((c) => c.startsWith("service-"))).toEqual([]);
  expect(authOf(envId)).toBeUndefined();
  expect(db.select().from(previews).all()).toEqual([]);
});

test("a dev port already in use is refused, naming the port", async () => {
  const envId = readyEnv();
  const agentId = seedAgent(envId);
  wire.exec = (argv) =>
    argv[0] === "sh" && argv.at(-1) === "5173"
      ? { exitCode: 10 }
      : { exitCode: 0 };
  const res = await start(agentId);
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({
    error: { code: "port_busy", message: expect.stringContaining("5173") },
  });
  expect(wire.calls.filter((c) => c.startsWith("service-"))).toEqual([]);
});

test("the port check runs after the replaced preview's services are gone, so it never counts its own proxy", async () => {
  const envId = readyEnv();
  const first = seedAgent(envId);
  const second = seedAgent(envId);
  await started(first);
  wire.calls.length = 0;
  await started(second);
  const firstDelete = wire.calls.findIndex((c) =>
    c.startsWith("service-delete"),
  );
  const check = wire.calls.findIndex(
    (c) => c.includes("/proc/net/tcp") || /exec .* sh -c .* sh 8080/.test(c),
  );
  expect(firstDelete).toBeGreaterThanOrEqual(0);
  expect(check).toBeGreaterThan(firstDelete);
});

test("a dev server that dies at start fails the start with its output, redacted, and leaves nothing running", async () => {
  const envId = readyEnv();
  const agentId = seedAgent(envId);
  const db_url = "postgres://user:hunter2hunter2@db.test/app";
  db.insert(secrets)
    .values({
      envId,
      name: "DATABASE_URL",
      kind: "value",
      connector: null,
      ...seal(
        config.secretEncryptionKey,
        db_url,
        envSecretAad(envId, "DATABASE_URL"),
      ),
    })
    .run();
  wire.serviceEvents = (_, service) =>
    service === PREVIEW_APP_SERVICE
      ? [
          {
            type: "stderr",
            data: `cannot connect to ${db_url}\n`,
            timestamp: 1,
          },
          { type: "exit", exit_code: 1, timestamp: 2 },
        ]
      : [{ type: "complete", timestamp: 1 }];
  const res = await start(agentId);
  expect(res.status).toBe(502);
  const { error } = (await res.json()) as {
    error: { code: string; message: string };
  };
  expect(error.code).toBe("preview_failed");
  expect(error.message).toContain(PREVIEW_APP_SERVICE);
  expect(error.message).toContain("cannot connect to [redacted]");
  expect(error.message).not.toContain("hunter2");
  expect(logs.join("\n")).not.toContain("hunter2");
  expect(servicesOf(envId).size).toBe(0);
  expect(authOf(envId)).toEqual({ auth: "sprite" });
  expect(db.select().from(previews).all()).toEqual([]);
});

test("a sprite that refuses the service fails the start and the URL never went public", async () => {
  const envId = readyEnv();
  const agentId = seedAgent(envId);
  wire.serviceStatus = 500;
  const res = await start(agentId);
  expect(res.status).toBe(502);
  expect(await res.json()).toMatchObject({ error: { code: "preview_failed" } });
  expect(authOf(envId)).toEqual({ auth: "sprite" });
  expect(db.select().from(previews).all()).toEqual([]);
});

test("state reports the two services' status and the expiry", async () => {
  const envId = readyEnv();
  const agentId = seedAgent(envId);
  const { preview } = await started(agentId);
  const res = await state(agentId);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    preview: {
      agentId,
      envId,
      port: 5173,
      cmd: "pnpm dev --host",
      startedAt: expect.any(String),
      expiresAt: preview.expiresAt,
      services: { app: "running", proxy: "running" },
    },
  });
});

test("a follow-up run on the agent leaves its preview running", async () => {
  const envId = readyEnv();
  const agentId = seedAgent(envId);
  db.insert(runs)
    .values({ id: "run_first" as RunId, agentId, status: "finished" })
    .run();
  const one = await started(agentId);
  wire.calls.length = 0;
  const res = await app.request(`/v1/agents/${agentId}/runs`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ prompt: "tweak the header" }),
  });
  expect(res.status).toBe(202);
  await new Promise((r) => setTimeout(r, 300));
  // no service was touched and the URL was not made private; the follow-up's edits reach the running
  // dev server through the worktree they share
  expect(wire.calls.filter((c) => /^(service-|label )/.test(c))).toEqual([]);
  expect(servicesOf(envId).size).toBe(2);
  expect(authOf(envId)).toEqual({ auth: "public" });
  expect(servicesOf(envId).get(PREVIEW_APP_SERVICE)?.dir).toBe(
    `/workspace/worktrees/${agentId}`,
  );
  expect(db.select().from(previews).get()?.tokenHash).toBe(
    sha256(tokenOf(one.preview.link)),
  );
});

test("the preview endpoints need a valid key", async () => {
  const envId = readyEnv();
  const agentId = seedAgent(envId);
  for (const method of ["POST", "GET", "DELETE"]) {
    const res = await app.request(`/v1/agents/${agentId}/preview`, { method });
    expect(res.status).toBe(401);
  }
});
