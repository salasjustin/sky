import {
  closeSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";

/** The log beside the run's prompt file, and the lock that says whose it is. */
export const logPathOf = (promptFile: string) =>
  promptFile.replace(/\.prompt$/, ".log");
const lockPathOf = (promptFile: string) =>
  promptFile.replace(/\.prompt$/, ".lock");

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists, it just isn't ours to signal
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Claims the run's log for this process: only the runner that holds the lock writes to it. A second
 * process for the same run, which the agent's own shell can start by running `runner.mjs` with the
 * run's environment about it, is refused and leaves the log alone. A lock whose process is gone (a
 * runner killed outright) is taken over. Returns the log's path and a `release`, or the refusal.
 */
export function claimRunLog(
  promptFile: string,
  pid = process.pid,
):
  | { ok: true; logFile: string; release: () => void }
  | { ok: false; reason: string } {
  const lock = lockPathOf(promptFile);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      writeSync(fd, String(pid));
      closeSync(fd);
      return {
        ok: true,
        logFile: logPathOf(promptFile),
        release: () => {
          try {
            if (readFileSync(lock, "utf8") === String(pid)) unlinkSync(lock);
          } catch {}
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        // a lock that can't be made is no reason to lose the run's log, nor to stop the run
        return { ok: true, logFile: logPathOf(promptFile), release: () => {} };
      }
    }
    const holder = Number.parseInt(readLock(lock), 10);
    if (Number.isInteger(holder) && holder !== pid && alive(holder)) {
      return {
        ok: false,
        reason: `another runner (pid ${holder}) already runs this run`,
      };
    }
    // stale: its process is gone
    try {
      unlinkSync(lock);
    } catch {}
  }
  return { ok: false, reason: "the run's lock could not be taken" };
}

function readLock(lock: string): string {
  try {
    return readFileSync(lock, "utf8");
  } catch {
    return "";
  }
}
