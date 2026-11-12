import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpritesClient } from "@fly/sprites";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { agents, type Db, environments, migrate, openDb, runs } from "@sky/db";
import type { AgentId, ApiKeyId, EnvironmentId, RunId } from "@sky/shared";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createApp } from "./app.js";
import { anyRun, runEvents } from "./run-events.js";
import { spriteNameFor } from "./sprites.js";
import {
  type SpritesWire,
  spritesToken,
  stubSprites,
  testConfig,
} from "./testing/sprites.js";

let dir: string;
let db: Db;
let app: ReturnType<typeof createApp>;
let wire: SpritesWire;
let closing: AbortController;
const clients: Client[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sky-mcp-"));
  writeFileSync(join(dir, "runner.mjs"), "// runner bundle v1\n");
  db = openDb(":memory:");
  migrate(db);
  wire = stubSprites();
  closing = new AbortController();
  app = createApp({
    db,
    config: testConfig({ runnerBundlePath: join(dir, "runner.mjs") }),
    sprites: new SpritesClient(spritesToken),
    log: () => {},
    nudgeDeliveries: () => {},
    closing: closing.signal,
  });
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  if (db.$client.open) db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

/** An MCP client whose transport reaches the app in-process, with no port. */
async function connect(token = testConfig().apiKey) {
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://sky.test/mcp"), {
      fetch: async (url, init) => app.request(new Request(url, init)),
      requestInit: {
        headers: { authorization: `Bearer ${token}` },
      },
    }),
  );
  clients.push(client);
  return client;
}

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  JSON.parse(
    (result.content as { type: "text"; text: string }[])[0]?.text ?? "",
  );

test("/mcp without the bearer key is 401", async () => {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "0.0.0" },
      },
    }),
  });
  expect(res.status).toBe(401);
  expect(await res.json()).toMatchObject({ error: { code: "unauthorized" } });
});

test("an MCP client launches an agent then reads its run status through /v1", async () => {
  const envId = "env_mcp";
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
  const client = await connect();

  const launched = await client.callTool({
    name: "launch",
    arguments: { envId, prompt: "fix the flaky test" },
  });
  expect(launched.isError).toBeFalsy();
  const { agent, run } = textOf(launched);
  expect(agent.branch).toBe(`claude/${agent.id}`);
  await vi.waitFor(() => expect(wire.sessions).toHaveLength(1));

  const status = await client.callTool({
    name: "status",
    arguments: { agentId: agent.id },
  });
  expect(status.isError).toBeFalsy();
  expect(textOf(status)).toMatchObject({ id: run.id, agentId: agent.id });
});

test("closing answers an in-flight wait_for_events with no events and a cursor", async () => {
  const client = await connect();
  // other listeners (a leaked one from another test) don't decide whether this call has parked
  const baseline = runEvents.listenerCount(anyRun);
  const pending = client.callTool({
    name: "wait_for_events",
    arguments: { wait: 30 },
  });
  await vi.waitFor(() =>
    expect(runEvents.listenerCount(anyRun)).toBe(baseline + 1),
  );
  const started = Date.now();
  closing.abort();
  const result = await pending;
  // the wait is 30 s, so only the shutdown can have ended it this fast
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(result.isError).toBeFalsy();
  expect(textOf(result)).toEqual({ events: [], cursor: "evt_0" });
});

function readyEnv(id: string) {
  db.insert(environments)
    .values({
      id: id as EnvironmentId,
      name: id,
      repo: "acme/kru",
      setup: "",
      status: "ready",
      spriteName: spriteNameFor(id),
      checkpointId: "v1",
    })
    .run();
  wire.sprites.add(spriteNameFor(id));
  return id as EnvironmentId;
}

async function mintKey(environmentIds: EnvironmentId[]) {
  const res = await app.request("/v1/keys", {
    method: "POST",
    headers: {
      authorization: `Bearer ${testConfig().apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "bot", role: "runs", environmentIds }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; secret: string };
}

const initialize = (token: string) =>
  app.request("/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "0.0.0" },
      },
    }),
  });

test("/mcp with an unknown or revoked issued key is 401", async () => {
  const key = await mintKey([readyEnv("env_mine")]);
  expect((await initialize(key.secret)).status).toBe(200);
  await app.request(`/v1/keys/${key.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${testConfig().apiKey}` },
  });
  for (const token of [key.secret, `sky_${"A".repeat(43)}`]) {
    const res = await initialize(token);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "unauthorized" } });
  }
});

test("an MCP client on a runs key has the key's limits", async () => {
  const mine = readyEnv("env_mine");
  const elsewhere = readyEnv("env_elsewhere");
  const key = await mintKey([mine]);
  const agentId = "agt_admins" as AgentId;
  db.insert(agents)
    .values({
      id: agentId,
      envId: mine,
      branch: `claude/${agentId}`,
      status: "running",
    })
    .run();
  db.insert(runs)
    .values({ id: "run_admins" as RunId, agentId, status: "running" })
    .run();
  const client = await connect(key.secret);

  const foreignLaunch = await client.callTool({
    name: "launch",
    arguments: { envId: elsewhere, prompt: "p" },
  });
  expect(foreignLaunch.isError).toBe(true);
  expect(textOf(foreignLaunch)).toMatchObject({
    status: 404,
    error: { code: "not_found" },
  });
  for (const [name, args] of [
    ["approve", { agentId, requestId: "req_x", decision: "approve" }],
    ["stop", { agentId }],
  ] as const) {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatchObject({ status: 404 });
  }
  const created = await client.callTool({
    name: "create_env",
    arguments: { name: "new", repo: "acme/kru", setup: "" },
  });
  expect(created.isError).toBe(true);
  expect(textOf(created)).toMatchObject({
    status: 403,
    error: { code: "forbidden" },
  });
  expect(db.select().from(environments).all()).toHaveLength(2);
  expect(db.select().from(runs).get()?.status).toBe("running");

  const launched = await client.callTool({
    name: "launch",
    arguments: { envId: mine, prompt: "fix the flaky test" },
  });
  expect(launched.isError).toBeFalsy();
  expect(
    db
      .select()
      .from(agents)
      .where(eq(agents.ownerKeyId, key.id as ApiKeyId))
      .all(),
  ).toHaveLength(1);
});
