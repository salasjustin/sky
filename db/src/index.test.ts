import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentId,
  AgentStatus,
  type EnvironmentId,
  EnvironmentStatus,
  EventType,
  type RequestId,
  type RunId,
  type RunRollup,
  RunStatus,
  type WebhookId,
} from "@sky/shared";
import { migrate as drizzleMigrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  agents,
  type Db,
  deliveryStatuses,
  migrate,
  openDb,
  requestKinds,
  runEnvVars,
  runRequests,
  runs,
  secretKinds,
  webhookDeliveries,
  webhooks,
} from "./index.js";

let dir: string;
let path: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sky-db-"));
  path = join(dir, "sky.db");
  db = openDb(path);
});
afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

const run = (stmt: string, ...params: unknown[]) =>
  db.$client.prepare(stmt).run(...params);

const seedRun = () => {
  run(
    "insert into environments (id, name, repo, setup, status, sprite_name) values ('env_1', 'e', 'o/r', '', 'ready', 's')",
  );
  run(
    "insert into agents (id, env_id, branch, status) values ('agt_1', 'env_1', 'claude/agt_1', 'idle')",
  );
  run(
    "insert into runs (id, agent_id, status) values ('run_1', 'agt_1', 'running')",
  );
};

const insertEvent = (type = "run.started") =>
  Number(
    run(
      "insert into events (run_id, ts, type, payload) values ('run_1', '2026-10-29T12:00:00.000Z', ?, '{}')",
      type,
    ).lastInsertRowid,
  );

test("openDb sets WAL, foreign keys and a busy timeout on the connection", () => {
  const pragma = (name: string) => db.$client.pragma(name, { simple: true });
  expect(pragma("journal_mode")).toBe("wal");
  expect(pragma("foreign_keys")).toBe(1);
  expect(pragma("busy_timeout")).toBe(5000);
});

const TABLES = [
  "agents",
  "api_keys",
  "claude_limits",
  "environments",
  "events",
  "run_env_vars",
  "run_requests",
  "runs",
  "secrets",
  "webhook_deliveries",
  "webhooks",
];

const userTables = () =>
  db.$client
    .prepare(
      "select name, strict from pragma_table_list where schema = 'main' and type = 'table' and name not like 'sqlite_%' and name not like '__drizzle_%' order by name",
    )
    .all() as { name: string; strict: number }[];

test("migrate creates every table on a fresh file, and a second migrate is a no-op", () => {
  migrate(db);
  expect(userTables().map((t) => t.name)).toEqual(TABLES);

  const changesBefore = db.$client.prepare("select total_changes() n").get();
  migrate(db);
  expect(db.$client.prepare("select total_changes() n").get()).toEqual(
    changesBefore,
  );
});

test("every table is STRICT, so a wrong-typed value is rejected", () => {
  migrate(db);
  expect(userTables().filter((t) => t.strict !== 1)).toEqual([]);

  seedRun();
  expect(() =>
    run("update environments set concurrency = 'three' where id = 'env_1'"),
  ).toThrow(/cannot store TEXT value in INTEGER column/);
});

test("event ids are monotonic and never reused after a delete", () => {
  migrate(db);
  seedRun();
  const first = insertEvent();
  const second = insertEvent();
  run("delete from events where id = ?", second);
  expect(insertEvent()).toBeGreaterThan(second);
  expect(second).toBeGreaterThan(first);
});

test("status and type columns accept exactly the shared enums", () => {
  migrate(db);
  seedRun();
  const accepts = (stmt: string, values: readonly string[]) => {
    for (const v of values) expect(() => run(stmt, v)).not.toThrow();
    expect(() => run(stmt, "bogus")).toThrow(/CHECK constraint failed/);
  };
  accepts("update environments set status = ?", EnvironmentStatus.options);
  accepts("update agents set status = ?", AgentStatus.options);
  accepts("update runs set status = ?", RunStatus.options);
  accepts(
    "insert into events (run_id, ts, type, payload) values ('run_1', '2026-10-29T12:00:00Z', ?, '{}')",
    EventType.options,
  );
});

test("events take claude.* hook types and run.resumed, and reject the retired run.progress", () => {
  migrate(db);
  seedRun();
  expect(insertEvent("claude.PostToolUse")).toBeGreaterThan(0);
  expect(insertEvent("run.resumed")).toBeGreaterThan(0);
  expect(() => insertEvent("run.progress")).toThrow(/CHECK constraint failed/);
  expect(() => insertEvent("claude.CwdChanged")).toThrow(
    /CHECK constraint failed/,
  );
});

test("events take run.probed, runner.warning and runner.heartbeat, and still reject an unknown type", () => {
  migrate(db);
  seedRun();
  expect(insertEvent("run.probed")).toBeGreaterThan(0);
  expect(insertEvent("runner.warning")).toBeGreaterThan(0);
  expect(insertEvent("runner.heartbeat")).toBeGreaterThan(0);
  expect(() => insertEvent("runner.error")).toThrow(
    /CHECK constraint failed: events_type/,
  );
});

test("foreign keys are enforced after migrate", () => {
  migrate(db);
  expect(() =>
    run(
      "insert into agents (id, env_id, branch, status) values ('agt_2', 'env_missing', 'claude/agt_2', 'idle')",
    ),
  ).toThrow(/FOREIGN KEY constraint failed/);
});

test("secrets hold a kind, a connector or ciphertext, nonce and key version, with no plaintext column", () => {
  migrate(db);
  const columns = db.$client
    .prepare("select name from pragma_table_info('secrets') order by cid")
    .all()
    .map((c) => (c as { name: string }).name);
  expect(columns).toEqual([
    "env_id",
    "name",
    "kind",
    "connector",
    "ciphertext",
    "nonce",
    "key_version",
  ]);
});

test("migrate refuses a file migrated by newer code", () => {
  migrate(db);
  run(
    "insert into __drizzle_migrations (hash, created_at) values ('from-a-newer-build', ?)",
    Date.now() + 86_400_000,
  );
  expect(() => migrate(db)).toThrow(/newer/);
});

// a copy of the migrations folder whose journal stops after `tag`, to build a file as an older release left it
const migrateThrough = (tag: string) => {
  const folder = join(dir, "drizzle");
  cpSync(new URL("../drizzle", import.meta.url), folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  const end = journal.entries.findIndex((e: { tag: string }) => e.tag === tag);
  journal.entries = journal.entries.slice(0, end + 1);
  writeFileSync(journalPath, JSON.stringify(journal));
  drizzleMigrate(db, { migrationsFolder: folder });
};

const count = (table: string) =>
  (db.$client.prepare(`select count(*) n from ${table}`).get() as { n: number })
    .n;

test("migrating a populated 0000 file keeps every row, cascade children included", () => {
  migrateThrough("0000_init");
  seedRun();
  insertEvent();
  run(
    "insert into secrets (env_id, name, ciphertext, nonce, key_version) values ('env_1', 'K', x'00', x'00', 1)",
  );
  run(
    "insert into webhooks (id, url, event_types) values ('wh_1', 'https://x', '[\"run.started\"]')",
  );

  migrate(db);

  const atInit = TABLES.filter(
    (t) =>
      t !== "webhook_deliveries" &&
      t !== "run_requests" &&
      t !== "run_env_vars" &&
      t !== "api_keys" &&
      t !== "claude_limits",
  );
  for (const table of atInit) expect([table, count(table)]).toEqual([table, 1]);
  const createdAt = db.$client
    .prepare("select created_at from environments")
    .pluck()
    .get();
  expect(createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("environment failure columns accept the provisioning steps and stderr up to 4000 chars", () => {
  migrate(db);
  seedRun();
  const fail = (step: string, stderr: string) =>
    run(
      "update environments set failure_step = ?, failure_stderr = ?",
      step,
      stderr,
    );
  for (const step of ["create", "clone", "setup", "checkpoint"])
    expect(() => fail(step, "x".repeat(4000))).not.toThrow();
  expect(() => fail("deploy", "")).toThrow(/CHECK constraint failed/);
  expect(() => fail("setup", "x".repeat(4001))).toThrow(
    /CHECK constraint failed/,
  );
});

test("environment names are unique", () => {
  migrate(db);
  seedRun();
  expect(() =>
    run(
      "insert into environments (id, name, repo, setup, status, sprite_name) values ('env_2', 'e', 'o/r', '', 'ready', 's')",
    ),
  ).toThrow(/UNIQUE constraint failed: environments.name/);
});

test("created_at is stamped as UTC ISO-8601 and rejects any other form", () => {
  migrate(db);
  seedRun();
  for (const table of ["environments", "agents", "runs"]) {
    const at = db.$client
      .prepare(`select created_at from ${table}`)
      .pluck()
      .get();
    expect(new Date(at as string).toISOString()).toBe(at);
    expect(() =>
      run(`update ${table} set created_at = '2026-10-29 12:00:00'`),
    ).toThrow(/CHECK constraint failed/);
  }
  expect(() =>
    run(
      "insert into webhooks (id, url, event_types, created_at) values ('wh_1', 'https://x', '[\"run.started\"]', 'yesterday')",
    ),
  ).toThrow(/CHECK constraint failed/);
});

test("drizzle inserts stamp created_at without the caller passing it", () => {
  migrate(db);
  db.insert(webhooks)
    .values({
      id: "wh_1" as WebhookId,
      url: "https://x",
      eventTypes: ["run.started"],
    })
    .run();
  const [row] = db.select().from(webhooks).all();
  expect(row?.createdAt).toMatch(/Z$/);
});

const seedDelivery = () => {
  seedRun();
  insertEvent();
  run(
    "insert into webhooks (id, url, event_types) values ('wh_1', 'https://x', '[\"run.started\"]')",
  );
};

const insertDelivery = (...extra: [column: string, value: unknown][]) =>
  run(
    `insert into webhook_deliveries (webhook_id, event_id, status, next_attempt_at${extra.map(([c]) => `, ${c}`).join("")}) values ('wh_1', 1, 'pending', '2026-10-29T12:00:00.000Z'${extra.map(() => ", ?").join("")})`,
    ...extra.map(([, v]) => v),
  );

test("an event is delivered at most once per webhook", () => {
  migrate(db);
  seedDelivery();
  insertDelivery();
  expect(() => insertDelivery()).toThrow(
    /UNIQUE constraint failed: webhook_deliveries.webhook_id, webhook_deliveries.event_id/,
  );
});

test("deleting a webhook drops its deliveries; an event with deliveries can't be deleted", () => {
  migrate(db);
  seedDelivery();
  insertDelivery();
  expect(() => run("delete from events")).toThrow(
    /FOREIGN KEY constraint failed/,
  );
  run("delete from webhooks");
  expect(count("webhook_deliveries")).toBe(0);
});

test("delivery columns reject values outside their contract", () => {
  migrate(db);
  seedDelivery();
  insertDelivery();
  const set = (assignment: string, value: unknown) =>
    run(`update webhook_deliveries set ${assignment} = ?`, value);
  for (const status of deliveryStatuses)
    expect(() => set("status", status)).not.toThrow();
  expect(() => set("status", "retrying")).toThrow(/CHECK constraint failed/);
  expect(() => set("attempts", -1)).toThrow(/CHECK constraint failed/);
  expect(() => set("next_attempt_at", "2026-10-29 12:00:00")).toThrow(
    /CHECK constraint failed/,
  );
  expect(() => set("last_status", 503)).not.toThrow();
  expect(() => set("last_status", 0)).toThrow(/CHECK constraint failed/);
  expect(() => set("last_error", "x".repeat(1000))).not.toThrow();
  expect(() => set("last_error", "x".repeat(1001))).toThrow(
    /CHECK constraint failed/,
  );
});

test("a drizzle insert starts a delivery at zero attempts with a stamped created_at", () => {
  migrate(db);
  seedDelivery();
  db.insert(webhookDeliveries)
    .values({
      webhookId: "wh_1" as WebhookId,
      eventId: 1,
      status: "pending",
      nextAttemptAt: "2026-10-29T12:00:00.000Z",
    })
    .run();
  const [row] = db.select().from(webhookDeliveries).all();
  expect(row).toMatchObject({ attempts: 0, lastStatus: null, lastError: null });
  expect(row?.createdAt).toMatch(/Z$/);
});

test("the due-pending scan is served by the status, next_attempt_at index", () => {
  migrate(db);
  const plan = db.$client
    .prepare(
      "explain query plan select id from webhook_deliveries where status = 'pending' and next_attempt_at <= ? order by next_attempt_at",
    )
    .all("2026-10-29T12:00:00.000Z") as { detail: string }[];
  expect(plan.map((p) => p.detail).join("\n")).toMatch(
    /USING (COVERING )?INDEX webhook_deliveries_status_next_attempt_at \(status=\? AND next_attempt_at<\?\)/,
  );
});

test("migrating a populated 0002 file adds an empty deliveries table and keeps every row", () => {
  migrateThrough("0002_remarkable_bishop");
  seedDelivery();

  migrate(db);

  for (const table of ["events", "webhooks"]) expect(count(table)).toBe(1);
  expect(count("webhook_deliveries")).toBe(0);
});

const question = (id: string) =>
  JSON.stringify({ kind: "question", requestId: id, prompt: "which branch?" });

const insertRequest = (id: string, request = question(id), kind = "question") =>
  run(
    "insert into run_requests (id, run_id, kind, request) values (?, 'run_1', ?, ?)",
    id,
    kind,
    request,
  );

const decide = (id: string, decision: unknown, decidedAt: unknown) =>
  run(
    "update run_requests set decision = ?, decided_at = ? where id = ?",
    decision,
    decidedAt,
    id,
  );

const answer = (id: string) =>
  JSON.stringify({ requestId: id, decision: "answer", answer: "main" });

test("a run has at most one undecided request; deciding it frees the slot", () => {
  migrate(db);
  seedRun();
  insertRequest("req_1");
  expect(() => insertRequest("req_2")).toThrow(
    /UNIQUE constraint failed: run_requests.run_id/,
  );
  decide("req_1", answer("req_1"), "2026-10-29T12:00:00.000Z");
  expect(() => insertRequest("req_2")).not.toThrow();
});

test("decision and decided_at are set together, and the decision names its request", () => {
  migrate(db);
  seedRun();
  insertRequest("req_1");
  expect(() => decide("req_1", answer("req_1"), null)).toThrow(
    /CHECK constraint failed: run_requests_decided/,
  );
  expect(() => decide("req_1", null, "2026-10-29T12:00:00.000Z")).toThrow(
    /CHECK constraint failed: run_requests_decided/,
  );
  expect(() =>
    decide("req_1", answer("req_other"), "2026-10-29T12:00:00.000Z"),
  ).toThrow(/CHECK constraint failed: run_requests_decision/);
  expect(() => decide("req_1", "not json", "2026-10-29T12:00:00.000Z")).toThrow(
    /CHECK constraint failed: run_requests_decision/,
  );
  expect(() => decide("req_1", answer("req_1"), "2026-10-29 12:00")).toThrow(
    /CHECK constraint failed: run_requests_decided_at/,
  );
});

test("a request's kind and id match its stored PendingRequest", () => {
  migrate(db);
  seedRun();
  const approval = JSON.stringify({
    kind: "approval",
    requestId: "req_1",
    toolName: "Bash",
    toolSummary: "rm -rf build",
  });
  const valid = { question: question("req_1"), approval };
  for (const kind of requestKinds) {
    expect(() => insertRequest("req_1", valid[kind], kind)).not.toThrow();
    run("delete from run_requests");
  }
  expect(() => insertRequest("req_1", approval, "question")).toThrow(
    /CHECK constraint failed: run_requests_request/,
  );
  expect(() => insertRequest("req_1", question("req_2"))).toThrow(
    /CHECK constraint failed: run_requests_request/,
  );
  expect(() => insertRequest("req_1", "[]")).toThrow(
    /CHECK constraint failed: run_requests_request/,
  );
  expect(() => insertRequest("req_1", question("req_1"), "bogus")).toThrow(
    /CHECK constraint failed/,
  );
});

test("a request needs an existing run, and pins the run against deletion", () => {
  migrate(db);
  seedRun();
  expect(() =>
    run(
      "insert into run_requests (id, run_id, kind, request) values ('req_1', 'run_missing', 'question', ?)",
      question("req_1"),
    ),
  ).toThrow(/FOREIGN KEY constraint failed/);
  insertRequest("req_1");
  expect(() => run("delete from runs")).toThrow(
    /FOREIGN KEY constraint failed/,
  );
});

test("drizzle round-trips the request and decision as parsed objects", () => {
  migrate(db);
  seedRun();
  const requestId = "req_1" as RequestId;
  db.insert(runRequests)
    .values({
      id: requestId,
      runId: "run_1" as RunId,
      kind: "approval",
      request: {
        kind: "approval",
        requestId,
        toolName: "Bash",
        toolSummary: "ls",
      },
    })
    .run();
  const [open] = db.select().from(runRequests).all();
  expect(open).toMatchObject({ decision: null, decidedAt: null });
  expect(open?.request).toEqual({
    kind: "approval",
    requestId,
    toolName: "Bash",
    toolSummary: "ls",
  });
  expect(open?.createdAt).toMatch(/Z$/);

  db.update(runRequests)
    .set({
      decision: { requestId, decision: "deny", reason: "no" },
      decidedAt: "2026-10-29T12:00:00.000Z",
    })
    .run();
  const [decided] = db.select().from(runRequests).all();
  expect(decided?.decision).toEqual({
    requestId,
    decision: "deny",
    reason: "no",
  });
});

test("the run's open request is found through the partial unique index", () => {
  migrate(db);
  const plan = db.$client
    .prepare(
      "explain query plan select * from run_requests where run_id = ? and decided_at is null",
    )
    .all("run_1") as { detail: string }[];
  expect(plan.map((p) => p.detail).join("\n")).toMatch(
    /USING INDEX run_requests_run_id_(open|decided_at) \(run_id=\?/,
  );
});

test("migrating a populated 0003 file adds an empty run_requests table and keeps every row", () => {
  migrateThrough("0003_nosy_miek");
  seedRun();
  insertEvent();

  migrate(db);

  for (const table of ["runs", "events"]) expect(count(table)).toBe(1);
  expect(count("run_requests")).toBe(0);
});

test("drizzle round-trips a run's rollup as a parsed object, null until set", () => {
  migrate(db);
  seedRun();
  const [before] = db.select().from(runs).all();
  expect(before?.rollup).toBeNull();

  const sha = "a".repeat(40);
  const rollup: RunRollup = {
    base: sha,
    run: {
      commits: [{ sha, subject: "fix" }],
      files: 2,
      added: 10,
      removed: 3,
    },
    cumulative: { commits: [], files: 0, added: 0, removed: 0 },
  };
  db.update(runs).set({ rollup }).run();
  const [after] = db.select().from(runs).all();
  expect(after?.rollup).toEqual(rollup);
});

test("migrating a populated 0004 file adds a null rollup to every run and keeps every row", () => {
  migrateThrough("0004_perpetual_hellion");
  seedRun();
  insertEvent();

  migrate(db);

  for (const table of ["runs", "events"]) expect(count(table)).toBe(1);
  expect(db.$client.prepare("select rollup from runs").get()).toEqual({
    rollup: null,
  });
});

const insertSecret = (
  name: string,
  kind: string,
  connector: string | null,
  sealed: boolean,
) =>
  run(
    "insert into secrets (env_id, name, kind, connector, ciphertext, nonce, key_version) values ('env_1', ?, ?, ?, ?, ?, ?)",
    name,
    kind,
    connector,
    sealed ? Buffer.from([1]) : null,
    sealed ? Buffer.from([2]) : null,
    sealed ? 1 : null,
  );

test("a value secret carries ciphertext, nonce and key version; a connector secret carries only its connector", () => {
  migrate(db);
  seedRun();
  expect(secretKinds).toEqual(["value", "connector"]);
  expect(() => insertSecret("A", "value", null, true)).not.toThrow();
  expect(() => insertSecret("B", "connector", "github", false)).not.toThrow();

  for (const [kind, connector, sealed] of [
    ["value", null, false],
    ["value", "github", true],
    ["connector", null, false],
    ["connector", "", false],
    ["connector", "github", true],
    ["bogus", null, true],
  ] as const) {
    expect(() => insertSecret("C", kind, connector, sealed)).toThrow(
      /CHECK constraint failed/,
    );
  }
  expect(() =>
    run(
      "insert into secrets (env_id, name, kind, connector, ciphertext, nonce, key_version) values ('env_1', 'D', 'value', null, x'01', null, 1)",
    ),
  ).toThrow(/CHECK constraint failed/);
});

test("secret names follow the env-var rule", () => {
  migrate(db);
  seedRun();
  for (const name of ["A", "_x", "API_KEY_2", "a1"])
    expect(() => insertSecret(name, "value", null, true)).not.toThrow();
  for (const name of ["", "1A", "A-B", "A B", "A.B", "\u00e9"])
    expect(() => insertSecret(name, "value", null, true)).toThrow(
      /CHECK constraint failed/,
    );
});

test("migrating a populated 0005 file keeps every secret as a value secret", () => {
  migrateThrough("0005_silky_changeling");
  seedRun();
  insertEvent();
  run(
    "insert into secrets (env_id, name, ciphertext, nonce, key_version) values ('env_1', 'K', x'0a', x'0b', 2)",
  );

  migrate(db);

  for (const table of ["environments", "runs", "events"])
    expect(count(table)).toBe(1);
  expect(db.$client.prepare("select * from secrets").all()).toEqual([
    {
      env_id: "env_1",
      name: "K",
      kind: "value",
      connector: null,
      ciphertext: Buffer.from([0x0a]),
      nonce: Buffer.from([0x0b]),
      key_version: 2,
    },
  ]);
});

const insertEnvVar = (
  name: string,
  expiresAt = "2026-10-30T12:00:00.000Z",
  keyVersion = 1,
) =>
  run(
    "insert into run_env_vars (run_id, name, ciphertext, nonce, key_version, expires_at) values ('run_1', ?, x'01', x'02', ?, ?)",
    name,
    keyVersion,
    expiresAt,
  );

test("a run's envVars are unique by name, follow the env-var rule, and need a positive key version and UTC expiry", () => {
  migrate(db);
  seedRun();
  expect(() => insertEnvVar("TOKEN")).not.toThrow();
  expect(() => insertEnvVar("TOKEN")).toThrow(/UNIQUE constraint failed/);
  for (const name of ["", "1A", "A-B"])
    expect(() => insertEnvVar(name)).toThrow(/CHECK constraint failed/);
  expect(() => insertEnvVar("K0", undefined, 0)).toThrow(
    /CHECK constraint failed/,
  );
  expect(() => insertEnvVar("K1", "2026-10-30 12:00:00")).toThrow(
    /CHECK constraint failed/,
  );
  expect(() =>
    run(
      "insert into run_env_vars (run_id, name, ciphertext, nonce, key_version, expires_at) values ('run_missing', 'X', x'01', x'02', 1, '2026-10-30T12:00:00Z')",
    ),
  ).toThrow(/FOREIGN KEY constraint failed/);
});

test("drizzle round-trips an envVar with a stamped created_at", () => {
  migrate(db);
  seedRun();
  db.insert(runEnvVars)
    .values({
      runId: "run_1" as RunId,
      name: "TOKEN",
      ciphertext: Buffer.from([1]),
      nonce: Buffer.from([2]),
      keyVersion: 1,
      expiresAt: "2026-10-30T12:00:00.000Z",
    })
    .run();
  const [row] = db.select().from(runEnvVars).all();
  expect(row).toMatchObject({
    runId: "run_1",
    name: "TOKEN",
    ciphertext: Buffer.from([1]),
    keyVersion: 1,
  });
  expect(row?.createdAt).toMatch(/Z$/);
});

test("deleting a run drops its envVars", () => {
  migrate(db);
  seedRun();
  insertEnvVar("TOKEN");
  run("delete from runs where id = 'run_1'");
  expect(count("run_env_vars")).toBe(0);
});

test("the expiry purge scan is served by the expires_at index", () => {
  migrate(db);
  const plan = db.$client
    .prepare(
      "explain query plan delete from run_env_vars where expires_at <= ?",
    )
    .all("2026-10-30T12:00:00.000Z")
    .map((r) => (r as { detail: string }).detail)
    .join("\n");
  expect(plan).toMatch(/USING (COVERING )?INDEX run_env_vars_expires_at/);
});

test("a run's secret_names audit round-trips through drizzle and is null on migrated runs", () => {
  migrateThrough("0005_silky_changeling");
  seedRun();
  migrate(db);
  const [before] = db.select().from(runs).all();
  expect(before?.secretNames).toBeNull();

  db.update(runs)
    .set({ secretNames: ["GITHUB_TOKEN", "API_KEY"] })
    .run();
  const [after] = db.select().from(runs).all();
  expect(after?.secretNames).toEqual(["GITHUB_TOKEN", "API_KEY"]);
});

const planOf = (stmt: string, ...params: unknown[]) =>
  (
    db.$client.prepare(`explain query plan ${stmt}`).all(...params) as {
      detail: string;
    }[]
  )
    .map((p) => p.detail)
    .join("\n");

const PRUNE_CUTOFF = "2026-10-23T12:00:00.000Z";

test("the claude.* prune finds old rows through the partial ts index", () => {
  migrate(db);
  expect(
    planOf(
      "select id from events where type glob 'claude.*' and ts < ?",
      PRUNE_CUTOFF,
    ),
  ).toMatch(/USING (COVERING )?INDEX events_claude_ts \(ts<\?\)/);
});

test("the heartbeat prune finds old rows through the partial ts index", () => {
  migrate(db);
  expect(
    planOf(
      "select id from events where type = 'runner.heartbeat' and ts < ?",
      PRUNE_CUTOFF,
    ),
  ).toMatch(/USING (COVERING )?INDEX events_heartbeat_ts \(ts<\?\)/);
});

test("deleting deliveries by event finds them through the event_id index", () => {
  migrate(db);
  expect(
    planOf(
      "delete from webhook_deliveries where event_id in (select id from events where type glob 'claude.*' and ts < ?)",
      PRUNE_CUTOFF,
    ),
  ).toMatch(
    /USING (COVERING )?INDEX webhook_deliveries_event_id \(event_id=\?\)/,
  );
});

test("migrating a populated 0006 file keeps every event and delivery, and never reuses a deleted event id", () => {
  migrateThrough("0006_sweet_madame_hydra");
  seedDelivery();
  insertDelivery();
  const tail = insertEvent();
  run("delete from events where id = ?", tail);

  migrate(db);

  expect(count("events")).toBe(1);
  expect(count("webhook_deliveries")).toBe(1);
  expect(insertEvent()).toBeGreaterThan(tail);
});

test("migrating a 0006 file drops run.progress events and their deliveries, keeps the rest, and never reuses the dropped id", () => {
  migrateThrough("0006_sweet_madame_hydra");
  seedDelivery();
  insertDelivery();
  const progress = insertEvent("run.progress");
  run(
    "insert into webhook_deliveries (webhook_id, event_id, status, next_attempt_at) values ('wh_1', ?, 'pending', '2026-10-29T12:00:00.000Z')",
    progress,
  );

  migrate(db);

  expect(db.$client.prepare("select id, type from events").all()).toEqual([
    { id: 1, type: "run.started" },
  ]);
  expect(
    db.$client.prepare("select event_id from webhook_deliveries").all(),
  ).toEqual([{ event_id: 1 }]);
  expect(insertEvent()).toBeGreaterThan(progress);
});

test("migrating a populated 0010 file keeps every event id, payload and delivery, and never reuses a deleted tail id", () => {
  migrateThrough("0010_fixed_gladiator");
  seedDelivery();
  insertDelivery();
  run(
    "insert into events (run_id, ts, type, payload) values ('run_1', '2026-10-29T12:00:01.000Z', 'claude.Message', ?)",
    JSON.stringify({ text: "hi", n: 2 }),
  );
  run(
    "insert into webhook_deliveries (webhook_id, event_id, status, next_attempt_at, attempts, last_status) values ('wh_1', 2, 'delivered', '2026-10-29T12:00:00.000Z', 1, 200)",
  );
  const tail = insertEvent();
  run("delete from events where id = ?", tail);
  const eventsBefore = db.$client
    .prepare("select * from events order by id")
    .all();
  const deliveriesBefore = db.$client
    .prepare("select * from webhook_deliveries order by id")
    .all();

  migrate(db);

  expect(db.$client.prepare("select * from events order by id").all()).toEqual(
    eventsBefore,
  );
  expect(
    db.$client.prepare("select * from webhook_deliveries order by id").all(),
  ).toEqual(deliveriesBefore);
  expect(insertEvent("run.probed")).toBe(tail + 1);
  expect(
    db.$client
      .prepare(
        "select name from sqlite_schema where type = 'index' and tbl_name in ('events', 'webhook_deliveries') and sql is not null order by name",
      )
      .pluck()
      .all(),
  ).toEqual([
    "events_claude_ts",
    "events_heartbeat_ts",
    "events_run_id_id",
    "webhook_deliveries_event_id",
    "webhook_deliveries_status_next_attempt_at",
    "webhook_deliveries_webhook_id_event_id",
  ]);
});

test("an agent round-trips with and without a remoteBranch", () => {
  migrate(db);
  seedRun();
  db.insert(agents)
    .values({
      id: "agt_2" as AgentId,
      envId: "env_1" as EnvironmentId,
      branch: "claude/agt_2",
      status: "idle",
      remoteBranch: "feature/login",
    })
    .run();

  const remoteBranches = db
    .select({ id: agents.id, remoteBranch: agents.remoteBranch })
    .from(agents)
    .orderBy(agents.id)
    .all();
  expect(remoteBranches).toEqual([
    { id: "agt_1", remoteBranch: null },
    { id: "agt_2", remoteBranch: "feature/login" },
  ]);
});

test("migrating a populated 0008 file adds remote_branch as NULL and keeps every agent and run", () => {
  migrateThrough("0008_fearless_stardust");
  seedRun();

  migrate(db);

  expect(
    db.$client.prepare("select id, remote_branch from agents").all(),
  ).toEqual([{ id: "agt_1", remote_branch: null }]);
  expect(count("runs")).toBe(1);
});

const seedKey = (id = "key_1", hash = "a".repeat(64)) =>
  run(
    "insert into api_keys (id, name, key_hash, role, environment_ids) values (?, 'ci', ?, 'runs', '[\"env_1\"]')",
    id,
    hash,
  );

test("api keys hold a unique hash, a known role, an environment id array and UTC revoked/last-used stamps", () => {
  migrate(db);
  seedKey();
  expect(() => seedKey("key_2")).toThrow(/UNIQUE constraint failed/);
  run(
    "insert into api_keys (id, name, key_hash, role, environment_ids) values ('key_3', 'root', 'b', 'admin', '[]')",
  );
  const rejects = (stmt: string, error: RegExp) =>
    expect(() => run(stmt)).toThrow(error);
  rejects("update api_keys set role = 'owner'", /CHECK constraint failed/);
  rejects(
    "update api_keys set environment_ids = '{}'",
    /CHECK constraint failed/,
  );
  rejects("update api_keys set environment_ids = null", /NOT NULL/);
  rejects("update api_keys set name = null", /NOT NULL/);
  rejects(
    "update api_keys set revoked_at = '2026-11-12 10:00:00'",
    /CHECK constraint failed/,
  );
  rejects(
    "update api_keys set last_used_at = 'yesterday'",
    /CHECK constraint failed/,
  );
  expect(() =>
    run(
      "update api_keys set revoked_at = '2026-11-12T10:00:00.000Z', last_used_at = '2026-11-12T09:00:00.000Z' where id = 'key_1'",
    ),
  ).not.toThrow();
});

test("an agent or webhook's owner key must exist, and null means an admin created it", () => {
  migrate(db);
  seedRun();
  seedKey();
  run("update agents set owner_key_id = 'key_1'");
  expect(() => run("update agents set owner_key_id = 'key_nope'")).toThrow(
    /FOREIGN KEY constraint failed/,
  );
  run(
    "insert into webhooks (id, url, event_types, owner_key_id) values ('whk_1', 'https://x.test', '[\"run.started\"]', 'key_1')",
  );
  expect(() =>
    run(
      "insert into webhooks (id, url, event_types, owner_key_id) values ('whk_2', 'https://x.test', '[\"run.started\"]', 'key_nope')",
    ),
  ).toThrow(/FOREIGN KEY constraint failed/);
  run(
    "insert into webhooks (id, url, event_types) values ('whk_3', 'https://x.test', '[\"run.started\"]')",
  );
  expect(
    db
      .select({ id: webhooks.id, ownerKeyId: webhooks.ownerKeyId })
      .from(webhooks)
      .orderBy(webhooks.id)
      .all(),
  ).toEqual([
    { id: "whk_1", ownerKeyId: "key_1" },
    { id: "whk_3", ownerKeyId: null },
  ]);
});

test("a key's agents are found through the owner_key_id index", () => {
  migrate(db);
  const plan = db.$client
    .prepare(
      "explain query plan select id from agents where owner_key_id = 'key_1'",
    )
    .all() as { detail: string }[];
  expect(plan.map((p) => p.detail).join("\n")).toMatch(
    /USING (COVERING )?INDEX agents_owner_key_id/,
  );
});

test("migrating a populated 0012 file adds owner_key_id as NULL and keeps every agent, run, webhook and delivery", () => {
  migrateThrough("0012_funny_lady_mastermind");
  seedRun();
  const eventId = insertEvent();
  run(
    "insert into webhooks (id, url, event_types) values ('whk_1', 'https://x.test', '[\"run.started\"]')",
  );
  run(
    "insert into webhook_deliveries (webhook_id, event_id, status, next_attempt_at) values ('whk_1', ?, 'pending', '2026-11-12T00:00:00Z')",
    eventId,
  );

  migrate(db);

  expect(
    db.$client.prepare("select id, owner_key_id from agents").all(),
  ).toEqual([{ id: "agt_1", owner_key_id: null }]);
  expect(
    db.$client.prepare("select id, owner_key_id from webhooks").all(),
  ).toEqual([{ id: "whk_1", owner_key_id: null }]);
  expect(count("runs")).toBe(1);
  expect(count("webhook_deliveries")).toBe(1);
  expect(count("api_keys")).toBe(0);
});
