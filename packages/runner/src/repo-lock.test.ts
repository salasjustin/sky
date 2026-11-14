import {
  type ChildProcess,
  execFileSync,
  spawn,
  spawnSync,
} from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { repoLockPath, withRepoLock } from "./repo-lock.js";
import { prepareWorktree } from "./sync.js";
import { ensureWorktree, retryOnLock } from "./worktree.js";

// real git and real flock processes: a loaded machine runs well past the 5 s default
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const canFlock =
  existsSync("/proc/self/cmdline") && spawnSync("flock", ["-V"]).status === 0;

const deferred = () => {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

/** The live processes whose command line names `lock`: the `flock` children holding or queued for it. */
const flocksOn = (lock: string) =>
  readdirSync("/proc")
    .filter((pid) => /^\d+$/.test(pid))
    .filter((pid) => {
      try {
        return readFileSync(`/proc/${pid}/cmdline`, "utf8")
          .split("\0")
          .includes(lock);
      } catch {
        // exited between the listing and the read
        return false;
      }
    });

/** `git worktree list --porcelain` as sorted { path, branch } entries. */
const worktrees = (cwd: string) =>
  git(cwd, "worktree", "list", "--porcelain")
    .split("\n\n")
    .map((block) => {
      const lines = block.split("\n");
      return {
        path: lines.find((l) => l.startsWith("worktree "))?.slice(9),
        branch: lines.find((l) => l.startsWith("branch "))?.slice(7),
      };
    })
    .sort((a, b) => (a.path ?? "").localeCompare(b.path ?? ""));

let root: string;
let repoDir: string;
let worktreesDir: string;
let children: ChildProcess[];

beforeEach(() => {
  children = [];
  for (const name of [
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
  ])
    vi.stubEnv(name, undefined);
  root = mkdtempSync(join(tmpdir(), "runner-lock-"));
  // every git here, the runner's included, inherits process.env: the host's global and system
  // config (hooks, autoSetupMerge, url rewrites) must not reach it
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("HOME", root);
  vi.stubEnv("XDG_CONFIG_HOME", join(root, ".config"));
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
  for (const child of children) child.kill("SIGKILL");
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const launch = (n: number) =>
  prepareWorktree(
    { repoDir, worktreesDir, agentId: `agt_${n}` },
    { env: {}, warn: () => {} },
  );

/** Holds the repo lock until `release` is called; resolves once the task is running under it. */
const hold = async () => {
  const released = deferred();
  const entered = deferred();
  const holding = withRepoLock(repoDir, async () => {
    entered.resolve();
    await released.promise;
  });
  await entered.promise;
  return { release: released.resolve, holding };
};

describe("retryOnLock", () => {
  test.each([
    [
      "config lock",
      "error: could not lock config file .git/config: File exists",
    ],
    ["upstream write", "error: unable to write upstream branch configuration"],
    [
      "ref lock",
      "fatal: Unable to create '/r/.git/refs/heads/claude/agt_1.lock': File exists.",
    ],
    [
      "index lock",
      "fatal: Unable to create '/r/.git/index.lock': File exists.",
    ],
    ["bare index.lock", "index.lock is held"],
  ])("a step git refused for a held %s is retried once", async (_, message) => {
    const step = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error(message))
      .mockResolvedValue("done");
    await expect(retryOnLock(step)).resolves.toBe("done");
    expect(step).toHaveBeenCalledTimes(2);
  });

  test("a second lock refusal is not retried further", async () => {
    const locked = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error("could not lock config file"));
    await expect(retryOnLock(locked)).rejects.toThrow("could not lock");
    expect(locked).toHaveBeenCalledTimes(2);
  });

  test("any other failure is not retried", async () => {
    const other = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error("fatal: not a git repository"));
    await expect(retryOnLock(other)).rejects.toThrow("not a git repository");
    expect(other).toHaveBeenCalledTimes(1);
  });
});

describe("ensureWorktree", () => {
  test("real git's refusal for a held ref lock is retried and the second attempt makes the worktree", async () => {
    const refDir = join(repoDir, ".git", "refs", "heads", "claude");
    mkdirSync(refDir, { recursive: true });
    const lockFile = join(refDir, "agt_1.lock");
    writeFileSync(lockFile, "");
    const path = join(worktreesDir, "agt_1");
    let calls = 0;
    await retryOnLock(async () => {
      calls++;
      // the lock goes at the start of the second call, so the first is always refused
      if (calls === 2) rmSync(lockFile);
      git(
        repoDir,
        "worktree",
        "add",
        "--no-track",
        "-b",
        "claude/agt_1",
        path,
        "origin/HEAD",
      );
    });
    expect(calls).toBe(2);
    expect(git(path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("claude/agt_1");
  });

  test("the worktree's branch has no upstream configured, so the repo's config lock is never taken", async () => {
    // a held config.lock makes any config write fail: a tracking branch would need one
    writeFileSync(join(repoDir, ".git", "config.lock"), "");
    const path = await ensureWorktree({
      repoDir,
      worktreesDir,
      agentId: "agt_1",
    });
    expect(git(path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("claude/agt_1");
    rmSync(join(repoDir, ".git", "config.lock"));
    const upstream = (branch: string) =>
      spawnSync(
        "git",
        ["config", "--get-regexp", `^branch\\.${branch}\\.(remote|merge)$`],
        { cwd: repoDir, encoding: "utf8" },
      ).stdout.trim();
    expect(upstream("claude/agt_1")).toBe("");
    // the same read is live: a branch made the default way records its upstream
    git(repoDir, "branch", "tracked", "origin/HEAD");
    expect(upstream("tracked")).toContain("branch.tracked.remote origin");
  });
});

describe("withRepoLock without a repo", () => {
  test("runs the task, taking no lock and making no .git", async () => {
    const bare = join(root, "no-repo");
    mkdirSync(bare);
    await expect(withRepoLock(bare, async () => "ran", 0.3)).resolves.toBe(
      "ran",
    );
    expect(existsSync(join(bare, ".git"))).toBe(false);
  });
});

describe.skipIf(!canFlock)("with flock", () => {
  test("a run waits while another holds the lock, then makes its worktree", async () => {
    const lock = repoLockPath(repoDir);
    const { release, holding } = await hold();
    const launched = launch(1);
    // the launch's flock is queued behind the holder's
    await vi.waitFor(() => expect(flocksOn(lock)).toHaveLength(2), {
      timeout: 20_000,
    });
    expect(existsSync(join(worktreesDir, "agt_1"))).toBe(false);
    release();
    await holding;
    const { cwd } = await launched;
    expect(cwd).toBe(join(worktreesDir, "agt_1"));
    expect(existsSync(cwd)).toBe(true);
  });

  test("a launch queues for the repo lock as long as its launch deadline allows, past the 120 s default", async () => {
    const lock = repoLockPath(repoDir);
    const { release, holding } = await hold();
    const launched = prepareWorktree(
      { repoDir, worktreesDir, agentId: "agt_1" },
      // the runner's 15 minute launch deadline, in seconds
      { env: {}, warn: () => {}, lockWaitS: 900 },
    );
    // the queued flock's own bound is on its command line; no time has to pass for it to be checked
    const waits = () =>
      flocksOn(lock).map((pid) => {
        const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
        return argv[argv.indexOf("-w") + 1];
      });
    await vi.waitFor(() => expect(waits()).toHaveLength(2), {
      timeout: 20_000,
    });
    expect([...waits()].sort()).toEqual(["120", "900"]);
    release();
    await holding;
    expect((await launched).cwd).toBe(join(worktreesDir, "agt_1"));
  });

  test("a second caller's task runs only after the first's has finished", async () => {
    const lock = repoLockPath(repoDir);
    const { release, holding } = await hold();
    const order: string[] = [];
    const waiter = withRepoLock(repoDir, async () => {
      order.push("waiter ran");
    });
    await vi.waitFor(() => expect(flocksOn(lock)).toHaveLength(2), {
      timeout: 20_000,
    });
    order.push("holder released");
    release();
    await Promise.all([holding, waiter]);
    expect(order).toEqual(["holder released", "waiter ran"]);
  });

  test("concurrent callers' tasks never overlap", async () => {
    const events: string[] = [];
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        withRepoLock(repoDir, async () => {
          events.push(`enter ${i}`);
          // time inside the lock for an unlocked caller to overlap in; nothing waits on it
          await sleep(25);
          events.push(`exit ${i}`);
        }),
      ),
    );
    expect(events).toHaveLength(12);
    // intervals strictly alternate, and each exit closes the enter before it
    for (let i = 0; i < events.length; i += 2) {
      const id = events[i]?.split(" ")[1];
      expect(events[i]).toBe(`enter ${id}`);
      expect(events[i + 1]).toBe(`exit ${id}`);
    }
    expect(new Set(events.map((e) => e.split(" ")[1])).size).toBe(6);
  });

  test("launches started at once each get their own worktree on their own branch", async () => {
    const results = await Promise.all([1, 2, 3, 4, 5, 6].map(launch));
    const base = realpathSync(root);
    expect(results.map((r) => r.cwd).sort()).toEqual(
      [1, 2, 3, 4, 5, 6].map((n) => join(worktreesDir, `agt_${n}`)).sort(),
    );
    expect(worktrees(repoDir)).toEqual(
      [
        { path: join(base, "repo"), branch: "refs/heads/trunk" },
        ...[1, 2, 3, 4, 5, 6].map((n) => ({
          path: join(base, "worktrees", `agt_${n}`),
          branch: `refs/heads/claude/agt_${n}`,
        })),
      ].sort((a, b) => a.path.localeCompare(b.path)),
    );
  });

  test("a held lock makes the wait fail with the timeout message, and the task never runs", async () => {
    const { release, holding } = await hold();
    const task = vi.fn(async () => "ran");
    await expect(withRepoLock(repoDir, task, 0.3)).rejects.toThrow(
      `can't take the repo lock ${repoLockPath(repoDir)} within 0.3s: another run's setup is holding it; retry shortly`,
    );
    expect(task).not.toHaveBeenCalled();
    release();
    await holding;
  });

  test("a flock failure that is not the timeout is reported with its exit status", async () => {
    // a lock path flock cannot open or create
    symlinkSync(join(root, "missing", "lock"), repoLockPath(repoDir));
    const failure = await withRepoLock(repoDir, async () => "ran", 2).catch(
      (error: Error) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    // the status flock gives an unopenable file differs by util-linux version
    expect((failure as Error).message).toMatch(
      new RegExp(
        `^can't take the repo lock ${repoLockPath(repoDir).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: flock exited (?!75\\b)\\d+`,
      ),
    );
    expect((failure as Error).message).not.toContain("another run's setup");
  });

  test("a lock file left behind with no holder does not block", async () => {
    writeFileSync(repoLockPath(repoDir), "999999\n");
    await expect(withRepoLock(repoDir, async () => "ok", 2)).resolves.toBe(
      "ok",
    );
  });

  test("a holder killed with SIGKILL frees the lock for the next caller", async () => {
    const lock = repoLockPath(repoDir);
    const holder = spawn(
      "sh",
      // one process owns the lock's fd (flock(1) with a command forks, leaving the child holding it)
      ["-c", 'exec 9>"$1"; flock -x 9; echo held; exec sleep 3600', "_", lock],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    children.push(holder);
    const exited = new Promise<void>((resolve) =>
      holder.on("close", () => resolve()),
    );
    await new Promise<void>((resolve) =>
      holder.stdout?.once("data", () => resolve()),
    );
    // the lock really is held: a non-blocking take is refused
    expect(spawnSync("flock", ["-n", lock, "true"]).status).toBe(1);
    holder.kill("SIGKILL");
    await exited;
    await expect(withRepoLock(repoDir, async () => "ok", 5)).resolves.toBe(
      "ok",
    );
  });

  test("the lock is released when the task throws", async () => {
    await expect(
      withRepoLock(repoDir, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(withRepoLock(repoDir, async () => "ok", 2)).resolves.toBe(
      "ok",
    );
  });

  describe("a stop while waiting for the lock", () => {
    test("aborting a run queued behind a held lock rejects promptly and never runs its task", async () => {
      const lock = repoLockPath(repoDir);
      const { release, holding } = await hold();
      const stop = new AbortController();
      const task = vi.fn(async () => "ran");
      const queued = withRepoLock(repoDir, task, 60, stop.signal);
      // the holder's flock and the queued one's
      await vi.waitFor(() => expect(flocksOn(lock)).toHaveLength(2), {
        timeout: 20_000,
      });
      stop.abort("SIGTERM");
      await expect(queued).rejects.toBe("SIGTERM");
      expect(task).not.toHaveBeenCalled();
      // the queued run's flock is gone; the holder's is still there
      expect(flocksOn(lock)).toHaveLength(1);
      release();
      await holding;
      await expect(withRepoLock(repoDir, async () => "ok", 10)).resolves.toBe(
        "ok",
      );
      expect(flocksOn(lock)).toHaveLength(0);
    });

    test("an already-stopped run never runs its task and never queues", async () => {
      const lock = repoLockPath(repoDir);
      const { release, holding } = await hold();
      const stop = new AbortController();
      stop.abort("SIGTERM");
      const task = vi.fn(async () => "ran");
      await expect(withRepoLock(repoDir, task, 60, stop.signal)).rejects.toBe(
        "SIGTERM",
      );
      expect(task).not.toHaveBeenCalled();
      expect(flocksOn(lock)).toHaveLength(1);
      release();
      await holding;
      await expect(withRepoLock(repoDir, async () => "ok", 10)).resolves.toBe(
        "ok",
      );
      expect(flocksOn(lock)).toHaveLength(0);
    });

    test("a signal that never aborts leaves the run's task to run", async () => {
      const stop = new AbortController();
      await expect(
        withRepoLock(repoDir, async () => "ok", 10, stop.signal),
      ).resolves.toBe("ok");
      expect(flocksOn(repoLockPath(repoDir))).toHaveLength(0);
    });
  });
});
