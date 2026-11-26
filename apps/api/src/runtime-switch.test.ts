import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpritesClient } from "@fly/sprites";
import {
  agents,
  type Db,
  environments,
  events,
  migrate,
  openDb,
  runs,
} from "@sky/db";
import {
  type AgentId,
  CreatedApiKey,
  type EnvironmentId,
  type RunId,
  type Runtime,
} from "@sky/shared";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createApp } from "./app.js";
import { limitedUntil, markLimited } from "./claude-credentials.js";
import type { Config } from "./config.js";
import {
  crossRuntimePrompt,
  effectiveRuntime,
  switchCommand,
} from "./runtime.js";
import { spriteNameFor } from "./sprites.js";
import { fiveHourLimit } from "./testing/limits.js";
import {
  envFileOf,
  type SpritesWire,
  spritesToken,
  stubSprites,
  testConfig,
} from "./testing/sprites.js";

const DEFAULT_TOKEN = "default-subscription-opaque-1";
const PERSONAL_TOKEN = "personal-subscription-opaque-2";
const API_KEY = "anthropic-api-key-opaque-4";
const GATEWAY_KEY = "gateway-key-opaque-5";
const CREDIT_LOW =
  "Claude Code returned an error result: Credit balance is too low";

let dir: string;
let db: Db;
let logs: string[];
let app: ReturnType<typeof createApp>;
let wire: SpritesWire;

const buildApp = (over: Partial<Config> = {}) => {
  app = createApp({
    db,
    config: testConfig({
      runnerBundlePath: join(dir, "runner.mjs"),
      claudeOauthToken: DEFAULT_TOKEN,
      claudeOauthTokens: { personal: PERSONAL_TOKEN },
      anthropicApiKey: API_KEY,
      ...over,
    }),
    sprites: new SpritesClient(spritesToken),
    log: (line) => logs.push(line),
    nudgeDeliveries: () => {},
    launchWatchMs: 50,
  });
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sky-runtime-switch-"));
  writeFileSync(join(dir, "runner.mjs"), "// runner bundle\n");
  db = openDb(":memory:");
  migrate(db);
  wire = stubSprites();
  logs = [];
  buildApp();
});
afterEach(() => {
  if (db.$client.open) db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

const admin = `Bearer ${testConfig().apiKey}`;
const call = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: {
      Authorization: admin,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

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

const setGatewayKey = async (envId: string) =>
  expect(
    (
      await call(
        "PUT",
        `/v1/environments/${envId}/secrets/AI_GATEWAY_API_KEY`,
        {
          value: GATEWAY_KEY,
        },
      )
    ).status,
  ).toBe(200);

type Launched = { agent: { id: AgentId }; run: { id: RunId } };

const sessionOpened = (count: number) =>
  vi.waitFor(() => expect(wire.sessions).toHaveLength(count));

/** Launches a run, or a follow-up of `agentId`, and returns what its runner was handed. */
async function launched(
  envId: string,
  agentId?: AgentId,
  prompt = "go",
  envVars?: Record<string, string>,
) {
  const before = wire.sessions.length;
  const res = agentId
    ? await call("POST", `/v1/agents/${agentId}/runs`, { prompt, envVars })
    : await call("POST", "/v1/agents", { envId, prompt, envVars });
  expect(res.status).toBe(202);
  const ids = (await res.json()) as Launched;
  await sessionOpened(before + 1);
  const session = wire.sessions[before];
  const promptBytes = wire.files.get(`/workspace/runs/${ids.run.id}.prompt`);
  return {
    ...ids,
    session,
    file: envFileOf(wire, session),
    prompt: new TextDecoder().decode(promptBytes),
  };
}

/** A launch whose runner never starts: the run's stored error once it fails. */
async function refused(envId: string) {
  const res = await call("POST", "/v1/agents", { envId, prompt: "go" });
  expect(res.status).toBe(202);
  const { run } = (await res.json()) as Launched;
  await vi.waitFor(() => expect(runRow(run.id)?.status).toBe("failed"));
  return failureOf(run.id);
}

const postEvent = (token: string | undefined, event: unknown) =>
  app.request("/internal/events", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(event),
  });

type Run = Awaited<ReturnType<typeof launched>>;

const start = async (r: Run, sessionId = "sess-1") =>
  expect(
    (
      await postEvent(r.file.AGENT_TOKEN, {
        runId: r.run.id,
        type: "run.started",
        payload: { sessionId },
      })
    ).status,
  ).toBe(201);

const fail = async (r: Run, error: string) =>
  expect(
    (
      await postEvent(r.file.AGENT_TOKEN, {
        runId: r.run.id,
        type: "run.failed",
        payload: { error },
      })
    ).status,
  ).toBe(201);

const finish = async (r: Run, summary: string) =>
  expect(
    (
      await postEvent(r.file.AGENT_TOKEN, {
        runId: r.run.id,
        type: "run.finished",
        payload: {
          summary,
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            costUsd: 0,
            turns: 1,
            durationMs: 1,
          },
        },
      })
    ).status,
  ).toBe(201);

const runRow = (id: string) =>
  db
    .select()
    .from(runs)
    .where(eq(runs.id, id as RunId))
    .get();

const failureOf = (runId: string) => {
  const row = db
    .select({ payload: events.payload })
    .from(events)
    .where(and(eq(events.runId, runId as RunId), eq(events.type, "run.failed")))
    .get();
  return String((row?.payload as { error?: string } | undefined)?.error);
};

// --- the helpers ---------------------------------------------------------------------------------

test("the stored runtime wins over the secret; an unset or unknown secret is Claude Code", () => {
  expect(effectiveRuntime("codex", "claude-code")).toBe("codex");
  expect(effectiveRuntime(null, "codex")).toBe("codex");
  expect(effectiveRuntime(null, undefined)).toBe("claude-code");
  expect(effectiveRuntime(null, "gpt")).toBe("claude-code");
});

test("the switch command quotes an environment name a shell would split", () => {
  expect(switchCommand("web", "codex")).toBe("sky env set-runtime web codex");
  expect(switchCommand("my app's env", "claude-code")).toBe(
    "sky env set-runtime 'my app'\\''s env' claude-code",
  );
});

// --- named failures ------------------------------------------------------------------------------

test("a run whose API key is out of credit fails claude_unavailable with the switch command, and the next launch fails fast", async () => {
  const envId = readyEnv({ claudeCredential: "api-key" });
  const r = await launched(envId);
  expect(r.file.SKY_CLAUDE_AUTH).toBe("api-key");
  await start(r);
  await fail(r, CREDIT_LOW);
  const error = failureOf(r.run.id);
  expect(error).toMatch(/^claude_unavailable: /);
  expect(error).toContain("out of credit");
  expect(error).toContain(`sky env set-runtime ${envId} codex`);

  // no runner is started for a launch that would die the same way
  const next = await refused(envId);
  expect(next).toMatch(/^claude_unavailable: /);
  expect(next).toContain("out of credit");
  expect(next).toContain(`sky env set-runtime ${envId} codex`);
  expect(wire.sessions).toHaveLength(1);

  // nor for one whose subscription is limited and would fall back on the key
  const other = readyEnv({ claudeCredential: "personal" });
  markLimited(db, "personal", new Date(Date.now() + 3_600_000));
  const fallback = await refused(other);
  expect(fallback).toMatch(/^claude_unavailable: /);
  expect(fallback).toContain("falls back on is out of credit");
  expect(fallback).toContain(`sky env set-runtime ${other} codex`);
  expect(wire.sessions).toHaveLength(1);
});

test("a run on the API key that finishes clears the out-of-credit mark", async () => {
  const envId = readyEnv({ claudeCredential: "api-key", concurrency: 2 });
  const a = await launched(envId);
  const b = await launched(envId);
  await start(a);
  await start(b, "sess-2");
  await fail(a, CREDIT_LOW);
  expect(await refused(envId)).toMatch(/^claude_unavailable: /);
  await finish(b, "done");
  const c = await launched(envId);
  expect(c.file.SKY_CLAUDE_AUTH).toBe("api-key");
});

test("a subscription run finishing leaves the out-of-credit mark on the API key", async () => {
  const keyEnv = readyEnv({ claudeCredential: "api-key" });
  const subscriptionEnv = readyEnv({ claudeCredential: "personal" });
  const onKey = await launched(keyEnv);
  const onSubscription = await launched(subscriptionEnv);
  expect(onSubscription.file.SKY_CLAUDE_AUTH).toBe("oauth");
  await start(onKey);
  await start(onSubscription, "sess-2");
  await fail(onKey, CREDIT_LOW);
  await finish(onSubscription, "done");
  const next = await refused(keyEnv);
  expect(next).toMatch(/^claude_unavailable: /);
  expect(next).toContain("out of credit");
  expect(wire.sessions).toHaveLength(2);
});

test("a run on the API key failing for another reason does not mark the key out of credit", async () => {
  const envId = readyEnv({ claudeCredential: "api-key" });
  const a = await launched(envId);
  await start(a);
  await fail(a, "the turn failed");
  expect(failureOf(a.run.id)).toBe("the turn failed");
  const b = await launched(envId);
  expect(b.file.SKY_CLAUDE_AUTH).toBe("api-key");
});

test("a run that hits its limit with nothing left to retry on fails claude_unavailable, naming the reset and the switch command", async () => {
  buildApp({ anthropicApiKey: undefined });
  const envId = readyEnv({ claudeCredential: "personal" });
  const r = await launched(envId);
  await start(r);
  const limit = fiveHourLimit();
  await fail(r, limit.text);
  const error = failureOf(r.run.id);
  expect(error).toMatch(/^claude_unavailable: /);
  expect(error).toContain('"personal" is at its usage limit');
  expect(error).toContain("UTC");
  expect(error).toContain(`sky env set-runtime ${envId} codex`);
  expect(wire.sessions).toHaveLength(1);
});

test("a Codex run the AI Gateway refused fails codex_unavailable with the command back to Claude Code", async () => {
  const envId = readyEnv({ runtime: "codex" });
  await setGatewayKey(envId);
  const r = await launched(envId);
  await start(r, "thread-1");
  await fail(
    r,
    "codex_unavailable: the AI Gateway is out of credit (Codex said: unexpected status 402 Payment Required)",
  );
  const error = failureOf(r.run.id);
  expect(error).toMatch(/^codex_unavailable: the AI Gateway is out of credit/);
  expect(error).toContain(`sky env set-runtime ${envId} claude-code`);
  // a Codex failure never touches a Claude credential, nor retries on one
  expect(wire.sessions).toHaveLength(1);
});

test("a Codex run's other failures keep their words", async () => {
  const envId = readyEnv({ runtime: "codex" });
  await setGatewayKey(envId);
  const r = await launched(envId);
  await start(r, "thread-1");
  await fail(r, "the turn failed");
  expect(failureOf(r.run.id)).toBe("the turn failed");
});

test("a Codex run failing with Claude's usage-limit wording keeps it, limits no credential and starts no retry", async () => {
  const envId = readyEnv({ runtime: "codex", claudeCredential: "personal" });
  await setGatewayKey(envId);
  const r = await launched(envId);
  await start(r, "thread-1");
  const limit = fiveHourLimit();
  await fail(r, limit.text);
  expect(failureOf(r.run.id)).toBe(limit.text);
  for (const name of ["default", "personal"]) {
    expect(limitedUntil(db, name)).toBeUndefined();
  }
  expect(db.select().from(runs).all()).toHaveLength(1);
  expect(wire.sessions).toHaveLength(1);
});

test("the same usage-limit wording on a Claude run limits its credential", async () => {
  buildApp({ anthropicApiKey: undefined });
  const envId = readyEnv({ claudeCredential: "personal" });
  const r = await launched(envId);
  await start(r);
  const limit = fiveHourLimit();
  await fail(r, limit.text);
  expect(limitedUntil(db, "personal")).toEqual(new Date(limit.at));
});

// --- Codex launches -------------------------------------------------------------------------------

test("a Codex launch with every subscription limited and the fallback off never resolves a Claude credential", async () => {
  const envId = readyEnv({
    claudeCredential: "pool",
    claudeFallback: "none",
    runtime: "codex",
  });
  for (const name of ["default", "personal"]) {
    markLimited(db, name, new Date(Date.now() + 3_600_000));
  }
  await setGatewayKey(envId);
  const r = await launched(envId);
  expect(r.file.SKY_RUNTIME).toBe("codex");
  expect(r.file.AI_GATEWAY_API_KEY).toBe(GATEWAY_KEY);
  expect(r.file).not.toHaveProperty("SKY_CLAUDE_AUTH");
  expect(r.file).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
  expect(r.file).not.toHaveProperty("SKY_CLAUDE_API_KEY");
  const text = JSON.stringify(r.file);
  for (const value of [DEFAULT_TOKEN, PERSONAL_TOKEN, API_KEY]) {
    expect(text).not.toContain(value);
  }
  expect(runRow(r.run.id)).toMatchObject({
    runtime: "codex",
    claudeCredential: null,
  });
});

test("the SKY_RUNTIME secret still picks Codex for an environment with no stored runtime", async () => {
  const envId = readyEnv();
  await setGatewayKey(envId);
  expect(
    (
      await call("PUT", `/v1/environments/${envId}/secrets/SKY_RUNTIME`, {
        value: "codex",
      })
    ).status,
  ).toBe(200);
  const r = await launched(envId);
  expect(r.file.SKY_RUNTIME).toBe("codex");
  expect(r.file).not.toHaveProperty("SKY_CLAUDE_AUTH");
});

test("the stored runtime goes to the runner over the SKY_RUNTIME secret", async () => {
  const envId = readyEnv({ runtime: "claude-code" });
  await setGatewayKey(envId);
  expect(
    (
      await call("PUT", `/v1/environments/${envId}/secrets/SKY_RUNTIME`, {
        value: "codex",
      })
    ).status,
  ).toBe(200);
  const r = await launched(envId);
  expect(r.file.SKY_RUNTIME).toBe("claude-code");
  expect(r.file.SKY_CLAUDE_AUTH).toBe("oauth");
});

test("a Codex launch on a sprite without Codex installs it before the runner starts", async () => {
  const envId = readyEnv({ runtime: "codex" });
  await setGatewayKey(envId);
  const base = wire.exec;
  const ensures: string[] = [];
  wire.exec = (argv, sprite) => {
    if (argv[0] === "sh" && argv[2]?.includes("npm install")) {
      ensures.push(argv[2]);
      // the binary was missing, and npm put the pinned version in
      return { exitCode: 3 };
    }
    return base(argv, sprite);
  };
  await launched(envId);
  expect(ensures).toHaveLength(1);
  expect(ensures[0]).toContain("@openai/codex@0.172.0");
  expect(ensures[0]).toContain("/opt/sky");
  const order = wire.calls.filter(
    (line) => line.includes("npm install") || line.startsWith("session "),
  );
  expect(order[0]).toContain("npm install");
  expect(order[1]).toMatch(/^session /);
});

test("a Codex launch whose install fails fails the run naming why, before any runner", async () => {
  const envId = readyEnv({ runtime: "codex" });
  await setGatewayKey(envId);
  const base = wire.exec;
  wire.exec = (argv, sprite) =>
    argv[0] === "sh" && argv[2]?.includes("npm install")
      ? { exitCode: 1, stderr: "npm ERR! network unreachable\n" }
      : base(argv, sprite);
  const error = await refused(envId);
  expect(error).toContain("installing Codex 0.172.0 failed");
  expect(error).toContain("network unreachable");
  expect(wire.sessions).toHaveLength(0);
});

test("a Codex launch in an environment with no gateway key fails at once, saying how to fix it", async () => {
  const envId = readyEnv({ runtime: "codex" });
  const error = await refused(envId);
  expect(error).toMatch(/^codex_unavailable: /);
  expect(error).toContain("AI_GATEWAY_API_KEY");
  expect(error).toContain(`sky env set-runtime ${envId} claude-code`);
  expect(wire.calls).toEqual([]);
});

// --- set-runtime ---------------------------------------------------------------------------------

test("switching to Codex is refused while the environment has no AI_GATEWAY_API_KEY", async () => {
  const envId = readyEnv();
  const res = await call("PUT", `/v1/environments/${envId}/runtime`, {
    runtime: "codex",
  });
  expect(res.status).toBe(409);
  const body = (await res.json()) as {
    error: { code: string; message: string };
  };
  expect(body.error.code).toBe("gateway_key_missing");
  expect(body.error.message).toContain(
    `sky secret set ${envId} AI_GATEWAY_API_KEY`,
  );
  expect(
    db.select().from(environments).where(eq(environments.id, envId)).get()
      ?.runtime,
  ).toBeNull();
});

test("switching to Codex installs it on the live sprite, stores the runtime and shows it", async () => {
  const envId = readyEnv();
  await setGatewayKey(envId);
  const before = wire.calls.length;
  const res = await call("PUT", `/v1/environments/${envId}/runtime`, {
    runtime: "codex",
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ id: envId, runtime: "codex" });
  const made = wire.calls.slice(before);
  // one exec, the pinned install, and nothing that reprovisions or touches a worktree
  expect(made).toHaveLength(1);
  expect(made[0]).toContain("@openai/codex@0.172.0");
  expect(made.join("\n")).not.toMatch(/worktree|rm -rf|checkpoint|create /);
  const shown = await call("GET", `/v1/environments/${envId}`);
  expect(await shown.json()).toMatchObject({ runtime: "codex" });
});

test("switching back to Claude Code needs no gateway key and no sprite work", async () => {
  const envId = readyEnv({ runtime: "codex" });
  const res = await call("PUT", `/v1/environments/${envId}/runtime`, {
    runtime: "claude-code",
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ runtime: "claude-code" });
  expect(wire.calls).toEqual([]);
});

test("a switch that can't install Codex leaves the runtime as it was", async () => {
  const envId = readyEnv();
  await setGatewayKey(envId);
  wire.exec = () => ({ exitCode: 1, stderr: "npm ERR! disk full\n" });
  const res = await call("PUT", `/v1/environments/${envId}/runtime`, {
    runtime: "codex",
  });
  expect(res.status).toBe(502);
  const body = (await res.json()) as {
    error: { code: string; message: string };
  };
  expect(body.error.code).toBe("codex_install_failed");
  expect(body.error.message).toContain("disk full");
  expect(
    db.select().from(environments).where(eq(environments.id, envId)).get()
      ?.runtime,
  ).toBeNull();
});

test("an unknown runtime is a 400", async () => {
  const envId = readyEnv();
  const res = await call("PUT", `/v1/environments/${envId}/runtime`, {
    runtime: "gpt",
  });
  expect(res.status).toBe(400);
});

test("a key scoped to an environment cannot switch its runtime", async () => {
  const envId = readyEnv();
  await setGatewayKey(envId);
  const minted = await call("POST", "/v1/keys", {
    name: "ci",
    role: "runs",
    environmentIds: [envId],
  });
  expect(minted.status).toBe(201);
  const { secret } = CreatedApiKey.parse(await minted.json());
  const res = await app.request(`/v1/environments/${envId}/runtime`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ runtime: "codex" }),
  });
  expect(res.status).toBe(403);
  expect(
    db.select().from(environments).where(eq(environments.id, envId)).get()
      ?.runtime,
  ).toBeNull();
});

test("switching an unknown environment is a 404", async () => {
  const res = await call("PUT", "/v1/environments/env_missing/runtime", {
    runtime: "claude-code",
  });
  expect(res.status).toBe(404);
});

test("switching to Codex on an environment still provisioning stores it with no sprite work", async () => {
  const envId = readyEnv({ status: "provisioning", checkpointId: null });
  await setGatewayKey(envId);
  const before = wire.calls.length;
  const res = await call("PUT", `/v1/environments/${envId}/runtime`, {
    runtime: "codex",
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ id: envId, runtime: "codex" });
  expect(wire.calls.slice(before)).toEqual([]);
  expect(
    db.select().from(environments).where(eq(environments.id, envId)).get()
      ?.runtime,
  ).toBe("codex");
});

// --- follow-ups after a switch --------------------------------------------------------------------

test("a follow-up after a switch starts a fresh session on the agent's branch, told what came before", async () => {
  const envId = readyEnv();
  await setGatewayKey(envId);
  const first = await launched(envId, undefined, "build the thing");
  await start(first, "claude-session");
  await finish(first, "Built half the thing; the API routes are in.");
  expect(
    db.select().from(agents).where(eq(agents.id, first.agent.id)).get(),
  ).toMatchObject({
    sessionId: "claude-session",
    sessionRuntime: "claude-code",
  });

  expect(
    (
      await call("PUT", `/v1/environments/${envId}/runtime`, {
        runtime: "codex",
      })
    ).status,
  ).toBe(200);
  const next = await launched(envId, first.agent.id, "finish the thing");
  expect(next.session?.env).not.toHaveProperty("SESSION_ID");
  expect(next.file.SKY_RUNTIME).toBe("codex");
  expect(next.prompt).toBe(
    crossRuntimePrompt({
      prompt: "finish the thing",
      from: "claude-code",
      to: "codex",
      branch: `claude/${first.agent.id}`,
      summary: "Built half the thing; the API routes are in.",
    }),
  );
  expect(next.prompt).toMatch(
    /^Note from Sky: this agent's earlier work ran on Claude Code/,
  );
  expect(next.prompt).toContain(`claude/${first.agent.id}`);
  expect(next.prompt).toContain("Built half the thing");
  expect(next.prompt.endsWith("finish the thing")).toBe(true);

  // once the Codex run starts, its session is the one the next Codex follow-up resumes
  await start(next, "codex-thread");
  await finish(next, "Finished it.");
  const third = await launched(envId, first.agent.id, "polish");
  expect(third.session?.env.SESSION_ID).toBe("codex-thread");
  expect(third.prompt).toBe("polish");
});

test("a same-runtime follow-up resumes its session as before", async () => {
  const envId = readyEnv();
  const first = await launched(envId);
  await start(first, "claude-session");
  await finish(first, "done");
  const next = await launched(envId, first.agent.id, "more");
  expect(next.session?.env.SESSION_ID).toBe("claude-session");
  expect(next.prompt).toBe("more");
});

// --- sessions from before runtimes were recorded --------------------------------------------------

/** An agent of `envId` whose session's runtime is unrecorded, like one from before runtimes were recorded. */
async function unrecordedSession(envId: EnvironmentId, summary = "done") {
  const first = await launched(envId);
  await start(first, "old-session");
  await finish(first, summary);
  db.update(agents)
    .set({ sessionRuntime: null })
    .where(eq(agents.id, first.agent.id))
    .run();
  return first.agent.id;
}

const storeRuntime = (envId: EnvironmentId, runtime: Runtime) =>
  db
    .update(environments)
    .set({ runtime })
    .where(eq(environments.id, envId))
    .run();

const setRuntimeSecret = async (envId: EnvironmentId) =>
  expect(
    (
      await call("PUT", `/v1/environments/${envId}/secrets/SKY_RUNTIME`, {
        value: "codex",
      })
    ).status,
  ).toBe(200);

test("with no runtime stored or set, an unrecorded session is resumed, as before", async () => {
  const envId = readyEnv();
  const agentId = await unrecordedSession(envId);
  const next = await launched(envId, agentId, "more");
  expect(next.session?.env.SESSION_ID).toBe("old-session");
  expect(next.prompt).toBe("more");
});

test("an unrecorded session in an environment switched to Codex ran on Claude Code: a fresh session, told so", async () => {
  const envId = readyEnv();
  await setGatewayKey(envId);
  const agentId = await unrecordedSession(envId, "Did the first half.");
  storeRuntime(envId, "codex");
  const next = await launched(envId, agentId, "more");
  expect(next.session?.env).not.toHaveProperty("SESSION_ID");
  expect(next.file.SKY_RUNTIME).toBe("codex");
  expect(next.prompt).toBe(
    crossRuntimePrompt({
      prompt: "more",
      from: "claude-code",
      to: "codex",
      branch: `claude/${agentId}`,
      summary: "Did the first half.",
    }),
  );
});

test("an unrecorded session from a SKY_RUNTIME=codex environment that now stores Codex is resumed", async () => {
  const envId = readyEnv();
  await setGatewayKey(envId);
  await setRuntimeSecret(envId);
  const agentId = await unrecordedSession(envId);
  storeRuntime(envId, "codex");
  const next = await launched(envId, agentId, "more");
  expect(next.session?.env.SESSION_ID).toBe("old-session");
  expect(next.prompt).toBe("more");
});

test("an unrecorded session from a SKY_RUNTIME=codex environment switched to Claude Code ran on Codex: a fresh session, told so", async () => {
  const envId = readyEnv();
  await setGatewayKey(envId);
  await setRuntimeSecret(envId);
  const agentId = await unrecordedSession(envId, "Did the first half.");
  storeRuntime(envId, "claude-code");
  const next = await launched(envId, agentId, "more");
  expect(next.session?.env).not.toHaveProperty("SESSION_ID");
  expect(next.file.SKY_RUNTIME).toBe("claude-code");
  expect(next.prompt).toBe(
    crossRuntimePrompt({
      prompt: "more",
      from: "codex",
      to: "claude-code",
      branch: `claude/${agentId}`,
      summary: "Did the first half.",
    }),
  );
});

// --- where the runtime comes from -----------------------------------------------------------------

test("a run's SKY_RUNTIME envVar picks Codex for an environment with no stored runtime", async () => {
  const envId = readyEnv();
  await setGatewayKey(envId);
  const r = await launched(envId, undefined, "go", { SKY_RUNTIME: "codex" });
  expect(r.file.SKY_RUNTIME).toBe("codex");
  expect(r.file).not.toHaveProperty("SKY_CLAUDE_AUTH");
  expect(runRow(r.run.id)?.runtime).toBe("codex");
});

test("a run's SKY_RUNTIME envVar beats a conflicting SKY_RUNTIME secret", async () => {
  const envId = readyEnv();
  await setGatewayKey(envId);
  await setRuntimeSecret(envId);
  const r = await launched(envId, undefined, "go", {
    SKY_RUNTIME: "claude-code",
  });
  expect(r.file.SKY_RUNTIME).toBe("claude-code");
  expect(r.file.SKY_CLAUDE_AUTH).toBe("oauth");
});

test("the stored runtime beats both a SKY_RUNTIME envVar and the secret", async () => {
  const envId = readyEnv({ runtime: "claude-code" });
  await setGatewayKey(envId);
  await setRuntimeSecret(envId);
  const r = await launched(envId, undefined, "go", { SKY_RUNTIME: "codex" });
  expect(r.file.SKY_RUNTIME).toBe("claude-code");
  expect(r.file.SKY_CLAUDE_AUTH).toBe("oauth");
});
