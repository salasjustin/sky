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
  HEARTBEAT_INTERVAL_MS,
  REPO_LOCK_FILE,
  REPO_LOCK_TIMED_OUT,
  type RunId,
  spriteTaskNameFor,
  truncationMarker,
} from "@sky/shared";
import { eq } from "drizzle-orm";
import { HttpResponse, http, ws } from "msw";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { server } from "../../../test/msw.js";
import { DIFF, DIFF_MAX_BYTES } from "./agents.js";
import { createApp } from "./app.js";
import { BASE_ENV_NAMES } from "./base-profile.js";
import { boot } from "./boot.js";
import type { Config } from "./config.js";
import { envSecretAad, seal } from "./crypto.js";
import { holdArgv, releaseArgv } from "./launch.js";
import { createRunProber } from "./probe.js";
import { KnownSecrets } from "./redact.js";
import {
  failStaleRuns,
  failUnlaunchedRuns,
  pruneClaudeEvents,
} from "./runs.js";
import {
  execInSprite,
  SPRITES_TIMEOUT_MS,
  type SpriteOps,
  spriteNameFor,
} from "./sprites.js";
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
    baseProfiles: { team, bare },
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
afterEach(async () => {
  // a capped exec's cleanup is not awaited by its caller, so it can land after the test's last request
  await wire.cleanedUp();
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
      remoteBranch: null,
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
      claudeCredential: null,
      retryOf: null,
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
    // the sprite's free memory is checked before anything is written to it
    `exec ${sprite} - free -m`,
    `exec ${sprite} - sha256sum /opt/sky/runner.mjs`,
    // written beside it, then renamed over it: a node starting on the bundle never reads it half-written
    `write ${sprite} /opt/sky/runner.mjs.${run.id}`,
    `exec ${sprite} - mv -f /opt/sky/runner.mjs.${run.id} /opt/sky/runner.mjs`,
    `write ${sprite} /workspace/runs/${run.id}.prompt`,
    `write ${sprite} /workspace/runs/${run.id}.env`,
    expect.stringMatching(`^exec ${sprite} - curl .* PUT `),
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
    LAUNCH_DEADLINE_MINUTES: "15",
  });
  // the secrets ride in a file only the sprite user can read, which the command sources and deletes
  expect(envFileOf(wire, session)).toEqual({
    SKY_CLAUDE_AUTH: "oauth",
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
  mcpServers: {
    doop: {
      url: "https://doop.test/mcp",
      headers: { Authorization: "DOOP_KEY" },
    },
  },
});

/** `team` without MCP servers. */
const bare = BaseProfile.parse({
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
  "SKY_MCP_SERVERS",
];
const profileEnv: Record<string, string> = {
  SKY_STORE_REPO: "acme/store",
  SKY_STORE_HOME: ".store",
  SKY_STORE_LAYOUT: JSON.stringify(team.storeLayout),
  SKY_SESSION_ENV: '{"PLUGIN_SWITCH":"1"}',
  SKY_CHECKS: '["run the linter","update the changelog"]',
  SKY_MCP_SERVERS: JSON.stringify(team.mcpServers),
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
    SKY_CLAUDE_AUTH: "oauth",
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
    // secret names only: the runner resolves them from the run's env
    SKY_MCP_SERVERS:
      '{"doop":{"url":"https://doop.test/mcp","headers":{"Authorization":"DOOP_KEY"}}}',
  });
});

test("a base profile with no MCP servers gives the session no SKY_MCP_SERVERS, while its other variables still arrive", async () => {
  const envId = readyEnv({ base: "bare" });
  await connect(envId);
  await launched(envId);
  await sessionOpened();
  const file = envFileOf(wire, wire.sessions[0]);
  expect(file).toHaveProperty("SKY_SESSION_ENV", '{"PLUGIN_SWITCH":"1"}');
  expect(file).not.toHaveProperty("SKY_MCP_SERVERS");
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

test("a runner that fails to start deletes the run's keep-awake task and still reports the start error", async () => {
  wire.sessionExit = { output: "node: bad option\r\n", code: 1 };
  const envId = readyEnv();
  const { agent, run } = await launched(envId);
  await vi.waitFor(async () =>
    expect((await getRun(agent.id, run.id)).body.status).toBe("failed"),
  );
  const { error } = (await getRun(agent.id, run.id)).body;
  expect(error).toMatch(/^launch_failed: runner exited 1 at launch: /);
  expect(wire.calls).toContain(
    `exec ${spriteNameFor(envId)} - rm -f /workspace/runs/${run.id}.env`,
  );
  const release = wire.calls.filter(
    (c) => c.includes(" curl ") && c.includes("-X DELETE"),
  );
  expect(release).toHaveLength(1);
  expect(release[0]).toContain(spriteTaskNameFor(run.id as RunId));
});

test("a launch that fails at the runner's start signals the runner, which may have spawned after all", async () => {
  wire.sessionExit = { output: "node: bad option\r\n", code: 1 };
  const envId = readyEnv();
  const sprite = spriteNameFor(envId);
  const { run } = await launched(envId);
  // the signal isn't awaited by the launch: its end line says the exec has settled
  await vi.waitFor(() =>
    expect(logs.some((l) => l.startsWith(`sprite ${sprite} pkill: ok`))).toBe(
      true,
    ),
  );
  expect(wire.calls.filter((c) => c.includes(" - pkill "))).toEqual([
    `exec ${sprite} - pkill -TERM -f ${runnerPattern(run.id as RunId)}`,
  ]);
});

test("a launch that fails before the runner starts sends no signal", async () => {
  wire.writeStatus = 500;
  const { run } = await launched(readyEnv());
  await vi.waitFor(() =>
    expect(runStatus(run.id)).toEqual({ status: "failed" }),
  );
  // a signal's exec logs its start in the same turn as the failure it follows
  expect(logs.filter((l) => l.includes(" pkill: "))).toEqual([]);
  expect(wire.calls.filter((c) => c.includes(" - pkill "))).toEqual([]);
});

test("a cleanup that fails after a failed start never masks the start error", async () => {
  wire.sessionExit = { output: "node: bad option\r\n", code: 1 };
  const exec = wire.exec;
  wire.exec = (argv) =>
    argv[0] === "curl" && argv.includes("DELETE")
      ? { exitCode: 7, stderr: "curl: (7) couldn't connect\n" }
      : exec(argv);
  // a 503 for the env-file rm alone: the exec rejects instead of exiting non-zero
  wire.hangs = (call) => call.includes(" rm -f ");
  wire.hangMs = 10;
  const envId = readyEnv();
  const { agent, run } = await launched(envId);
  await vi.waitFor(async () =>
    expect((await getRun(agent.id, run.id)).body.status).toBe("failed"),
  );
  expect((await getRun(agent.id, run.id)).body.error).toMatch(
    /^launch_failed: runner exited 1 at launch: /,
  );
  expect(logs.some((l) => l.includes("releasing the sprite hold failed"))).toBe(
    true,
  );
  expect(wire.calls).toContain(
    `exec ${spriteNameFor(envId)} - rm -f /workspace/runs/${run.id}.env`,
  );
});

test.each([
  {
    name: "404, a task already gone, counts as released",
    status: 404,
    logged: false,
  },
  { name: "500 is a failed release", status: 500, logged: true },
])("a release whose DELETE answers $name", async ({ status, logged }) => {
  wire.sessionExit = { output: "node: bad option\r\n", code: 1 };
  const exec = wire.exec;
  wire.exec = (argv) =>
    argv[0] === "curl" && argv.includes("DELETE")
      ? {
          exitCode: 22,
          stderr: `curl: (22) The requested URL returned error: ${status}\n`,
        }
      : exec(argv);
  const { agent, run } = await launched(readyEnv());
  await vi.waitFor(async () =>
    expect((await getRun(agent.id, run.id)).body.status).toBe("failed"),
  );
  // the release is awaited before the start error is thrown, so it has finished by now
  expect(
    wire.calls.filter((c) => c.includes(" curl ") && c.includes("-X DELETE")),
  ).toHaveLength(1);
  expect(logs.some((l) => l.includes("releasing the sprite hold failed"))).toBe(
    logged,
  );
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

test("a runner.warning from the run's token is stored with its text redacted and trimmed, and leaves the run running", async () => {
  const { agent, run, token } = await runningRun();
  await postEvent(token, {
    runId: run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  const res = await postEvent(token, {
    runId: run.id,
    type: "runner.warning",
    payload: {
      message: `runner: sprite task PUT failed: ${config.spritesToken} ${"x".repeat(EVENT_TEXT_MAX)}`,
    },
  });
  expect(res.status).toBe(201);
  const [warning] = eventsOf(run.id).filter((e) => e.type === "runner.warning");
  const { message } = JSON.parse(warning?.payload ?? "") as { message: string };
  expect(message).not.toContain(config.spritesToken);
  expect(message).toContain("sprite task PUT failed");
  expect(message).toMatch(/…\[truncated \d+ chars\]$/);
  expect((await getRun(agent.id, run.id)).body.status).toBe("running");
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

// nothing here reads the machine's git config or the clock
const gitEnv = {
  PATH: process.env.PATH,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Test Author",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "Test Committer",
  GIT_COMMITTER_EMAIL: "committer@example.com",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

/** A temp repo with `main` holding a.txt and `claude/agt_x` one commit ahead of it. */
function repoWithBranch() {
  const repo = mkdtempSync(join(dir, "repo-"));
  const git = (...args: string[]) => {
    const out = spawnSync("git", args, {
      cwd: repo,
      env: gitEnv,
      encoding: "utf8",
    });
    expect(out.status, `git ${args.join(" ")}: ${out.stderr}`).toBe(0);
    return out.stdout;
  };
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "claude/agt_x");
  writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
  git("commit", "-q", "-a", "-m", "work");
  git("checkout", "-q", "main");
  return { repo, git };
}

const runDiff = (repo: string, base: string, branch: string) =>
  spawnSync("sh", ["-c", DIFF, "sh", base, branch], {
    cwd: repo,
    env: gitEnv,
    encoding: "utf8",
  });

test("the diff script prints git's three-dot diff of an existing branch against the base", () => {
  const { repo, git } = repoWithBranch();
  const out = runDiff(repo, "main", "claude/agt_x");
  expect(out.status).toBe(0);
  expect(out.stdout).toContain("+two");
  expect(out.stdout).toBe(git("diff", "main...claude/agt_x"));
});

test("the diff script exits 3 with nothing on stdout or stderr for a branch that was never created", () => {
  const { repo } = repoWithBranch();
  const out = runDiff(repo, "main", "claude/agt_never");
  expect(out.status).toBe(3);
  expect(out.stdout).toBe("");
  expect(out.stderr).toBe("");
});

const patch = "diff --git a/x b/x\n+fixed\n";
// the diff's file reads and removals follow its exec, so the exec is the last `exec` call
const lastExec = () => wire.calls.findLast((c) => c.startsWith("exec "));
/** The run-detail diff exec: `sh -c <script> sh <base> <branch>`. */
const isDiff = (argv: string[]) =>
  argv[0] === "sh" && argv[2]?.includes("git diff") === true;

test("GET of an ended run returns its branch and its diff against the env's base branch", async () => {
  const { agent, run, envId } = await finishedRun();
  wire.exec = (argv) =>
    isDiff(argv) ? { exitCode: 0, stdout: patch } : { exitCode: 0 };
  const { status, body } = await getRun(agent.id, run.id);
  expect(status).toBe(200);
  expect(body).toEqual({
    id: run.id,
    agentId: agent.id,
    status: "finished",
    summary: "done",
    usage,
    error: null,
    claudeCredential: "default",
    retryOf: null,
    createdAt: expect.any(String),
    branch: `claude/${agent.id}`,
    diff: patch,
    pendingRequest: null,
    rollup: null,
    compareUrl: null,
    secretNames: [],
  });
  expect(lastExec()).toMatch(
    new RegExp(
      `^exec ${spriteNameFor(envId)} /workspace/repo sh -c .* sh origin/HEAD claude/${agent.id}$`,
    ),
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

test("GET of a run whose runner was killed before it made its branch is a 200 with no diff, and the exec never carries git's complaint", async () => {
  const { agent, run } = await finishedRun();
  // the script's own answer for a missing branch: its exit, with nothing on stderr to share a chunk with it
  wire.exec = (argv) => (isDiff(argv) ? { exitCode: 3 } : { exitCode: 0 });
  const { status, body } = await getRun(agent.id, run.id);
  expect(status).toBe(200);
  expect(body).toMatchObject({ id: run.id, status: "finished", diff: null });
  // a branch never created is a normal answer, not worth a line
  expect(logs.filter((l) => l.startsWith(`diff of ${run.id}`))).toEqual([]);
});

test("GET of a run whose diff fails in git is still a 200 with no diff, and logs the run, agent and exit", async () => {
  const { agent, run } = await finishedRun();
  wire.exec = (argv) => (isDiff(argv) ? { exitCode: 128 } : { exitCode: 0 });
  const { status, body } = await getRun(agent.id, run.id);
  expect(status).toBe(200);
  expect(body).toMatchObject({ id: run.id, diff: null });
  expect(logs).toContain(
    `diff of ${run.id} (agent ${agent.id}) exited 128; answered without one`,
  );
});

test("GET of a run with a large diff returns all of it, however the exec stream is re-chunked", async () => {
  const { agent, run } = await finishedRun();
  const large = "+tttttttttttttttttttttttttttttttt\n".repeat(20_000);
  expect(large.length).toBeLessThan(DIFF_MAX_BYTES);
  wire.execChunkBytes = 1024;
  wire.exec = (argv) =>
    isDiff(argv) ? { exitCode: 0, stdout: large } : { exitCode: 0 };
  const { status, body } = await getRun(agent.id, run.id);
  expect(status).toBe(200);
  expect(body.diff).toBe(large);
  expect(body).not.toHaveProperty("diffTruncated");
});

test("GET of a run whose diff is over the cap returns it cut to whole lines, flagged, with its full size", async () => {
  const { agent, run } = await finishedRun();
  const line = `+${"x".repeat(78)}\n`;
  const huge = line.repeat(Math.ceil((DIFF_MAX_BYTES * 3) / line.length));
  wire.exec = (argv) =>
    isDiff(argv) ? { exitCode: 0, stdout: huge } : { exitCode: 0 };
  const { status, body } = await getRun(agent.id, run.id);
  expect(status).toBe(200);
  expect(body).toMatchObject({ diffTruncated: true, diffSize: huge.length });
  const diff = body.diff as string;
  expect(diff.length).toBeLessThanOrEqual(DIFF_MAX_BYTES);
  expect(diff.length).toBeGreaterThan(DIFF_MAX_BYTES - line.length);
  expect(diff.endsWith("\n")).toBe(true);
  expect(huge.startsWith(diff)).toBe(true);
});

test("GET of a run whose diff is exactly the cap is not truncated", async () => {
  const { agent, run } = await finishedRun();
  const exact = "x".repeat(DIFF_MAX_BYTES);
  wire.exec = (argv) =>
    isDiff(argv) ? { exitCode: 0, stdout: exact } : { exitCode: 0 };
  const { body } = await getRun(agent.id, run.id);
  expect(body.diff).toBe(exact);
  expect(body).not.toHaveProperty("diffTruncated");
});

test("GET of a truncated diff redacts a secret the cut would have split", async () => {
  const { agent, run } = await finishedRun();
  const key = "sk-proj-0123456789abcdefABCDEF";
  const filler = "+x\n".repeat(Math.floor((DIFF_MAX_BYTES - 20) / 3));
  wire.exec = (argv) =>
    isDiff(argv)
      ? { exitCode: 0, stdout: `${filler}+API_KEY=${key}\n${filler}` }
      : { exitCode: 0 };
  const { body } = await getRun(agent.id, run.id);
  expect(body.diffTruncated).toBe(true);
  expect(body.diff).not.toContain("sk-proj");
  // the cut lands inside the key's line and goes back to the filler's last newline; a kept 13-character
  // stub of the key would be under redact's pattern floor and would show
  expect(body.diff).toBe(filler);
});

test("GET of a truncated diff redacts a credential, an env secret and the run's agent token held wholly in its kept part", async () => {
  const { agent, run, envId, token } = await finishedRun();
  const stored = "plain-env-secret-value-42";
  expect(
    (await putSecret(envId, "DB_PASSWORD", { value: stored })).status,
  ).toBe(200);
  const key = "sk-proj-0123456789abcdefABCDEF";
  expect(token).not.toBe("");
  const lead = `+API_KEY=${key}\n+DB_PASSWORD=${stored}\n+AGENT_TOKEN=${token}\n+PORT=8080\n`;
  const filler = "+x\n".repeat(Math.ceil(DIFF_MAX_BYTES / 3));
  wire.exec = (argv) =>
    isDiff(argv)
      ? { exitCode: 0, stdout: `${lead}${filler}` }
      : { exitCode: 0 };
  const { body } = await getRun(agent.id, run.id);
  expect(body.diffTruncated).toBe(true);
  const diff = body.diff as string;
  expect(
    diff.startsWith(
      "+API_KEY=[redacted]\n+DB_PASSWORD=[redacted]\n+AGENT_TOKEN=[redacted]\n+PORT=8080\n",
    ),
  ).toBe(true);
  for (const secret of [key, stored, token]) {
    expect(diff).not.toContain(secret);
  }
});

test.each([
  { name: "non-numeric", size: "lots\n" },
  { name: "smaller than the diff's head", size: "2\n" },
])(
  "GET whose diff's size file is $name is 502 sprite_exec_failed, not a 200 without a diff",
  async ({ size }) => {
    const { agent, run } = await finishedRun();
    wire.exec = (argv) =>
      isDiff(argv) ? { exitCode: 0, stdout: patch } : { exitCode: 0 };
    // a process in the sprite rewrites the size file between the exec and the read
    wire.afterExec = () => {
      for (const path of [...wire.files.keys()]) {
        if (path.endsWith("/size")) {
          wire.files.set(path, new TextEncoder().encode(size));
        }
      }
    };
    const { status, body } = await getRun(agent.id, run.id);
    expect(status).toBe(502);
    expect(body).toMatchObject({ error: { code: "sprite_exec_failed" } });
    expect(
      logs.some(
        (l) =>
          l.includes(`diff of ${run.id} failed`) &&
          l.includes("unreadable size file"),
      ),
    ).toBe(true);
  },
);

test("GET removes the files the diff left in the sprite", async () => {
  const { agent, run } = await finishedRun();
  wire.exec = (argv) =>
    isDiff(argv) ? { exitCode: 0, stdout: patch } : { exitCode: 0 };
  await getRun(agent.id, run.id);
  await wire.cleanedUp();
  expect(
    [...wire.files.keys(), ...wire.dirs].filter((p) =>
      p.startsWith("/tmp/sky-exec-"),
    ),
  ).toEqual([]);
});

test("GET whose diff wrapper can't stage its output in the sprite is 502 sprite_exec_failed, not a 200 without a diff", async () => {
  const { agent, run } = await finishedRun();
  wire.tmpFull = true;
  wire.exec = (argv) =>
    isDiff(argv) ? { exitCode: 0, stdout: patch } : { exitCode: 0 };
  const { status, body } = await getRun(agent.id, run.id);
  expect(status).toBe(502);
  expect(body).toMatchObject({ error: { code: "sprite_exec_failed" } });
  expect(
    logs.some(
      (l) =>
        l.includes(`diff of ${run.id} failed`) &&
        l.includes("could not stage its output"),
    ),
  ).toBe(true);
});

test("GET whose exec stream cannot be decoded is 502 sprite_exec_failed, with the cause logged", async () => {
  const { agent, run } = await finishedRun();
  // the exit frame split in two, which the SDK rejects: the sprite answered, so it is not unreachable
  wire.execChunkBytes = 1;
  const { status, body } = await getRun(agent.id, run.id);
  expect(status).toBe(502);
  expect(body).toMatchObject({ error: { code: "sprite_exec_failed" } });
  expect(
    logs.some(
      (l) =>
        l.includes(`diff of ${run.id} failed`) &&
        l.includes("HTTP exec exit frame"),
    ),
  ).toBe(true);
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

test("a runner.warning or runner.heartbeat before run.started doesn't prove the launch: the run still fails launch_timeout", async () => {
  const { agent, run, token } = await runningRun();
  await postEvent(token, {
    runId: run.id,
    type: "runner.warning",
    payload: { message: "holding the sprite failed" },
  });
  await postEvent(token, {
    runId: run.id,
    type: "runner.heartbeat",
    payload: { toolName: "Bash", toolUseId: "t1", elapsedMs: 61_000 },
  });
  const deadline = config.launchDeadlineMs;
  expect(
    failUnlaunchedRuns(db, deadline, Date.now() + deadline + 1000).map(
      (r) => r.runId,
    ),
  ).toEqual([run.id]);
  expect((await getRun(agent.id, run.id)).body).toMatchObject({
    status: "failed",
    error: "launch_timeout",
  });
});

const holdCalls = () => wire.calls.filter((c) => c.includes(" curl "));

test("launch holds the sprite under the runner's task name before it starts the runner", async () => {
  const envId = readyEnv();
  const { run } = await launched(envId);
  await sessionOpened();
  const sprite = spriteNameFor(envId);
  const hold = wire.calls.findIndex((c) =>
    c.startsWith(`exec ${sprite} - curl`),
  );
  const start = wire.calls.findIndex((c) => c.startsWith(`session ${sprite}`));
  expect(hold).toBeGreaterThan(-1);
  expect(hold).toBeLessThan(start);
  const call = wire.calls[hold] ?? "";
  expect(call).toContain("--unix-socket /.sprite/api.sock");
  expect(call).toContain(`-X PUT`);
  expect(call).toContain(`http://sprite/v1/tasks/${spriteTaskNameFor(run.id)}`);
  expect(call).toContain(`{"expire":"2m"}`);
});

test("a hold that fails is logged and the launch goes on", async () => {
  const exec = wire.exec;
  wire.exec = (argv) =>
    argv[0] === "curl"
      ? { exitCode: 7, stderr: "curl: (7) couldn't connect\n" }
      : exec(argv);
  const { agent, run } = await runningRun();
  expect(holdCalls()).toHaveLength(1);
  expect(
    logs.some((l) => l.includes(run.id) && l.includes("hold sprite failed")),
  ).toBe(true);
  expect((await getRun(agent.id, run.id)).body).toMatchObject({
    status: "starting",
  });
});

test("a hold whose exec the Sprites API fails is logged and the launch goes on", async () => {
  // a 503 for the curl call alone: the exec rejects instead of exiting non-zero
  wire.hangs = (call) => call.includes(" curl ");
  wire.hangMs = 10;
  const { agent, run } = await runningRun();
  expect(holdCalls()).toHaveLength(1);
  expect(
    logs.some((l) => l.includes(run.id) && l.includes("hold sprite failed")),
  ).toBe(true);
  expect((await getRun(agent.id, run.id)).body).toMatchObject({
    status: "starting",
  });
});

test("the hold's curl takes a 2m task over the sprite's socket, failing on an HTTP error within 5 s", () => {
  const runId = "run_1" as RunId;
  const url = `http://sprite/v1/tasks/${spriteTaskNameFor(runId)}`;
  expect(holdArgv(runId)).toEqual([
    "curl",
    "-sSf",
    "--max-time",
    "5",
    "--unix-socket",
    "/.sprite/api.sock",
    "-X",
    "PUT",
    "-H",
    "content-type: application/json",
    "-d",
    '{"expire":"2m"}',
    url,
  ]);
  expect(releaseArgv(runId)).toEqual([
    "curl",
    "-sSf",
    "--max-time",
    "5",
    "--unix-socket",
    "/.sprite/api.sock",
    "-X",
    "DELETE",
    url,
  ]);
});

test("a launch wakes its silent run 90 s after the runner starts, by default", {
  timeout: 10_000,
}, async () => {
  // the 90 s timer is captured instead of scheduled, so no real 90 s timer outlives the test
  const realSetTimeout = globalThis.setTimeout;
  const wakes: (() => void)[] = [];
  const timers = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    fn: () => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    if (ms === 90_000) {
      wakes.push(fn);
      // a real, inert timer: the launcher calls `.unref()` on it, and a throw there fails the launch
      return Reflect.apply(realSetTimeout, globalThis, [() => {}, 0]);
    }
    return Reflect.apply(realSetTimeout, globalThis, [fn, ms, ...args]);
  }) as unknown as typeof setTimeout);
  try {
    pgrepAnswers(0);
    const { run } = await launched(readyEnv());
    // launches of earlier tests may still be starting and add timers of their own; their wakes fire
    // into a closed database and do nothing, so every captured wake runs and this run's pgrep is the proof
    let fired = 0;
    await vi.waitFor(
      () => {
        while (fired < wakes.length) wakes[fired++]?.();
        expect(pgrepsOf(run.id)).toHaveLength(1);
      },
      { timeout: 5000 },
    );
  } finally {
    timers.mockRestore();
  }
});

/** An app whose launches wake a silent run's sprite after `ms`. */
function wakingAfter(ms: number) {
  app = createApp({
    db,
    config,
    sprites: new SpritesClient(spritesToken),
    log: (line) => logs.push(line),
    nudgeDeliveries: () => {},
    launchWatchMs: 50,
    launchWakeMs: ms,
  });
}
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Launches a silent run after the one under test and resolves once its wake has run. Timers of
 * equal delay fire in start order, so by then the earlier run's timer has fired, and had that run
 * been woken its pgrep would be in `pgreps()`.
 */
async function untilLaterRunWoke() {
  const { run } = await runningRun();
  await vi.waitFor(
    () =>
      expect(
        logs.some((l) => l.includes(`for ${run.id}: its runner is alive`)),
      ).toBe(true),
    { timeout: 5000 },
  );
}
const pgrepsOf = (runId: string) =>
  pgreps().filter((c) => c.includes(runnerPattern(runId)));

test("a run still starting with only a warning and a heartbeat gets exactly one wake after the delay", async () => {
  wakingAfter(500);
  pgrepAnswers(0);
  const { run, token } = await runningRun();
  await postEvent(token, {
    runId: run.id,
    type: "runner.warning",
    payload: { message: "holding the sprite failed" },
  });
  await postEvent(token, {
    runId: run.id,
    type: "runner.heartbeat",
    payload: { toolName: "Bash", toolUseId: "t1", elapsedMs: 61_000 },
  });
  await vi.waitFor(() => expect(pgreps()).toHaveLength(1), { timeout: 5000 });
  await settle(600);
  expect(pgreps()).toHaveLength(1);
  expect(logs.some((l) => l.includes(run.id) && l.includes("waking"))).toBe(
    true,
  );
  expect(logs.some((l) => l.includes("its runner is alive"))).toBe(true);
  // a live runner is left alone: no event, no failure
  expect(eventsOf(run.id).map((e) => e.type)).toEqual([
    "runner.warning",
    "runner.heartbeat",
  ]);
});

const holdsOf = (runId: string) =>
  holdCalls().filter((c) => c.includes(spriteTaskNameFor(runId as RunId)));

test("a woken silent launch takes the run's hold again", async () => {
  wakingAfter(150);
  pgrepAnswers(0);
  const { run } = await runningRun();
  await vi.waitFor(() => expect(holdsOf(run.id)).toHaveLength(2), {
    timeout: 5000,
  });
  const holds = holdsOf(run.id);
  expect(holds[1]).toBe(holds[0]);
  expect(holds[1]).toContain(`-X PUT`);
  expect(holds[1]).toContain(`{"expire":"2m"}`);
});

test("a woken silent launch whose wake finds no runner is not held again", async () => {
  wakingAfter(150);
  pgrepAnswers(1);
  const { run } = await runningRun();
  await vi.waitFor(
    () =>
      expect(
        logs.some((l) => l.includes(`for ${run.id}: no runner found`)),
      ).toBe(true),
    { timeout: 5000 },
  );
  await settle(300);
  expect(holdsOf(run.id)).toHaveLength(1);
});

test("a re-hold waits for a wake that is still resolving", async () => {
  wakingAfter(150);
  pgrepAnswers(0);
  wire.hangs = (call) => call.includes(" pgrep ");
  wire.hangMs = 400;
  const { run } = await runningRun();
  await vi.waitFor(
    () =>
      expect(wire.calls.some((c) => c.includes(runnerPattern(run.id)))).toBe(
        true,
      ),
    { timeout: 5000 },
  );
  // the pgrep is in flight and will fail at 400ms; no second hold may precede its settling
  await settle(150);
  expect(holdsOf(run.id)).toHaveLength(1);
  await vi.waitFor(() => expect(holdsOf(run.id)).toHaveLength(2), {
    timeout: 5000,
  });
});

test("a run that has reported in is not held again by a wake it never gets", async () => {
  wakingAfter(500);
  pgrepAnswers(0);
  const { run, token } = await runningRun();
  const started = await postEvent(token, {
    runId: run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  expect(started.status).toBe(201);
  // a silent run launched after it wakes, and takes its hold again: the read is live
  const later = await runningRun();
  await vi.waitFor(() => expect(holdsOf(later.run.id)).toHaveLength(2), {
    timeout: 5000,
  });
  expect(holdsOf(run.id)).toHaveLength(1);
});

test("a re-hold that fails on a wake is logged and the run is left alone", async () => {
  const exec = wire.exec;
  let holds = 0;
  wire.exec = (argv) =>
    argv[0] === "curl" && ++holds > 1
      ? { exitCode: 7, stderr: "curl: (7) couldn't connect\n" }
      : exec(argv);
  wakingAfter(150);
  pgrepAnswers(0);
  const { agent, run } = await runningRun();
  await vi.waitFor(() =>
    expect(
      logs.some(
        (l) =>
          l.includes(run.id) &&
          l.includes("hold sprite failed, nothing more is tried"),
      ),
    ).toBe(true),
  );
  await vi.waitFor(() =>
    expect(
      logs.some((l) => l.includes(`for ${run.id}: its runner is alive`)),
    ).toBe(true),
  );
  expect((await getRun(agent.id, run.id)).body).toMatchObject({
    status: "starting",
  });
});

test("a run that has reported in is not woken", async () => {
  wakingAfter(500);
  pgrepAnswers(0);
  const { run, token } = await runningRun();
  const started = await postEvent(token, {
    runId: run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  expect(started.status).toBe(201);
  await untilLaterRunWoke();
  expect(pgrepsOf(run.id)).toEqual([]);
});

// run.started also moves the run off `starting`; a claude.* event leaves the status alone
test("a run still starting that has an event beyond a warning and a heartbeat is not woken", async () => {
  wakingAfter(500);
  pgrepAnswers(0);
  const { agent, run, token } = await runningRun();
  const message = await postEvent(token, {
    runId: run.id,
    type: "claude.Message",
    payload: { text: "reading the test" },
  });
  expect(message.status).toBe(201);
  expect((await getRun(agent.id, run.id)).body).toMatchObject({
    status: "starting",
  });
  await untilLaterRunWoke();
  expect(pgrepsOf(run.id)).toEqual([]);
});

test("a wake that finds no runner leaves the run to the launch deadline", async () => {
  wakingAfter(150);
  pgrepAnswers(1);
  const { agent, run, envId } = await runningRun();
  await vi.waitFor(() => expect(pgreps()).toHaveLength(1));
  await vi.waitFor(() =>
    expect(logs.some((l) => l.includes("no runner found"))).toBe(true),
  );
  expect((await getRun(agent.id, run.id)).body).toMatchObject({
    status: "starting",
  });
  const deadline = config.launchDeadlineMs;
  expect(
    failUnlaunchedRuns(db, deadline, Date.now() + deadline - 60_000),
  ).toEqual([]);
  expect((await getRun(agent.id, run.id)).body).toMatchObject({
    status: "starting",
  });
  expect(
    failUnlaunchedRuns(db, deadline, Date.now() + deadline + 1000),
  ).toEqual([{ runId: run.id, spriteName: spriteNameFor(envId) }]);
  expect((await getRun(agent.id, run.id)).body).toMatchObject({
    status: "failed",
    error: "launch_timeout",
  });
});

test("a run that ended before the delay is not woken", async () => {
  wakingAfter(500);
  pgrepAnswers(0);
  const { run } = await runningRun();
  db.$client
    .prepare("update runs set status = 'failed' where id = ?")
    .run(run.id);
  await untilLaterRunWoke();
  expect(pgrepsOf(run.id)).toEqual([]);
});

test("a wake whose pgrep the Sprites API fails is logged, holds the sprite again and leaves the run alone", async () => {
  const unhandled: unknown[] = [];
  const onRejection = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    wakingAfter(150);
    wire.hangs = (call) => call.includes(" pgrep ");
    wire.hangMs = 10;
    const { agent, run, envId } = await runningRun();
    const failed = `waking ${spriteNameFor(envId)} for ${run.id} failed: `;
    await vi.waitFor(() =>
      expect(logs.some((l) => l.startsWith(failed))).toBe(true),
    );
    // a sprite that couldn't be read may still hold a frozen runner
    await vi.waitFor(() => expect(holdsOf(run.id)).toHaveLength(2), {
      timeout: 5000,
    });
    // unhandled rejections surface after the microtasks drain
    await new Promise((r) => setImmediate(r));
    expect(unhandled).toEqual([]);
    expect(eventsOf(run.id)).toEqual([]);
    expect((await getRun(agent.id, run.id)).body).toMatchObject({
      status: "starting",
    });
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});

/**
 * A prober over the stub sprites; `nudges` counts its dispatcher nudges. `sprites` is the ops it
 * probes through, wired as `boot` wires them: an exec on it that exits 137 probes the sprite's runs,
 * and names the sprite in `execsKilled`; `probed` holds each such probe, to await its settling.
 */
function proberOver(secrets = new KnownSecrets()) {
  const nudges = { count: 0 };
  const execsKilled: string[] = [];
  const probed: Promise<void>[] = [];
  const sprites: SpriteOps = {
    client: new SpritesClient(spritesToken),
    log: () => {},
    secrets,
    timeoutMs: SPRITES_TIMEOUT_MS,
    longTimeoutMs: config.spritesLongTimeoutMs,
    onExecKilled: (name) => {
      execsKilled.push(name);
      probed.push(prober.probeSprite(name));
    },
  };
  const prober = createRunProber({
    db,
    sprites,
    probeMs: config.runProbeMs,
    lowMemoryMb: config.spriteMinFreeMb,
    log: (line) => logs.push(line),
    nudgeDeliveries: () => {
      nudges.count++;
    },
  });
  return { prober, nudges, sprites, execsKilled, probed };
}

/** Makes `pgrep` on the stub sprite answer `exitCode` (0 found a runner, 1 none, 2 an error of its own). */
const pgrepAnswers = (exitCode: number, during?: () => void) => {
  const exec = wire.exec;
  wire.exec = (argv) => {
    if (argv[0] !== "pgrep") return exec(argv);
    during?.();
    return { exitCode, stderr: exitCode > 1 ? "pgrep: boom\n" : "" };
  };
};
const pgreps = () => wire.calls.filter((c) => c.includes(" pgrep "));
const eventsOf = (runId: string) =>
  db.$client
    .prepare("select type, payload from events where run_id = ? order by id")
    .all(runId) as { type: string; payload: string }[];
const silentFor = (ms: number) => Date.now() + ms;

test("a run silent past the probe window whose runner is alive gets a run.probed and carries on", async () => {
  const envId = readyEnv();
  const { agent, run, token } = await runningRun(envId);
  await postEvent(token, {
    runId: run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  pgrepAnswers(0);
  const { prober, nudges } = proberOver();
  const sprite = spriteNameFor(envId);
  const silent = config.runProbeMs + 1000;
  await prober.sweep(silentFor(silent));

  expect(pgreps()).toEqual([
    `exec ${sprite} - pgrep -f ${runnerPattern(run.id as RunId)}`,
  ]);
  const probed = eventsOf(run.id).filter((e) => e.type === "run.probed");
  expect(probed).toHaveLength(1);
  expect(JSON.parse(probed[0]?.payload ?? "")).toEqual({
    spriteName: sprite,
    silentMs: expect.any(Number),
  });
  expect(nudges.count).toBe(1);
  expect((await getRun(agent.id, run.id)).body.status).toBe("running");
  expect(failStaleRuns(db, config.runTimeoutMs, silentFor(silent))).toEqual([]);
});

test("a run.probed doesn't count as the runner's activity: a runner alive but wedged still times out", async () => {
  const { run, token } = await runningRun();
  await postEvent(token, {
    runId: run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  const probedAt = new Date(silentFor(20 * 60_000)).toISOString();
  db.$client
    .prepare(
      `insert into events (run_id, ts, type, payload) values (?, ?, 'run.probed', '{"spriteName":"s","silentMs":1}')`,
    )
    .run(run.id, probedAt);
  expect(
    failStaleRuns(
      db,
      config.runTimeoutMs,
      silentFor(config.runTimeoutMs + 1000),
    ),
  ).toEqual([run.id]);
});

test("a runner.warning doesn't count as the runner's activity: a flapping sprite hold can't keep a wedged run alive", async () => {
  const { run, token } = await runningRun();
  await postEvent(token, {
    runId: run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  insertEvent(run.id, "runner.warning", silentFor(20 * 60_000), {
    message: "holding the sprite failed",
  });
  expect(
    failStaleRuns(
      db,
      config.runTimeoutMs,
      silentFor(config.runTimeoutMs + 1000),
    ),
  ).toEqual([run.id]);
});

test("a run silent past the probe window whose runner is gone fails at once with runner_lost naming the sprite, freeing the agent for a follow-up", async () => {
  const envId = readyEnv({ concurrency: 1 });
  const { agent, run, token } = await runningRun(envId);
  await postEvent(token, {
    runId: run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  pgrepAnswers(1);
  const { prober, nudges } = proberOver();
  const silent = config.runProbeMs + 1000;
  // far inside the run timeout, which would only fail it as runner_timeout
  expect(silent).toBeLessThan(config.runTimeoutMs);
  await prober.sweep(silentFor(silent));

  const failed = (await getRun(agent.id, run.id)).body;
  expect(failed).toMatchObject({ status: "failed" });
  expect(failed.error).toMatch(/^runner_lost: /);
  expect(failed.error).toContain(spriteNameFor(envId));
  expect(nudges.count).toBe(1);
  expect(logs).toContain(
    `run ${run.id} failed: runner_lost on sprite ${spriteNameFor(envId)}`,
  );
  const again = await followUp(agent.id, { prompt: "carry on" });
  expect(again.status).toBe(202);
  await sessionOpened(2);
});

test("a run silent for less than the probe window is not probed", async () => {
  const { run, token } = await runningRun();
  await postEvent(token, {
    runId: run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  pgrepAnswers(1);
  const { prober } = proberOver();
  await prober.sweep(silentFor(config.runProbeMs - 1000));
  expect(pgreps()).toEqual([]);
});

test("only a running run is probed: a waiting or starting one is left to its own deadlines", async () => {
  const { run, token } = await runningRun();
  // still starting: no event yet
  pgrepAnswers(1);
  const { prober } = proberOver();
  await prober.sweep(silentFor(config.runProbeMs + 1000));
  expect(pgreps()).toEqual([]);
  await postEvent(token, {
    runId: run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  await postEvent(token, {
    runId: run.id,
    type: "run.waiting",
    payload: {
      request: {
        kind: "question",
        requestId: `req_${"a".repeat(22)}`,
        prompt: "which?",
      },
    },
  });
  await prober.sweep(silentFor(config.runProbeMs + 1000));
  expect(pgreps()).toEqual([]);
});

test("a run is probed at most once per window, however many sweeps, and again in the next", async () => {
  const { run, token } = await runningRun();
  await postEvent(token, {
    runId: run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  pgrepAnswers(0);
  const { prober } = proberOver();
  const window = config.runProbeMs;
  const first = Date.now() + window + 1000;
  await prober.sweep(first);
  await prober.sweep(first + 60_000);
  await prober.sweep(first + 120_000);
  expect(pgreps()).toHaveLength(1);
  expect(eventsOf(run.id).filter((e) => e.type === "run.probed")).toHaveLength(
    1,
  );
  // the probe's event started a new window, measured from when it was recorded
  await prober.sweep(Date.now() + 2 * window + 2000);
  expect(pgreps()).toHaveLength(2);
});

test("a sprite that can't answer the probe is logged, not held against the run, and tried again a window later", async () => {
  const { agent, run, token } = await runningRun();
  await postEvent(token, {
    runId: run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  pgrepAnswers(2);
  const { prober, nudges } = proberOver();
  const window = config.runProbeMs;
  await prober.sweep(Date.now() + window + 1000);
  await prober.sweep(Date.now() + window + 61_000);
  expect(pgreps()).toHaveLength(1);
  expect(logs.some((l) => l.includes(`probing the runner of ${run.id}`))).toBe(
    true,
  );
  expect((await getRun(agent.id, run.id)).body.status).toBe("running");
  expect(nudges.count).toBe(0);
  await prober.sweep(Date.now() + 2 * window + 2000);
  expect(pgreps()).toHaveLength(2);
});

test("a slow sprite is probed once while it wakes, and the sweep that started the probe doesn't wait on it", async () => {
  const { run, token } = await runningRun();
  await postEvent(token, {
    runId: run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  pgrepAnswers(0);
  wire.hangs = (call) => call.includes(" pgrep ");
  wire.hangMs = 300;
  const { prober } = proberOver();
  const now = Date.now() + config.runProbeMs + 1000;
  const slow = prober.sweep(now);
  await vi.waitFor(() => expect(pgreps()).toHaveLength(1));
  // the next sweep finds the probe in flight and starts none
  await prober.sweep(now + 60_000);
  expect(pgreps()).toHaveLength(1);
  await slow;
});

test("a sweep whose lookup of silent runs fails logs it and resolves instead of throwing", async () => {
  const busy = vi.spyOn(db, "select").mockImplementationOnce(() => {
    throw new Error("SQLITE_BUSY: database is locked");
  });
  try {
    const { prober } = proberOver();
    let swept: Promise<void> | undefined;
    expect(() => {
      swept = prober.sweep(silentFor(config.runProbeMs + 1000));
    }).not.toThrow();
    await expect(swept).resolves.toBeUndefined();
  } finally {
    busy.mockRestore();
  }
  expect(logs).toContain(
    "finding the silent runs to probe failed: Error: SQLITE_BUSY: database is locked",
  );
});

test("a probe on a sprite that no longer exists fails the run at once with runner_lost, freeing the agent", async () => {
  const envId = readyEnv({ concurrency: 1 });
  const { agent, run, token } = await runningRun(envId);
  await postEvent(token, {
    runId: run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  const sprite = spriteNameFor(envId);
  wire.sprites.delete(sprite);
  const { prober, nudges } = proberOver();
  await prober.sweep(silentFor(config.runProbeMs + 1000));

  expect(runStatus(run.id)).toEqual({ status: "failed" });
  expect(runFailure(run.id)).toBe(
    `runner_lost: its runner is gone from sprite ${sprite}`,
  );
  expect(
    db.$client.prepare("select status from agents where id = ?").get(agent.id),
  ).toEqual({ status: "idle" });
  expect(nudges.count).toBe(1);
  expect(logs).toContain(
    `run ${run.id} failed: runner_lost on sprite ${sprite}`,
  );
  // there is nothing to read from a sprite that is gone, so no diagnostics report is stored
  expect(warningsOf(run.id)).toEqual([]);
});

const freeOutput = (availableMb: number, totalMb = 16_000) =>
  `               total        used        free      shared  buff/cache   available
Mem:           ${totalMb}        9019        1500         100        5000        ${availableMb}
Swap:              0           0           0
`;

// the stub sprite's uptime when its diagnostics are taken; `dmesg` stamps kill lines in seconds since boot
const SPRITE_UPTIME_SEC = 90_000;
/** A kill line as `dmesg` prints it, `agoSec` before the diagnostics were taken. */
const kernelLine = (agoSec: number, text: string) =>
  `[${(SPRITE_UPTIME_SEC - agoSec).toFixed(6)}] ${text}`;

/** What the sprite's diagnostics script writes for a sprite with `availableMb` free. */
const diagnosticsReport = ({
  availableMb,
  ps = "4242 1 3100000 12:03 node server.js",
  kernel = [],
}: {
  availableMb: number;
  ps?: string;
  kernel?: string[];
}) =>
  `== free -m
${freeOutput(availableMb)}== uptime
 17:03:01 up 1 day,  1:00,  0 users,  load average: 9.10, 4.20, 1.70
== seconds since boot
${SPRITE_UPTIME_SEC}.00
== top processes by RSS (pid ppid rss_kb elapsed command)
${ps}
== kernel kills
${kernel.join("\n")}
`;

/** The stub sprite's answer to the diagnostics script: `report` in the file the script is told to write. */
const diagnosticsAnswer = (report: string) => {
  const exec = wire.exec;
  wire.exec = (argv) => {
    if (argv[0] !== "bash" || !argv[2]?.includes("== free -m"))
      return exec(argv);
    wire.files.set(argv[4] ?? "", new TextEncoder().encode(report));
    return { exitCode: 0 };
  };
};

/** Makes `free -m` on the stub sprite report `availableMb` available. */
const freeAnswers = (availableMb: number) => {
  const exec = wire.exec;
  wire.exec = (argv) =>
    argv[0] === "free"
      ? { exitCode: 0, stdout: freeOutput(availableMb) }
      : exec(argv);
};

const warningsOf = (runId: string) =>
  eventsOf(runId)
    .filter((e) => e.type === "runner.warning")
    .map((e) => (JSON.parse(e.payload) as { message: string }).message);

test("a runner found gone has its sprite's diagnostics collected, redacted, logged and stored on the run before it fails", async () => {
  const envId = readyEnv();
  const { run, token } = await runningRun(envId);
  await postEvent(token, {
    runId: run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  pgrepAnswers(1);
  diagnosticsAnswer(
    diagnosticsReport({
      availableMb: 5_000,
      ps: "4242 1 3100000 12:03 node server.js --token hunter2-hunter2",
    }),
  );
  const secrets = new KnownSecrets();
  secrets.add("PROJECT_TOKEN", "hunter2-hunter2");
  const { prober } = proberOver(secrets);
  await prober.sweep(silentFor(config.runProbeMs + 1000));

  const sprite = spriteNameFor(envId);
  const [message] = warningsOf(run.id);
  expect(message).toContain(`diagnostics of sprite ${sprite}`);
  for (const part of [
    "== free -m",
    "Mem:",
    "== uptime",
    "load average",
    "== top processes by RSS",
    "node server.js",
    "== kernel kills",
  ]) {
    expect(message).toContain(part);
  }
  expect(message).not.toContain("hunter2");
  expect(logs).toContain(`run ${run.id}: ${message}`);
  // plenty of memory and no kill line: lost, not killed
  expect(runFailure(run.id)).toBe(
    `runner_lost: its runner is gone from sprite ${sprite}`,
  );
  // the diagnostics land before the failure, which ends the run
  expect(
    eventsOf(run.id)
      .map((e) => e.type)
      .slice(-2),
  ).toEqual(["runner.warning", "run.failed"]);
});

test("the diagnostics stored on a run are bounded below what an event holds", async () => {
  const { run, token } = await runningRun();
  await postEvent(token, {
    runId: run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  pgrepAnswers(1);
  diagnosticsAnswer(
    diagnosticsReport({ availableMb: 5_000, ps: "x".repeat(20_000) }),
  );
  const { prober } = proberOver();
  await prober.sweep(silentFor(config.runProbeMs + 1000));

  const [message] = warningsOf(run.id);
  expect(message?.length).toBeLessThan(EVENT_TEXT_MAX);
  expect(message).toMatch(/\d+ characters omitted/);
  expect(runStatus(run.id)).toEqual({ status: "failed" });
});

test("a sprite that can't give its diagnostics still fails the run, saying so in the stored report", async () => {
  const envId = readyEnv();
  const { run, token } = await runningRun(envId);
  await postEvent(token, {
    runId: run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  pgrepAnswers(1);
  const exec = wire.exec;
  wire.exec = (argv) =>
    argv[0] === "bash" && argv[2]?.includes("== free -m")
      ? { exitCode: 3, stderr: "bash: boom\n" }
      : exec(argv);
  const { prober } = proberOver();
  await prober.sweep(silentFor(config.runProbeMs + 1000));

  expect(warningsOf(run.id)[0]).toContain("diagnostics unavailable: exit 3");
  expect(runFailure(run.id)).toBe(
    `runner_lost: its runner is gone from sprite ${spriteNameFor(envId)}`,
  );
});

test("a runner gone after the kernel logged a kill fails as runner_killed, naming the sprite and the memory it had", async () => {
  const envId = readyEnv();
  const { run, token } = await runningRun(envId);
  await postEvent(token, {
    runId: run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  pgrepAnswers(1);
  diagnosticsAnswer(
    diagnosticsReport({
      availableMb: 5_000,
      kernel: [
        kernelLine(
          0,
          "Out of memory: Killed process 3912 (node) total-vm:9012344kB",
        ),
      ],
    }),
  );
  const { prober, nudges } = proberOver();
  await prober.sweep(silentFor(config.runProbeMs + 1000));

  const sprite = spriteNameFor(envId);
  const error = runFailure(run.id);
  expect(error).toMatch(
    /^runner_killed: the sprite killed the runner, likely out of memory/,
  );
  expect(error).toContain(sprite);
  expect(error).toContain("5000 MB of 16000 MB available");
  expect(logs).toContain(
    `run ${run.id} failed: runner_killed on sprite ${sprite}`,
  );
  expect(nudges.count).toBe(1);
});

test("a runner gone after an earlier run's process was killed for memory is runner_lost: only a kill since the run began counts", async () => {
  const envId = readyEnv();
  const { run, token } = await runningRun(envId);
  await postEvent(token, {
    runId: run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  pgrepAnswers(1);
  const old = kernelLine(
    5 * 3600,
    "Out of memory: Killed process 812 (node) total-vm:9012344kB",
  );
  diagnosticsAnswer(diagnosticsReport({ availableMb: 5_000, kernel: [old] }));
  const { prober } = proberOver();
  await prober.sweep(silentFor(config.runProbeMs + 1000));

  expect(runFailure(run.id)).toBe(
    `runner_lost: its runner is gone from sprite ${spriteNameFor(envId)}`,
  );
  // still in the stored report, for whoever reads it
  expect(warningsOf(run.id)[0]).toContain(old);
});

test("a runner gone from a sprite with less memory available than the floor is runner_killed though dmesg can't be read", async () => {
  const envId = readyEnv();
  const { run, token } = await runningRun(envId);
  await postEvent(token, {
    runId: run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  pgrepAnswers(1);
  diagnosticsAnswer(
    diagnosticsReport({
      availableMb: config.spriteMinFreeMb - 1,
      kernel: ["dmesg not readable"],
    }),
  );
  const { prober } = proberOver();
  await prober.sweep(silentFor(config.runProbeMs + 1000));

  expect(runFailure(run.id)).toMatch(
    /^runner_killed: the sprite killed the runner, likely out of memory/,
  );
  expect(runFailure(run.id)).toContain(spriteNameFor(envId));
  expect(runFailure(run.id)).toContain(`${config.spriteMinFreeMb - 1} MB of`);
});

test("a runner gone from a sprite with memory at the floor and no kill line is runner_lost", async () => {
  const envId = readyEnv();
  const { run, token } = await runningRun(envId);
  await postEvent(token, {
    runId: run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  pgrepAnswers(1);
  diagnosticsAnswer(
    diagnosticsReport({
      availableMb: config.spriteMinFreeMb,
      kernel: ["dmesg not readable"],
    }),
  );
  const { prober } = proberOver();
  await prober.sweep(silentFor(config.runProbeMs + 1000));
  expect(runFailure(run.id)).toBe(
    `runner_lost: its runner is gone from sprite ${spriteNameFor(envId)}`,
  );
});

test("the diagnostics file is removed from the sprite even when reading it back fails", async () => {
  const envId = readyEnv();
  const { run, token } = await runningRun(envId);
  await postEvent(token, {
    runId: run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  pgrepAnswers(1);
  const exec = wire.exec;
  // the script exits 0 but the file can't be read: the read answers 404
  wire.exec = (argv) =>
    argv[0] === "bash" && argv[2]?.includes("== free -m")
      ? { exitCode: 0 }
      : exec(argv);
  const { prober } = proberOver();
  await prober.sweep(silentFor(config.runProbeMs + 1000));

  expect(warningsOf(run.id)[0]).toContain("diagnostics unavailable");
  const path = `/tmp/sky-diagnostics-${run.id}.txt`;
  await vi.waitFor(() =>
    expect(wire.calls).toContain(
      `exec ${spriteNameFor(envId)} - rm -f ${path}`,
    ),
  );
});

test("an exec on a sprite exiting 137 probes its running runs at once: a run whose runner is gone fails as runner_killed without waiting out the window", async () => {
  const envId = readyEnv({ concurrency: 2 });
  const first = await runningRun(envId);
  const second = await runningRun(envId);
  const elsewhere = await runningRun();
  for (const { run, token } of [first, second, elsewhere]) {
    await postEvent(token, {
      runId: run.id,
      type: "run.started",
      payload: { sessionId: "s" },
    });
  }
  pgrepAnswers(1);
  diagnosticsAnswer(
    diagnosticsReport({
      availableMb: 200,
      kernel: [kernelLine(0, "Out of memory: Killed process 77 (node)")],
    }),
  );
  const exec = wire.exec;
  // the wake exec of the incident, as the kernel's kill leaves it
  wire.exec = (argv) => (argv[0] === "true" ? { exitCode: 137 } : exec(argv));
  const { prober, sprites, probed } = proberOver();
  // nothing has been silent for a window yet, so a sweep probes nothing
  await prober.sweep();
  expect(pgreps()).toEqual([]);

  const woken = await execInSprite(sprites, spriteNameFor(envId), ["true"], {
    op: "wake",
  });
  expect(woken.exitCode).toBe(137);

  await Promise.all(probed);
  expect(runStatus(first.run.id)).toEqual({ status: "failed" });
  expect(runStatus(second.run.id)).toEqual({ status: "failed" });
  expect(runFailure(first.run.id)).toMatch(/^runner_killed: /);
  expect(runFailure(second.run.id)).toContain(spriteNameFor(envId));
  // the run on another sprite was not probed
  expect(runStatus(elsewhere.run.id)).toEqual({ status: "running" });
  expect(pgreps()).toHaveLength(2);
  expect(
    logs.some((l) =>
      l.includes(`an exec on ${spriteNameFor(envId)} was killed`),
    ),
  ).toBe(true);
});

test("an exec exiting 137 that finds the runner alive leaves the run alone and records nothing", async () => {
  const envId = readyEnv();
  const { agent, run, token } = await runningRun(envId);
  await postEvent(token, {
    runId: run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  pgrepAnswers(0);
  const exec = wire.exec;
  wire.exec = (argv) => (argv[0] === "true" ? { exitCode: 137 } : exec(argv));
  const { sprites, nudges, probed } = proberOver();
  const before = eventsOf(run.id).length;
  await execInSprite(sprites, spriteNameFor(envId), ["true"], { op: "wake" });
  // the probe has handled pgrep's answer, not just sent the request, before anything is asserted
  expect(probed).toHaveLength(1);
  await Promise.all(probed);
  expect(pgreps()).toHaveLength(1);

  expect((await getRun(agent.id, run.id)).body.status).toBe("running");
  expect(eventsOf(run.id)).toHaveLength(before);
  expect(nudges.count).toBe(0);
});

test("a probe's own exec exiting 137 never starts another probe", async () => {
  const envId = readyEnv({ concurrency: 2 });
  const first = await runningRun(envId);
  const second = await runningRun(envId);
  for (const { run, token } of [first, second]) {
    await postEvent(token, {
      runId: run.id,
      type: "run.started",
      payload: { sessionId: "s" },
    });
  }
  const exec = wire.exec;
  // the first run's pgrep is killed; the second's runner is gone and its diagnostics are killed
  wire.exec = (argv) => {
    if (argv[0] === "pgrep") {
      return {
        exitCode:
          argv.at(-1) === runnerPattern(first.run.id as RunId) ? 137 : 1,
      };
    }
    if (argv[0] === "bash" && argv[2]?.includes("== free -m")) {
      return { exitCode: 137 };
    }
    return exec(argv);
  };
  const { prober, execsKilled } = proberOver();
  await prober.probeSprite(spriteNameFor(envId));

  expect(execsKilled).toEqual([]);
  expect(pgreps()).toHaveLength(2);
  expect(runStatus(first.run.id)).toEqual({ status: "running" });
  expect(runFailure(second.run.id)).toMatch(/^runner_lost: /);
});

test("a sprite is probed for a killed exec once at a time: another 137 while that probe runs starts none", async () => {
  const envId = readyEnv({ concurrency: 2 });
  const first = await runningRun(envId);
  await postEvent(first.token, {
    runId: first.run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  const second = await runningRun(envId);
  pgrepAnswers(0);
  wire.hangs = (call) => call.includes(" pgrep ");
  wire.hangMs = 300;
  const { prober } = proberOver();
  const sprite = spriteNameFor(envId);
  const probing = prober.probeSprite(sprite);
  await vi.waitFor(() => expect(pgreps()).toHaveLength(1));
  await postEvent(second.token, {
    runId: second.run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  await prober.probeSprite(sprite);
  await probing;
  expect(pgreps()).toHaveLength(1);
});

test("an exec exiting 137 probes only running runs: a starting run is left to its launch deadline", async () => {
  const envId = readyEnv();
  const { agent } = await launched(envId);
  await sessionOpened();
  pgrepAnswers(1);
  const exec = wire.exec;
  wire.exec = (argv) => (argv[0] === "true" ? { exitCode: 137 } : exec(argv));
  const { prober } = proberOver();
  await prober.probeSprite(spriteNameFor(envId));
  expect(pgreps()).toEqual([]);
  expect(
    db.$client.prepare("select status from agents where id = ?").get(agent.id),
  ).toEqual({ status: "running" });
});

test("a launch on a sprite with less memory available than the floor is refused with sprite_low_memory saying how much is free, and starts nothing", async () => {
  const envId = readyEnv();
  freeAnswers(500);
  const { agent, run } = await launched(envId);
  await vi.waitFor(async () =>
    expect((await getRun(agent.id, run.id)).body.status).toBe("failed"),
  );

  const sprite = spriteNameFor(envId);
  const error = runFailure(run.id);
  expect(error).toMatch(/^sprite_low_memory: /);
  expect(error).toContain(sprite);
  expect(error).toContain("500 MB of memory available (of 16000 MB)");
  expect(error).toContain("1024 MB floor");
  expect(wire.sessions).toHaveLength(0);
  expect(wire.calls.some((c) => c.startsWith("write "))).toBe(false);
  expect(
    db.$client.prepare("select status from agents where id = ?").get(agent.id),
  ).toEqual({ status: "idle" });
  // the refused agent is free for a follow-up once memory is back
  freeAnswers(4_000);
  const again = await followUp(agent.id, { prompt: "try again" });
  expect(again.status).toBe(202);
  await sessionOpened();
});

test("a runner gone after a kill line, from a sprite whose memory the report can't give, fails as runner_killed saying so", async () => {
  const envId = readyEnv();
  const { run, token } = await runningRun(envId);
  await postEvent(token, {
    runId: run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  pgrepAnswers(1);
  diagnosticsAnswer(
    diagnosticsReport({
      availableMb: 5_000,
      kernel: [kernelLine(0, "Out of memory: Killed process 3912 (node)")],
    }).replace(freeOutput(5_000), "free: not found\n"),
  );
  const { prober } = proberOver();
  await prober.sweep(silentFor(config.runProbeMs + 1000));

  expect(runFailure(run.id)).toBe(
    `runner_killed: the sprite killed the runner, likely out of memory (sprite ${spriteNameFor(envId)}: its free memory could not be read)`,
  );
});

test("a runner gone from a sprite that can't run the diagnostics at all is runner_lost, the report saying why", async () => {
  const envId = readyEnv();
  const { run, token } = await runningRun(envId);
  await postEvent(token, {
    runId: run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  pgrepAnswers(1);
  // the Sprites API hangs on the diagnostics exec only, then answers 503
  wire.hangs = (call) => call.includes(" bash ");
  wire.hangMs = 10;
  const { prober } = proberOver();
  await prober.sweep(silentFor(config.runProbeMs + 1000));

  expect(warningsOf(run.id)[0]).toMatch(/diagnostics unavailable: .+/);
  expect(runFailure(run.id)).toBe(
    `runner_lost: its runner is gone from sprite ${spriteNameFor(envId)}`,
  );
});

test("a launch exec exiting 137 on a booted app probes the sprite's running runs, so a runner the kernel killed fails as runner_killed", async () => {
  mkdirSync(join(dir, "data"));
  const booted = boot(
    testConfig({
      dataDir: join(dir, "data"),
      runnerBundlePath: join(dir, "runner.mjs"),
    }),
    (line) => logs.push(line),
  );
  try {
    // the helpers drive `app` and read `db`: both are now the booted ones
    db.$client.close();
    db = booted.db;
    app = booted.app;
    const envId = readyEnv({ concurrency: 2 });
    const first = await runningRun(envId);
    await postEvent(first.token, {
      runId: first.run.id,
      type: "run.started",
      payload: { sessionId: "s" },
    });
    pgrepAnswers(1);
    diagnosticsAnswer(
      diagnosticsReport({
        availableMb: 200,
        kernel: [kernelLine(0, "Out of memory: Killed process 77 (node)")],
      }),
    );
    const exec = wire.exec;
    wire.exec = (argv) => (argv[0] === "free" ? { exitCode: 137 } : exec(argv));
    // a second launch on the sprite: its memory check is the exec the kernel kills
    await launched(envId);

    await vi.waitFor(() =>
      expect(runStatus(first.run.id)).toEqual({ status: "failed" }),
    );
    expect(runFailure(first.run.id)).toMatch(/^runner_killed: /);
    expect(pgreps()).toEqual([
      `exec ${spriteNameFor(envId)} - pgrep -f ${runnerPattern(first.run.id as RunId)}`,
    ]);
  } finally {
    booted.stopSweeping();
    booted.stopDelivering();
  }
});

test("a launch on a sprite with one MB less than the floor is refused, where the floor itself is not", async () => {
  const envId = readyEnv();
  freeAnswers(config.spriteMinFreeMb - 1);
  const { agent, run } = await launched(envId);
  await vi.waitFor(async () =>
    expect((await getRun(agent.id, run.id)).body.status).toBe("failed"),
  );
  expect(runFailure(run.id)).toContain(
    `${config.spriteMinFreeMb - 1} MB of memory available`,
  );
  expect(runFailure(run.id)).toMatch(/^sprite_low_memory: /);
  expect(wire.sessions).toHaveLength(0);
});

test("a launch on a sprite with memory at or above the floor goes ahead", async () => {
  const envId = readyEnv();
  freeAnswers(config.spriteMinFreeMb);
  const { run } = await launched(envId);
  await sessionOpened();
  expect(wire.calls[0]).toBe(`exec ${spriteNameFor(envId)} - free -m`);
  expect(runStatus(run.id)).toEqual({ status: "starting" });
});

test("a floor of 0 turns the launch memory check off", async () => {
  config = testConfig({
    runnerBundlePath: join(dir, "runner.mjs"),
    spriteMinFreeMb: 0,
  });
  app = createApp({
    db,
    config,
    sprites: new SpritesClient(spritesToken),
    log: (line) => logs.push(line),
    nudgeDeliveries: () => {},
    launchWatchMs: 50,
  });
  const envId = readyEnv();
  freeAnswers(10);
  await launched(envId);
  await sessionOpened();
  expect(wire.calls.some((c) => c.includes(" free "))).toBe(false);
});

test("a launch on a sprite whose memory can't be read goes ahead and logs it", async () => {
  const envId = readyEnv();
  const exec = wire.exec;
  wire.exec = (argv) =>
    argv[0] === "free"
      ? { exitCode: 127, stderr: "free: not found\n" }
      : exec(argv);
  const { run } = await launched(envId);
  await sessionOpened();
  expect(logs).toContain(
    `launching ${run.id}: the memory of ${spriteNameFor(envId)} could not be read; launching anyway`,
  );
});

test("a launch on a sprite reporting more page cache than memory goes ahead and logs it", async () => {
  const envId = readyEnv();
  const exec = wire.exec;
  wire.exec = (argv) =>
    argv[0] === "free"
      ? {
          exitCode: 0,
          stdout: `               total        used        free      shared  buff/cache   available
Mem:            8192        8192           0           0        8922           0
Swap:              0           0           0
`,
        }
      : exec(argv);
  const { run } = await launched(envId);
  await sessionOpened();
  expect(logs).toContain(
    `launching ${run.id}: the memory of ${spriteNameFor(envId)} could not be read; launching anyway`,
  );
});

test("a launch whose memory read fails at the Sprites API goes ahead and logs it", async () => {
  const envId = readyEnv();
  server.use(
    http.post("https://api.sprites.dev/v1/sprites/:name/exec", ({ request }) =>
      new URL(request.url).searchParams.get("cmd") === "free"
        ? HttpResponse.json({ error: "upstream unavailable" }, { status: 503 })
        : undefined,
    ),
  );
  const { run } = await launched(envId);
  await sessionOpened();
  expect(runStatus(run.id)).toEqual({ status: "starting" });
  expect(
    logs.some((l) =>
      l.startsWith(
        `launching ${run.id}: reading the memory of ${spriteNameFor(envId)} failed: `,
      ),
    ),
  ).toBe(true);
});

test("a probe that fails while the sprite lookup also fails is logged and leaves the run running", async () => {
  const { agent, run, token, envId } = await runningRun();
  await postEvent(token, {
    runId: run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  pgrepAnswers(2);
  server.use(
    http.get("https://api.sprites.dev/v1/sprites/:name", () =>
      HttpResponse.json({ error: "upstream unavailable" }, { status: 503 }),
    ),
  );
  const { prober, nudges } = proberOver();
  await prober.sweep(silentFor(config.runProbeMs + 1000));
  expect((await getRun(agent.id, run.id)).body.status).toBe("running");
  expect(nudges.count).toBe(0);
  expect(
    logs.some((l) =>
      l.startsWith(
        `checking whether sprite ${spriteNameFor(envId)} exists after probing ${run.id} failed: `,
      ),
    ),
  ).toBe(true);
});

test("a runner that spoke while the probe was running is not failed as lost", async () => {
  const { agent, run, token } = await runningRun();
  await postEvent(token, {
    runId: run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  // pgrep finds nothing, but the runner's event lands as it runs; its timestamp is an hour old, so
  // only its id, higher than the run's latest when the probe began, says it came after
  pgrepAnswers(1, () => {
    db.$client
      .prepare(
        "insert into events (run_id, ts, type, payload) values (?, ?, 'claude.Message', '{\"text\":\"hi\"}')",
      )
      .run(run.id, new Date(Date.now() - 3_600_000).toISOString());
  });
  const { prober } = proberOver();
  await prober.sweep(silentFor(config.runProbeMs + 1000));
  expect((await getRun(agent.id, run.id)).body.status).toBe("running");
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
    isDiff(argv) ? { exitCode: 0, stdout: patch } : { exitCode: 0 };
  expect((await getRun(agent.id, run.id)).body).toMatchObject({
    id: run.id,
    summary: "added the test",
    diff: patch,
  });
  // against the base branch, not run 1's end: the diff spans every run on the branch
  expect(lastExec()).toMatch(new RegExp(` sh origin/HEAD claude/${agent.id}$`));
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

/** The stop-lingering exec's argv after the script: `[mode, quietS, termS, pattern]`. */
const stopLingeringArgs = (runId: string) =>
  wire.execUrls
    .map((u) => new URL(u).searchParams.getAll("cmd"))
    .filter((cmd) => cmd[0] === "bash" && cmd.at(-1) === runnerPattern(runId))
    .map((cmd) => cmd.slice(3));

/** Moves the run's terminal event `ms` before now, as though the run ended that long ago. */
const endedAgo = (runId: string, ms: number) =>
  db.$client
    .prepare(
      "update events set ts = ? where run_id = ? and type in ('run.finished', 'run.failed', 'run.stopped')",
    )
    .run(new Date(Date.now() - ms).toISOString(), runId);

// the follow-up may SIGTERM a previous runner only once its run ended this long ago
const SIGNAL_WINDOW_MS = 60_000;

test("a follow-up right after stop waits for the stopped runner; still alive, it gets 409 runner_still_exiting and starts nothing", async () => {
  const { agent, run, envId } = await runningRun();
  expect((await action(agent.id, "stop")).status).toBe(200);
  // the stop's run.stopped carries the real time; this test's own timeout keeps it far inside the window
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
  // the wait is one bash exec on the sprite, bounded by the pre-launch deadline
  const wait = wire.calls.at(-1) ?? "";
  expect(wait.startsWith(`exec ${spriteNameFor(envId)} - bash -c `)).toBe(true);
  // the stop already signalled it: a second SIGTERM would kill it mid-commit, so both waits only wait
  expect(stopLingeringArgs(run.id)).toEqual([
    ["wait", "5", "9", runnerPattern(run.id)],
  ]);

  // the retry the 409 asks for is just as soon after the stop, and waits the same way
  alive = false;
  expect((await followUp(agent.id, { prompt: "go another way" })).status).toBe(
    202,
  );
  expect(stopLingeringArgs(run.id).map(([mode]) => mode)).toEqual([
    "wait",
    "wait",
  ]);
  // the stop's own pkill is the only signal the runner got
  expect(wire.calls.filter((c) => c.includes(" - pkill "))).toHaveLength(1);
  expect(logs.join("\n")).not.toContain("SIGTERMed");
  await sessionOpened(2);
});

test("a follow-up a while after stop waits in term mode: a runner alive that long is wedged, not committing", async () => {
  const { agent, run } = await runningRun();
  expect((await action(agent.id, "stop")).status).toBe(200);
  endedAgo(run.id, SIGNAL_WINDOW_MS + 60_000);
  runnerAlive(run.id, () => false);
  expect((await followUp(agent.id, { prompt: "go another way" })).status).toBe(
    202,
  );
  expect(stopLingeringArgs(run.id)).toEqual([
    ["term", "5", "9", runnerPattern(run.id)],
  ]);
  await sessionOpened(2);
});

test("a follow-up within a minute of the sweep failing a run as quiet only waits for its runner", async () => {
  const { agent, run, token } = await runningRun();
  await postEvent(token, {
    runId: run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  // the sweep's run.failed carries the real time; the boot sweep signals the runner of each run it fails
  expect(failStaleRuns(db, 0, Date.now() + 1000)).toEqual([run.id]);
  runnerAlive(run.id, () => true);
  expect((await followUp(agent.id, { prompt: "carry on" })).status).toBe(409);
  expect(stopLingeringArgs(run.id).map(([mode]) => mode)).toEqual(["wait"]);
});

/** A deadline of `ms` on the sprite calls before a launch, with every other bound at the test default. */
function appWithDeadline(ms: number) {
  app = createApp({
    db,
    config,
    sprites: new SpritesClient(spritesToken),
    log: (line) => logs.push(line),
    nudgeDeliveries: () => {},
    launchWatchMs: 50,
    preLaunchDeadlineMs: ms,
  });
}

test("a follow-up whose previous runner outlived its timed-out run SIGTERMs it, then launches", async () => {
  const { agent, run, envId, token } = await runningRun();
  await postEvent(token, {
    runId: run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  // the sweep failed it as quiet long ago; its runner is still there
  expect(failStaleRuns(db, 0, Date.now() + 1000)).toEqual([run.id]);
  endedAgo(run.id, SIGNAL_WINDOW_MS + 60_000);
  // exit 3: still alive after the quiet wait, gone after the SIGTERM
  const exec = wire.exec;
  wire.exec = (argv) =>
    argv[0] === "bash" && argv.at(-1) === runnerPattern(run.id)
      ? { exitCode: 3 }
      : exec(argv);
  const res = await followUp(agent.id, { prompt: "carry on" });
  expect(res.status).toBe(202);
  const call = wire.calls.find((c) => c.includes('pkill -TERM -f "$3"'));
  expect(call).toContain(`exec ${spriteNameFor(envId)} - bash -c `);
  expect(logs).toContain(`the runner of ${run.id} outlived its run; SIGTERMed`);
  await sessionOpened(2);
});

test("a follow-up whose previous runner won't exit even after the SIGTERM gets 409 runner_still_exiting", async () => {
  appWithDeadline(30_000);
  const { agent, run } = await finishedRun();
  endedAgo(run.id, SIGNAL_WINDOW_MS + 60_000);
  runnerAlive(run.id, () => true);
  const res = await followUp(agent.id, { prompt: "again" });
  expect(stopLingeringArgs(run.id).map(([mode]) => mode)).toEqual(["term"]);
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({
    error: { code: "runner_still_exiting" },
  });
  expect(db.$client.prepare("select count(*) n from runs").get()).toEqual({
    n: 1,
  });
});

/** Every stop-lingering exec's argv after the script, whichever run's runner it waits on. */
const stopLingeringExecs = () =>
  wire.execUrls
    .map((u) => new URL(u).searchParams.getAll("cmd"))
    .filter(
      (cmd) => cmd[0] === "bash" && ["term", "wait"].includes(cmd[3] ?? ""),
    )
    .map((cmd) => cmd.slice(3));

test("a follow-up whose previous runner is already gone launches after one wait and logs no SIGTERM", async () => {
  const { agent, run } = await finishedRun();
  endedAgo(run.id, SIGNAL_WINDOW_MS + 60_000);
  runnerAlive(run.id, () => false);
  expect((await followUp(agent.id, { prompt: "carry on" })).status).toBe(202);
  expect(stopLingeringArgs(run.id)).toEqual([
    ["term", "5", "9", runnerPattern(run.id)],
  ]);
  expect(logs.join("\n")).not.toContain("SIGTERMed");
  await sessionOpened(2);
});

test("a follow-up whose wait for the previous runner fails in the script gets 502, logs it and starts nothing", async () => {
  const { agent, run } = await finishedRun();
  const exec = wire.exec;
  wire.exec = (argv) =>
    argv[0] === "bash" && argv.at(-1) === runnerPattern(run.id)
      ? { exitCode: 2, stderr: "pgrep: cannot read /proc\n" }
      : exec(argv);
  const res = await followUp(agent.id, { prompt: "carry on" });
  expect(res.status).toBe(502);
  expect(await res.json()).toMatchObject({
    error: { code: "sprite_unreachable" },
  });
  expect(
    logs.some(
      (l) =>
        l.startsWith(`waiting for the runner of ${run.id} failed:`) &&
        l.includes("exit 2: pgrep: cannot read /proc"),
    ),
  ).toBe(true);
  expect(db.$client.prepare("select count(*) n from runs").get()).toEqual({
    n: 1,
  });
  expect(wire.sessions).toHaveLength(1);
});

test("a follow-up while the previous run is still active waits for no runner", async () => {
  const { agent } = await runningRun();
  const res = await followUp(agent.id, { prompt: "carry on" });
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ error: { code: "agent_busy" } });
  expect(stopLingeringExecs()).toEqual([]);
});

test("a follow-up on an agent that never had a run waits for no runner", async () => {
  const envId = readyEnv();
  const agentId = "agt_norun";
  db.$client
    .prepare(
      "insert into agents (id, env_id, branch, status) values (?, ?, ?, 'idle')",
    )
    .run(agentId, envId, `claude/${agentId}`);
  expect((await followUp(agentId, { prompt: "start" })).status).toBe(202);
  await sessionOpened(1);
  expect(stopLingeringExecs()).toEqual([]);
});

test("a follow-up never takes longer than the deadline: a sprite that stops answering gets the API's own 502, not a client timeout", async () => {
  appWithDeadline(400);
  const { agent } = await finishedRun();
  wire.hangs = (call) => call.includes(" bash -c ");
  const res = await followUp(agent.id, { prompt: "again" });
  expect(res.status).toBe(502);
  expect(await res.json()).toMatchObject({
    error: { code: "sprite_unreachable" },
  });
  expect(logs.join("\n")).toContain("stop-lingering: timed out after 400ms");
  expect(db.$client.prepare("select count(*) n from runs").get()).toEqual({
    n: 1,
  });
  await wire.hangsSettled();
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

test("archive's runner wait and lock wait leave git time inside the rm-worktree exec bound, so a held lock fails naming it", async () => {
  const { agent } = await runningRun();
  await action(agent.id, "archive");
  const removal = wire.calls.at(-1) ?? "";
  const runnerWaitS = Number(removal.match(/\$\(seq (\d+)\)/)?.[1]);
  const lockWaitS = Number(removal.match(/flock -x -w (\d+) /)?.[1]);
  expect(runnerWaitS).toBeGreaterThan(0);
  expect(lockWaitS).toBeGreaterThan(0);
  // rm-worktree passes no timeoutMs, so SPRITES_TIMEOUT_MS bounds it
  const gitRemovalMarginMs = 10_000;
  expect(
    (runnerWaitS + lockWaitS) * 1000 + gitRemovalMarginMs,
  ).toBeLessThanOrEqual(SPRITES_TIMEOUT_MS);
  expect(removal).toContain(`-E ${REPO_LOCK_TIMED_OUT} `);
  expect(removal).toContain(
    `can't take the repo lock /workspace/repo/.git/${REPO_LOCK_FILE} within ${lockWaitS}s`,
  );
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
    remoteBranch: null,
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
    SKY_CLAUDE_AUTH: "oauth",
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
  ["the start branch", { envVars: { START_BRANCH: "main" } }, "reserved_name"],
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

const isBranchCheck = (argv: string[]) =>
  argv[0] === "sh" && argv[2]?.includes(" branch-check ") === true;

/** Answers the runner's `branch-check` with `outcome`; every other exec as the stub does. */
function branchCheckAnswers(outcome: {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}) {
  const fallback = wire.exec;
  const checks: string[][] = [];
  wire.exec = (argv) => {
    if (!isBranchCheck(argv)) return fallback(argv);
    checks.push(argv);
    return outcome;
  };
  return checks;
}

/** A ready env with a GITHUB_CONNECTOR connector secret. */
async function connectedEnv() {
  const envId = readyEnv();
  expect(
    (await putSecret(envId, "GITHUB_CONNECTOR", { connector: "VPpb7x" }))
      .status,
  ).toBe(200);
  return envId;
}

const agentCount = () =>
  db.$client.prepare("select count(*) n from agents").get();

/** Launches on `branch` and ends the run with `rollup`, as `endedWith` does. */
async function finishedOnBranch(branch: string, rollup?: unknown) {
  const envId = await connectedEnv();
  branchCheckAnswers({ exitCode: 0, stdout: `${sha("c")}\n` });
  const res = await launch({ envId, prompt: "go", branch });
  expect(res.status).toBe(202);
  const { agent, run } = (await res.json()) as Launched;
  await sessionOpened();
  const token = envFileOf(wire, wire.sessions[0]).AGENT_TOKEN ?? "";
  await postEvent(token, {
    runId: run.id,
    type: "run.started",
    payload: { sessionId: "s" },
  });
  await postEvent(token, {
    runId: run.id,
    type: "run.finished",
    payload: { summary: "done", usage, ...(rollup ? { rollup } : {}) },
  });
  return { agent, run, envId };
}

test("start with a branch records remoteBranch and passes START_BRANCH to the runner", async () => {
  const envId = await connectedEnv();
  const checks = branchCheckAnswers({ exitCode: 0, stdout: `${sha("c")}\n` });
  const res = await launch({ envId, prompt: "go", branch: "feature/login" });
  expect(res.status).toBe(202);
  const body = (await res.json()) as Launched;
  expect(body.agent).toMatchObject({
    branch: `claude/${body.agent.id}`,
    remoteBranch: "feature/login",
  });
  expect((await getAgent(body.agent.id)).body.remoteBranch).toBe(
    "feature/login",
  );
  expect(checks).toHaveLength(1);
  await sessionOpened();
  expect(wire.sessions[0]?.env.START_BRANCH).toBe("feature/login");
});

test("follow-up runs pass START_BRANCH again", async () => {
  const { agent } = await finishedOnBranch("feature/login");
  expect((await followUp(agent.id, { prompt: "more" })).status).toBe(202);
  await sessionOpened(2);
  expect(wire.sessions[1]?.env.START_BRANCH).toBe("feature/login");
});

test("a follow-up can't redirect the start branch through envVars", async () => {
  const { agent } = await finishedOnBranch("feature/login");
  const res = await followUp(agent.id, {
    prompt: "more",
    envVars: { START_BRANCH: "main" },
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: { code: "reserved_name" } });
  expect(db.$client.prepare("select count(*) n from runs").get()).toEqual({
    n: 1,
  });
});

test("start without a branch is unchanged (remoteBranch null, no preflight exec)", async () => {
  const envId = await connectedEnv();
  const checks = branchCheckAnswers({ exitCode: 0 });
  const { agent } = await launched(envId);
  expect(agent).toMatchObject({ remoteBranch: null });
  await sessionOpened();
  expect(checks).toEqual([]);
  expect(wire.sessions[0]?.env).not.toHaveProperty("START_BRANCH");
});

test("start with a branch that doesn't exist answers 404 branch_not_found and creates no agent", async () => {
  const envId = await connectedEnv();
  branchCheckAnswers({ exitCode: 3 });
  const res = await launch({ envId, prompt: "go", branch: "feature/nope" });
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({
    error: {
      code: "branch_not_found",
      message:
        "branch feature/nope doesn't exist on GitHub (acme/kru); check the name, or start without --branch",
    },
  });
  expect(agentCount()).toEqual({ n: 0 });
  expect(wire.sessions).toEqual([]);
});

test("start with the default branch answers 422 branch_is_default", async () => {
  const envId = await connectedEnv();
  branchCheckAnswers({ exitCode: 4 });
  const res = await launch({ envId, prompt: "go", branch: "main" });
  expect(res.status).toBe(422);
  expect(await res.json()).toMatchObject({
    error: {
      code: "branch_is_default",
      message: expect.stringContaining("omit --branch"),
    },
  });
  expect(agentCount()).toEqual({ n: 0 });
});

test("start with a branch whose check outlasts the deadline answers 502 branch_check_failed", async () => {
  appWithDeadline(300);
  const envId = await connectedEnv();
  wire.hangs = (call) => call.includes(" sh -c ");
  // the check itself isn't cut at the deadline, only answered past it
  wire.hangMs = 600;
  const res = await launch({ envId, prompt: "go", branch: "feature/login" });
  expect(res.status).toBe(502);
  expect(await res.json()).toMatchObject({
    error: {
      code: "branch_check_failed",
      message: expect.stringContaining("no answer within 0.3s"),
    },
  });
  expect(agentCount()).toEqual({ n: 0 });
  await wire.hangsSettled();
});

test("start with a branch on an env with no connector secret answers 422 branch_needs_connector before any check", async () => {
  const envId = readyEnv();
  const checks = branchCheckAnswers({ exitCode: 0 });
  const res = await launch({ envId, prompt: "go", branch: "feature/login" });
  expect(res.status).toBe(422);
  expect(await res.json()).toEqual({
    error: {
      code: "branch_needs_connector",
      message: `starting on a branch needs a GitHub connector secret on the environment; set one with sky secret set ${envId} GITHUB_CONNECTOR --connector=<id>`,
    },
  });
  expect(checks).toEqual([]);
  expect(agentCount()).toEqual({ n: 0 });
});

test("a check exiting 2 (a usage or shell error) answers 502 branch_check_failed with its stderr", async () => {
  const envId = await connectedEnv();
  branchCheckAnswers({
    exitCode: 2,
    stderr: "sh: 1: .: cannot open /tmp/x.env\n",
  });
  const res = await launch({ envId, prompt: "go", branch: "feature/login" });
  expect(res.status).toBe(502);
  expect(await res.json()).toMatchObject({
    error: {
      code: "branch_check_failed",
      message: expect.stringContaining("cannot open /tmp/x.env"),
    },
  });
  expect(agentCount()).toEqual({ n: 0 });
});

test("start with a branch on an unknown or unready env answers as without one, before any check", async () => {
  const checks = branchCheckAnswers({ exitCode: 0 });
  const unknown = await launch({
    envId: "env_missing",
    prompt: "go",
    branch: "feature/login",
  });
  expect(unknown.status).toBe(404);
  expect(await unknown.json()).toMatchObject({ error: { code: "not_found" } });
  const unready = await launch({
    envId: readyEnv({ status: "provisioning" }),
    prompt: "go",
    branch: "feature/login",
  });
  expect(unready.status).toBe(409);
  expect(await unready.json()).toMatchObject({
    error: { code: "env_not_ready" },
  });
  expect(checks).toEqual([]);
});

test("start with a branch on an env at its cap answers 409 concurrency_cap before any check", async () => {
  const envId = await connectedEnv();
  db.update(environments)
    .set({ concurrency: 1 })
    .where(eq(environments.id, envId))
    .run();
  await launched(envId);
  const checks = branchCheckAnswers({ exitCode: 0 });
  const res = await launch({ envId, prompt: "go", branch: "feature/login" });
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({
    error: { code: "concurrency_cap", limit: 1 },
  });
  expect(checks).toEqual([]);
  expect(agentCount()).toEqual({ n: 1 });
  await sessionOpened();
});

test("a check exiting otherwise answers 502 branch_check_failed with its stderr tail redacted", async () => {
  const envId = await connectedEnv();
  const gateway = "https://gateway.example/secret-path-0042";
  expect(
    (await putSecret(envId, "GITHUB_GATEWAY_URL", { value: gateway })).status,
  ).toBe(200);
  branchCheckAnswers({ exitCode: 1, stderr: `fetch ${gateway} failed\n` });
  const res = await launch({ envId, prompt: "go", branch: "feature/login" });
  expect(res.status).toBe(502);
  const body = (await res.json()) as {
    error: { code: string; message: string };
  };
  expect(body.error.code).toBe("branch_check_failed");
  expect(body.error.message).toContain("fetch [redacted] failed");
  expect(JSON.stringify(body) + logs.join("\n")).not.toContain(gateway);
  expect(agentCount()).toEqual({ n: 0 });
});

test("a gateway secret that won't decrypt answers 502 branch_check_failed, not 500", async () => {
  const envId = await connectedEnv();
  seedLegacySecret(envId, "GITHUB_GATEWAY_URL", "https://gateway.example/x");
  db.update(secrets)
    .set({ keyVersion: 99 })
    .where(eq(secrets.name, "GITHUB_GATEWAY_URL"))
    .run();
  const checks = branchCheckAnswers({ exitCode: 0 });
  const res = await launch({ envId, prompt: "go", branch: "feature/login" });
  expect(res.status).toBe(502);
  expect(await res.json()).toMatchObject({
    error: {
      code: "branch_check_failed",
      message: expect.stringContaining("no key for version 99"),
    },
  });
  expect(checks).toEqual([]);
  expect(agentCount()).toEqual({ n: 0 });
});

test("preflight transport failure answers 502 branch_check_failed", async () => {
  app = createApp({
    db,
    config,
    sprites: new SpritesClient(spritesToken),
    log: (line) => logs.push(line),
    nudgeDeliveries: () => {},
    spritesTimeoutMs: 200,
  });
  const envId = await connectedEnv();
  wire.hangs = (call) => call.includes(" branch-check ");
  const res = await launch({ envId, prompt: "go", branch: "feature/login" });
  expect(res.status).toBe(502);
  expect(await res.json()).toMatchObject({
    error: {
      code: "branch_check_failed",
      message: expect.stringContaining("branch-check timed out after 200 ms"),
    },
  });
  expect(agentCount()).toEqual({ n: 0 });
});

test("invalid branch name answers 400", async () => {
  const envId = await connectedEnv();
  const checks = branchCheckAnswers({ exitCode: 0 });
  const res = await launch({ envId, prompt: "go", branch: "a..b" });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: { code: "invalid_body" } });
  expect(checks).toEqual([]);
  expect(agentCount()).toEqual({ n: 0 });
});

test("the preflight env file is removed even when the check fails", async () => {
  const envId = await connectedEnv();
  const sprite = spriteNameFor(envId);
  const fileAtCheck: Record<string, string>[] = [];
  const checks = branchCheckAnswers({ exitCode: 3 });
  const answer = wire.exec;
  wire.exec = (argv) => {
    if (isBranchCheck(argv)) {
      fileAtCheck.push(envFileOf(wire, { env: { ENV_FILE: argv[4] ?? "" } }));
    }
    return answer(argv);
  };
  const res = await launch({ envId, prompt: "go", branch: "feature/nope" });
  expect(res.status).toBe(404);
  const [argv] = checks;
  const path = argv?.[4] ?? "";
  expect(path).toMatch(/^\/tmp\/sky-branch-check-[0-9a-f-]+\.env$/);
  expect(argv?.slice(3)).toEqual(["sh", path, "feature/nope"]);
  expect(fileAtCheck).toEqual([{ GITHUB_CONNECTOR: "VPpb7x" }]);
  expect(wire.modes.get(path)).toBe("0600");
  expect(wire.calls.slice(-3)).toEqual([
    `write ${sprite} ${path}`,
    expect.stringMatching(
      `^exec ${sprite} /workspace/repo sh -c .* branch-check "\\$2" sh ${path} feature/nope$`,
    ),
    `exec ${sprite} - rm -f ${path}`,
  ]);
});

test("compareUrl uses the remote branch", async () => {
  const { agent } = await finishedOnBranch(
    "feature/login",
    rollupWith("fix the flaky test"),
  );
  expect((await listRuns(agent.id)).body.data).toEqual([
    expect.objectContaining({
      compareUrl: `https://github.com/acme/kru/compare/${sha("b")}...feature/login`,
    }),
  ]);
});

test("compareUrl escapes # and % within a branch segment, keeping its slashes", async () => {
  const { agent } = await finishedOnBranch(
    "fix/#12%done",
    rollupWith("fix the flaky test"),
  );
  expect((await listRuns(agent.id)).body.data).toEqual([
    expect.objectContaining({
      compareUrl: `https://github.com/acme/kru/compare/${sha("b")}...fix/%2312%25done`,
    }),
  ]);
});

test("an ended run's diff on a remote branch is against the start point the runner pinned, so outside pushes never shrink it", async () => {
  const { agent, run } = await finishedOnBranch("feature/login");
  wire.exec = (argv) =>
    isDiff(argv) ? { exitCode: 0, stdout: patch } : { exitCode: 0 };
  const { status, body } = await getRun(agent.id, run.id);
  expect(status).toBe(200);
  expect(body.diff).toBe(patch);
  expect(lastExec()).toMatch(
    new RegExp(` sh refs/sky/starts/${agent.id} claude/${agent.id}$`),
  );
});

test("a secret named START_BRANCH is refused, so it can't redirect the runner", async () => {
  const res = await putSecret(readyEnv(), "START_BRANCH", { value: "main" });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: { code: "reserved_name" } });
});

const insertEvent = (
  runId: string,
  type: string,
  ts: number,
  payload: object,
) =>
  db.$client
    .prepare(
      "insert into events (run_id, ts, type, payload) values (?, ?, ?, ?)",
    )
    .run(runId, new Date(ts).toISOString(), type, JSON.stringify(payload));
const beat = (toolName: string, elapsedMs: number) => ({
  toolName,
  toolUseId: "t1",
  elapsedMs,
});
test("a runner.heartbeat from the run's token is stored and leaves the run running", async () => {
  const { agent, run, token } = await startedRun();
  const res = await postEvent(token, {
    runId: run.id,
    type: "runner.heartbeat",
    payload: beat("Bash", 61_000),
  });
  expect(res.status).toBe(201);
  const stored = eventsOf(run.id).filter((e) => e.type === "runner.heartbeat");
  expect(stored.map((e) => JSON.parse(e.payload))).toEqual([
    beat("Bash", 61_000),
  ]);
  expect((await getRun(agent.id, run.id)).body.status).toBe("running");
});

test("a run whose heartbeats are arriving is alive: it is not probed, however long its tool call has been quiet", async () => {
  const { run } = await startedRun();
  pgrepAnswers(1);
  const { prober } = proberOver();
  const now = Date.now() + 20 * 60_000;
  // the call began 20 minutes ago, and its last heartbeat was 30 s ago
  insertEvent(run.id, "claude.PreToolUse", Date.now() + 1, {
    toolName: "Bash",
    toolUseId: "t1",
    input: "{}",
  });
  insertEvent(
    run.id,
    "runner.heartbeat",
    now - 30_000,
    beat("Bash", 1_170_000),
  );
  await prober.sweep(now);
  expect(pgreps()).toEqual([]);
});

test("a tool call that outlives the run timeout fails the run as runner_timeout naming the tool and how long it ran, though heartbeats kept arriving", async () => {
  const { agent, run } = await startedRun();
  const limit = config.runTimeoutMs;
  const now = Date.now() + limit + 120_000;
  insertEvent(run.id, "claude.PreToolUse", Date.now() + 1, {
    toolName: "Bash",
    toolUseId: "t1",
    input: "{}",
  });
  // a beat 20 s before the sweep, from a call 31 minutes in
  insertEvent(
    run.id,
    "runner.heartbeat",
    now - 20_000,
    beat("Bash", limit + 60_000),
  );
  expect(failStaleRuns(db, limit, now)).toEqual([run.id]);
  const { error } = (await getRun(agent.id, run.id)).body;
  expect(error).toBe(
    "runner_timeout: Bash was still running after 31m with no result, past the 30m limit",
  );
});

test.each([
  ["runner.warning", { message: "holding the sprite failed" }],
  ["run.probed", { spriteName: "s", silentMs: 1 }],
])(
  "a %s after the last heartbeat still leaves the tool in flight named in the runner_timeout",
  async (type, payload) => {
    const { agent, run } = await startedRun();
    const limit = config.runTimeoutMs;
    const now = Date.now() + limit + 120_000;
    insertEvent(run.id, "claude.PreToolUse", Date.now() + 1, {
      toolName: "Bash",
      toolUseId: "t1",
      input: "{}",
    });
    insertEvent(
      run.id,
      "runner.heartbeat",
      now - 20_000,
      beat("Bash", limit + 60_000),
    );
    insertEvent(run.id, type, now - 10_000, payload);
    expect(failStaleRuns(db, limit, now)).toEqual([run.id]);
    expect((await getRun(agent.id, run.id)).body.error).toBe(
      "runner_timeout: Bash was still running after 31m with no result, past the 30m limit",
    );
  },
);

test.each(["Bash (background)", "Agent (background)"])(
  "a quiet run whose last heartbeat names %s fails stating how long the session was quiet and, apart, how long the task had run",
  async (toolName) => {
    const { agent, run } = await startedRun();
    const limit = config.runTimeoutMs;
    const now = Date.now() + 60 * 60_000;
    // the session's last result came 31 minutes before the sweep; the task started 19 minutes before that
    insertEvent(run.id, "claude.PostToolUse", now - limit - 60_000, {
      toolName: "Read",
      toolUseId: "t0",
      input: "{}",
      output: "ok",
    });
    insertEvent(
      run.id,
      "runner.heartbeat",
      now - HEARTBEAT_INTERVAL_MS,
      beat(toolName, 50 * 60_000 - HEARTBEAT_INTERVAL_MS),
    );
    expect(failStaleRuns(db, limit, now)).toEqual([run.id]);
    expect((await getRun(agent.id, run.id)).body.error).toBe(
      `runner_timeout: the session waited on ${toolName} with nothing else happening for 31m, past the 30m limit; the task had run 50m`,
    );
  },
);

test("a run whose heartbeats stopped while the session waited on a background task fails saying the runner went quiet, with how long the task had run", async () => {
  const { agent, run } = await startedRun();
  const limit = config.runTimeoutMs;
  const now = Date.now() + limit + 120_000;
  // the last beat is past fresh by the sweep, 5 minutes into the task
  insertEvent(
    run.id,
    "runner.heartbeat",
    now - 4 * HEARTBEAT_INTERVAL_MS,
    beat("Bash (background)", 300_000),
  );
  expect(failStaleRuns(db, limit, now)).toEqual([run.id]);
  expect((await getRun(agent.id, run.id)).body.error).toBe(
    "runner_timeout: the runner went quiet while the session waited on Bash (background); the task had run 5m",
  );
});

test("a run whose heartbeats stopped mid tool call fails as runner_timeout saying the runner went quiet, not that the tool ran on", async () => {
  const { agent, run } = await startedRun();
  insertEvent(run.id, "claude.PreToolUse", Date.now() + 1, {
    toolName: "Bash",
    toolUseId: "t1",
    input: "{}",
  });
  // the last beat, 5 minutes into the call, is long past fresh by the sweep
  insertEvent(
    run.id,
    "runner.heartbeat",
    Date.now() + 2,
    beat("Bash", 300_000),
  );
  expect(
    failStaleRuns(
      db,
      config.runTimeoutMs,
      silentFor(config.runTimeoutMs + 1000),
    ),
  ).toEqual([run.id]);
  expect((await getRun(agent.id, run.id)).body.error).toBe(
    "runner_timeout: the runner went quiet during Bash after it had run 5m",
  );
});

test("a run quiet past the timeout with no tool call in flight is a bare runner_timeout, even after earlier heartbeats", async () => {
  const { agent, run, token } = await startedRun();
  insertEvent(run.id, "runner.heartbeat", Date.now() + 1, beat("Bash", 60_000));
  await postEvent(token, {
    runId: run.id,
    type: "claude.PostToolUse",
    payload: { toolName: "Bash", toolUseId: "t1", input: "{}", output: "ok" },
  });
  expect(
    failStaleRuns(
      db,
      config.runTimeoutMs,
      silentFor(config.runTimeoutMs + 1000),
    ),
  ).toEqual([run.id]);
  expect((await getRun(agent.id, run.id)).body.error).toBe("runner_timeout");
});

test("heartbeats older than 7 days are pruned with their deliveries; newer ones and run events stay", async () => {
  const { run } = await startedRun();
  const day = 86_400_000;
  const old = insertEvent(
    run.id,
    "runner.heartbeat",
    Date.now() - 8 * day,
    beat("Bash", 1),
  ).lastInsertRowid;
  const young = insertEvent(
    run.id,
    "runner.heartbeat",
    Date.now() - day,
    beat("Bash", 2),
  ).lastInsertRowid;
  db.$client
    .prepare(
      "insert into webhooks (id, url, event_types) values ('whk_beat', 'https://hooks.example.com/beat', '[\"runner.heartbeat\"]')",
    )
    .run();
  const deliver = db.$client.prepare(
    "insert into webhook_deliveries (webhook_id, event_id, status, next_attempt_at) values ('whk_beat', ?, 'delivered', ?)",
  );
  for (const eventId of [old, young]) {
    deliver.run(eventId, new Date(Date.now() - 8 * day).toISOString());
  }
  expect(pruneClaudeEvents(db)).toBe(1);
  expect(eventsOf(run.id).map((e) => e.type)).toEqual([
    "run.started",
    "runner.heartbeat",
  ]);
  expect(
    db.$client
      .prepare(
        "select event_id from webhook_deliveries where webhook_id = 'whk_beat'",
      )
      .all(),
  ).toEqual([{ event_id: young }]);
});

test("a lost runner is failed even when its last event and the probe share a millisecond", async () => {
  const { agent, run, token } = await runningRun();
  // a clock that does not move: on a fast host the last event and the probe really do share a tick
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    await postEvent(token, {
      runId: run.id,
      type: "run.started",
      payload: { sessionId: "s" },
    });
    pgrepAnswers(1);
    const { prober } = proberOver();
    await prober.sweep(Date.now() + config.runProbeMs + 1000);
  } finally {
    vi.useRealTimers();
  }
  const failed = (await getRun(agent.id, run.id)).body;
  expect(failed).toMatchObject({ status: "failed" });
  expect(failed.error).toMatch(/^runner_lost: /);
});
