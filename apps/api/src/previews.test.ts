import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, expect, test } from "vitest";
import { server } from "../../../test/msw.js";
import { mintAgentToken } from "./agent-token.js";
import { createApp } from "./app.js";
import type { Config } from "./config.js";
import { envSecretAad, seal } from "./crypto.js";
import { sweepExpiredPreviews } from "./previews.js";
import { RUNNER } from "./provision.js";
import { KnownSecrets } from "./redact.js";
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

/** Of the calls since `wire.calls` was last cleared: the env's URL went private before either service was deleted. */
function expectPrivateBeforeServicesGo(envId: string) {
  const label = `label ${sprite(envId)}`;
  const teardown = wire.calls.filter(
    (c) => c === label || c.startsWith(`service-delete ${sprite(envId)} `),
  );
  // either service may go first; both go after the URL
  expect(teardown).toHaveLength(3);
  expect(teardown[0]).toBe(label);
  for (const service of [PREVIEW_APP_SERVICE, PREVIEW_PROXY_SERVICE]) {
    expect(teardown).toContain(`service-delete ${sprite(envId)} ${service}`);
  }
  expect(wire.updates.get(sprite(envId))).toEqual({
    url_settings: { auth: "sprite" },
  });
}

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
  // the command is the shell's $1, run by a shell of its own, never spliced into the script
  expect(appService?.args).toEqual([
    "-c",
    expect.stringMatching(/&& exec bash -c "\$1"$/),
    "bash",
    "pnpm dev --host",
  ]);

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

test.each([
  ["a cd first", "cd web && pwd > ../ran", (dir: string) => `${dir}/web\n`],
  ["a variable set for it", `FOO=1 sh -c 'echo "$FOO"' > ran`, () => "1\n"],
  ["two commands", "echo one > ran && echo two >> ran", () => "one\ntwo\n"],
  ["quotes", `echo "it's" 'a "test"' > ran`, () => `it's a "test"\n`],
])(
  "a command with %s runs whole, as written, in the worktree",
  async (_, cmd, expected) => {
    const envId = readyEnv();
    const agentId = seedAgent(envId);
    await started(agentId, { cmd, port: 5173 });
    const service = servicesOf(envId).get(PREVIEW_APP_SERVICE);
    expect(service?.cmd).toBe("bash");
    // what the sprite would run, run here by a real bash in a stand-in worktree
    mkdirSync(join(dir, "worktree", "web"), { recursive: true });
    // as `pwd` prints it, where the temp dir is behind a symlink
    const worktree = realpathSync(join(dir, "worktree"));
    execFileSync("bash", service?.args ?? [], { cwd: worktree });
    expect(readFileSync(join(worktree, "ran"), "utf8")).toBe(
      expected(worktree),
    );
  },
);

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
  const stopFirst = await stop(first);
  expect(stopFirst.status).toBe(200);
  expect(await stopFirst.json()).toEqual({ preview: null, stopped: null });
  // and stopping it did not touch the second's
  expect(servicesOf(envId).size).toBe(2);
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
});

test("stopping with no preview running succeeds, changes nothing and says so", async () => {
  const envId = readyEnv();
  const agentId = seedAgent(envId);
  const res = await stop(agentId);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ preview: null, stopped: null });
  // a retried stop after a real one is the same
  await started(agentId);
  expect((await stop(agentId)).status).toBe(200);
  wire.calls.length = 0;
  const again = await stop(agentId);
  expect(again.status).toBe(200);
  expect(await again.json()).toEqual({ preview: null, stopped: null });
  expect(wire.calls).toEqual([]);
  // an agent that doesn't exist is still a 404
  expect((await stop("agt_nope")).status).toBe(404);
});

test("the URL goes private before the services go, and the dev server goes before the proxy it needs", async () => {
  const envId = readyEnv();
  const agentId = seedAgent(envId);
  await started(agentId);
  wire.calls.length = 0;
  await stop(agentId);
  expect(wire.calls).toEqual([
    `label ${sprite(envId)}`,
    `service-delete ${sprite(envId)} ${PREVIEW_APP_SERVICE}`,
    `service-delete ${sprite(envId)} ${PREVIEW_PROXY_SERVICE}`,
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
    secrets: new KnownSecrets(),
    timeoutMs: 5_000,
    longTimeoutMs: 5_000,
  };

  // not yet due
  expect(await sweepExpiredPreviews(db, ops, ops.log, new Date())).toBe(0);
  expect(servicesOf(envId).size).toBe(2);

  wire.calls.length = 0;
  const later = new Date(Date.parse(preview.expiresAt) + 1000);
  expect(await sweepExpiredPreviews(db, ops, ops.log, later)).toBe(1);
  expectPrivateBeforeServicesGo(envId);
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
  expectPrivateBeforeServicesGo(envId);
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
  wire.calls.length = 0;
  const res = await app.request(`/v1/environments/${envId}`, {
    method: "DELETE",
    headers: headers(),
  });
  expect(res.status).toBe(204);
  expectPrivateBeforeServicesGo(envId);
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

test("a runs key can't replace a preview another key started, and the refusal names no agent", async () => {
  const envId = readyEnv();
  const first = await mintKey([envId]);
  const second = await mintKey([envId]);
  const a = seedAgent(envId, { ownerKeyId: first.id });
  const b = seedAgent(envId, { ownerKeyId: second.id });
  const { preview } = await started(a, undefined, first.secret);
  wire.calls.length = 0;

  const res = await start(b, undefined, second.secret);
  expect(res.status).toBe(409);
  const body = (await res.json()) as {
    error: { code: string; message: string };
  };
  expect(body.error.code).toBe("preview_busy");
  expect(JSON.stringify(body)).not.toContain(a);
  // nothing reached the sprite, and the first key's preview is exactly as it was
  expect(wire.calls).toEqual([]);
  expect(servicesOf(envId).size).toBe(2);
  expect(authOf(envId)).toEqual({ auth: "public" });
  expect(db.select().from(previews).get()).toMatchObject({
    agentId: a,
    tokenHash: sha256(tokenOf(preview.link)),
  });
});

test("a preview the admin key started is not replaceable by a runs key either", async () => {
  const envId = readyEnv();
  const key = await mintKey([envId]);
  const theirs = seedAgent(envId);
  const mine = seedAgent(envId, { ownerKeyId: key.id });
  await started(theirs);
  const res = await start(mine, undefined, key.secret);
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ error: { code: "preview_busy" } });
  expect(db.select().from(previews).get()?.agentId).toBe(theirs);
});

test("the admin key replaces any key's preview and the answer names the agent replaced", async () => {
  const envId = readyEnv();
  const key = await mintKey([envId]);
  const a = seedAgent(envId, { ownerKeyId: key.id });
  const b = seedAgent(envId);
  await started(a, undefined, key.secret);
  const two = await started(b);
  expect(two.preview.replaced).toBe(a);
  expect(db.select().from(previews).get()?.agentId).toBe(b);
});

test("a runs key replaces its own preview, on the same agent or another of its own", async () => {
  const envId = readyEnv();
  const key = await mintKey([envId]);
  const a = seedAgent(envId, { ownerKeyId: key.id });
  const b = seedAgent(envId, { ownerKeyId: key.id });
  await started(a, undefined, key.secret);
  const again = await started(a, undefined, key.secret);
  expect(again.preview.replaced).toBeNull();
  const other = await started(b, undefined, key.secret);
  expect(other.preview.replaced).toBe(a);
  expect(db.select().from(previews).get()?.agentId).toBe(b);
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

/** Starts `agentId`'s preview and returns a check, for after a refused start, that the preview still runs untouched. */
async function runningPreviewOf(envId: EnvironmentId, agentId: AgentId) {
  await started(agentId);
  const row = db.select().from(previews).get();
  wire.calls.length = 0;
  return async () => {
    expect(db.select().from(previews).all()).toEqual([row]);
    expect(servicesOf(envId).size).toBe(2);
    expect(servicesOf(envId).get(PREVIEW_APP_SERVICE)?.dir).toBe(
      `/workspace/worktrees/${agentId}`,
    );
    expect(authOf(envId)).toEqual({ auth: "public" });
    const touched = wire.calls.filter((c) => /^(service-|label )/.test(c));
    expect(touched).toEqual([]);
    expect(await (await state(agentId)).json()).toMatchObject({
      preview: { agentId, services: { app: "running", proxy: "running" } },
    });
  };
}

test("a start refused for a busy port other than the running preview's leaves that preview running", async () => {
  const envId = readyEnv();
  const a = seedAgent(envId);
  const b = seedAgent(envId);
  const untouched = await runningPreviewOf(envId, a);
  wire.exec = (argv) =>
    argv[0] === "sh" && argv.at(-1) === "4000"
      ? { exitCode: 10 }
      : { exitCode: 0 };
  const res = await start(b, { cmd: "npm run dev", port: 4000 });
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({
    error: { code: "port_busy", message: expect.stringContaining("4000") },
  });
  await untouched();
});

test("a start refused because the sprite has no URL leaves the running preview running", async () => {
  const envId = readyEnv();
  const a = seedAgent(envId);
  const b = seedAgent(envId);
  const untouched = await runningPreviewOf(envId, a);
  server.use(
    http.get("https://api.sprites.dev/v1/sprites/:name", ({ params }) =>
      HttpResponse.json({
        id: `spr_${String(params.name)}`,
        name: String(params.name),
        status: "warm",
      }),
    ),
  );
  const res = await start(b, { cmd: "npm run dev", port: 4000 });
  expect(res.status).toBe(502);
  expect(await res.json()).toMatchObject({ error: { code: "preview_failed" } });
  await untouched();
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
  // the user's own command dying is a refusal of the start, not a sprite failure
  expect(res.status).toBe(422);
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

test("a dev server's failure output keeps the port and the profile's switches; only secrets are redacted", async () => {
  const envId = readyEnv({ base: "team" });
  const agentId = seedAgent(envId);
  db.insert(secrets)
    .values({
      envId,
      name: "STRIPE_KEY",
      kind: "value",
      connector: null,
      ...seal(
        config.secretEncryptionKey,
        "stripe-value-9f8e7d",
        envSecretAad(envId, "STRIPE_KEY"),
      ),
    })
    .run();
  wire.serviceEvents = (_, service) =>
    service === PREVIEW_APP_SERVICE
      ? [
          {
            type: "stderr",
            data: "attempt 1: listen EADDRINUSE :::5173 (key stripe-value-9f8e7d)\n",
            timestamp: 1,
          },
          { type: "exit", exit_code: 1, timestamp: 2 },
        ]
      : [{ type: "complete", timestamp: 1 }];
  const res = await start(agentId, { cmd: "pnpm dev", port: 5173 });
  expect(res.status).toBe(422);
  const { error } = (await res.json()) as { error: { message: string } };
  expect(error.message).toContain(
    "attempt 1: listen EADDRINUSE :::5173 (key [redacted])",
  );
  expect(error.message).not.toContain("stripe-value-9f8e7d");
});

test.each([
  [
    "the proxy exits",
    (_: string, service: string) =>
      service === PREVIEW_PROXY_SERVICE
        ? [{ type: "exit", exit_code: 1, timestamp: 1 }]
        : [{ type: "complete", timestamp: 1 }],
  ],
  [
    "the sprite can't spawn the dev server",
    (_: string, service: string) =>
      service === PREVIEW_APP_SERVICE
        ? [{ type: "error", data: "spawn failed", timestamp: 1 }]
        : [{ type: "complete", timestamp: 1 }],
  ],
])(
  "a start that fails because %s is the sprite's failure, 502, not the user's 422",
  async (_, events) => {
    const envId = readyEnv();
    const agentId = seedAgent(envId);
    wire.serviceEvents = events;
    const res = await start(agentId);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      error: { code: "preview_failed" },
    });
    expect(servicesOf(envId).size).toBe(0);
    expect(authOf(envId)).toEqual({ auth: "sprite" });
  },
);

test("a start writes its row with minutes to live and extends it to the TTL only once it has succeeded", async () => {
  const envId = readyEnv();
  const agentId = seedAgent(envId);
  // what the row holds while the start is under way: read when the dev server's service is created
  const during: string[] = [];
  wire.serviceEvents = (_, service) => {
    if (service === PREVIEW_APP_SERVICE) {
      during.push(db.select().from(previews).get()?.expiresAt ?? "none");
    }
    return [{ type: "complete", timestamp: 1 }];
  };
  const before = Date.now();
  const { preview } = await started(agentId, {
    cmd: "pnpm dev",
    port: 5173,
    ttlSeconds: 7 * 24 * 3600,
  });
  const mid = Date.parse(during[0] ?? "");
  expect(mid).toBeGreaterThan(before);
  expect(mid).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
  // then the full TTL, in the row and in the answer
  expect(db.select().from(previews).get()?.expiresAt).toBe(preview.expiresAt);
  expect(Date.parse(preview.expiresAt)).toBeGreaterThan(
    before + 6.9 * 24 * 3600_000,
  );
});

test("a start that dies and can't clean up leaves a row the sweep ends within minutes, not days", async () => {
  const envId = readyEnv();
  const agentId = seedAgent(envId);
  wire.serviceEvents = (_, service) =>
    service === PREVIEW_APP_SERVICE
      ? [{ type: "exit", exit_code: 1, timestamp: 1 }]
      : [{ type: "complete", timestamp: 1 }];
  // the cleanup's own calls fail too
  wire.serviceDeleteStatus = 503;
  const before = Date.now();
  const res = await start(agentId, {
    cmd: "pnpm dev",
    port: 5173,
    ttlSeconds: 7 * 24 * 3600,
  });
  expect(res.status).toBe(422);
  const [row] = db.select().from(previews).all();
  expect(row).toBeDefined();
  expect(Date.parse(row?.expiresAt ?? "")).toBeLessThanOrEqual(
    Date.now() + 5 * 60_000,
  );
  expect(Date.parse(row?.expiresAt ?? "")).toBeGreaterThan(before);

  wire.serviceDeleteStatus = 204;
  const ops = {
    client: new SpritesClient(spritesToken),
    log: (line: string) => logs.push(line),
    secrets: new KnownSecrets(),
    timeoutMs: 5_000,
    longTimeoutMs: 5_000,
  };
  const later = new Date(Date.now() + 6 * 60_000);
  expect(await sweepExpiredPreviews(db, ops, ops.log, later)).toBe(1);
  expect(db.select().from(previews).all()).toEqual([]);
  expect(servicesOf(envId).size).toBe(0);
  expect(authOf(envId)).toEqual({ auth: "sprite" });
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
