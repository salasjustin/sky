import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { repoLockPath, withRepoLock } from "./repo-lock.js";
import { prepareWorktree } from "./sync.js";
import { retryOnLock } from "./worktree.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let root: string;
let repoDir: string;
let worktreesDir: string;

beforeEach(() => {
  for (const name of [
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
  ])
    vi.stubEnv(name, undefined);
  root = mkdtempSync(join(tmpdir(), "runner-lock-"));
  const origin = join(root, "origin");
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
    "i",
  );
  execFileSync("git", ["clone", "-q", origin, repoDir]);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const launch = (n: number) =>
  prepareWorktree(
    { repoDir, worktreesDir, agentId: `agt_${n}` },
    { env: {}, warn: () => {} },
  );

test("two launches started at once both get worktrees", async () => {
  const results = await Promise.all([launch(1), launch(2)]);
  expect(results.map((r) => r.cwd)).toEqual([
    join(worktreesDir, "agt_1"),
    join(worktreesDir, "agt_2"),
  ]);
  for (const [i, { cwd }] of results.entries()) {
    expect(git(cwd, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
      `claude/agt_${i + 1}`,
    );
  }
});

test("three launches started at once all get worktrees", async () => {
  const results = await Promise.all([launch(1), launch(2), launch(3)]);
  expect(results.every((r) => existsSync(r.cwd))).toBe(true);
  expect(git(repoDir, "worktree", "list", "--porcelain")).toMatch(
    /agt_1[\s\S]*agt_2[\s\S]*agt_3|agt_\d[\s\S]*agt_\d[\s\S]*agt_\d/,
  );
});

test("a launch waits while another holds the lock, then goes ahead", async () => {
  let released = false;
  const holding = withRepoLock(repoDir, async () => {
    await sleep(400);
    released = true;
  });
  await sleep(100);
  await launch(1);
  expect(released).toBe(true);
  await holding;
});

test("the lock wait is bounded and its error names the lock", async () => {
  const holding = withRepoLock(repoDir, () => sleep(1500));
  await sleep(100);
  const started = Date.now();
  await expect(withRepoLock(repoDir, async () => {}, 0.3)).rejects.toThrow(
    repoLockPath(repoDir),
  );
  expect(Date.now() - started).toBeLessThan(1200);
  await holding;
});

test("a lock file left by a killed process does not block", async () => {
  writeFileSync(repoLockPath(repoDir), "999999\n");
  await expect(withRepoLock(repoDir, async () => "ok", 2)).resolves.toBe("ok");
});

test("the lock is released when the task throws", async () => {
  await expect(
    withRepoLock(repoDir, async () => {
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  await expect(withRepoLock(repoDir, async () => "ok", 2)).resolves.toBe("ok");
});

test("a step git refused for a held config lock is retried once", async () => {
  const step = vi
    .fn<() => Promise<string>>()
    .mockRejectedValueOnce(
      new Error("error: could not lock config file .git/config: File exists"),
    )
    .mockResolvedValue("done");
  await expect(retryOnLock(step)).resolves.toBe("done");
  expect(step).toHaveBeenCalledTimes(2);
});

test("a second lock refusal, or any other failure, is not retried further", async () => {
  const locked = vi
    .fn<() => Promise<string>>()
    .mockRejectedValue(new Error("could not lock config file"));
  await expect(retryOnLock(locked)).rejects.toThrow("could not lock");
  expect(locked).toHaveBeenCalledTimes(2);
  const other = vi
    .fn<() => Promise<string>>()
    .mockRejectedValue(new Error("x"));
  await expect(retryOnLock(other)).rejects.toThrow("x");
  expect(other).toHaveBeenCalledTimes(1);
});
