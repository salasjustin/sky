import { expect, test } from "vitest";
import {
  ClaudeCredentialName,
  ClaudeSubscriptionName,
} from "./claude-credential.js";
import { Environment } from "./environment.js";

const env = {
  id: "env_1",
  name: "kru",
  repo: "ap-justin/kru",
  setup: "pnpm install",
  status: "ready",
  spriteName: "sky-kru",
  checkpointId: "cp_abc",
};

test("pool is reserved and can't be a subscription name or a pool member", () => {
  expect(ClaudeSubscriptionName.safeParse("pool").success).toBe(false);
  const parsed = Environment.safeParse({
    ...env,
    claudeCredential: "pool",
    claudePool: ["work", "pool"],
  });
  expect(parsed.error?.issues.map((issue) => issue.path)).toEqual([
    ["claudePool", 1],
  ]);
});

test("default is a pool member", () => {
  expect(
    Environment.parse({
      ...env,
      claudeCredential: "pool",
      claudePool: ["default", "work"],
    }).claudePool,
  ).toEqual(["default", "work"]);
});

test("pool is an assignment", () => {
  expect(ClaudeCredentialName.parse("pool")).toBe("pool");
  expect(
    Environment.parse({ ...env, claudeCredential: "pool" }).claudeCredential,
  ).toBe("pool");
});

test.each([
  { label: "a token", name: "sk-ant-oat01-abc" },
  { label: "a 65-character name", name: "a".repeat(65) },
])("rejects $label as a subscription and as a credential name", ({ name }) => {
  expect(ClaudeSubscriptionName.safeParse(name).success).toBe(false);
  expect(ClaudeCredentialName.safeParse(name).success).toBe(false);
});

test("an invalid credential name lists every kind of name", () => {
  expect(
    ClaudeCredentialName.safeParse("Default").error?.issues[0]?.message,
  ).toBe(
    "expected a credential name: a subscription (lowercase letters, digits, _), default, pool or api-key",
  );
});
