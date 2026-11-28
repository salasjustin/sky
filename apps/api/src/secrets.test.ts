import { SpritesClient } from "@fly/sprites";
import { agents, type Db, environments, migrate, openDb, runs } from "@sky/db";
import type { AgentId, EnvironmentId, RunId } from "@sky/shared";
import { afterEach, beforeEach, expect, test } from "vitest";
import { mintAgentToken } from "./agent-token.js";
import { createApp } from "./app.js";
import { runEnvVarAad, seal } from "./crypto.js";
import { KnownSecrets, redact } from "./redact.js";
import { spriteNameFor } from "./sprites.js";
import { spritesToken, stubSprites, testConfig } from "./testing/sprites.js";

const apiKey = "k".repeat(40);
const config = testConfig();

let db: Db;
let app: ReturnType<typeof createApp>;
const newApp = () =>
  createApp({
    db,
    config,
    sprites: new SpritesClient(spritesToken),
    log: () => {},
    nudgeDeliveries: () => {},
  });
beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
  stubSprites();
  app = newApp();
});
afterEach(() => {
  if (db.$client.open) db.$client.close();
});

const auth = { Authorization: `Bearer ${apiKey}` };
const json = { ...auth, "Content-Type": "application/json" };

function env(id = "env_secrets"): EnvironmentId {
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
  return id as EnvironmentId;
}

const put = (envId: string, name: string, body: unknown) =>
  app.request(`/v1/environments/${envId}/secrets/${name}`, {
    method: "PUT",
    headers: json,
    body: JSON.stringify(body),
  });

const list = async (envId: string) => {
  const res = await app.request(`/v1/environments/${envId}/secrets`, {
    headers: auth,
  });
  return { status: res.status, body: await res.json() };
};

const rawSecrets = () =>
  db.$client.prepare("select * from secrets order by name").all() as Record<
    string,
    unknown
  >[];

const plaintext = "ghp_plaintext-secret-value-0001";

test("a connector secret's connection id is redacted like any secret value: when set, after a restart, and still once replaced or deleted", async () => {
  const known = KnownSecrets.fromConfig(config);
  const appWith = (secrets: KnownSecrets) =>
    createApp({
      db,
      config,
      sprites: new SpritesClient(spritesToken),
      log: () => {},
      nudgeDeliveries: () => {},
      secrets,
    });
  const live = appWith(known);
  const envId = env();
  const id = "conn_0123456789abcdef";
  const set = (name: string, body: unknown) =>
    live.request(`/v1/environments/${envId}/secrets/${name}`, {
      method: "PUT",
      headers: json,
      body: JSON.stringify(body),
    });
  const scrubbed = (secrets: KnownSecrets) =>
    redact(`gateway/github/${id}/repos/acme/widgets`, secrets.values());

  expect((await set("GITHUB_CONNECTOR", { connector: id })).status).toBe(200);
  expect(scrubbed(known)).toBe("gateway/github/[redacted]/repos/acme/widgets");

  // a restarted API learns it from the stored row
  const restarted = KnownSecrets.fromConfig(config);
  appWith(restarted);
  expect(scrubbed(restarted)).toBe(
    "gateway/github/[redacted]/repos/acme/widgets",
  );

  // set again to another id, then to a value, then deleted: a run started with an earlier id still
  // holds it, and the connector still serves it, so every id stays scrubbed until a restart
  const other = "conn_fedcba9876543210";
  await set("GITHUB_CONNECTOR", { connector: other });
  expect(known.values()).toContain(other);
  expect(known.values()).toContain(id);
  expect((await set("GITHUB_CONNECTOR", { value: plaintext })).status).toBe(
    200,
  );
  expect(
    (
      await live.request(`/v1/environments/${envId}/secrets/GITHUB_CONNECTOR`, {
        method: "DELETE",
        headers: auth,
      })
    ).status,
  ).toBe(204);
  expect(known.values()).toEqual(expect.arrayContaining([id, other]));
  expect(scrubbed(known)).toBe("gateway/github/[redacted]/repos/acme/widgets");

  // a restart forgets the ids no longer stored, as it does replaced values
  const afterDelete = KnownSecrets.fromConfig(config);
  appWith(afterDelete);
  expect(afterDelete.values()).not.toContain(id);
  expect(afterDelete.values()).not.toContain(other);
});

test("PUT of a value answers its name and kind, never the value, and stores no plaintext", async () => {
  const envId = env();
  const res = await put(envId, "GITHUB_TOKEN", { value: plaintext });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ name: "GITHUB_TOKEN", kind: "value" });
  const rows = rawSecrets();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    env_id: envId,
    name: "GITHUB_TOKEN",
    kind: "value",
    connector: null,
    key_version: 1,
  });
  const raw = JSON.stringify(
    rows.map((r) => ({
      ...r,
      ciphertext: (r.ciphertext as Buffer).toString("latin1"),
    })),
  );
  expect(raw).not.toContain(plaintext);
  expect(raw).not.toContain("plaintext");
});

test("GET lists names and kinds in name order, never a value; a connector names its connector", async () => {
  const envId = env();
  await put(envId, "Z_TOKEN", { value: plaintext });
  await put(envId, "A_GITHUB", { connector: "github" });
  expect(await list(envId)).toEqual({
    status: 200,
    body: {
      data: [
        { name: "A_GITHUB", kind: "connector", connector: "github" },
        { name: "Z_TOKEN", kind: "value" },
      ],
    },
  });
});

test("a connector secret stores only its connector name", async () => {
  const envId = env();
  const res = await put(envId, "GH", { connector: "github" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    name: "GH",
    kind: "connector",
    connector: "github",
  });
  expect(rawSecrets()).toEqual([
    {
      env_id: envId,
      name: "GH",
      kind: "connector",
      connector: "github",
      ciphertext: null,
      nonce: null,
      key_version: null,
    },
  ]);
});

test("PUT replaces a secret, value to connector and back, under a fresh nonce", async () => {
  const envId = env();
  await put(envId, "TOKEN", { value: plaintext });
  const nonceOf = (row: Record<string, unknown> | undefined) =>
    row?.nonce as Buffer;
  const firstNonce = nonceOf(rawSecrets()[0]);
  await put(envId, "TOKEN", { connector: "github" });
  expect(rawSecrets()[0]).toMatchObject({ kind: "connector", nonce: null });
  await put(envId, "TOKEN", { value: plaintext });
  const rows = rawSecrets();
  expect(rows).toHaveLength(1);
  expect(nonceOf(rows[0]).equals(firstNonce)).toBe(false);
});

test("DELETE answers 204, then 404 once gone; GET and PUT on an unknown env are 404", async () => {
  const envId = env();
  await put(envId, "TOKEN", { value: plaintext });
  const del = () =>
    app.request(`/v1/environments/${envId}/secrets/TOKEN`, {
      method: "DELETE",
      headers: auth,
    });
  expect((await del()).status).toBe(204);
  expect(rawSecrets()).toEqual([]);
  expect((await del()).status).toBe(404);
  expect((await list("env_missing")).status).toBe(404);
  expect((await put("env_missing", "TOKEN", { value: "x" })).status).toBe(404);
  expect(rawSecrets()).toEqual([]);
});

test.each([
  ["PATH", 400, "reserved_name"],
  ["AGENT_TOKEN", 400, "reserved_name"],
  ["SKY_REFRESH", 400, "reserved_name"],
  ["ENV_FILE", 400, "reserved_name"],
  ["AUTO_APPROVE", 400, "reserved_name"],
  ["1BAD", 400, "invalid_name"],
  ["BAD-NAME", 400, "invalid_name"],
])("PUT of %s is %i %s and stores nothing", async (name, status, code) => {
  const res = await put(env(), name, { value: plaintext });
  expect(res.status).toBe(status);
  expect(await res.json()).toMatchObject({ error: { code } });
  expect(rawSecrets()).toEqual([]);
});

test("a body with both or neither of value and connector is 400", async () => {
  const envId = env();
  for (const body of [{}, { value: "a", connector: "b" }, { value: "" }]) {
    expect((await put(envId, "TOKEN", body)).status).toBe(400);
  }
  expect(rawSecrets()).toEqual([]);
});

test("the secret routes need the API key", async () => {
  const envId = env();
  const res = await app.request(`/v1/environments/${envId}/secrets/TOKEN`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: plaintext }),
  });
  expect(res.status).toBe(401);
  expect((await app.request(`/v1/environments/${envId}/secrets`)).status).toBe(
    401,
  );
  expect(rawSecrets()).toEqual([]);
});

/** A running run on the env, and the event its runner would post carrying `message`. */
function runOn(envId: EnvironmentId) {
  const agentId = "agt_redact" as AgentId;
  const runId = "run_redact" as RunId;
  db.insert(agents)
    .values({
      id: agentId,
      envId,
      branch: `claude/${agentId}`,
      status: "running",
    })
    .run();
  db.insert(runs).values({ id: runId, agentId, status: "running" }).run();
  return (target: typeof app, message: string) =>
    target.request("/internal/events", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mintAgentToken(config.apiKey, runId)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        runId,
        type: "claude.Message",
        payload: { text: message },
      }),
    });
}

const storedEvents = () =>
  JSON.stringify(db.$client.prepare("select * from events").all());

// opaque: no token pattern would catch it, only the registry
const opaque = "opaque-secret-value-0042";

test("a value set at runtime is redacted from an event a runner posts", async () => {
  const envId = env();
  await put(envId, "DB_PASSWORD", { value: opaque });
  const post = runOn(envId);
  expect((await post(app, `connecting with ${opaque}`)).status).toBeLessThan(
    300,
  );
  expect(storedEvents()).not.toContain(opaque);
  expect(storedEvents()).toContain("connecting with [redacted]");
});

test("a value stored before the app started is redacted too", async () => {
  const envId = env();
  await put(envId, "DB_PASSWORD", { value: opaque });
  const post = runOn(envId);
  expect((await post(newApp(), `leaked ${opaque}`)).status).toBeLessThan(300);
  expect(storedEvents()).toContain("leaked [redacted]");
});

const copySealed = (
  fromEnv: string,
  fromName: string,
  toEnv: string,
  toName: string,
) =>
  db.$client
    .prepare(
      `insert into secrets (env_id, name, kind, ciphertext, nonce, key_version)
       select ?, ?, kind, ciphertext, nonce, key_version from secrets where env_id = ? and name = ?`,
    )
    .run(toEnv, toName, fromEnv, fromName);

test.each([
  ["another env", "env_two", "TOKEN"],
  ["another name", "env_one", "OTHER"],
])(
  "a secret's ciphertext copied onto %s refuses to open when the app boots",
  async (_label, toEnv, toName) => {
    const one = env("env_one");
    env("env_two");
    await put(one, "TOKEN", { value: opaque });
    expect(() => newApp()).not.toThrow();

    copySealed(one, "TOKEN", toEnv, toName);

    expect(() => newApp()).toThrow();
  },
);

test("a run envVar's ciphertext copied onto another run or name refuses to open when the app boots", () => {
  const { agentId } = (() => {
    const envId = env();
    const agentId = "agt_vars" as AgentId;
    db.insert(agents)
      .values({
        id: agentId,
        envId,
        branch: "claude/agt_vars",
        status: "running",
      })
      .run();
    return { agentId };
  })();
  for (const id of ["run_one", "run_two"]) {
    db.insert(runs)
      .values({ id: id as RunId, agentId, status: "running" })
      .run();
  }
  const insert = db.$client.prepare(
    "insert into run_env_vars (run_id, name, ciphertext, nonce, key_version, expires_at) values (?, ?, ?, ?, ?, '2099-01-01T00:00:00.000Z')",
  );
  const sealed = seal(
    config.secretEncryptionKey,
    opaque,
    runEnvVarAad("run_one", "VAR"),
  );
  insert.run(
    "run_one",
    "VAR",
    sealed.ciphertext,
    sealed.nonce,
    sealed.keyVersion,
  );
  expect(() => newApp()).not.toThrow();

  insert.run(
    "run_two",
    "VAR",
    sealed.ciphertext,
    sealed.nonce,
    sealed.keyVersion,
  );

  expect(() => newApp()).toThrow();
});
