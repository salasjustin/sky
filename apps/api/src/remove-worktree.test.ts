import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_LOCK_FILE, REPO_LOCK_TIMED_OUT } from "@sky/shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { REMOVE_WORKTREE } from "./launch.js";
import { REPO_DIR } from "./provision.js";

// real git, bash and flock processes: a loaded machine runs well past the 5 s default
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

// REMOVE_WORKTREE runs under bash on a Linux sprite with util-linux flock
const canRun =
  spawnSync("flock", ["-V"]).status === 0 &&
  spawnSync("bash", ["-c", "true"]).status === 0;

const isolatedEnv = (home: string) => ({
  PATH: process.env.PATH,
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
});

describe.skipIf(!canRun)("REMOVE_WORKTREE under real bash", () => {
  let root: string;
  let repo: string;
  let path: string;
  let holders: ChildProcess[];

  const git = (...args: string[]) => {
    const out = spawnSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      env: isolatedEnv(root),
    });
    expect(out.status, out.stderr).toBe(0);
    return out.stdout.trim();
  };
  const remove = (script = REMOVE_WORKTREE, target = path) =>
    spawnSync("bash", ["-c", script, "_", target], {
      cwd: repo,
      encoding: "utf8",
      env: isolatedEnv(root),
    });
  const worktreePaths = () =>
    git("worktree", "list", "--porcelain")
      .split("\n")
      .filter((l) => l.startsWith("worktree "));

  /** A process that holds the repo lock until killed; resolves once it says so. */
  const holdLock = async () => {
    const holder = spawn(
      "sh",
      [
        "-c",
        // one process owns the lock's fd (flock(1) with a command forks, leaving the child holding it)
        'exec 9>"$1"; flock -x 9; echo held; exec sleep 3600',
        "_",
        join(repo, ".git", REPO_LOCK_FILE),
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    holders.push(holder);
    const exited = new Promise<void>((resolve) => holder.on("close", () => resolve()));
    await new Promise<void>((resolve) => holder.stdout?.once("data", () => resolve()));
    return async () => {
      holder.kill("SIGKILL");
      await exited;
    };
  };

  beforeEach(() => {
    holders = [];
    root = mkdtempSync(join(tmpdir(), "api-rm-worktree-"));
    repo = join(root, "repo");
    path = join(root, "worktrees", "agt_1");
    mkdirSync(repo);
    git("init", "-q", "-b", "trunk");
    writeFileSync(join(repo, "README"), "hi\n");
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "i");
    git("worktree", "add", "-q", "-b", "claude/agt_1", path);
  });
  afterEach(() => {
    for (const h of holders) h.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  });

  test("removes the worktree and keeps its branch", () => {
    expect(worktreePaths()).toHaveLength(2);
    const out = remove();
    expect(out.status, out.stderr).toBe(0);
    expect(existsSync(path)).toBe(false);
    expect(worktreePaths()).toHaveLength(1);
    expect(git("branch", "--list", "claude/agt_1")).toContain("claude/agt_1");
  });

  test("a worktree that never existed counts as removed", () => {
    const never = join(root, "worktrees", "agt_never");
    const out = remove(REMOVE_WORKTREE, never);
    expect(out.status, out.stderr).toBe(0);
    expect(worktreePaths()).toHaveLength(2);
  });

  test("a directory git won't remove as a worktree fails the removal", () => {
    const plain = join(root, "worktrees", "plain");
    mkdirSync(plain);
    const out = remove(REMOVE_WORKTREE, plain);
    expect(out.status).not.toBe(0);
    expect(out.status).not.toBe(REPO_LOCK_TIMED_OUT);
    expect(existsSync(plain)).toBe(true);
  });

  test("a lock held past the wait fails with the timeout status, naming the lock, and removes nothing", async () => {
    const release = await holdLock();
    // the 20 s wait is baked into the script; shorten it so the test waits 1 s
    const shortened = REMOVE_WORKTREE.replace(/-w \d+ /, "-w 1 ");
    expect(shortened).not.toBe(REMOVE_WORKTREE);
    const held = remove(shortened);
    expect(held.status).toBe(REPO_LOCK_TIMED_OUT);
    expect(held.stderr).toContain(
      `can't take the repo lock ${REPO_DIR}/.git/${REPO_LOCK_FILE} within `,
    );
    expect(held.stderr).toContain("another run's setup is holding it");
    expect(existsSync(path)).toBe(true);
    // the same script goes through once the holder is gone
    await release();
    const freed = remove(shortened);
    expect(freed.status, freed.stderr).toBe(0);
    expect(existsSync(path)).toBe(false);
  });
});
