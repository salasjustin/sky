import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
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

// git is the oracle: outside any repo, so `@{-1}`-style names can't expand to a real branch
const gitAccepts = (name: string) =>
  spawnSync("git", ["check-ref-format", "--branch", name], {
    cwd: tmpdir(),
  }).status === 0;

test.each([
  "main",
  "feature/login",
  "claude/agt_7",
  "fix-123_v2.1",
  "user@host",
  "a.lockb",
  "a.lock.b/c",
  "feat/x.y",
  "x".repeat(255),
  "",
  "my branch",
  "a\tb",
  "a\u0001b",
  "a\u007fb",
  "a~1",
  "a^2",
  "a:b",
  "a?",
  "a*",
  "a[b",
  "a\\b",
  "a..b",
  "a@{1}",
  "-main",
  "/main",
  "main/",
  "main.",
  "main.lock",
  "a//b",
  ".hidden",
  "feat/.x",
  "a.lock/b",
  "feat/a.lock/b",
  "HEAD",
])("BranchName agrees with git check-ref-format --branch on %j", (name) => {
  expect(BranchName.safeParse(name).success).toBe(gitAccepts(name));
});

// where git is laxer than a branch the API can start an agent on
test.each([
  ["a full ref, not a branch name", "refs/heads/main"],
  ["over the 255-char cap", "x".repeat(256)],
  ["Unicode whitespace", "feat x"],
  ["exactly @, which git reads as HEAD inside a repo", "@"],
])("BranchName rejects %s, which git accepts", (_, name) => {
  expect(gitAccepts(name)).toBe(true);
  expect(BranchName.safeParse(name).success).toBe(false);
});

test("BranchName names the rule it enforces", () => {
  expect(BranchName.safeParse("a..b").error?.issues[0]?.message).toMatch(
    /git branch name/,
  );
});
