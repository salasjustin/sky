import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentId } from "@sky/shared";
import { afterEach, beforeEach, expect, test } from "vitest";
import { parseWorkCheck, WORK_CHECK } from "./unpublished.js";

// nothing here reads the machine's git config or the clock
const env = {
  PATH: process.env.PATH,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();

let root: string;
let repo: string;
let trees: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sky-work-check-"));
  const origin = join(root, "origin");
  repo = join(root, "repo");
  trees = join(root, "worktrees");
  mkdirSync(origin);
  git(origin, "init", "-q", "-b", "main");
  writeFileSync(join(origin, "a.txt"), "a\n");
  git(origin, "add", ".");
  git(origin, "commit", "-q", "-m", "first");
  git(root, "clone", "-q", origin, repo);
  mkdirSync(trees);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A worktree on claude/<id>, as the runner makes one. */
function worktree(id: string) {
  const path = join(trees, id);
  git(repo, "worktree", "add", "-q", path, "-b", `claude/${id}`);
  return path;
}

const commit = (cwd: string, file: string, subject = file) => {
  writeFileSync(join(cwd, file), `${file}\n`);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", subject);
  return git(cwd, "rev-parse", "HEAD");
};

/** What the runner's `recordPublished` leaves: two lines, in a file named for the local branch. */
function recordPublished(id: string, head: string, branch: string) {
  const dir = join(repo, ".git", "sky-published");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `claude%2F${id}`), `${head}\n${branch}\n`);
}

/** The check's raw answer for `ids`. */
function answer(...ids: string[]) {
  const out = spawnSync("bash", ["-c", WORK_CHECK, "_", trees, ...ids], {
    env,
    encoding: "utf8",
  });
  expect(out.status).toBe(0);
  return out.stdout;
}

function check(...ids: string[]) {
  return Object.fromEntries(
    answer(...ids)
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [id = "", ...rest] = line.split("\t");
        return [id, rest.join("\t")];
      }),
  );
}

test("an agent with no worktree on the sprite has nothing there", () => {
  expect(check("agt_none")).toEqual({ agt_none: "none" });
});

test("a worktree with no change and no commit is clean", () => {
  worktree("agt_clean");
  expect(check("agt_clean")).toEqual({ agt_clean: "ok\t0\t0\t0\t" });
});

test("uncommitted changes, tracked or new, are counted", () => {
  const path = worktree("agt_dirty");
  writeFileSync(join(path, "a.txt"), "changed\n");
  writeFileSync(join(path, "new.txt"), "new\n");
  expect(check("agt_dirty")).toEqual({ agt_dirty: "ok\t2\t0\t0\t" });
});

test("commits on a branch that was never published are all at risk", () => {
  const path = worktree("agt_never");
  commit(path, "b.txt");
  commit(path, "c.txt");
  expect(check("agt_never")).toEqual({ agt_never: "ok\t0\t2\t1\t" });
});

test("commits past the last publish are at risk, the published ones are not", () => {
  const path = worktree("agt_ahead");
  const published = commit(path, "b.txt");
  recordPublished("agt_ahead", published, "feature/login");
  expect(check("agt_ahead")).toEqual({
    agt_ahead: "ok\t0\t0\t0\tfeature/login",
  });
  commit(path, "c.txt");
  writeFileSync(join(path, "a.txt"), "dirty\n");
  expect(check("agt_ahead")).toEqual({
    agt_ahead: "ok\t1\t1\t0\tfeature/login",
  });
});

test("a worktree started on a GitHub branch counts that branch's tip as published", () => {
  const path = worktree("agt_start");
  const tip = commit(path, "b.txt", "already on GitHub");
  git(repo, "update-ref", "refs/sky/starts/agt_start", tip);
  expect(check("agt_start")).toEqual({ agt_start: "ok\t0\t0\t0\t" });
  commit(path, "c.txt");
  expect(check("agt_start")).toEqual({ agt_start: "ok\t0\t1\t0\t" });
});

test("a branch rebased since its publish, with the same files, is still published", () => {
  const path = worktree("agt_rebased");
  const published = commit(path, "b.txt");
  recordPublished("agt_rebased", published, "feature/rebased");
  // the same change on new commits: the old head is no longer an ancestor of HEAD
  git(path, "reset", "-q", "--hard", "main");
  commit(path, "b.txt");
  expect(check("agt_rebased")).toEqual({
    agt_rebased: "ok\t0\t0\t0\tfeature/rebased",
  });
});

test("a branch rebased since its publish, with more commits, counts what is past the shared history", () => {
  const path = worktree("agt_diverged");
  const published = commit(path, "b.txt");
  recordPublished("agt_diverged", published, "feature/diverged");
  git(path, "reset", "-q", "--hard", "main");
  commit(path, "other.txt");
  expect(check("agt_diverged")).toEqual({
    agt_diverged: "ok\t0\t1\t0\tfeature/diverged",
  });
});

test("every agent is answered, and a branch with a % or / in its name finds its record", () => {
  worktree("agt_one");
  const path = worktree("agt_two");
  const head = commit(path, "b.txt");
  recordPublished("agt_two", head, "feature/two");
  expect(check("agt_one", "agt_gone", "agt_two")).toEqual({
    agt_one: "ok\t0\t0\t0\t",
    agt_gone: "none",
    agt_two: "ok\t0\t0\t0\tfeature/two",
  });
});

test("the check leaves the worktrees as it found them", () => {
  const path = worktree("agt_still");
  commit(path, "b.txt");
  writeFileSync(join(path, "a.txt"), "dirty\n");
  const before = git(path, "status", "--porcelain");
  const head = git(path, "rev-parse", "HEAD");
  check("agt_still");
  expect(git(path, "status", "--porcelain")).toBe(before);
  expect(git(path, "rev-parse", "HEAD")).toBe(head);
});

const rows = (...ids: string[]) =>
  ids.map((id) => ({
    id: id as AgentId,
    branch: `claude/${id}`,
    remoteBranch: null,
  }));

test("parseWorkCheck names each agent at risk, by the branch it publishes to", () => {
  const found = parseWorkCheck(
    "agt_a\tok\t1\t0\t0\t\nagt_b\tok\t0\t3\t0\tfeature/b\nagt_c\tnone\nagt_d\tok\t0\t0\t0\t\n",
    [
      ...rows("agt_a", "agt_c", "agt_d"),
      {
        id: "agt_b" as AgentId,
        branch: "claude/agt_b",
        remoteBranch: "feature/started",
      },
    ],
  );
  expect(found).toEqual([
    {
      agentId: "agt_a",
      branch: "claude/agt_a",
      uncommitted: 1,
      unpublishedCommits: 0,
      neverPublished: false,
    },
    {
      agentId: "agt_b",
      branch: "feature/b",
      uncommitted: 0,
      unpublishedCommits: 3,
      neverPublished: false,
    },
  ]);
});

test("parseWorkCheck refuses an answer that leaves an agent out or can't be read", () => {
  expect(() =>
    parseWorkCheck("agt_a\tok\t0\t0\t0\t\n", rows("agt_a", "agt_b")),
  ).toThrow(/said nothing of agt_b/);
  expect(() =>
    parseWorkCheck("agt_a\tok\tmany\t0\t0\t\n", rows("agt_a")),
  ).toThrow(/unreadable/);
  expect(() => parseWorkCheck("agt_a\tweird\n", rows("agt_a"))).toThrow(
    /unreadable/,
  );
});

// a git step that fails must leave the worktree unreadable, so the rebuild falls back to the records
// and refuses; read as 0 it would rebuild over the work

test("a worktree whose git status fails, as with a corrupt index, is unreadable rather than clean", () => {
  const path = worktree("agt_corrupt");
  writeFileSync(join(path, "new.txt"), "new\n");
  writeFileSync(join(repo, ".git", "worktrees", "agt_corrupt", "index"), "x");
  expect(check("agt_corrupt")).toEqual({ agt_corrupt: "error" });
  expect(() =>
    parseWorkCheck(answer("agt_corrupt"), rows("agt_corrupt")),
  ).toThrow(/unreadable/);
});

test("commits with no publish record, no start ref and no origin/HEAD to count from are unreadable rather than clean", () => {
  const path = worktree("agt_nobase");
  commit(path, "b.txt");
  git(repo, "remote", "set-head", "origin", "--delete");
  expect(check("agt_nobase")).toEqual({ agt_nobase: "error" });
  expect(() =>
    parseWorkCheck(answer("agt_nobase"), rows("agt_nobase")),
  ).toThrow(/unreadable/);
});

test("parseWorkCheck refuses an ok line with fields missing or empty, rather than reading them as 0", () => {
  for (const line of [
    "agt_a\tok",
    "agt_a\tok\t0\t0",
    "agt_a\tok\t\t\t0\t",
    "agt_a\tok\t0\t0\t\t",
  ]) {
    expect(() => parseWorkCheck(`${line}\n`, rows("agt_a"))).toThrow(
      /unreadable/,
    );
  }
});
