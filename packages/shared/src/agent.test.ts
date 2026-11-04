import { expect, test } from "vitest";
import { Agent, agentBranch, BranchName } from "./agent.js";

const agent = {
  id: "agt_7",
  envId: "env_1",
  sessionId: null,
  branch: "claude/agt_7",
  status: "idle",
  archivedAt: null,
  remoteBranch: null,
};

test("accepts an agent on its own branch", () => {
  expect(Agent.parse(agent)).toEqual(agent);
  expect(
    Agent.parse({ ...agent, sessionId: "8f2c-session", status: "running" })
      .sessionId,
  ).toBe("8f2c-session");
});

test("agentBranch names the agent's branch", () => {
  expect(agentBranch("agt_7")).toBe("claude/agt_7");
});

test("rejects a branch that isn't claude/<agentId>", () => {
  const result = Agent.safeParse({ ...agent, branch: "claude/agt_8" });
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.path).toEqual(["branch"]);
  expect(Agent.safeParse({ ...agent, branch: "main" }).success).toBe(false);
});

test("archivedAt is null or a UTC ISO timestamp", () => {
  const archivedAt = "2026-10-29T12:00:00.000Z";
  expect(Agent.parse({ ...agent, archivedAt }).archivedAt).toBe(archivedAt);
  expect(Agent.safeParse({ ...agent, archivedAt: "yesterday" }).success).toBe(
    false,
  );
  const { archivedAt: _, ...unarchived } = agent;
  expect(Agent.safeParse(unarchived).success).toBe(false);
});

test("remoteBranch is null or an existing branch name, beside its own branch", () => {
  const onPr = Agent.parse({ ...agent, remoteBranch: "feature/login" });
  expect(onPr.remoteBranch).toBe("feature/login");
  expect(onPr.branch).toBe("claude/agt_7");
  const bad = Agent.safeParse({ ...agent, remoteBranch: "a..b" });
  expect(bad.error?.issues[0]?.path).toEqual(["remoteBranch"]);
  const { remoteBranch: _, ...withoutField } = agent;
  expect(Agent.safeParse(withoutField).success).toBe(false);
});

test.each([
  "main",
  "feature/login",
  "claude/agt_7",
  "fix-123_v2.1",
  "user@host",
  "a.lockb",
  "x".repeat(255),
])("BranchName accepts %j", (name) => {
  expect(BranchName.parse(name)).toBe(name);
});

test.each([
  ["empty", ""],
  ["over 255 chars", "x".repeat(256)],
  ["a space", "my branch"],
  ["a tab", "a\tb"],
  ["a control char", "a\u0001b"],
  ["DEL", "a\u007fb"],
  ["~", "a~1"],
  ["^", "a^2"],
  [":", "a:b"],
  ["?", "a?"],
  ["*", "a*"],
  ["[", "a[b"],
  ["backslash", "a\\b"],
  ["..", "a..b"],
  ["@{", "a@{1}"],
  ["leading -", "-main"],
  ["leading /", "/main"],
  ["trailing /", "main/"],
  ["trailing .", "main."],
  ["trailing .lock", "main.lock"],
  ["//", "a//b"],
  ["exactly @", "@"],
  ["refs/ prefix", "refs/heads/main"],
])("BranchName rejects %s", (_, name) => {
  const result = BranchName.safeParse(name);
  expect(result.success).toBe(false);
});

test("BranchName names the rule it enforces", () => {
  expect(BranchName.safeParse("a..b").error?.issues[0]?.message).toMatch(
    /git branch name/,
  );
});
