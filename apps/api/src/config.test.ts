import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { loadConfig } from "./config.js";

const apiKey = "k".repeat(40);
const spritesToken = "sprites-token";
const claudeOauthToken = "sk-ant-oat01-test";
const required = {
  SKY_API_KEY: apiKey,
  SPRITES_TOKEN: spritesToken,
  DATA_DIR: "/data",
  CLAUDE_CODE_OAUTH_TOKEN: claudeOauthToken,
  PUBLIC_BASE_URL: "https://sky.example.com",
  WEBHOOK_SIGNING_KEY: "w".repeat(32),
  SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
};

test("parses the env, defaulting PORT, the runner bundle path and the run and wait timeouts", () => {
  expect(loadConfig(required)).toEqual({
    ok: true,
    config: {
      apiKey,
      spritesToken,
      dataDir: "/data",
      port: 8080,
      claudeOauthToken,
      publicBaseUrl: "https://sky.example.com",
      runnerBundlePath: expect.stringMatching(/\/runner\.mjs$/),
      cliBundlePath: expect.stringMatching(/\/sky\.mjs$/),
      runTimeoutMs: 30 * 60_000,
      launchDeadlineMs: 15 * 60_000,
      waitTimeoutMs: 120 * 60_000,
      baseProfiles: {},
      spritesLongTimeoutMs: 30 * 60_000,
      webhookSigningKey: "w".repeat(32),
      secretEncryptionKey: Buffer.alloc(32, 7),
    },
  });
});

test("RUNNER_BUNDLE_PATH, RUN_TIMEOUT_MINUTES, LAUNCH_DEADLINE_MINUTES, WAIT_TIMEOUT_MINUTES and SPRITES_LONG_TIMEOUT_MINUTES override their defaults", () => {
  const result = loadConfig({
    ...required,
    RUNNER_BUNDLE_PATH: "/opt/api/runner.mjs",
    RUN_TIMEOUT_MINUTES: "5",
    LAUNCH_DEADLINE_MINUTES: "3",
    WAIT_TIMEOUT_MINUTES: "15",
    SPRITES_LONG_TIMEOUT_MINUTES: "45",
  });
  expect(result).toMatchObject({
    ok: true,
    config: {
      runnerBundlePath: "/opt/api/runner.mjs",
      runTimeoutMs: 300_000,
      launchDeadlineMs: 180_000,
      waitTimeoutMs: 900_000,
      spritesLongTimeoutMs: 2_700_000,
    },
  });
});

test("a SPRITES_LONG_TIMEOUT_MINUTES that isn't a positive number is rejected", () => {
  const result = loadConfig({ ...required, SPRITES_LONG_TIMEOUT_MINUTES: "0" });
  expect(result).toEqual({
    ok: false,
    message: expect.stringContaining("SPRITES_LONG_TIMEOUT_MINUTES is invalid"),
  });
});

test.each([
  "CLAUDE_CODE_OAUTH_TOKEN",
  "PUBLIC_BASE_URL",
  "WEBHOOK_SIGNING_KEY",
])("%s is required", (name) => {
  const result = loadConfig({ ...required, [name]: undefined });
  expect(result).toEqual({
    ok: false,
    message: expect.stringContaining(`${name} is missing`),
  });
});

test("a missing variable is named in the failure", () => {
  const result = loadConfig({ DATA_DIR: "/data" });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.message).toContain("SKY_API_KEY");
    expect(result.message).toContain("SPRITES_TOKEN is missing");
  }
});

test("an invalid value is named by its variable, never echoed", () => {
  const secret = "short-secret-value";
  const result = loadConfig({
    SKY_API_KEY: secret,
    DATA_DIR: "/data",
    PORT: "not-a-port",
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.message).toContain("SKY_API_KEY");
  expect(result.message).toContain("PORT");
  expect(result.message).not.toContain(secret);
  expect(result.message).not.toContain("not-a-port");
});

test("a WEBHOOK_SIGNING_KEY under 32 characters is rejected", () => {
  const result = loadConfig({
    ...required,
    WEBHOOK_SIGNING_KEY: "w".repeat(31),
  });
  expect(result).toEqual({
    ok: false,
    message: expect.stringContaining("WEBHOOK_SIGNING_KEY is invalid"),
  });
});

test.each([
  ["missing", undefined, "SECRET_ENCRYPTION_KEY is missing"],
  [
    "31 bytes",
    Buffer.alloc(31).toString("base64"),
    "SECRET_ENCRYPTION_KEY is invalid",
  ],
  [
    "33 bytes",
    Buffer.alloc(33).toString("base64"),
    "SECRET_ENCRYPTION_KEY is invalid",
  ],
  ["not base64", "!".repeat(44), "SECRET_ENCRYPTION_KEY is invalid"],
])("a SECRET_ENCRYPTION_KEY that is %s is rejected", (_, value, message) => {
  const result = loadConfig({ ...required, SECRET_ENCRYPTION_KEY: value });
  expect(result).toEqual({
    ok: false,
    message: expect.stringContaining(message),
  });
});

const profileJson = JSON.stringify({
  team: {
    marketplaces: ["acme/plugins"],
    plugins: ["review@plugins"],
    mcpServers: {
      docs: { command: "npx", args: ["-y", "docs-mcp"] },
      search: {
        url: "https://search.example.com/mcp",
        headers: { "X-Api-Key": "SEARCH_KEY" },
      },
    },
    storeRepo: "acme/store",
    checks: ["run the linter"],
  },
});

test("SKY_BASE_PROFILES is parsed into profiles with their defaults filled, and is empty when unset", () => {
  const result = loadConfig({ ...required, SKY_BASE_PROFILES: profileJson });
  expect(result.ok && result.config.baseProfiles).toEqual({
    team: {
      marketplaces: ["acme/plugins"],
      plugins: ["review@plugins"],
      mcpServers: {
        docs: { command: "npx", args: ["-y", "docs-mcp"], env: {} },
        search: {
          url: "https://search.example.com/mcp",
          headers: { "X-Api-Key": "SEARCH_KEY" },
        },
      },
      storeRepo: "acme/store",
      sessionEnv: {},
      checks: ["run the linter"],
    },
  });
  const bare = loadConfig({ ...required, SKY_BASE_PROFILES: '{"empty":{}}' });
  expect(bare.ok && bare.config.baseProfiles).toEqual({
    empty: {
      marketplaces: [],
      plugins: [],
      mcpServers: {},
      sessionEnv: {},
      checks: [],
    },
  });
  expect(loadConfig(required)).toMatchObject({
    ok: true,
    config: { baseProfiles: {} },
  });
});

// each input carries SECRET where a credential would sit; the message must name the field, not echo it
const SECRET = "sk-live";
test.each([
  [
    "JSON that isn't JSON",
    `{${SECRET}`,
    "SKY_BASE_PROFILES is invalid: expected JSON",
  ],
  [
    "a profile with an unknown field",
    `{"team":{"secrets":{"KEY":"${SECRET}"}}}`,
    'SKY_BASE_PROFILES.team is invalid: Unrecognized key: "secrets"',
  ],
  [
    "a plugin that isn't name@marketplace",
    `{"team":{"plugins":["${SECRET}"]}}`,
    "SKY_BASE_PROFILES.team.plugins.0 is invalid: Invalid string: must match pattern /^[A-Za-z0-9][^@\\s]*@[^@\\s]+$/",
  ],
  [
    "a profile name with a space",
    `{"a b":{"checks":["${SECRET}"]}}`,
    "SKY_BASE_PROFILES.a b is invalid: Invalid key in record",
  ],
  [
    "a store repo that isn't owner/name",
    `{"team":{"storeRepo":"${SECRET}"}}`,
    "SKY_BASE_PROFILES.team.storeRepo is invalid: expected a GitHub repo as owner/name",
  ],
  [
    "an MCP credential that isn't a secret's name",
    `{"team":{"mcpServers":{"x":{"command":"x","env":{"KEY":"${SECRET} abc"}}}}}`,
    "SKY_BASE_PROFILES.team.mcpServers.x.env.KEY is invalid: expected an env secret's name",
  ],
  [
    "an MCP server that is neither stdio nor http",
    `{"team":{"mcpServers":{"x":{"args":["${SECRET}"]}}}}`,
    'SKY_BASE_PROFILES.team.mcpServers.x.command is invalid: Invalid input: expected string, received undefined; SKY_BASE_PROFILES.team.mcpServers.x.url is invalid: Invalid input: expected string, received undefined; SKY_BASE_PROFILES.team.mcpServers.x is invalid: Unrecognized key: "args"',
  ],
  [
    "an MCP server mixing stdio and http fields",
    `{"team":{"mcpServers":{"x":{"command":"","url":"${SECRET} abc"}}}}`,
    'SKY_BASE_PROFILES.team.mcpServers.x.command is invalid: Too small: expected string to have >=1 characters; SKY_BASE_PROFILES.team.mcpServers.x is invalid: Unrecognized key: "url"; SKY_BASE_PROFILES.team.mcpServers.x.url is invalid: Invalid URL; SKY_BASE_PROFILES.team.mcpServers.x is invalid: Unrecognized key: "command"',
  ],
  [
    "a store home outside $HOME",
    `{"team":{"storeRepo":"a/b","storeLayout":{"home":"/etc/${SECRET}"}}}`,
    "SKY_BASE_PROFILES.team.storeLayout.home is invalid: expected a path under $HOME",
  ],
  [
    "a marketplace source that is a flag",
    `{"team":{"marketplaces":["--${SECRET}"]}}`,
    "SKY_BASE_PROFILES.team.marketplaces.0 is invalid: Invalid string: must match pattern /^[^\\s-][^\\s]*$/",
  ],
])(
  "SKY_BASE_PROFILES with %s is rejected, naming the field and never the value",
  (_, value, problems) => {
    const result = loadConfig({ ...required, SKY_BASE_PROFILES: value });
    expect(result).toEqual({
      ok: false,
      message: `invalid config: ${problems}`,
    });
    expect(!result.ok && result.message).not.toContain(SECRET);
  },
);

test("docs/examples/base-profile.kru.json is a valid SKY_BASE_PROFILES", () => {
  const example = readFileSync(
    new URL("../../../docs/examples/base-profile.kru.json", import.meta.url),
    "utf8",
  );
  const result = loadConfig({ ...required, SKY_BASE_PROFILES: example });
  expect(result.ok).toBe(true);
  expect(result.ok && Object.keys(result.config.baseProfiles)).toEqual(["kru"]);
});
