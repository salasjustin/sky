import { expect, test } from "vitest";
import { ConfigError, loadConfig } from "./config.js";
import { sessionMcpServers } from "./mcp.js";

const env = {
  AGENT_ID: "agt_1",
  RUN_ID: "run_1",
  PROMPT: "fix the bug",
  API_BASE_URL: "https://api.test",
  AGENT_TOKEN: "agent-secret",
  CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret",
};

test("reads a run from env, defaulting the sprite paths", () => {
  expect(loadConfig(env)).toEqual({
    agentId: "agt_1",
    runId: "run_1",
    prompt: "fix the bug",
    sessionId: undefined,
    apiBaseUrl: "https://api.test",
    agentToken: "agent-secret",
    repoDir: "/workspace/repo",
    worktreesDir: "/workspace/worktrees",
    approvalPolicy: [],
    autoApprove: { defaults: true, commands: [] },
    sessionEnv: {},
    checks: [],
    mcpServers: {},
    waitTimeoutMs: 120 * 60_000,
    startBranch: undefined,
  });
});

test("reads the profile's session variables and checks, and refuses ones that aren't", () => {
  expect(
    loadConfig({
      ...env,
      SKY_SESSION_ENV: '{"A":"1"}',
      SKY_CHECKS: '["run the tests", "lint"]',
    }),
  ).toMatchObject({
    sessionEnv: { A: "1" },
    checks: ["run the tests", "lint"],
  });
  expect(() => loadConfig({ ...env, SKY_CHECKS: "run it" })).toThrow(
    "SKY_CHECKS",
  );
  expect(() => loadConfig({ ...env, SKY_SESSION_ENV: '["A"]' })).toThrow(
    "SKY_SESSION_ENV",
  );
});

test("reads the profile's MCP servers, defaults the optional parts, and refuses a malformed one", () => {
  expect(
    loadConfig({
      ...env,
      SKY_MCP_SERVERS:
        '{"doop":{"url":"https://doop.test/mcp","headers":{"Authorization":"DOOP_KEY"}}}',
    }).mcpServers,
  ).toEqual({
    doop: {
      url: "https://doop.test/mcp",
      headers: { Authorization: "DOOP_KEY" },
    },
  });
  expect(() =>
    loadConfig({ ...env, SKY_MCP_SERVERS: '{"doop":{"token":"x"}}' }),
  ).toThrow("SKY_MCP_SERVERS");
});

test("an http server without headers and a stdio server without args or env load with empty ones, which resolve with no secrets", () => {
  const { mcpServers } = loadConfig({
    ...env,
    SKY_MCP_SERVERS: '{"a":{"url":"https://x.test/mcp"},"b":{"command":"x"}}',
  });
  expect(mcpServers).toEqual({
    a: { url: "https://x.test/mcp", headers: {} },
    b: { command: "x", args: [], env: {} },
  });
  expect(sessionMcpServers(mcpServers, {})).toEqual({
    servers: {
      a: { type: "http", url: "https://x.test/mcp", headers: {} },
      b: { type: "stdio", command: "x", args: [], env: {} },
    },
    unresolved: [],
  });
});

test.each([
  ["set", "feature/login", "feature/login"],
  ["empty", "", undefined],
])("reads the start branch when %s", (_, value, expected) => {
  expect(loadConfig({ ...env, START_BRANCH: value }).startBranch).toBe(
    expected,
  );
});

test("reads the approval policy and the max wait", () => {
  const config = loadConfig({
    ...env,
    APPROVAL_POLICY: '["Bash(git push:*)", "Write"]',
    WAIT_TIMEOUT_MINUTES: "5",
  });
  expect(config).toMatchObject({
    approvalPolicy: ["Bash(git push:*)", "Write"],
    waitTimeoutMs: 300_000,
  });
});

test("reads the auto-approve overrides", () => {
  const config = loadConfig({
    ...env,
    AUTO_APPROVE: '{"defaults":false,"commands":["make check"]}',
  });
  expect(config.autoApprove).toEqual({
    defaults: false,
    commands: ["make check"],
  });
});

test.each([
  ["AUTO_APPROVE", "not json"],
  ["AUTO_APPROVE", '{"commands":["ls; rm x"]}'],
  ["AUTO_APPROVE", '{"defaults":"no"}'],
  ["APPROVAL_POLICY", "not json"],
  ["APPROVAL_POLICY", '"Bash"'],
  ["APPROVAL_POLICY", '["WebFetch(https:*)"]'],
  ["APPROVAL_POLICY", '["Bash("]'],
  ["WAIT_TIMEOUT_MINUTES", "0"],
  ["WAIT_TIMEOUT_MINUTES", "soon"],
])("rejects %s=%s", (key, value) => {
  expect(() => loadConfig({ ...env, [key]: value })).toThrow(
    new ConfigError(`missing or invalid env: ${key}`),
  );
});

test("takes a session id to resume and path overrides", () => {
  const config = loadConfig({
    ...env,
    SESSION_ID: "sess-1",
    REPO_DIR: "/tmp/r",
    WORKTREES_DIR: "/tmp/w",
  });
  expect(config).toMatchObject({
    sessionId: "sess-1",
    repoDir: "/tmp/r",
    worktreesDir: "/tmp/w",
  });
});

test("an empty SESSION_ID is a new session", () => {
  expect(loadConfig({ ...env, SESSION_ID: "" }).sessionId).toBeUndefined();
});

test("names every bad key without echoing any value", () => {
  const error = (() => {
    try {
      loadConfig({
        ...env,
        RUN_ID: "nope",
        AGENT_TOKEN: "",
        CLAUDE_CODE_OAUTH_TOKEN: undefined,
      });
    } catch (e) {
      return e;
    }
  })();
  expect(error).toBeInstanceOf(ConfigError);
  const message = (error as Error).message;
  expect(message).toMatch(/RUN_ID/);
  expect(message).toMatch(/AGENT_TOKEN/);
  expect(message).toMatch(/CLAUDE_CODE_OAUTH_TOKEN/);
  expect(message).not.toMatch(/nope|secret/);
});
