import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  claudeProcessEnv,
  commandEnvScript,
  prepareCommandEnv,
} from "./claude-auth.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sky-claude-auth-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const runnerEnv = {
  PATH: "/bin",
  ANTHROPIC_API_KEY: "project-key",
  ANTHROPIC_AUTH_TOKEN: "project-auth",
  CLAUDE_CODE_OAUTH_TOKEN: "subscription-token",
  SKY_CLAUDE_AUTH: "oauth",
  SKY_CLAUDE_API_KEY: "sky-key",
  ANTHROPIC_BASE_URL: "https://gateway.example",
  CLAUDE_CODE_USE_BEDROCK: "1",
  CLAUDE_CODE_USE_VERTEX: "1",
  CLAUDE_CODE_USE_FOUNDRY: "1",
  CLAUDE_CODE_USE_ANTHROPIC_AWS: "1",
  CLAUDE_CODE_USE_MANTLE: "1",
};

test("a subscription run's process env keeps the token and no API key of any name, gateway or provider switch", () => {
  expect(claudeProcessEnv(runnerEnv, "oauth")).toEqual({
    PATH: "/bin",
    CLAUDE_CODE_OAUTH_TOKEN: "subscription-token",
  });
});

test("an API-key run's process env holds Sky's key as ANTHROPIC_API_KEY, and no token, gateway or provider switch", () => {
  expect(claudeProcessEnv(runnerEnv, "api-key")).toEqual({
    PATH: "/bin",
    ANTHROPIC_API_KEY: "sky-key",
  });
});

test("the credential comes from the runner's own env, never from a session env merged over it", () => {
  const merged = {
    ...runnerEnv,
    CLAUDE_CODE_OAUTH_TOKEN: "profile-token",
    SKY_CLAUDE_API_KEY: "profile-key",
  };
  expect(claudeProcessEnv(merged, "oauth", runnerEnv)).toEqual({
    PATH: "/bin",
    CLAUDE_CODE_OAUTH_TOKEN: "subscription-token",
  });
  expect(claudeProcessEnv(merged, "api-key", runnerEnv)).toEqual({
    PATH: "/bin",
    ANTHROPIC_API_KEY: "sky-key",
  });
});

test("the command script gives commands the project's key, or unsets Sky's on an API-key run", () => {
  expect(commandEnvScript("oauth", { ANTHROPIC_API_KEY: "pk'1" })).toBe(
    "export ANTHROPIC_API_KEY='pk'\\''1'\n",
  );
  expect(commandEnvScript("api-key", { ANTHROPIC_API_KEY: "pk" })).toBe(
    "export ANTHROPIC_API_KEY='pk'\n",
  );
  expect(commandEnvScript("api-key", { PATH: "/bin" })).toBe(
    "unset ANTHROPIC_API_KEY\n",
  );
  expect(commandEnvScript("oauth", { PATH: "/bin" })).toBeUndefined();
});

test("the command script gives commands back every project value the Claude process drops, and no run credential", () => {
  const script = commandEnvScript("oauth", runnerEnv);
  expect(script).toBe(
    [
      "export ANTHROPIC_API_KEY='project-key'",
      "export ANTHROPIC_AUTH_TOKEN='project-auth'",
      "export ANTHROPIC_BASE_URL='https://gateway.example'",
      "export CLAUDE_CODE_USE_BEDROCK='1'",
      "export CLAUDE_CODE_USE_VERTEX='1'",
      "export CLAUDE_CODE_USE_FOUNDRY='1'",
      "export CLAUDE_CODE_USE_ANTHROPIC_AWS='1'",
      "export CLAUDE_CODE_USE_MANTLE='1'",
      "",
    ].join("\n"),
  );
  expect(script).not.toContain("subscription-token");
  expect(script).not.toContain("sky-key");
  expect(commandEnvScript("api-key", runnerEnv)).toBe(script);
});

test("an API-key run whose project has a gateway but no key still unsets Sky's key for commands", () => {
  const script = commandEnvScript("api-key", {
    ANTHROPIC_AUTH_TOKEN: "gw'token",
    ANTHROPIC_BASE_URL: "https://gateway.example",
    SKY_CLAUDE_API_KEY: "sky-key",
  });
  expect(script).toBe(
    [
      "unset ANTHROPIC_API_KEY",
      "export ANTHROPIC_AUTH_TOKEN='gw'\\''token'",
      "export ANTHROPIC_BASE_URL='https://gateway.example'",
      "",
    ].join("\n"),
  );
});

test("the script file is readable by its owner alone, and gone once removed", async () => {
  const env = await prepareCommandEnv(
    "oauth",
    { ANTHROPIC_API_KEY: "project-key" },
    dir,
  );
  const command = JSON.stringify(env.hooks);
  const path = /cat '([^']+)'/.exec(command)?.[1] ?? "";
  expect(readFileSync(path, "utf8")).toContain("project-key");
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(command).not.toContain("project-key");
  await env.remove();
  expect(() => statSync(path)).toThrow();
});

test("with nothing to say there is no hook and nothing to remove", async () => {
  const env = await prepareCommandEnv("oauth", { PATH: "/bin" }, dir);
  expect(env.hooks).toBeUndefined();
  await expect(env.remove()).resolves.toBeUndefined();
});
