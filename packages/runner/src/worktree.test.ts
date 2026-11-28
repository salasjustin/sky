import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { recordPublished } from "./published.js";
import { commitAll, diffRollup, ensureWorktree, headSha } from "./worktree.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let root: string;
let origin: string;
let repoDir: string;
let worktreesDir: string;

beforeEach(() => {
  // a host that exports git identity (a sandbox, a CI bot) would beat the `-c user.name` the commit sets
  for (const name of [
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
  ])
    vi.stubEnv(name, undefined);
  root = mkdtempSync(join(tmpdir(), "runner-wt-"));
  origin = join(root, "origin");
  repoDir = join(root, "repo");
  worktreesDir = join(root, "worktrees");
  execFileSync("git", ["init", "-q", "-b", "trunk", origin]);
  writeFileSync(join(origin, "README"), "hi\n");
  git(origin, "add", ".");
  git(
    origin,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-qm",
    "init",
  );
  execFileSync("git", ["clone", "-q", origin, repoDir]);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

test("first run branches claude/<agentId> from the clone's default branch", async () => {
  const path = await ensureWorktree({
    repoDir,
    worktreesDir,
    agentId: "agt_1",
  });
  expect(path).toBe(join(worktreesDir, "agt_1"));
  expect(git(path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("claude/agt_1");
  expect(git(path, "rev-parse", "HEAD")).toBe(
    git(origin, "rev-parse", "trunk"),
  );
});

test("a later run reuses the worktree and what's in it", async () => {
  const path = await ensureWorktree({
    repoDir,
    worktreesDir,
    agentId: "agt_1",
  });
  writeFileSync(join(path, "wip.txt"), "draft\n");
  expect(
    await ensureWorktree({ repoDir, worktreesDir, agentId: "agt_1" }),
  ).toBe(path);
  expect(existsSync(join(path, "wip.txt"))).toBe(true);
});

test("two agents on one clone get separate worktrees and branches, and a write in one is absent from the other", async () => {
  const a = await ensureWorktree({ repoDir, worktreesDir, agentId: "agt_1" });
  const b = await ensureWorktree({ repoDir, worktreesDir, agentId: "agt_2" });
  expect(a).not.toBe(b);
  expect(git(a, "rev-parse", "--abbrev-ref", "HEAD")).toBe("claude/agt_1");
  expect(git(b, "rev-parse", "--abbrev-ref", "HEAD")).toBe("claude/agt_2");

  writeFileSync(join(a, "only-a.txt"), "a\n");
  await commitAll({ cwd: a, agentId: "agt_1", runId: "run_1" });

  expect(existsSync(join(b, "only-a.txt"))).toBe(false);
  expect(git(b, "rev-parse", "HEAD")).toBe(git(origin, "rev-parse", "trunk"));
  expect(git(repoDir, "branch", "--list", "claude/agt_2")).toContain(
    "claude/agt_2",
  );
});

test("a branch whose worktree directory is gone is checked out again, keeping its commits", async () => {
  const path = await ensureWorktree({
    repoDir,
    worktreesDir,
    agentId: "agt_1",
  });
  writeFileSync(join(path, "a.txt"), "a\n");
  await commitAll({ cwd: path, agentId: "agt_1", runId: "run_1" });
  const head = git(path, "rev-parse", "HEAD");
  rmSync(path, { recursive: true, force: true });
  await ensureWorktree({ repoDir, worktreesDir, agentId: "agt_1" });
  expect(git(path, "rev-parse", "HEAD")).toBe(head);
});

test("commits every change on the agent branch as sky-agent, and never pushes", async () => {
  const path = await ensureWorktree({
    repoDir,
    worktreesDir,
    agentId: "agt_1",
  });
  writeFileSync(join(path, "new.txt"), "n\n");
  writeFileSync(join(path, "README"), "changed\n");
  expect(await commitAll({ cwd: path, agentId: "agt_1", runId: "run_7" })).toBe(
    true,
  );
  expect(git(path, "status", "--porcelain")).toBe("");
  expect(git(path, "log", "-1", "--format=%an <%ae>|%s")).toBe(
    "sky-agent <agent@sky.local>|agent agt_1 run run_7",
  );
  expect(git(origin, "branch", "--list", "claude/*")).toBe("");
});

test("a clean worktree makes no commit", async () => {
  const path = await ensureWorktree({
    repoDir,
    worktreesDir,
    agentId: "agt_1",
  });
  const head = git(path, "rev-parse", "HEAD");
  expect(await commitAll({ cwd: path, agentId: "agt_1", runId: "run_1" })).toBe(
    false,
  );
  expect(git(path, "rev-parse", "HEAD")).toBe(head);
});

const commit = (cwd: string, subject: string) => {
  git(cwd, "add", "--all");
  git(
    cwd,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-qm",
    subject,
  );
  return git(cwd, "rev-parse", "HEAD");
};

test("a run's rollup lists its commits newest first with their diffstat; cumulative matches on a first run", async () => {
  const path = await ensureWorktree({
    repoDir,
    worktreesDir,
    agentId: "agt_1",
  });
  const since = await headSha(path);
  writeFileSync(join(path, "a.txt"), "1\n2\n3\n");
  const first = commit(path, "add a");
  writeFileSync(join(path, "README"), "bye\n");
  writeFileSync(join(path, "a.txt"), "1\n3\n");
  const second = commit(path, "edit a and README");
  const rollup = await diffRollup({ cwd: path, since });
  const run = {
    commits: [
      { sha: second, subject: "edit a and README" },
      { sha: first, subject: "add a" },
    ],
    files: 2,
    added: 3,
    removed: 1,
  };
  expect(rollup).toEqual({
    base: git(origin, "rev-parse", "trunk"),
    run,
    cumulative: run,
  });
});

test("a follow-up run's rollup covers only its own commits; cumulative covers the branch since base", async () => {
  const path = await ensureWorktree({
    repoDir,
    worktreesDir,
    agentId: "agt_1",
  });
  writeFileSync(join(path, "a.txt"), "a\n");
  const first = commit(path, "add a");
  writeFileSync(join(path, "b.txt"), "b\n");
  const second = commit(path, "add b");
  const since = await headSha(path);
  writeFileSync(join(path, "a.txt"), "a2\n");
  const third = commit(path, "change a");
  const rollup = await diffRollup({ cwd: path, since });
  expect(rollup.run).toEqual({
    commits: [{ sha: third, subject: "change a" }],
    files: 1,
    added: 1,
    removed: 1,
  });
  expect(rollup.cumulative).toEqual({
    commits: [
      { sha: third, subject: "change a" },
      { sha: second, subject: "add b" },
      { sha: first, subject: "add a" },
    ],
    files: 2,
    added: 2,
    removed: 0,
  });
});

test("a run that changed nothing has an empty run rollup", async () => {
  const path = await ensureWorktree({
    repoDir,
    worktreesDir,
    agentId: "agt_1",
  });
  writeFileSync(join(path, "a.txt"), "a\n");
  commit(path, "add a");
  const since = await headSha(path);
  const rollup = await diffRollup({ cwd: path, since });
  expect(rollup.run).toEqual({ commits: [], files: 0, added: 0, removed: 0 });
  expect(rollup.cumulative.commits).toHaveLength(1);
});

test("a binary file counts as a file with no lines, and a subject clips to 200 characters", async () => {
  const path = await ensureWorktree({
    repoDir,
    worktreesDir,
    agentId: "agt_1",
  });
  const since = await headSha(path);
  writeFileSync(join(path, "blob.bin"), Buffer.from([0, 1, 2, 0, 255]));
  commit(path, "x".repeat(300));
  const { run } = await diffRollup({ cwd: path, since });
  expect(run).toMatchObject({ files: 1, added: 0, removed: 0 });
  expect(run.commits[0]?.subject).toBe(`${"x".repeat(199)}…`);
});

test("the commit list keeps the newest 50", async () => {
  const path = await ensureWorktree({
    repoDir,
    worktreesDir,
    agentId: "agt_1",
  });
  const since = await headSha(path);
  for (let i = 1; i <= 51; i++)
    git(
      path,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      `empty ${i}`,
    );
  const { run, cumulative } = await diffRollup({ cwd: path, since });
  expect(run.commits).toHaveLength(50);
  expect(run.commits[0]?.subject).toBe("empty 51");
  expect(run.commits.at(-1)?.subject).toBe("empty 2");
  expect(cumulative.commits).toHaveLength(50);
});

test("a rollup carries what was last published, for a rebuild to compare the branch against", async () => {
  const path = await ensureWorktree({
    repoDir,
    worktreesDir,
    agentId: "agt_1",
  });
  const since = await headSha(path);
  writeFileSync(join(path, "a.txt"), "1\n");
  const first = commit(path, "add a");
  expect((await diffRollup({ cwd: path, since })).published).toBeUndefined();
  await recordPublished(path, "claude/agt_1", {
    head: first,
    branch: "feature/a",
  });
  expect((await diffRollup({ cwd: path, since })).published).toEqual({
    head: first,
    branch: "feature/a",
  });
});

test("a worktree started on a GitHub branch counts the branch's tip as published until it publishes", async () => {
  const path = await ensureWorktree({
    repoDir,
    worktreesDir,
    agentId: "agt_1",
  });
  const since = await headSha(path);
  git(repoDir, "update-ref", "refs/sky/starts/agt_1", since);
  // `continueStartBranch` records the branch the runner publishes to
  git(
    repoDir,
    "config",
    "branch.claude/agt_1.sky-remote-branch",
    "feature/theirs",
  );
  writeFileSync(join(path, "a.txt"), "1\n");
  commit(path, "add a");
  expect((await diffRollup({ cwd: path, since })).published).toEqual({
    head: since,
    branch: "feature/theirs",
  });
});
