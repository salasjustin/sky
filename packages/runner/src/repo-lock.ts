import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  REPO_LOCK_FILE,
  REPO_LOCK_TIMED_OUT,
  REPO_LOCK_WAIT_S,
} from "@sky/shared";

/** The lock file of the shared repo at `repoDir`. */
export const repoLockPath = (repoDir: string) =>
  join(repoDir, ".git", REPO_LOCK_FILE);

/**
 * Runs `task` holding an exclusive `flock` on the shared repo's lock file, so runs starting at once on
 * one sprite take turns at everything that writes `.git` (worktree add, branch and config writes,
 * fetches). A child `flock` holds the lock while it reads stdin, so the kernel drops it when this
 * process dies and a lock file left behind never blocks anyone. Fails naming the lock file when
 * it stays held for `waitS` seconds. A `signal` aborted before the lock is taken stops the wait and
 * rejects with its reason, without running `task`; once `task` runs, it runs to the end.
 */
export async function withRepoLock<T>(
  repoDir: string,
  task: () => Promise<T>,
  waitS = REPO_LOCK_WAIT_S,
  signal?: AbortSignal,
): Promise<T> {
  // no repo yet means nothing shared to protect, and git reports that itself
  if (!existsSync(join(repoDir, ".git"))) return task();
  signal?.throwIfAborted();
  const lock = repoLockPath(repoDir);
  const holder = spawn(
    "flock",
    [
      "-x",
      "-w",
      String(waitS),
      "-E",
      String(REPO_LOCK_TIMED_OUT),
      lock,
      "sh",
      "-c",
      "echo held; cat >/dev/null",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const closed = new Promise<number | null>((resolve) => {
    holder.on("close", resolve);
  });
  let stderr = "";
  holder.stderr.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  holder.stdin.on("error", () => {});
  let onAbort = () => {};
  try {
    await new Promise<void>((resolve, reject) => {
      onAbort = () => reject(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      holder.on("error", (error) =>
        reject(new Error(`can't take the repo lock ${lock}: ${error.message}`)),
      );
      holder.stdout.once("data", () => resolve());
      void closed.then((code) => {
        reject(
          new Error(
            code === REPO_LOCK_TIMED_OUT
              ? `can't take the repo lock ${lock} within ${waitS}s: another run's setup is holding it; retry shortly`
              : `can't take the repo lock ${lock}: flock exited ${code}${stderr.trim() ? ` (${stderr.trim()})` : ""}`,
          ),
        );
      });
    });
  } catch (error) {
    // ending stdin first frees the lock if flock took it just as the wait was abandoned
    holder.stdin.end();
    holder.kill();
    // a child that spawned is gone before the caller hears of the failure
    if (holder.pid !== undefined) await closed;
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  try {
    // an abort that landed after flock answered but before this resumed
    signal?.throwIfAborted();
    return await task();
  } finally {
    holder.stdin.end();
    await closed;
  }
}
