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
};

test("a subscription run's process env keeps the token and no API key of any name", () => {
  expect(claudeProcessEnv(runnerEnv, "oauth")).toEqual({
    PATH: "/bin",
    CLAUDE_CODE_OAUTH_TOKEN: "subscription-token",
  });
});

test("an API-key run's process env holds Sky's key as ANTHROPIC_API_KEY and no token", () => {
  expect(claudeProcessEnv(runnerEnv, "api-key")).toEqual({
    PATH: "/bin",
    ANTHROPIC_API_KEY: "sky-key",
  });
});

test("the command script gives commands the project's key, or unsets Sky's on an API-key run", () => {
  expect(commandEnvScript("oauth", "pk'1")).toBe(
    "export ANTHROPIC_API_KEY='pk'\\''1'\n",
  );
  expect(commandEnvScript("api-key", "pk")).toBe(
    "export ANTHROPIC_API_KEY='pk'\n",
  );
  expect(commandEnvScript("api-key", undefined)).toBe(
    "unset ANTHROPIC_API_KEY\n",
  );
  expect(commandEnvScript("oauth", undefined)).toBeUndefined();
});

test("the script file is readable by its owner alone, and gone once removed", async () => {
  const env = await prepareCommandEnv("oauth", "project-key", dir);
  const command = JSON.stringify(env.hooks);
  const path = /cat '([^']+)'/.exec(command)?.[1] ?? "";
  expect(readFileSync(path, "utf8")).toContain("project-key");
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(command).not.toContain("project-key");
  await env.remove();
  expect(() => statSync(path)).toThrow();
});

test("with nothing to say there is no hook and nothing to remove", async () => {
  const env = await prepareCommandEnv("oauth", undefined, dir);
  expect(env.hooks).toBeUndefined();
  await expect(env.remove()).resolves.toBeUndefined();
});
