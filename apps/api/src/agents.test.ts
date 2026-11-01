import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpritesClient } from "@fly/sprites";
import { type Db, environments, migrate, openDb, runs, secrets } from "@sky/db";
import {
  type AgentId,
  BaseProfile,
  type EnvironmentId,
  EVENT_TEXT_MAX,
  type RunId,
  truncationMarker,
} from "@sky/shared";
import { eq } from "drizzle-orm";
import { HttpResponse, http, ws } from "msw";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { server } from "../../../test/msw.js";
import { createApp } from "./app.js";
import { BASE_ENV_NAMES } from "./base-profile.js";
import type { Config } from "./config.js";
import { envSecretAad, seal } from "./crypto.js";
import { failStaleRuns, failUnlaunchedRuns } from "./runs.js";
import { spriteNameFor } from "./sprites.js";
import {
  envFileOf,
  type SpritesWire,
  spritesToken,
  stubSprites,
  testConfig,
} from "./testing/sprites.js";

const bundle = "// runner bundle v1\n";
let dir: string;
let db: Db;
let config: Config;
let logs: string[];
let app: ReturnType<typeof createApp>;
let wire: SpritesWire;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sky-agents-"));
  writeFileSync(join(dir, "runner.mjs"), bundle);
  db = openDb(":memory:");
  migrate(db);
  wire = stubSprites();
  logs = [];
  config = testConfig({
    runnerBundlePath: join(dir, "runner.mjs"),
    baseProfiles: { team },
  });
  app = createApp({
    db,
    config,
    sprites: new SpritesClient(spritesToken),
    log: (line) => logs.push(line),
    nudgeDeliveries: () => {},
    launchWatchMs: 50,
  });
});
afterEach(() => {
  if (db.$client.open) db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

const auth = { Authorization: `Bearer ${testConfig().apiKey}` };
const json = { ...auth, "Content-Type": "application/json" };

/** A provisioned environment whose sprite exists on the stub. */
function readyEnv(
  overrides: Partial<typeof environments.$inferInsert> = {},
): EnvironmentId {
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
      ...overrides,
    })
    .run();
  wire.sprites.add(spriteNameFor(id));
  return id;
}

const launch = (body: unknown) =>
  app.request("/v1/agents", {
    method: "POST",
    headers: json,
    body: JSON.stringify(body),
  });

type Launched = {
  agent: { id: string; branch: string };
  run: { id: string; status: string };
};

const launched = async (envId: string, prompt = "fix the flaky test") => {
  const res = await launch({ envId, prompt });
  expect(res.status).toBe(202);
  return (await res.json()) as Launched;
};

/** Waits until the background launch has opened its runner session. */
const sessionOpened = (count = 1) =>
  vi.waitFor(() => expect(wire.sessions).toHaveLength(count));

test("POST returns 202 with the agent on claude/<agentId> and a starting run", async () => {
  const envId = readyEnv();
  const res = await launch({ envId, prompt: "fix the flaky test" });
  expect(res.status).toBe(202);
  const body = (await res.json()) as Launched;
  const iso = expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
  expect(body).toEqual({
    agent: {
      id: expect.stringMatching(/^agt_[0-9A-Za-z]+$/),
      envId,
      sessionId: null,
      branch: `claude/${body.agent.id}`,
      status: "running",
      createdAt: iso,
      archivedAt: null,
    },
    run: {
      id: expect.stringMatching(/^run_[0-9A-Za-z]+$/),
      agentId: body.agent.id,
      status: "starting",
      summary: null,
      usage: null,
      error: null,
      createdAt: iso,
    },
  });
  expect(res.headers.get("location")).toBe(
    `/v1/agents/${body.agent.id}/runs/${body.run.id}`,
  );
  await sessionOpened();
});

test("launch uploads the bundle, then starts the runner as a detached session and lets go of it", async () => {
  const envId = readyEnv();
  const { agent, run } = await launched(envId);
  await sessionOpened();
  const sprite = spriteNameFor(envId);
  expect(wire.calls).toEqual([
    `exec ${sprite} - sha256sum /opt/sky/runner.mjs`,
    // written beside it, then renamed over it: a node starting on the bundle never reads it half-written
    `write ${sprite} /opt/sky/runner.mjs.${run.id}`,
    `exec ${sprite} - mv -f /opt/sky/runner.mjs.${run.id} /opt/sky/runner.mjs`,
    `write ${sprite} /workspace/runs/${run.id}.prompt`,
    `write ${sprite} /workspace/runs/${run.id}.env`,
    expect.stringMatching(`^session ${sprite} /workspace/repo bash -c `),
  ]);
  expect(new TextDecoder().decode(wire.files.get("/opt/sky/runner.mjs"))).toBe(
    bundle,
  );
  expect(
    new TextDecoder().decode(
      wire.files.get(`/workspace/runs/${run.id}.prompt`),
    ),
  ).toBe("fix the flaky test");

  const [session] = wire.sessions;
  // detachable: the process outlives the socket, which the API closes once the launch window passes
  expect(session).toMatchObject({ detachable: true, tty: true });
  await vi.waitFor(() => expect(wire.openSockets).toBe(0));
  expect(session?.argv.join(" ")).toContain("exec node /opt/sky/runner.mjs");
  expect(session?.env).toEqual({
    AGENT_ID: agent.id,
    RUN_ID: run.id,
    API_BASE_URL: config.publicBaseUrl,
    ENV_FILE: `/workspace/runs/${run.id}.env`,
    PROMPT_FILE: `/workspace/runs/${run.id}.prompt`,
    REPO_DIR: "/workspace/repo",
    WORKTREES_DIR: "/workspace/worktrees",
    APPROVAL_POLICY: "[]",
    AUTO_APPROVE: JSON.stringify({ defaults: true, commands: [] }),
    WAIT_TIMEOUT_MINUTES: "120",
  });
  // the secrets ride in a file only the sprite user can read, which the command sources and deletes
  expect(envFileOf(wire, session)).toEqual({
    CLAUDE_CODE_OAUTH_TOKEN: config.claudeOauthToken,
    AGENT_TOKEN: expect.any(String),
  });
  expect(wire.modes.get(`/workspace/runs/${run.id}.env`)).toBe("0600");
  expect(session?.argv.join(" ")).toMatch(
    /set -a && \. "\$ENV_FILE" && set \+a && rm -f "\$ENV_FILE" && /,
  );
});

test("the runner, and so its agent's shell, finds the pnpm provisioning enabled under ~/.local/bin", async () => {
  await launched(readyEnv());
  await sessionOpened();
  const session = wire.sessions[0];
  if (!session) throw new Error("no session");
  // runs the session's command locally, where a stub node prints what pnpm resolves to, as an agent's shell would
  writeFileSync(join(dir, "node"), "#!/bin/sh\ncommand -v pnpm\n", {
    mode: 0o755,
  });
  mkdirSync(join(dir, ".local/bin"), { recursive: true });
  writeFileSync(join(dir, ".local/bin/pnpm"), "#!/bin/sh\n", { mode: 0o755 });
  const local = (path: string) => {
    const at = join(dir, path.replaceAll("/", "_"));
    writeFileSync(at, wire.files.get(path) ?? "");
    return at;
  };
  const out = spawnSync(session.argv[0] ?? "", session.argv.slice(1), {
    env: {
      ...session.env,
      ENV_FILE: local(session.env.ENV_FILE ?? ""),
      PROMPT_FILE: local(session.env.PROMPT_FILE ?? ""),
      HOME: dir,
      PATH: `${dir}:/usr/bin:/bin`,
    },
    encoding: "utf8",
    timeout: 10_000,
  });
  expect({ stdout: out.stdout, stderr: out.stderr }).toEqual({
    stdout: `${dir}/.local/bin/pnpm\n`,
    stderr: "",
  });
});

test("the runner gets the env's approval policy as a JSON array", async () => {
  await launched(readyEnv({ approvalPolicy: ["Bash", "mcp__github__*"] }));
  await sessionOpened();
  expect(wire.sessions[0]?.env.APPROVAL_POLICY).toBe(
    '["Bash","mcp__github__*"]',
  );
});

test("the runner gets the env's auto-approve overrides as JSON", async () => {
  const autoApprove = { defaults: false, commands: ["make check"] };
  await launched(readyEnv({ autoApprove }));
  await sessionOpened();
  expect(wire.sessions[0]?.env.AUTO_APPROVE).toBe(JSON.stringify(autoApprove));
});

test("a secret stored under a reserved name never reaches the runner, so the env's auto-approve setting holds", async () => {
  const envId = readyEnv({ autoApprove: { defaults: false, commands: [] } });
  // PUT refuses the name; this is a row written before it was reserved
  db.insert(secrets)
    .values({
      envId,
      name: "AUTO_APPROVE",
      kind: "value",
      connector: null,
      ...seal(
        config.secretEncryptionKey,
        '{"defaults":true,"commands":["rm"]}',
        envSecretAad(envId, "AUTO_APPROVE"),
      ),
    })
    .run();
  const { agent, run } = await launched(envId);
  await sessionOpened();
  expect(envFileOf(wire, wire.sessions[0])).not.toHaveProperty("AUTO_APPROVE");
  expect(wire.sessions[0]?.env.AUTO_APPROVE).toBe(
    JSON.stringify({ defaults: false, commands: [] }),
  );
  await vi.waitFor(async () =>
    expect((await getRun(agent.id, run.id)).body.secretNames).toEqual([]),
  );
  expect(logs.join("\n")).toContain(
    `secret AUTO_APPROVE on ${envId} is reserved by sky; not passed to ${run.id}`,
  );
});

const team = BaseProfile.parse({
  storeRepo: "acme/store",
  storeLayout: { home: ".store" },
  sessionEnv: { PLUGIN_SWITCH: "1" },
  checks: ["run the linter", "update the changelog"],
});

const BASE_NAMES = [
  "SKY_STORE_REPO",
  "SKY_STORE_HOME",
  "SKY_STORE_LAYOUT",
  "SKY_SESSION_ENV",
  "SKY_CHECKS",
];
const profileEnv: Record<string, string> = {
  SKY_STORE_REPO: "acme/store",
  SKY_STORE_HOME: ".store",
  SKY_STORE_LAYOUT: JSON.stringify(team.storeLayout),
  SKY_SESSION_ENV: '{"PLUGIN_SWITCH":"1"}',
  SKY_CHECKS: '["run the linter","update the changelog"]',
};

const putSecret = (envId: string, name: string, body: unknown) =>
  app.request(`/v1/environments/${envId}/secrets/${name}`, {
    method: "PUT",
    headers: json,
    body: JSON.stringify(body),
  });

test("the env's secrets reach the runner through the env file, quotes intact; a connector as its connection id", async () => {
  const envId = readyEnv();
  const tricky = `it's "quoted" $HOME \`x\`\nline two`;
  expect((await putSecret(envId, "TRICKY", { value: tricky })).status).toBe(
    200,
  );
  expect(
    (await putSecret(envId, "DB_URL", { value: "postgres://u:p@db/x" })).status,
  ).toBe(200);
  expect(
    (await putSecret(envId, "GITHUB_CONNECTOR", { connector: "VPpb7x" }))
      .status,
  ).toBe(200);
  const { agent, run } = await launched(envId);
  await sessionOpened();
  const session = wire.sessions[0];
  expect(envFileOf(wire, session)).toEqual({
    TRICKY: tricky,
    DB_URL: "postgres://u:p@db/x",
    GITHUB_CONNECTOR: "VPpb7x",
    CLAUDE_CODE_OAUTH_TOKEN: config.claudeOauthToken,
    AGENT_TOKEN: expect.any(String),
  });
  expect(session?.env).not.toHaveProperty("DB_URL");
  expect(wire.execUrls.map(decodeURIComponent).join("\n")).not.toContain(
    "postgres://u:p@db/x",
  );
  await vi.waitFor(async () =>
    expect((await getRun(agent.id, run.id)).body.secretNames).toEqual([
      "DB_URL",
      "GITHUB_CONNECTOR",
      "TRICKY",
    ]),
  );
});

const connect = async (envId: string) =>
  expect(
    (await putSecret(envId, "GITHUB_CONNECTOR", { connector: "VPpb7x" }))
      .status,
  ).toBe(200);

test("an env with a base profile and a GITHUB_CONNECTOR connector gives every session the profile's store, session variables and checks", async () => {
  const envId = readyEnv({ base: "team" });
  await connect(envId);
  await launched(envId);
  await sessionOpened();
  expect(envFileOf(wire, wire.sessions[0])).toMatchObject({
    SKY_STORE_REPO: "acme/store",
    SKY_STORE_HOME: ".store",
    SKY_STORE_LAYOUT: JSON.stringify(team.storeLayout),
    SKY_SESSION_ENV: '{"PLUGIN_SWITCH":"1"}',
    SKY_CHECKS: '["run the linter","update the changelog"]',
  });
});

test.each(BASE_NAMES)(
  "a secret named %s is refused, since the profile fills it",
  async (name) => {
    const envId = readyEnv({ base: "team" });
    const res = await putSecret(envId, name, { value: "someone/else" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: "reserved_name" },
    });
  },
);

test.each(BASE_NAMES)(
  "a launch's envVars cannot set %s, which the profile fills",
  async (name) => {
    const envId = readyEnv({ base: "team" });
    await connect(envId);
    const res = await launch({
      envId,
      prompt: "go",
      envVars: { [name]: "someone/else" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: "reserved_name", message: `${name} is reserved by sky` },
    });
    expect(db.$client.prepare("select count(*) n from runs").get()).toEqual({
      n: 0,
    });
  },
);

/** A row written before the name was reserved; PUT refuses it now. */
const seedLegacySecret = (
  envId: `env_${string}`,
  name: string,
  value: string,
) =>
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

test.each(BASE_NAMES)(
  "a stored %s secret never overrides the profile's value, and the log says it was dropped",
  async (name) => {
    const envId = readyEnv({ base: "team" });
    await connect(envId);
    seedLegacySecret(envId, name, "someone/else");
    const { agent, run } = await launched(envId);
    await sessionOpened();
    const file = envFileOf(wire, wire.sessions[0]);
    expect(file[name]).toBe(profileEnv[name]);
    await vi.waitFor(async () =>
      expect((await getRun(agent.id, run.id)).body.secretNames).toEqual([
        "GITHUB_CONNECTOR",
      ]),
    );
    expect(logs.join("\n")).toContain(
      `secret ${name} on ${envId} is reserved by sky; not passed to ${run.id}`,
    );
  },
);

test.each(BASE_NAMES)(
  "a stored %s secret in an env with no base profile reaches no session",
  async (name) => {
    const envId = readyEnv();
    await connect(envId);
    seedLegacySecret(envId, name, "someone/else");
    await launched(envId);
    await sessionOpened();
    expect(envFileOf(wire, wire.sessions[0])).not.toHaveProperty(name);
  },
);

test("a session in an env with no GITHUB_CONNECTOR connector gets no store, but still the profile's variables and checks", async () => {
  const envId = readyEnv({ base: "team" });
  expect(
    (await putSecret(envId, "GITHUB_CONNECTOR", { value: "ghp_pasted" }))
      .status,
  ).toBe(200);
  await launched(envId);
  await sessionOpened();
  const file = envFileOf(wire, wire.sessions[0]);
  expect(file).not.toHaveProperty("SKY_STORE_REPO");
  expect(file).not.toHaveProperty("SKY_STORE_HOME");
  expect(file).toHaveProperty("SKY_CHECKS");
  expect(file).toHaveProperty("SKY_SESSION_ENV");
});

test("an env with no base gets no store, session variables or checks, connector or not", async () => {
  const envId = readyEnv();
  await connect(envId);
  await launched(envId);
  await sessionOpened();
  const file = envFileOf(wire, wire.sessions[0]);
  for (const name of BASE_ENV_NAMES) expect(file).not.toHaveProperty(name);
});

test("an env whose base profile is no longer configured fails the run at launch, naming it, and starts no runner", async () => {
  const envId = readyEnv({ base: "gone" });
  await connect(envId);
  const { agent, run } = await launched(envId);
  await vi.waitFor(async () =>
    expect((await getRun(agent.id, run.id)).body).toMatchObject({
      status: "failed",
      error: expect.stringContaining('base profile "gone"'),
    }),
  );
  expect(wire.sessions).toEqual([]);
});

test("a runner session that fails to open fails the run and deletes the env file it would have sourced", async () => {
  server.use(
    ws
      .link("wss://api.sprites.dev/v1/sprites/:name/exec")
      .addEventListener("connection", ({ client }) => {
        client.close(1011, "upstream unavailable");
      }),
  );
  const envId = readyEnv();
  const { agent, run } = await launched(envId);
  await vi.waitFor(async () =>
    expect((await getRun(agent.id, run.id)).body.status).toBe("failed"),
  );
  expect(wire.calls).toContain(
    `exec ${spriteNameFor(envId)} - rm -f /workspace/runs/${run.id}.env`,
  );
});

test("secrets travel in the env file only: never an exec URL, argv, the run row, an event or the logs", async () => {
  const { run } = await launched(readyEnv());
  await sessionOpened();
  const session = wire.sessions[0];
  const secrets = [
    config.claudeOauthToken,
    envFileOf(wire, session).AGENT_TOKEN ?? "missing",
  ];
  const urls = wire.execUrls.map(decodeURIComponent).join("\n");
  const stored = JSON.stringify([
    db.$client.prepare("select * from runs").all(),
    db.$client.prepare("select * from agents").all(),
    db.$client.prepare("select * from events").all(),
  ]);
  for (const secret of secrets) {
    expect(urls).not.toContain(secret);
    expect(session?.argv.join(" ")).not.toContain(secret);
    expect(stored).not.toContain(secret);
    expect(logs.join("\n")).not.toContain(secret);
  }
  expect(run.status).toBe("starting");
});

test("a sprite already holding the current bundle gets no upload", async () => {
  wire.files.set("/opt/sky/runner.mjs", new TextEncoder().encode(bundle));
  const envId = readyEnv();
  await launched(envId);
  await sessionOpened();
  expect(wire.calls.filter((c) => c.startsWith("write"))).toEqual([
    expect.stringMatching(/\.prompt$/),
    expect.stringMatching(/\.env$/),
  ]);
});

test("two agents on one env get distinct worktrees and branches", async () => {
  const envId = readyEnv();
  const a = await launched(envId);
  const b = await launched(envId);
  await sessionOpened(2);
  expect(a.agent.branch).toBe(`claude/${a.agent.id}`);
  expect(b.agent.branch).toBe(`claude/${b.agent.id}`);
  expect(a.agent.id).not.toBe(b.agent.id);
  const agentIds = wire.sessions.map((s) => s.env.AGENT_ID);
  expect(new Set(agentIds)).toEqual(new Set([a.agent.id, b.agent.id]));
  // the runner derives its worktree from AGENT_ID: <WORKTREES_DIR>/<agentId> on claude/<agentId>
  expect(new Set(wire.sessions.map((s) => s.env.WORKTREES_DIR)).size).toBe(1);
});

test("launching past the env's cap gets a typed 409 naming the cap, and nothing is queued", async () => {
  const envId = readyEnv({ concurrency: 2 });
  await launched(envId);
  await launched(envId);
  const res = await launch({ envId, prompt: "third" });
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({
    error: {
      code: "concurrency_cap",
      message:
        "this environment allows 2 active runs; wait for one to end or stop one",
      limit: 2,
    },
  });
  await sessionOpened(2);
  expect(db.$client.prepare("select count(*) n from runs").get()).toEqual({
    n: 2,
  });
});

test("the default cap is 3", async () => {
  const envId = readyEnv();
  for (let i = 0; i < 3; i++) await launched(envId);
  expect((await launch({ envId, prompt: "fourth" })).status).toBe(409);
  await sessionOpened(3);
});

test.each([
  ["provisioning", 409, "env_not_ready"],
  ["failed", 409, "env_not_ready"],
] as const)("an env that is %s gets %i %s", async (status, code, errCode) => {
  const envId = readyEnv({ status });
  const res = await launch({ envId, prompt: "go" });
  expect(res.status).toBe(code);
  expect(await res.json()).toMatchObject({ error: { code: errCode } });
});

test("an unknown env gets 404", async () => {
  const res = await launch({ envId: "env_nope", prompt: "go" });
  expect(res.status).toBe(404);
});

test.each([
  ["no prompt", { envId: "env_x" }],
  ["an empty prompt", { envId: "env_x", prompt: "" }],
  ["an unknown key", { envId: "env_x", prompt: "go", extra: 1 }],
])("a body with %s gets 400", async (_, body) => {
  expect((await launch(body)).status).toBe(400);
});

test("POST without a bearer gets 401 and launches nothing", async () => {
  const envId = readyEnv();
  const res = await app.request("/v1/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ envId, prompt: "go" }),
  });
  expect(res.status).toBe(401);
  expect(wire.calls).toEqual([]);
});

test("a runner that exits at launch fails the run with its exit code and output tail, redacted", async () => {
  wire.sessionExit = {
    output: `node: bad option: --frobnicate\r\ntoken ${config.claudeOauthToken}\r\n`,
    code: 1,
  };
  const { agent, run } = await launched(readyEnv());
  await vi.waitFor(async () =>
    expect((await getRun(agent.id, run.id)).body.status).toBe("failed"),
  );
  const { error } = (await getRun(agent.id, run.id)).body;
  expect(error).toMatch(/^launch_failed: runner exited 1 at launch: /);
  expect(error).toContain("node: bad option: --frobnicate");
  expect(error).not.toContain(config.claudeOauthToken);
  expect(
    db.$client.prepare("select status from agents where id = ?").get(agent.id),
  ).toEqual({ status: "idle" });
});

test("a runner that outlives the launch window is left running, with an explicit run-after-disconnect", async () => {
  const { agent, run } = await launched(readyEnv());
  await sessionOpened();
  await vi.waitFor(() => expect(wire.openSockets).toBe(0));
  expect(
    new URL(wire.sessions[0]?.url ?? "").searchParams.get(
      "max_run_after_disconnect",
    ),
  ).toBe("24h");
  expect((await getRun(agent.id, run.id)).body.status).toBe("starting");
});

test("a runner exiting 0 inside the launch window leaves its run to its own events", async () => {
  wire.sessionExit = { output: "", code: 0 };
  const { agent, run } = await launched(readyEnv());
  await sessionOpened();
  await vi.waitFor(() => expect(wire.openSockets).toBe(0));
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect((await getRun(agent.id, run.id)).body.status).toBe("starting");
});

test("a launch the sprite rejects fails the run with a redacted error and frees the agent", async () => {
  wire.writeStatus = 500;
  const { agent, run } = await launched(readyEnv());
  await vi.waitFor(() =>
    expect(
      db.$client.prepare("select status from runs where id = ?").get(run.id),
    ).toEqual({ status: "failed" }),
  );
  const res = await app.request(`/v1/agents/${agent.id}/runs/${run.id}`, {
    headers: auth,
  });
  expect(await res.json()).toMatchObject({
    status: "failed",
    error: expect.stringMatching(/^launch_failed: /),
  });
  expect(
    db.$client.prepare("select status from agents where id = ?").get(agent.id),
  ).toEqual({ status: "idle" });
  expect(wire.sessions).toEqual([]);
});

test("a launch whose file write hangs past its bound fails the run with launch_failed naming the timeout", async () => {
  app = createApp({
    db,
    config,
    sprites: new SpritesClient(spritesToken),
    log: (line) => logs.push(line),
    nudgeDeliveries: () => {},
    launchWatchMs: 50,
    spritesTimeoutMs: 300,
  });
  wire.hangs = (call) => call.endsWith(".prompt");
  const envId = readyEnv();
  const sprite = spriteNameFor(envId);
  const { run } = await launched(envId);
  await vi.waitFor(() =>
    expect(runStatus(run.id)).toMatchObject({ status: "failed" }),
  );
  expect(runFailure(run.id)).toBe(
    `launch_failed: sprite ${sprite}: write-prompt timed out after 300 ms`,
  );
  expect(logs).toContain(
    `sprite ${sprite} write-prompt: timed out after 300ms`,
  );
  expect(wire.sessions).toEqual([]);
});

const envRow = (id: string) =>
  db.$client
    .prepare(
      "select status, failure_step as failureStep, failure_stderr as failureStderr from environments where id = ?",
    )
    .get(id);

const runStatus = (id: string) =>
  db.$client.prepare("select status from runs where id = ?").get(id);

// read from the event, since GET on a run reads its diff from the sprite, which is gone
const runFailure = (id: string) =>
  (
    db.$client
      .prepare(
        "select json_extract(payload, '$.error') as error from events where run_id = ? and type = 'run.failed'",
      )
      .get(id) as { error: string } | undefined
  )?.error;

/** Runs `onBundleCheck` when the launch first execs in the sprite, so the sprite can vanish mid-launch. */
const onFirstExec = (onBundleCheck: () => void) => {
  const exec = wire.exec;
  wire.exec = (argv) => {
    if (argv[0] === "sha256sum") onBundleCheck();
    return exec(argv);
  };
};

test("a launch on a sprite that no longer exists fails the run and marks the ready environment failed", async () => {
  const envId = readyEnv();
  wire.sprites.delete(spriteNameFor(envId));
  const { run } = await launched(envId);
  await vi.waitFor(() =>
    expect(envRow(envId)).toMatchObject({
      status: "failed",
      failureStep: "create",
      failureStderr: expect.stringContaining(spriteNameFor(envId)),
    }),
  );
  await vi.waitFor(() =>
    expect(runStatus(run.id)).toMatchObject({ status: "failed" }),
  );
  expect(runFailure(run.id)).toMatch(/^launch_failed: /);
});

test("a sprite that vanishes mid-launch, failing a file write rather than an exec, marks the environment failed", async () => {
  const envId = readyEnv();
  onFirstExec(() => {
    wire.sprites.delete(spriteNameFor(envId));
    wire.writeStatus = 404;
  });
  await launched(envId);
  await vi.waitFor(() =>
    expect(envRow(envId)).toMatchObject({ status: "failed" }),
  );
});

test("a launch that fails on a sprite that still exists fails the run and leaves the environment ready", async () => {
  wire.writeStatus = 404;
  const envId = readyEnv();
  const { run } = await launched(envId);
  await vi.waitFor(() =>
    expect(runStatus(run.id)).toMatchObject({ status: "failed" }),
  );
  expect(wire.calls).toContain(`get ${spriteNameFor(envId)}`);
  expect(envRow(envId)).toMatchObject({
    status: "ready",
    failureStep: null,
    failureStderr: null,
  });
});

test("a missing sprite does not fail an environment that is no longer ready", async () => {
  const envId = readyEnv();
  onFirstExec(() => {
    wire.sprites.delete(spriteNameFor(envId));
    wire.writeStatus = 500;
    db.update(environments)
      .set({ status: "provisioning" })
      .where(eq(environments.id, envId))
      .run();
  });
  const { run } = await launched(envId);
  await vi.waitFor(() =>
    expect(runStatus(run.id)).toMatchObject({ status: "failed" }),
  );
  expect(wire.calls).toContain(`get ${spriteNameFor(envId)}`);
  expect(envRow(envId)).toMatchObject({
    status: "provisioning",
    failureStderr: null,
  });
});

test("a sprite lookup that errors leaves the environment ready and the run failed with the launch's own error", async () => {
  wire.writeStatus = 500;
  server.use(
    http.get("https://api.sprites.dev/v1/sprites/:name", () =>
      HttpResponse.json({ error: "upstream unavailable" }, { status: 503 }),
    ),
  );
  const envId = readyEnv();
  const { agent, run } = await launched(envId);
  await vi.waitFor(() =>
    expect(runStatus(run.id)).toMatchObject({ status: "failed" }),
  );
  expect((await getRun(agent.id, run.id)).body.error).toMatch(
    /^launch_failed: .*write failed/,
  );
  expect(envRow(envId)).toMatchObject({ status: "ready" });
  expect(
    logs.some((line) => line.startsWith("checking whether the sprite of")),
  ).toBe(true);
});

test("retrying an environment failed for its missing sprite recreates the sprite, clears the failure and takes a new run", async () => {
  const envId = readyEnv();
  const sprite = spriteNameFor(envId);
  wire.sprites.delete(sprite);
  const first = await launched(envId);
  await vi.waitFor(() =>
    expect(envRow(envId)).toMatchObject({ status: "failed" }),
  );
  // the lost sprite took the agent's Claude session with it
  db.$client
    .prepare("update agents set session_id = 'sess_gone' where id = ?")
    .run(first.agent.id);
  const res = await app.request(`/v1/environments/${envId}/retry`, {
    method: "POST",
    headers: auth,
  });
  expect(res.status).toBe(202);
  await vi.waitFor(
    () =>
      expect(envRow(envId)).toMatchObject({
        status: "ready",
        failureStep: null,
        failureStderr: null,
      }),
    { timeout: 5000 },
  );
  expect(wire.calls).toContain(`create ${sprite}`);
  expect(
    db.$client
      .prepare("select session_id as sessionId from agents where id = ?")
      .get(first.agent.id),
  ).toEqual({ sessionId: null });
  const second = await launched(envId);
  await sessionOpened();
  expect(wire.sessions[0]?.sprite).toBe(sprite);
  expect(runStatus(second.run.id)).toMatchObject({ status: "starting" });
});

const usage = {
  inputTokens: 1200,
  outputTokens: 340,
  costUsd: 0.04,
  turns: 3,
  durationMs: 41_000,
};

/** Launches a run and returns the agent token its runner was handed. */
async function runningRun(envId = readyEnv()) {
  const before = wire.sessions.length;
  const ids = await launched(envId);
  await sessionOpened(before + 1);
  const token = envFileOf(wire, wire.sessions[before]).AGENT_TOKEN ?? "";
  return { ...ids, envId, token };
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

const getRun = async (agentId: string, runId: string) => {
  const res = await app.request(`/v1/agents/${agentId}/runs/${runId}`, {
    headers: auth,
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
};

test("events from the run's own token advance it: started stores the session, finished the result", async () => {
  const { agent, run, token } = await runningRun();
  const started = await postEvent(token, {
    runId: run.id,
    type: "run.started",
    payload: { sessionId: "sess-1" },
  });
  expect(started.status).toBe(201);
  expect(await started.json()).toEqual({ id: expect.any(Number) });
  expect((await getRun(agent.id, run.id)).body.status).toBe("running");
  expect(
    db.$client.prepare("select session_id, status from agents").get(),
  ).toEqual({ session_id: "sess-1", status: "running" });

  const message = await postEvent(token, {
    runId: run.id,
    type: "claude.Message",
    payload: { text: "reading the test" },
  });
  expect(message.status).toBe(201);
  expect(
    (
      await postEvent(token, {
        runId: run.id,
        type: "run.finished",
        payload: { summary: "fixed the race", usage },
      })
    ).status,
  ).toBe(201);

  expect(
    db.$client.prepare("select type from events order by id").all(),
  ).toEqual([
    { type: "run.started" },
    { type: "claude.Message" },
    { type: "run.finished" },
  ]);
  expect(db.$client.prepare("select status from agents").get()).toEqual({
    status: "idle",
  });
  const { body } = await getRun(agent.id, run.id);
  expect(body).toMatchObject({
    status: "finished",
    summary: "fixed the race",
    usage,
    error: null,
  });
});

const tool = { toolName: "Bash", toolUseId: "tu_1", input: '{"command":"ls"}' };
const task = { taskId: "t1", taskSubject: "write the test" };

test.each([
  ["claude.PreToolUse", tool],
  ["claude.PostToolUse", { ...tool, output: "a.ts", durationMs: 12 }],
  ["claude.PostToolUseFailure", { ...tool, error: "exit 1" }],
  ["claude.SubagentStart", { subagentId: "sa_1", agentType: "Explore" }],
  ["claude.SubagentStop", { subagentId: "sa_1", agentType: "Explore" }],
  ["claude.TaskCreated", task],
  ["claude.TaskCompleted", task],
  ["claude.Notification", { message: "idle", notificationType: "idle_prompt" }],
  ["claude.PreCompact", { trigger: "auto", customInstructions: null }],
  ["claude.FileChanged", { filePath: "src/a.ts", event: "change" }],
  ["claude.Message", { text: "done reading" }],
])(
  "%s is stored as posted and leaves the run running",
  async (type, payload) => {
    const { agent, run, token } = await runningRun();
    await postEvent(token, {
      runId: run.id,
      type: "run.started",
      payload: { sessionId: "s" },
    });
    const res = await postEvent(token, { runId: run.id, type, payload });
    expect(res.status).toBe(201);
    const row = db.$client
      .prepare("select payload from events where type = ?")
      .get(type) as { payload: string };
    expect(JSON.parse(row.payload)).toEqual(payload);
    expect((await getRun(agent.id, run.id)).body.status).toBe("running");
  },
);

const startedRun = async () => {
  const ids = await runningRun();
  await postEvent(ids.token, {
    runId: ids.run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  return ids;
};

const storedOutput = () =>
  (
    JSON.parse(
      (
        db.$client
          .prepare(
            "select payload from events where type = 'claude.PostToolUse'",
          )
          .get() as { payload: string }
      ).payload,
    ) as { output: string }
  ).output;

test("a 10 KB tool output is stored trimmed to EVENT_TEXT_MAX with the truncation marker", async () => {
  const { run, token } = await startedRun();
  const res = await postEvent(token, {
    runId: run.id,
    type: "claude.PostToolUse",
    payload: { ...tool, output: "a".repeat(10_240) },
  });
  expect(res.status).toBe(201);
  expect(storedOutput()).toBe(
    "a".repeat(EVENT_TEXT_MAX) + truncationMarker(10_240 - EVENT_TEXT_MAX),
  );
});

test.each([
  ["claude.PostToolUse", "output", { ...tool, output: "" }],
  ["claude.PreToolUse", "input", { ...tool, input: "" }],
  ["claude.PostToolUseFailure", "error", { ...tool, error: "" }],
  ["claude.Message", "text", { text: "" }],
])(
  "a registered secret straddling the trim point of %s.%s is redacted whole, never stored in part",
  async (type, field, base) => {
    const { run, token } = await startedRun();
    const secret = config.webhookSigningKey;
    const at = EVENT_TEXT_MAX - 16;
    const text = `${"a".repeat(at)}${secret}`.padEnd(10_240, "b");
    const res = await postEvent(token, {
      runId: run.id,
      type,
      payload: { ...base, [field]: text },
    });
    expect(res.status).toBe(201);
    const row = db.$client
      .prepare("select payload from events where type = ?")
      .get(type) as { payload: string };
    const stored =
      (JSON.parse(row.payload) as Record<string, string>)[field] ?? "";
    expect(stored).not.toContain(secret.slice(0, 8));
    expect(stored.slice(at, at + "[redacted]".length)).toBe("[redacted]");
    expect(stored).toMatch(/…\[truncated \d+ chars\]$/);
  },
);

test("a secret with a quote and a newline is redacted from a tool's JSON-text input", async () => {
  const envId = readyEnv();
  const secret = 'pa"ss\\word\nline-two-0042';
  expect((await putSecret(envId, "TRICKY", { value: secret })).status).toBe(
    200,
  );
  const { run, token } = await runningRun(envId);
  await postEvent(token, {
    runId: run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  const res = await postEvent(token, {
    runId: run.id,
    type: "claude.PreToolUse",
    payload: { ...tool, input: JSON.stringify({ content: `x ${secret} y` }) },
  });
  expect(res.status).toBe(201);
  const row = db.$client
    .prepare("select payload from events where type = 'claude.PreToolUse'")
    .get() as { payload: string };
  expect(JSON.parse(row.payload).input).toBe('{"content":"x [redacted] y"}');
});

test("a 5000-char approval summary is redacted whole, then stored trimmed to 2000 with the marker", async () => {
  const { run, token } = await startedRun();
  const secret = config.webhookSigningKey;
  const at = 2000 - 8;
  const toolSummary = `${"a".repeat(at)}${secret}`.padEnd(5000, "b");
  const res = await postEvent(token, {
    runId: run.id,
    type: "run.waiting",
    payload: {
      request: {
        kind: "approval",
        requestId: "req_1",
        toolName: "Bash",
        toolSummary,
      },
    },
  });
  expect(res.status).toBe(201);
  const row = db.$client
    .prepare("select payload from events where type = 'run.waiting'")
    .get() as { payload: string };
  const stored: string = JSON.parse(row.payload).request.toolSummary;
  const redacted = toolSummary.replace(secret, "[redacted]");
  expect(stored).not.toContain(secret.slice(0, 8));
  expect(stored).toBe(
    redacted.slice(0, 2000) + truncationMarker(redacted.length - 2000),
  );
});

test("a run.progress post is rejected 400 and stores nothing", async () => {
  const { run, token } = await startedRun();
  const res = await postEvent(token, {
    runId: run.id,
    type: "run.progress",
    payload: { message: "working" },
  });
  expect(res.status).toBe(400);
  expect(db.$client.prepare("select type from events").all()).toEqual([
    { type: "run.started" },
  ]);
});

test("a failed event records its error and frees the agent", async () => {
  const { agent, run, token } = await runningRun();
  await postEvent(token, {
    runId: run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  await postEvent(token, {
    runId: run.id,
    type: "run.failed",
    payload: { error: "claude exited 1" },
  });
  expect((await getRun(agent.id, run.id)).body).toMatchObject({
    status: "failed",
    error: "claude exited 1",
    usage: null,
  });
});

test("another live run's token gets 403 and stores nothing", async () => {
  const envId = readyEnv();
  const a = await runningRun(envId);
  const b = await runningRun(envId);
  const res = await postEvent(b.token, {
    runId: a.run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  expect(res.status).toBe(403);
  expect(db.$client.prepare("select count(*) n from events").get()).toEqual({
    n: 0,
  });
});

test("an ended run's token gets 401", async () => {
  const { run, token } = await runningRun();
  await postEvent(token, {
    runId: run.id,
    type: "run.stopped",
    payload: {},
  });
  const res = await postEvent(token, {
    runId: run.id,
    type: "claude.Message",
    payload: { text: "late" },
  });
  expect(res.status).toBe(401);
  expect(await res.json()).toMatchObject({ error: { code: "run_ended" } });
});

test.each([
  ["a garbage token", { Authorization: "Bearer not-a-token" }],
  ["the API key", { Authorization: `Bearer ${testConfig().apiKey}` }],
  ["no token", {}],
])("%s gets 401", async (_, authHeader) => {
  const { run } = await runningRun();
  const res = await app.request("/internal/events", {
    method: "POST",
    headers: { ...authHeader, "Content-Type": "application/json" },
    body: JSON.stringify({
      runId: run.id,
      type: "run.started",
      payload: { sessionId: "s" },
    }),
  });
  expect(res.status).toBe(401);
});

test("an event outside the shared schema gets 400", async () => {
  const { run, token } = await runningRun();
  const res = await postEvent(token, {
    runId: run.id,
    type: "run.started",
    payload: {},
  });
  expect(res.status).toBe(400);
});

test("an event the transition table forbids gets 409 and leaves the run as it was", async () => {
  const { agent, run, token } = await runningRun();
  const res = await postEvent(token, {
    runId: run.id,
    type: "run.finished",
    payload: { summary: "skipped start", usage },
  });
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({
    error: { code: "invalid_transition" },
  });
  expect((await getRun(agent.id, run.id)).body.status).toBe("starting");
});

test("secrets a runner echoes are redacted before the event is stored", async () => {
  const { run, token } = await runningRun();
  await postEvent(token, {
    runId: run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  await postEvent(token, {
    runId: run.id,
    type: "claude.Message",
    payload: {
      text: `env: AGENT_TOKEN=${token} CLAUDE_CODE_OAUTH_TOKEN=${config.claudeOauthToken}`,
    },
  });
  const stored = JSON.stringify(
    db.$client.prepare("select * from events").all(),
  );
  expect(stored).not.toContain(token);
  expect(stored).not.toContain(config.claudeOauthToken);
  expect(stored).toContain("AGENT_TOKEN=[redacted]");
});

test("a credential in a nested payload field is redacted, even at the start of a line", async () => {
  const { run, token } = await runningRun();
  const pat = `ghp_${"a1B2".repeat(9)}`;
  await postEvent(token, {
    runId: run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  const res = await postEvent(token, {
    runId: run.id,
    type: "run.waiting",
    payload: {
      request: {
        kind: "question",
        requestId: "req_1",
        prompt: `push with which token?\n${pat}`,
      },
    },
  });
  expect(res.status).toBe(201);
  const row = db.$client
    .prepare("select payload from events where type = 'run.waiting'")
    .get() as { payload: string };
  expect(JSON.parse(row.payload)).toMatchObject({
    request: { prompt: "push with which token?\n[redacted]" },
  });
});

async function finishedRun() {
  const r = await runningRun();
  await postEvent(r.token, {
    runId: r.run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  await postEvent(r.token, {
    runId: r.run.id,
    type: "run.finished",
    payload: { summary: "done", usage },
  });
  return r;
}

const patch = "diff --git a/x b/x\n+fixed\n";

test("GET of an ended run returns its branch and its diff against the env's base branch", async () => {
  const { agent, run, envId } = await finishedRun();
  wire.exec = (argv) =>
    argv[0] === "git" ? { exitCode: 0, stdout: patch } : { exitCode: 0 };
  const { status, body } = await getRun(agent.id, run.id);
  expect(status).toBe(200);
  expect(body).toEqual({
    id: run.id,
    agentId: agent.id,
    status: "finished",
    summary: "done",
    usage,
    error: null,
    createdAt: expect.any(String),
    branch: `claude/${agent.id}`,
    diff: patch,
    pendingRequest: null,
    rollup: null,
    compareUrl: null,
    secretNames: [],
  });
  expect(wire.calls.at(-1)).toBe(
    `exec ${spriteNameFor(envId)} /workspace/repo git diff origin/HEAD...claude/${agent.id}`,
  );
});

const sha = (c: string) => c.repeat(40);
const rollupWith = (subject: string) => ({
  base: sha("b"),
  run: {
    commits: [{ sha: sha("1"), subject }],
    files: 2,
    added: 10,
    removed: 3,
  },
  cumulative: {
    commits: [
      { sha: sha("1"), subject },
      { sha: sha("0"), subject: "earlier run" },
    ],
    files: 3,
    added: 14,
    removed: 3,
  },
});

async function endedWith(type: "run.finished" | "run.failed", rollup: unknown) {
  const r = await runningRun();
  await postEvent(r.token, {
    runId: r.run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  const res = await postEvent(r.token, {
    runId: r.run.id,
    type,
    payload:
      type === "run.finished"
        ? { summary: "done", usage, rollup }
        : { error: "boom", usage, rollup },
  });
  return { ...r, res };
}

test("a finished run's rollup and compare URL show on GET and on the list, which never wakes the sprite", async () => {
  const rollup = rollupWith("fix the flaky test");
  const { agent, run, res } = await endedWith("run.finished", rollup);
  expect(res.status).toBe(201);
  const compareUrl = `https://github.com/acme/kru/compare/${sha("b")}...claude/${agent.id}`;
  wire.exec = () => ({ exitCode: 0, stdout: patch });
  expect((await getRun(agent.id, run.id)).body).toMatchObject({
    rollup,
    compareUrl,
    diff: patch,
  });
  const calls = wire.calls.length;
  expect((await listRuns(agent.id)).body.data).toEqual([
    expect.objectContaining({ id: run.id, rollup, compareUrl, diff: null }),
  ]);
  expect(wire.calls).toHaveLength(calls);
});

test("a failed run's rollup is stored with its commit subjects redacted", async () => {
  const key = "sk-proj-0123456789abcdefABCDEF";
  const { agent, run, res } = await endedWith(
    "run.failed",
    rollupWith(`add API_KEY=${key}`),
  );
  expect(res.status).toBe(201);
  expect(
    JSON.stringify(db.$client.prepare("select * from runs").all()),
  ).not.toContain(key);
  expect((await listRuns(agent.id)).body.data[0]).toMatchObject({
    id: run.id,
    status: "failed",
    rollup: { run: { commits: [{ subject: "add API_KEY=[redacted]" }] } },
  });
});

test("an unparseable rollup is dropped with a log line and the event still lands", async () => {
  const { agent, run, res } = await endedWith("run.finished", {
    base: "not-a-sha",
  });
  expect(res.status).toBe(201);
  expect((await listRuns(agent.id)).body.data[0]).toMatchObject({
    id: run.id,
    status: "finished",
    summary: "done",
    rollup: null,
    compareUrl: null,
  });
  expect(logs.some((l) => l.includes("rollup") && l.includes(run.id))).toBe(
    true,
  );
});

test("after runs with planted secrets, no stored event, run or agent row holds any of them", async () => {
  const a = await runningRun();
  const b = await runningRun();
  const platform = [
    "sk-ant-oat01-AbCdEf0123456789_xyz-AbCdEf",
    "sk-proj-0123456789abcdefABCDEF",
    `ghp_${"a1B2".repeat(9)}`,
    `github_pat_11ABC${"x9".repeat(20)}`,
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    config.apiKey,
    config.spritesToken,
    config.claudeOauthToken,
  ];
  // a runner can read any live runner's env on its sprite, never a token already revoked
  const whileBothLive = [...platform, a.token, b.token].join("\n");
  const steps = [
    [a, { type: "run.started", payload: { sessionId: "s1" } }],
    [b, { type: "run.started", payload: { sessionId: "s2" } }],
    [
      a,
      {
        type: "run.waiting",
        payload: {
          request: {
            kind: "approval",
            requestId: "req_1",
            toolName: "Bash",
            toolSummary: whileBothLive,
          },
        },
      },
    ],
    [b, { type: "claude.Message", payload: { text: whileBothLive } }],
    [b, { type: "run.finished", payload: { summary: whileBothLive, usage } }],
    [
      a,
      {
        type: "run.failed",
        payload: { error: [...platform, a.token].join("\n"), usage },
      },
    ],
  ] as const;
  for (const [{ run, token }, event] of steps) {
    const res = await postEvent(token, { runId: run.id, ...event });
    expect(res.status).toBe(201);
  }
  const stored = JSON.stringify([
    db.$client.prepare("select * from events").all(),
    db.$client.prepare("select * from runs").all(),
    db.$client.prepare("select * from agents").all(),
  ]);
  for (const secret of [...platform, a.token, b.token]) {
    expect(stored).not.toContain(secret);
  }
  expect(stored).toContain("[redacted]");
});

test("GET redacts credentials and the run's own agent token from the diff", async () => {
  const { agent, run, token } = await finishedRun();
  const key = "sk-proj-0123456789abcdefABCDEF";
  wire.exec = () => ({
    exitCode: 0,
    stdout: `+API_KEY=${key}\n+AGENT_TOKEN=${token}\n+PORT=8080\n`,
  });
  expect((await getRun(agent.id, run.id)).body.diff).toBe(
    "+API_KEY=[redacted]\n+AGENT_TOKEN=[redacted]\n+PORT=8080\n",
  );
});

test("GET of an active run has a null diff and never wakes the sprite", async () => {
  const { agent, run } = await runningRun();
  const calls = wire.calls.length;
  expect((await getRun(agent.id, run.id)).body).toMatchObject({
    status: "starting",
    diff: null,
  });
  expect(wire.calls).toHaveLength(calls);
});

test("GET of an ended run whose branch never existed has a null diff", async () => {
  const { agent, run } = await finishedRun();
  wire.exec = () => ({ exitCode: 128, stderr: "fatal: bad revision\n" });
  expect((await getRun(agent.id, run.id)).body).toMatchObject({ diff: null });
});

test("GET while the sprite is unreachable gets 502", async () => {
  const { agent, run, envId } = await finishedRun();
  wire.sprites.delete(spriteNameFor(envId));
  const { status, body } = await getRun(agent.id, run.id);
  expect(status).toBe(502);
  expect(body).toMatchObject({ error: { code: "sprite_unreachable" } });
});

test.each([
  ["an unknown run", (a: string) => `/v1/agents/${a}/runs/run_nope`],
  ["a malformed id", () => "/v1/agents/nope/runs/nope"],
])("GET of %s gets 404", async (_, path) => {
  const { agent } = await runningRun();
  const res = await app.request(path(agent.id), { headers: auth });
  expect(res.status).toBe(404);
});

test("GET of a run under another agent gets 404", async () => {
  const envId = readyEnv();
  const a = await runningRun(envId);
  const b = await runningRun(envId);
  expect((await getRun(b.agent.id, a.run.id)).status).toBe(404);
});

test("GET without a bearer gets 401", async () => {
  const { agent, run } = await runningRun();
  const res = await app.request(`/v1/agents/${agent.id}/runs/${run.id}`);
  expect(res.status).toBe(401);
});

const listRuns = async (agentId: string) => {
  const res = await app.request(`/v1/agents/${agentId}/runs`, {
    headers: auth,
  });
  return {
    status: res.status,
    body: (await res.json()) as { data: { id: string }[] },
  };
};

test("GET runs lists the agent's runs newest first, ties by insert order, without diffs or waking the sprite", async () => {
  const { agent, run } = await finishedRun();
  await runningRun();
  const agentId = agent.id as AgentId;
  const at = (iso: string, suffix: string) => ({
    id: `run_${suffix.repeat(22)}` as RunId,
    agentId,
    status: "stopped" as const,
    createdAt: iso,
  });
  db.insert(runs)
    .values([
      at("2000-01-01T00:00:00.000Z", "o"),
      at("2999-01-01T00:00:00.000Z", "B"),
      at("2999-01-01T00:00:00.000Z", "A"),
    ])
    .run();
  const calls = wire.calls.length;
  const { status, body } = await listRuns(agent.id);
  expect(status).toBe(200);
  expect(body.data.map((r) => r.id)).toEqual([
    `run_${"A".repeat(22)}`,
    `run_${"B".repeat(22)}`,
    run.id,
    `run_${"o".repeat(22)}`,
  ]);
  for (const item of body.data) {
    expect(item).toMatchObject({
      agentId,
      branch: agent.branch,
      diff: null,
      pendingRequest: null,
    });
  }
  expect(body.data[2]).toMatchObject({ summary: "done", status: "finished" });
  expect(wire.calls).toHaveLength(calls);
});

test.each([
  ["an unknown agent", "agt_nope"],
  ["a malformed id", "nope"],
])("GET runs of %s gets 404", async (_, id) => {
  const res = await app.request(`/v1/agents/${id}/runs`, { headers: auth });
  expect(res.status).toBe(404);
});

test("GET runs without a bearer gets 401", async () => {
  const { agent } = await runningRun();
  expect((await app.request(`/v1/agents/${agent.id}/runs`)).status).toBe(401);
});

test("a run silent past the timeout is failed with runner_timeout, freeing its cap slot", async () => {
  const envId = readyEnv({ concurrency: 1 });
  const { agent, run, token } = await runningRun(envId);
  await postEvent(token, {
    runId: run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  const timeout = config.runTimeoutMs;
  expect(failStaleRuns(db, timeout, Date.now() + timeout - 1000)).toEqual([]);
  expect(failStaleRuns(db, timeout, Date.now() + timeout + 1000)).toEqual([
    run.id,
  ]);
  expect((await getRun(agent.id, run.id)).body).toMatchObject({
    status: "failed",
    error: "runner_timeout",
  });
  // the runner, if it was only slow, is now told its run is over
  expect(
    (
      await postEvent(token, {
        runId: run.id,
        type: "claude.Message",
        payload: { text: "late" },
      })
    ).status,
  ).toBe(401);
  await launched(envId);
  await sessionOpened(2);
});

test("a run that never reports in is failed with launch_timeout past the launch deadline, freeing the agent", async () => {
  const envId = readyEnv({ concurrency: 1 });
  const { agent, run } = await runningRun(envId);
  const deadline = config.launchDeadlineMs;
  expect(
    failUnlaunchedRuns(db, deadline, Date.now() + deadline - 1000),
  ).toEqual([]);
  expect(
    failUnlaunchedRuns(db, deadline, Date.now() + deadline + 1000),
  ).toEqual([{ runId: run.id, spriteName: spriteNameFor(envId) }]);
  expect((await getRun(agent.id, run.id)).body).toMatchObject({
    status: "failed",
    error: "launch_timeout",
  });
  await launched(envId);
  await sessionOpened(2);
});

test("the launch deadline leaves a run alone once its runner has reported in", async () => {
  const envId = readyEnv({ concurrency: 1 });
  const { agent, run, token } = await runningRun(envId);
  await postEvent(token, {
    runId: run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  const deadline = config.launchDeadlineMs;
  expect(
    failUnlaunchedRuns(db, deadline, Date.now() + deadline + 1000),
  ).toEqual([]);
  expect((await getRun(agent.id, run.id)).body).toMatchObject({
    status: "running",
  });
});

const followUp = (agentId: string, body: unknown) =>
  app.request(`/v1/agents/${agentId}/runs`, {
    method: "POST",
    headers: json,
    body: JSON.stringify(body),
  });

test("a follow-up run resumes the agent's session in the same worktree", async () => {
  const { agent, run: first } = await finishedRun();
  const res = await followUp(agent.id, { prompt: "now add a test" });
  expect(res.status).toBe(202);
  const body = (await res.json()) as Launched;
  expect(body.agent).toMatchObject({ id: agent.id, status: "running" });
  expect(body.run).toMatchObject({ agentId: agent.id, status: "starting" });
  expect(body.run.id).not.toBe(first.id);
  expect(res.headers.get("location")).toBe(
    `/v1/agents/${agent.id}/runs/${body.run.id}`,
  );
  await sessionOpened(2);
  expect(wire.sessions[1]?.env).toMatchObject({
    AGENT_ID: agent.id,
    RUN_ID: body.run.id,
    SESSION_ID: "s",
    PROMPT_FILE: `/workspace/runs/${body.run.id}.prompt`,
  });
  expect(
    new TextDecoder().decode(
      wire.files.get(`/workspace/runs/${body.run.id}.prompt`),
    ),
  ).toBe("now add a test");
});

test("a follow-up run gets the env's approval policy and auto-approve as they stand now", async () => {
  const { agent, envId } = await finishedRun();
  const autoApprove = { defaults: false, commands: ["make check"] };
  db.update(environments)
    .set({ approvalPolicy: ["Bash"], autoApprove })
    .where(eq(environments.id, envId))
    .run();
  expect((await followUp(agent.id, { prompt: "more" })).status).toBe(202);
  await sessionOpened(2);
  expect(wire.sessions[1]?.env).toMatchObject({
    APPROVAL_POLICY: '["Bash"]',
    AUTO_APPROVE: JSON.stringify(autoApprove),
  });
});

test("a follow-up on an agent whose first run never started a session starts a fresh one", async () => {
  const { agent, run, token } = await runningRun();
  await postEvent(token, {
    runId: run.id,
    type: "run.failed",
    payload: { error: "worktree setup failed" },
  });
  expect((await followUp(agent.id, { prompt: "retry" })).status).toBe(202);
  await sessionOpened(2);
  expect(wire.sessions[1]?.env).not.toHaveProperty("SESSION_ID");
});

test("a follow-up while the agent has an active run gets 409 agent_busy and starts nothing", async () => {
  const { agent } = await runningRun();
  const res = await followUp(agent.id, { prompt: "again" });
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ error: { code: "agent_busy" } });
  expect(db.$client.prepare("select count(*) n from runs").get()).toEqual({
    n: 1,
  });
});

test("a follow-up counts against the env's concurrency cap", async () => {
  const envId = readyEnv({ concurrency: 1 });
  const { agent, run, token } = await runningRun(envId);
  await postEvent(token, {
    runId: run.id,
    type: "run.stopped",
    payload: {},
  });
  // the slot run 1 freed is taken by another agent
  await runningRun(envId);
  const res = await followUp(agent.id, { prompt: "more" });
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({
    error: { code: "concurrency_cap", limit: 1 },
  });
});

test("GET of a follow-up run shows its own summary and the cumulative branch diff", async () => {
  const { agent, run: first } = await finishedRun();
  const res = await followUp(agent.id, { prompt: "add a test" });
  const { run } = (await res.json()) as Launched;
  await sessionOpened(2);
  const token = envFileOf(wire, wire.sessions[1]).AGENT_TOKEN ?? "";
  await postEvent(token, {
    runId: run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  await postEvent(token, {
    runId: run.id,
    type: "run.finished",
    payload: { summary: "added the test", usage },
  });
  wire.exec = (argv) =>
    argv[0] === "git" ? { exitCode: 0, stdout: patch } : { exitCode: 0 };
  expect((await getRun(agent.id, run.id)).body).toMatchObject({
    id: run.id,
    summary: "added the test",
    diff: patch,
  });
  // against the base branch, not run 1's end: the diff spans every run on the branch
  expect(wire.calls.at(-1)).toMatch(
    new RegExp(`git diff origin/HEAD\\.\\.\\.claude/${agent.id}$`),
  );
  expect((await getRun(agent.id, first.id)).body.summary).toBe("done");
});

test.each([
  ["an unknown agent", "agt_nope"],
  ["a malformed id", "nope"],
])("a follow-up on %s gets 404", async (_, id) => {
  expect((await followUp(id, { prompt: "go" })).status).toBe(404);
});

test.each([
  ["no prompt", {}],
  ["an empty prompt", { prompt: "" }],
  ["an unknown key", { prompt: "go", envId: "env_x" }],
])("a follow-up body with %s gets 400", async (_, body) => {
  const { agent } = await finishedRun();
  expect((await followUp(agent.id, body)).status).toBe(400);
});

test("a follow-up without a bearer gets 401 and starts nothing", async () => {
  const { agent } = await finishedRun();
  const res = await app.request(`/v1/agents/${agent.id}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "go" }),
  });
  expect(res.status).toBe(401);
  expect(wire.sessions).toHaveLength(1);
});

const action = (agentId: string, verb: "stop" | "archive") =>
  app.request(`/v1/agents/${agentId}/${verb}`, {
    method: "POST",
    headers: auth,
  });

const runnerPattern = (runId: string) => `/opt/sky/runner\\.mjs ${runId}$`;

test("stop SIGTERMs the run's runner, marks the run stopped and frees its cap slot", async () => {
  const envId = readyEnv({ concurrency: 1 });
  const { agent, run, token } = await runningRun(envId);
  await postEvent(token, {
    runId: run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  const res = await action(agent.id, "stop");
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    agent: { id: agent.id, status: "idle", archivedAt: null },
    run: { id: run.id, status: "stopped" },
  });
  // the runner's argv carries its run id, so the match signals this run's runner only
  expect(wire.sessions[0]?.argv.join(" ")).toContain(
    'exec node /opt/sky/runner.mjs "$RUN_ID"',
  );
  expect(wire.calls.at(-1)).toBe(
    `exec ${spriteNameFor(envId)} - pkill -TERM -f ${runnerPattern(run.id)}`,
  );
  expect(
    db.$client.prepare("select type from events order by id").all(),
  ).toEqual([{ type: "run.started" }, { type: "run.stopped" }]);
  // the runner reports its interrupt after the run has ended
  const late = await postEvent(token, {
    runId: run.id,
    type: "run.failed",
    payload: { error: "interrupted by SIGTERM" },
  });
  expect(late.status).toBe(401);
  expect((await getRun(agent.id, run.id)).body.status).toBe("stopped");
  await launched(envId);
  await sessionOpened(2);
});

/** Answers the follow-up's wait for `runId`'s runner: exit 0 once it is gone, 1 while it lives. */
function runnerAlive(runId: string, alive: () => boolean) {
  const exec = wire.exec;
  wire.exec = (argv) =>
    argv[0] === "bash" && argv.at(-1) === runnerPattern(runId)
      ? { exitCode: alive() ? 1 : 0 }
      : exec(argv);
}

test("a follow-up right after stop waits for the stopped runner; still alive, it gets 409 runner_still_exiting and starts nothing", async () => {
  const { agent, run, envId } = await runningRun();
  expect((await action(agent.id, "stop")).status).toBe(200);
  let alive = true;
  runnerAlive(run.id, () => alive);

  const res = await followUp(agent.id, { prompt: "go another way" });
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({
    error: { code: "runner_still_exiting" },
  });
  expect(db.$client.prepare("select count(*) n from runs").get()).toEqual({
    n: 1,
  });
  expect(
    db.$client.prepare("select status from agents where id = ?").get(agent.id),
  ).toEqual({ status: "idle" });
  // the wait is bounded on the sprite, to the same 30 s archive allows
  const wait = wire.calls.at(-1) ?? "";
  expect(wait.startsWith(`exec ${spriteNameFor(envId)} - bash -c `)).toBe(true);
  expect(wait).toContain("seq 30");

  alive = false;
  expect((await followUp(agent.id, { prompt: "go another way" })).status).toBe(
    202,
  );
  await sessionOpened(2);
});

test("a follow-up whose wait for the previous runner can't reach the sprite gets 502 and starts nothing", async () => {
  const { agent, envId } = await finishedRun();
  wire.sprites.delete(spriteNameFor(envId));
  const res = await followUp(agent.id, { prompt: "again" });
  expect(res.status).toBe(502);
  expect(await res.json()).toMatchObject({
    error: { code: "sprite_unreachable" },
  });
  expect(db.$client.prepare("select count(*) n from runs").get()).toEqual({
    n: 1,
  });
});

test("stopping an agent with no active run is a 200 no-op that never wakes the sprite", async () => {
  const { agent } = await finishedRun();
  const calls = wire.calls.length;
  for (let i = 0; i < 2; i++) {
    const res = await action(agent.id, "stop");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      agent: { id: agent.id, status: "idle" },
      run: null,
    });
  }
  expect(wire.calls).toHaveLength(calls);
});

test("a stop whose signal can't reach the sprite still stops the run, and logs it", async () => {
  const { agent, run, envId } = await runningRun();
  wire.sprites.delete(spriteNameFor(envId));
  const res = await action(agent.id, "stop");
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ run: { status: "stopped" } });
  expect(logs.join("\n")).toContain(
    `signalling the runner of ${run.id} failed`,
  );
});

test("a run stopped before its launch opens a session never gets a runner", async () => {
  const { agent, run } = await launched(readyEnv());
  expect((await action(agent.id, "stop")).status).toBe(200);
  await vi.waitFor(() =>
    expect(logs).toContain(`${run.id} ended before its runner started`),
  );
  expect(wire.sessions).toEqual([]);
});

test.each([
  ["an unknown agent", "agt_nope"],
  ["a malformed id", "nope"],
])("stop or archive of %s gets 404", async (_, id) => {
  expect((await action(id, "stop")).status).toBe(404);
  expect((await action(id, "archive")).status).toBe(404);
});

test("stop or archive without a bearer gets 401 and touches nothing", async () => {
  const { agent, run } = await runningRun();
  const calls = wire.calls.length;
  for (const verb of ["stop", "archive"]) {
    const res = await app.request(`/v1/agents/${agent.id}/${verb}`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  }
  expect(wire.calls).toHaveLength(calls);
  expect((await getRun(agent.id, run.id)).body.status).toBe("starting");
});

const worktreeRemoval = (envId: string, agentId: string) =>
  new RegExp(
    `^exec ${spriteNameFor(envId)} /workspace/repo bash -c .*git worktree remove --force "\\$1".* _ /workspace/worktrees/${agentId}`,
  );

test("archive stops the active run, waits for its runner, then removes the worktree and keeps the branch", async () => {
  const { agent, run, envId } = await runningRun();
  const res = await action(agent.id, "archive");
  expect(res.status).toBe(200);
  const body = (await res.json()) as { agent: Record<string, unknown> };
  expect(body.agent).toMatchObject({
    id: agent.id,
    status: "idle",
    branch: `claude/${agent.id}`,
    archivedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/),
  });
  const [signal, removal] = wire.calls.slice(-2);
  expect(signal).toBe(
    `exec ${spriteNameFor(envId)} - pkill -TERM -f ${runnerPattern(run.id)}`,
  );
  expect(removal).toMatch(worktreeRemoval(envId, agent.id));
  // the runner commits after SIGTERM, so removal waits until no process matches it
  expect(removal).toContain('pgrep -f "$2"');
  expect(removal?.endsWith(` ${runnerPattern(run.id)}`)).toBe(true);
  expect(wire.calls.join("\n")).not.toMatch(/git branch/);
  expect((await getRun(agent.id, run.id)).body.status).toBe("stopped");
});

test("archiving an idle agent removes its worktree without signalling anything", async () => {
  const { agent, envId } = await finishedRun();
  const calls = wire.calls.length;
  expect((await action(agent.id, "archive")).status).toBe(200);
  const made = wire.calls.slice(calls);
  expect(made).toHaveLength(1);
  expect(made[0]).toMatch(worktreeRemoval(envId, agent.id));
  expect(made[0]).not.toContain("pgrep");
});

test("an archived agent refuses follow-ups and stops with 409 agent_archived", async () => {
  const { agent } = await finishedRun();
  await action(agent.id, "archive");
  for (const res of [
    await followUp(agent.id, { prompt: "more" }),
    await action(agent.id, "stop"),
  ]) {
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: { code: "agent_archived" },
    });
  }
  expect(wire.sessions).toHaveLength(1);
});

test("archiving twice keeps the first archivedAt and retries the worktree removal", async () => {
  const { agent, envId } = await finishedRun();
  const first = (await (await action(agent.id, "archive")).json()) as {
    agent: { archivedAt: string };
  };
  const calls = wire.calls.length;
  const again = await action(agent.id, "archive");
  expect(again.status).toBe(200);
  expect(await again.json()).toMatchObject({
    agent: { archivedAt: first.agent.archivedAt },
  });
  expect(wire.calls.slice(calls)).toEqual([
    expect.stringMatching(worktreeRemoval(envId, agent.id)),
  ]);
});

test.each([
  [
    "the removal fails",
    (w: SpritesWire) => {
      w.exec = (argv) =>
        argv[0] === "bash"
          ? { exitCode: 128, stderr: "fatal: worktree is locked\n" }
          : { exitCode: 0 };
    },
  ],
  [
    "the sprite is unreachable",
    (w: SpritesWire, envId: string) => {
      w.sprites.delete(spriteNameFor(envId));
    },
  ],
])("an archive where %s gets 502 and stays archived", async (_, breakIt) => {
  const { agent, envId } = await finishedRun();
  breakIt(wire, envId);
  const res = await action(agent.id, "archive");
  expect(res.status).toBe(502);
  expect(await res.json()).toMatchObject({
    error: { code: "worktree_remove_failed" },
  });
  expect(logs.join("\n")).toContain(`removing the worktree of ${agent.id}`);
  expect((await followUp(agent.id, { prompt: "more" })).status).toBe(409);
});

const getAgent = async (agentId: string) => {
  const res = await app.request(`/v1/agents/${agentId}`, { headers: auth });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
};

/** Starts a follow-up on `agentId` and returns its run id and agent token. */
async function followUpRun(agentId: string, sessions: number) {
  const res = await followUp(agentId, { prompt: "more" });
  expect(res.status).toBe(202);
  const { run } = (await res.json()) as Launched;
  await sessionOpened(sessions);
  return {
    runId: run.id,
    token: envFileOf(wire, wire.sessions.at(-1)).AGENT_TOKEN ?? "",
  };
}

test("GET agent totals usage across its runs; a stopped run adds nothing", async () => {
  const { agent } = await finishedRun();
  const second = await followUpRun(agent.id, 2);
  await postEvent(second.token, {
    runId: second.runId,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  await postEvent(second.token, {
    runId: second.runId,
    type: "run.finished",
    payload: {
      summary: "more",
      usage: {
        inputTokens: 800,
        outputTokens: 60,
        costUsd: 0.01,
        turns: 2,
        durationMs: 9_000,
      },
    },
  });
  const third = await followUpRun(agent.id, 3);
  expect((await action(agent.id, "stop")).status).toBe(200);
  expect((await getRun(agent.id, third.runId)).body.usage).toBeNull();

  const { status, body } = await getAgent(agent.id);
  expect(status).toBe(200);
  expect(body).toEqual({
    id: agent.id,
    envId: expect.any(String),
    sessionId: "s",
    branch: `claude/${agent.id}`,
    status: "idle",
    createdAt: expect.any(String),
    archivedAt: null,
    usage: {
      inputTokens: 2000,
      outputTokens: 400,
      costUsd: expect.closeTo(0.05),
      turns: 5,
      durationMs: 50_000,
    },
  });
});

test("GET agent whose runs never reported usage shows null usage, not zeros", async () => {
  const { agent, run, token } = await runningRun();
  await postEvent(token, {
    runId: run.id,
    type: "run.failed",
    payload: { error: "claude exited 1" },
  });
  expect((await getAgent(agent.id)).body).toMatchObject({
    status: "idle",
    usage: null,
  });
  expect(
    db.$client.prepare("select input_tokens, cost_usd, turns from runs").get(),
  ).toEqual({ input_tokens: null, cost_usd: null, turns: null });
});

test.each([
  ["an unknown agent", "agt_doesnotexist0000000000"],
  ["a malformed id", "not-an-id"],
])("GET of %s gets 404", async (_, id) => {
  const { status, body } = await getAgent(id);
  expect(status).toBe(404);
  expect(body).toMatchObject({ error: { code: "not_found" } });
});

test("GET agent without a bearer gets 401", async () => {
  const { agent } = await runningRun();
  const res = await app.request(`/v1/agents/${agent.id}`);
  expect(res.status).toBe(401);
});

const rawEnvVars = () =>
  db.$client
    .prepare("select * from run_env_vars order by run_id, name")
    .all() as Record<string, unknown>[];

const envVarValue = "opaque-envvar-value-0099";

test("launch envVars reach that run's env file, are stored encrypted until their TTL, and join the audit", async () => {
  const envId = readyEnv();
  await putSecret(envId, "B_SECRET", { value: "env-secret-value-1" });
  const before = Date.now();
  const res = await launch({
    envId,
    prompt: "go",
    envVars: { A_VAR: envVarValue, B_SECRET: "overrides-the-env-one" },
    ttlSeconds: 600,
  });
  expect(res.status).toBe(202);
  const { agent, run } = (await res.json()) as Launched;
  await sessionOpened();
  expect(envFileOf(wire, wire.sessions[0])).toEqual({
    A_VAR: envVarValue,
    B_SECRET: "overrides-the-env-one",
    CLAUDE_CODE_OAUTH_TOKEN: config.claudeOauthToken,
    AGENT_TOKEN: expect.any(String),
  });
  const rows = rawEnvVars();
  expect(rows.map((r) => r.name)).toEqual(["A_VAR", "B_SECRET"]);
  const expiresAt = Date.parse(String(rows[0]?.expires_at));
  expect(expiresAt).toBeGreaterThanOrEqual(before + 600_000);
  expect(expiresAt).toBeLessThanOrEqual(Date.now() + 600_000);
  const raw = rows
    .map((r) => (r.ciphertext as Buffer).toString("latin1"))
    .join();
  expect(raw).not.toContain(envVarValue);
  expect(raw).not.toContain("overrides");
  await vi.waitFor(async () =>
    expect((await getRun(agent.id, run.id)).body.secretNames).toEqual([
      "A_VAR",
      "B_SECRET",
    ]),
  );
});

test("ttlSeconds defaults to an hour", async () => {
  const before = Date.now();
  await launch({ envId: readyEnv(), prompt: "go", envVars: { X: "y" } });
  await sessionOpened();
  const expiresAt = Date.parse(String(rawEnvVars()[0]?.expires_at));
  expect(expiresAt).toBeGreaterThanOrEqual(before + 3_600_000);
  expect(expiresAt).toBeLessThanOrEqual(Date.now() + 3_600_000);
});

test("follow-up envVars are injected into that run only", async () => {
  const { agent } = await finishedRun();
  const res = await followUp(agent.id, {
    prompt: "more",
    envVars: { ONLY_HERE: envVarValue },
  });
  expect(res.status).toBe(202);
  const { run } = (await res.json()) as Launched;
  await sessionOpened(2);
  const second = envFileOf(wire, wire.sessions[1]);
  expect(second).toMatchObject({ ONLY_HERE: envVarValue });
  expect(envFileOf(wire, wire.sessions[0])).not.toHaveProperty("ONLY_HERE");
  await postEvent(second.AGENT_TOKEN ?? "", {
    runId: run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  await postEvent(second.AGENT_TOKEN ?? "", {
    runId: run.id,
    type: "run.finished",
    payload: { summary: "done", usage },
  });
  await followUpRun(agent.id, 3);
  expect(envFileOf(wire, wire.sessions[2])).not.toHaveProperty("ONLY_HERE");
});

test("an envVar a runner echoes is redacted from the stored event while it is held", async () => {
  const res = await launch({
    envId: readyEnv(),
    prompt: "go",
    envVars: { TOKEN: envVarValue },
  });
  const { run } = (await res.json()) as Launched;
  await sessionOpened();
  const token = envFileOf(wire, wire.sessions[0]).AGENT_TOKEN ?? "";
  await postEvent(token, {
    runId: run.id,
    type: "claude.Message",
    payload: { text: `echo ${envVarValue}` },
  });
  const stored = JSON.stringify(
    db.$client.prepare("select * from events").all(),
  );
  expect(stored).not.toContain(envVarValue);
  expect(stored).toContain("echo [redacted]");
});

test.each([
  ["a reserved name", { envVars: { PATH: "/evil" } }, "reserved_name"],
  ["a sky name", { envVars: { AGENT_TOKEN: "x" } }, "reserved_name"],
  [
    "the env's auto-approve setting",
    { envVars: { AUTO_APPROVE: '{"defaults":true,"commands":["rm"]}' } },
    "reserved_name",
  ],
  ["an invalid name", { envVars: { "1X": "y" } }, "invalid_body"],
  [
    "a TTL over a day",
    { envVars: { X: "y" }, ttlSeconds: 86_401 },
    "invalid_body",
  ],
  ["a zero TTL", { envVars: { X: "y" }, ttlSeconds: 0 }, "invalid_body"],
  [
    "a fractional TTL",
    { envVars: { X: "y" }, ttlSeconds: 1.5 },
    "invalid_body",
  ],
])(
  "launch envVars with %s get 400 and launch nothing",
  async (_, extra, code) => {
    const envId = readyEnv();
    const res = await launch({ envId, prompt: "go", ...extra });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code } });
    expect(db.$client.prepare("select count(*) n from runs").get()).toEqual({
      n: 0,
    });
    expect(rawEnvVars()).toEqual([]);
  },
);

test("a follow-up with a reserved envVar name gets 400 and starts nothing", async () => {
  const { agent } = await finishedRun();
  const res = await followUp(agent.id, {
    prompt: "more",
    envVars: { HOME: "/tmp" },
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: { code: "reserved_name" } });
  expect(db.$client.prepare("select count(*) n from runs").get()).toEqual({
    n: 1,
  });
});
