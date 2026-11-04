import { randomBytes } from "node:crypto";
import {
  linkSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

/** The prompt path less its `.prompt`, so a log or lock path can never be the prompt file itself. */
const runPathOf = (promptFile: string) => promptFile.replace(/\.prompt$/, "");
/** The log beside the run's prompt file, and the lock that says whose it is. */
export const logPathOf = (promptFile: string) => `${runPathOf(promptFile)}.log`;
const lockPathOf = (promptFile: string) => `${runPathOf(promptFile)}.lock`;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists, it just isn't ours to signal
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const codeOf = (error: unknown) => (error as NodeJS.ErrnoException).code;

/**
 * Claims the run's log for this process: only the runner that holds the lock writes to it. A second
 * process for the same run, which the agent's own shell can start by running `runner.mjs` with the
 * run's environment about it, is refused and leaves the log alone. A lock that doesn't name a live
 * process (a runner killed outright, or a file that isn't a pid) is taken over. Returns the log's
 * path and a `release`, or the refusal.
 */
export function claimRunLog(
  promptFile: string,
  pid = process.pid,
):
  | { ok: true; logFile: string; release: () => void }
  | { ok: false; reason: string } {
  const lock = lockPathOf(promptFile);
  const logFile = logPathOf(promptFile);
  const unlocked = { ok: true as const, logFile, release: () => {} };
  // a private file in the lock's directory, so a link makes the lock appear whole: never empty to a reader
  const temp = `${lock}.${pid}.${randomBytes(6).toString("hex")}`;
  try {
    writeFileSync(temp, String(pid), { mode: 0o600 });
  } catch {
    // a lock that can't be made is no reason to lose the run's log, nor to stop the run
    return unlocked;
  }
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        linkSync(temp, lock);
        return {
          ok: true,
          logFile,
          release: () => {
            try {
              if (readFileSync(lock, "utf8") === String(pid)) unlinkSync(lock);
            } catch {}
          },
        };
      } catch (error) {
        if (codeOf(error) !== "EEXIST") return unlocked;
      }
      const content = readLock(lock);
      const holder = /^\d+$/.test(content) ? Number(content) : undefined;
      if (holder !== undefined && holder !== pid && alive(holder)) {
        return {
          ok: false,
          reason: `another runner (pid ${holder}) already runs this run`,
        };
      }
      takeOver(lock, content, temp);
    }
    return { ok: false, reason: "the run's lock could not be taken" };
  } finally {
    try {
      unlinkSync(temp);
    } catch {}
  }
}

/**
 * Removes a stale lock holding `stale`. Moved aside first, not unlinked: a rival that judged the same
 * lock stale and has since claimed it is not removed, but put back, and found alive on the next try.
 */
function takeOver(lock: string, stale: string, temp: string): void {
  const aside = `${temp}.stale`;
  try {
    renameSync(lock, aside);
  } catch {
    // gone already: a rival took it over first, and the next link settles who holds it
    return;
  }
  if (readLock(aside) !== stale)
    try {
      linkSync(aside, lock);
    } catch {}
  try {
    unlinkSync(aside);
  } catch {}
}

function readLock(lock: string): string {
  try {
    return readFileSync(lock, "utf8");
  } catch {
    return "";
  }
}
