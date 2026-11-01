import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import {
  agents,
  type Db,
  environments,
  events,
  runs,
  webhookDeliveries,
  webhooks,
} from "@sky/db";
import type { AgentId, EnvironmentId, RunId } from "@sky/shared";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { server } from "../../../test/msw.js";
import { mintAgentToken } from "./agent-token.js";
import { boot, shutdown } from "./boot.js";
import { runEnvVarAad, seal } from "./crypto.js";
import { runnerPattern } from "./launch.js";
import { stubSprites, testConfig } from "./testing/sprites.js";

let dir: string;
let db: Db | undefined;
let stops: (() => unknown)[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sky-api-"));
  stops = [];
});
afterEach(async () => {
  vi.useRealTimers();
  for (const stop of stops) await stop();
  if (db?.$client.open) db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

const config = () => testConfig({ dataDir: dir, runTimeoutMs: 60_000 });

const booted = (log: (line: string) => void = () => {}) => {
  const b = boot(config(), log);
  stops.push(b.stopSweeping, b.stopDelivering);
  return b;
};

test("booting on an empty data dir creates sky.db with the schema migrated", async () => {
  const b = booted();
  db = b.db;
  expect(existsSync(join(dir, "sky.db"))).toBe(true);
  const table = db.$client
    .prepare("select name from sqlite_schema where name = 'environments'")
    .get();
  expect(table).toEqual({ name: "environments" });
  expect((await b.app.request("/healthz")).status).toBe(200);
});

test("shutdown closes the server before the DB", async () => {
  db = booted().db;
  const order: string[] = [];
  const server = {
    close(done: (err?: Error) => void) {
      setTimeout(() => {
        order.push(`server closed, db open: ${db?.$client.open}`);
        done();
      }, 1);
    },
    closeIdleConnections() {},
    closeAllConnections() {},
  };
  await shutdown(server, db);
  order.push(`db open: ${db.$client.open}`);
  expect(order).toEqual(["server closed, db open: true", "db open: false"]);
});

test("shutdown with an open SSE stream closes it after the drain, well inside Fly's kill timeout", async () => {
  db = booted().db;
  const app = new Hono().get("/stream", (c) =>
    streamSSE(c, async (stream) => {
      await stream.writeSSE({ data: "open" });
      while (!stream.aborted) await stream.sleep(20);
    }),
  );
  const server = serve({ fetch: app.fetch, port: 0 }) as Server;
  stops.push(() => {
    server.closeAllConnections();
    server.close();
  });
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  // a raw socket: MSW intercepts http and fetch, and would count the request as a leak
  const socket = connect(port, "127.0.0.1");
  stops.push(() => socket.destroy());
  socket.write(`GET /stream HTTP/1.1\r\nHost: localhost\r\n\r\n`);
  await once(socket, "data");
  const closed = once(socket, "close");

  const started = Date.now();
  await shutdown(server, db, 100);
  await closed;
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(db.$client.open).toBe(false);
});

test("closing the streams before shutdown ends an open /v1/stream with a shutdown frame, before the drain cutoff", async () => {
  const b = booted();
  db = b.db;
  const server = serve({ fetch: b.app.fetch, port: 0 }) as Server;
  stops.push(() => {
    server.closeAllConnections();
    server.close();
  });
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  // a raw socket: MSW intercepts http and fetch, and would count the request as a leak
  const socket = connect(port, "127.0.0.1");
  stops.push(() => socket.destroy());
  let received = "";
  socket.on("data", (chunk) => {
    received += chunk;
  });
  socket.write(
    `GET /v1/stream HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${config().apiKey}\r\n\r\n`,
  );
  await once(socket, "data");
  const closed = once(socket, "close");

  const started = Date.now();
  b.closeStreams();
  await shutdown(server, db, 5_000);
  await closed;
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(received).toContain("event: server.shutdown");
  expect(received).toContain("retry: 2000");
});

test("an env a previous process left provisioning boots as failed; others keep their status", async () => {
  const first = booted().db;
  const insert = first.$client.prepare(
    "insert into environments (id, name, repo, setup, status, sprite_name) values (?, ?, 'acme/kru', '', ?, ?)",
  );
  insert.run("env_stuck", "stuck", "provisioning", "sky-env_stuck");
  insert.run("env_ok", "ok", "ready", "sky-env_ok");
  first.$client.close();

  db = booted().db;
  const rows = db.$client
    .prepare("select id, status from environments order by id")
    .all();
  expect(rows).toEqual([
    { id: "env_ok", status: "ready" },
    { id: "env_stuck", status: "failed" },
  ]);
});

test("boot fails runs a previous process left silent past the timeout; fresh ones stay", async () => {
  const first = booted().db;
  first.$client.exec(`
    insert into environments (id, name, repo, setup, status, sprite_name) values ('env_a', 'a', 'acme/kru', '', 'ready', 'sky-env_a');
    insert into agents (id, env_id, branch, status) values ('agt_old', 'env_a', 'claude/agt_old', 'running'), ('agt_new', 'env_a', 'claude/agt_new', 'running');
    insert into runs (id, agent_id, status, created_at) values ('run_old', 'agt_old', 'running', '2026-01-01T00:00:00.000Z'), ('run_new', 'agt_new', 'starting', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  `);
  first.$client.close();

  db = booted().db;
  expect(
    db.$client.prepare("select id, status from runs order by id").all(),
  ).toEqual([
    { id: "run_new", status: "starting" },
    { id: "run_old", status: "failed" },
  ]);
  expect(db.$client.prepare("select type, payload from events").all()).toEqual([
    { type: "run.failed", payload: '{"error":"runner_timeout"}' },
  ]);
  expect(
    db.$client.prepare("select status from agents where id = 'agt_old'").get(),
  ).toEqual({ status: "idle" });
});

test("boot fails a run that never reported in past the launch deadline and signals its runner", async () => {
  const wire = stubSprites();
  wire.sprites.add("sky-env_a");
  const first = booted().db;
  first.$client.exec(`
    insert into environments (id, name, repo, setup, status, sprite_name) values ('env_a', 'a', 'acme/kru', '', 'ready', 'sky-env_a');
    insert into agents (id, env_id, branch, status) values ('agt_late', 'env_a', 'claude/agt_late', 'running');
    insert into runs (id, agent_id, status, created_at) values ('run_late', 'agt_late', 'starting', '2026-01-01T00:00:00.000Z');
  `);
  first.$client.close();

  const lines: string[] = [];
  db = booted((line) => lines.push(line)).db;
  expect(db.$client.prepare("select type, payload from events").all()).toEqual([
    { type: "run.failed", payload: '{"error":"launch_timeout"}' },
  ]);
  await expect
    .poll(() => wire.calls)
    .toContain(
      `exec sky-env_a - pkill -TERM -f ${runnerPattern("run_late" as RunId)}`,
    );
  // settled before teardown closes the DB and resets the handlers
  await expect
    .poll(() => lines.some((l) => l.startsWith("sprite sky-env_a pkill: ok")))
    .toBe(true);
});

test("a webhook delivery a previous process left pending is sent after boot", async () => {
  const first = booted();
  const envId = "env_boot" as EnvironmentId;
  const agentId = "agt_boot" as AgentId;
  const runId = "run_boot" as RunId;
  await first.stopDelivering();
  first.db
    .insert(environments)
    .values({
      id: envId,
      name: "e",
      repo: "acme/kru",
      setup: "",
      status: "ready",
      spriteName: "sky-env_boot",
    })
    .run();
  first.db
    .insert(agents)
    .values({ id: agentId, envId, branch: `claude/${agentId}`, status: "idle" })
    .run();
  first.db.insert(runs).values({ id: runId, agentId, status: "stopped" }).run();
  first.db
    .insert(webhooks)
    .values({
      id: "whk_boot",
      url: "https://hooks.example.com/boot",
      eventTypes: ["run.stopped"],
    })
    .run();
  const { id: eventId } = first.db
    .insert(events)
    .values({
      runId,
      ts: new Date().toISOString(),
      type: "run.stopped",
      payload: {},
    })
    .returning({ id: events.id })
    .get();
  first.db
    .insert(webhookDeliveries)
    .values({
      webhookId: "whk_boot",
      eventId,
      status: "pending",
      nextAttemptAt: new Date().toISOString(),
    })
    .run();
  first.db.$client.close();

  const received: string[] = [];
  server.use(
    http.post("https://hooks.example.com/boot", ({ request }) => {
      received.push(request.headers.get("sky-event-id") ?? "");
      return new HttpResponse(null, { status: 204 });
    }),
  );
  const second = booted();
  db = second.db;
  await expect.poll(() => received).toEqual([`evt_${eventId}`]);
  await expect
    .poll(() => db?.select().from(webhookDeliveries).get()?.status)
    .toBe("delivered");
});

test("the sweep deletes envVars once their TTL passes, and redacts them only while held", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-10-30T12:00:00.000Z"));
  const first = booted().db;
  first.$client.exec(`
    insert into environments (id, name, repo, setup, status, sprite_name) values ('env_a', 'a', 'acme/kru', '', 'ready', 'sky-env_a');
    insert into agents (id, env_id, branch, status) values ('agt_a', 'env_a', 'claude/agt_a', 'running');
    insert into runs (id, agent_id, status, created_at) values ('run_a', 'agt_a', 'running', '2026-10-30T12:00:00.000Z');
  `);
  const held = (name: string, value: string, expiresAt: string) => {
    const s = seal(
      config().secretEncryptionKey,
      value,
      runEnvVarAad("run_a", name),
    );
    first.$client
      .prepare(
        "insert into run_env_vars (run_id, name, ciphertext, nonce, key_version, expires_at) values ('run_a', ?, ?, ?, ?, ?)",
      )
      .run(name, s.ciphertext, s.nonce, s.keyVersion, expiresAt);
  };
  held("SHORT", "short-lived-value-01", "2026-10-30T12:00:30.000Z");
  held("LONG", "long-lived-value-02", "2026-10-30T13:00:00.000Z");
  first.$client.close();

  // the default run timeout, not `config()`'s 60 s, so the run itself stays live across the sweep
  const b = boot(testConfig({ dataDir: dir }), () => {});
  stops.push(b.stopSweeping, b.stopDelivering);
  db = b.db;
  const echo = async (message: string) => {
    const res = await b.app.request("/internal/events", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mintAgentToken(config().apiKey, "run_a")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        runId: "run_a",
        type: "claude.Message",
        payload: { text: message },
      }),
    });
    expect(res.status).toBeLessThan(300);
    const last = db?.$client
      .prepare("select payload from events order by id desc limit 1")
      .get() as { payload: string };
    return JSON.parse(last.payload).text;
  };
  expect(await echo("short-lived-value-01")).toBe("[redacted]");

  vi.advanceTimersByTime(60_000);
  expect(db.$client.prepare("select name from run_env_vars").all()).toEqual([
    { name: "LONG" },
  ]);
  expect(await echo("short-lived-value-01")).toBe("short-lived-value-01");
  expect(await echo("long-lived-value-02")).toBe("[redacted]");
});

test("the sweep prunes claude.* events past 7 days with their deliveries; younger ones and run.* stay", async () => {
  const first = booted().db;
  const daysAgo = (d: number) =>
    new Date(Date.now() - d * 86_400_000).toISOString();
  first.$client.exec(`
    insert into environments (id, name, repo, setup, status, sprite_name) values ('env_a', 'a', 'acme/kru', '', 'ready', 'sky-env_a');
    insert into agents (id, env_id, branch, status) values ('agt_a', 'env_a', 'claude/agt_a', 'idle');
    insert into runs (id, agent_id, status) values ('run_a', 'agt_a', 'finished');
    insert into webhooks (id, url, event_types) values ('whk_a', 'https://hooks.example.com/a', '["claude.Message","run.finished"]');
  `);
  const event = (type: string, ts: string, payload: object) =>
    first
      .insert(events)
      .values({
        runId: "run_a" as RunId,
        ts,
        type: type as "run.finished",
        payload,
      })
      .returning({ id: events.id })
      .get().id;
  const old = event("claude.Message", daysAgo(8), { text: "old" });
  const young = event("claude.Message", daysAgo(6), { text: "young" });
  const finished = event("run.finished", daysAgo(8), {
    summary: "done",
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
      turns: 1,
      durationMs: 1,
    },
  });
  for (const eventId of [old, young, finished]) {
    first
      .insert(webhookDeliveries)
      .values({
        webhookId: "whk_a",
        eventId,
        status: "delivered",
        nextAttemptAt: daysAgo(8),
      })
      .run();
  }
  first.$client.close();

  const lines: string[] = [];
  db = booted((line) => lines.push(line)).db;
  expect(db.$client.prepare("select id from events order by id").all()).toEqual(
    [{ id: young }, { id: finished }],
  );
  expect(
    db.$client
      .prepare("select event_id from webhook_deliveries order by event_id")
      .all(),
  ).toEqual([{ event_id: young }, { event_id: finished }]);
  expect(lines.filter((l) => l.includes("pruned"))).toEqual([
    "pruned 1 claude.* events older than 7 days",
  ]);
});

test("a sweep with nothing to prune logs nothing about pruning", () => {
  const lines: string[] = [];
  db = booted((line) => lines.push(line)).db;
  expect(lines.filter((l) => l.includes("pruned"))).toEqual([]);
});
