import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSeal } from "../seal.js";

// where seal.ts looks for setpriv
const SETPRIV_PATHS = ["/usr/bin/setpriv", "/bin/setpriv"];

function setprivRuns(): boolean {
  return SETPRIV_PATHS.some(
    (path) =>
      spawnSync(path, [
        "--inh-caps=-dac_override,-dac_read_search",
        "--ambient-caps=-dac_override,-dac_read_search",
        "true",
      ]).status === 0,
  );
}

/** Whether a file written to the temp directory can be executed from it: a `noexec` mount can't. */
function tmpdirExecutes(): boolean {
  const scratch = mkdtempSync(join(tmpdir(), "sky-exec-"));
  try {
    const script = join(scratch, "probe");
    writeFileSync(script, "#!/bin/sh\nexit 0\n");
    chmodSync(script, 0o755);
    return spawnSync(script).status === 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function suidDumpable(): string | undefined {
  try {
    return readFileSync("/proc/sys/fs/suid_dumpable", "utf8").trim();
  } catch {
    return undefined;
  }
}

/**
 * Why this machine can't be asked what the kernel does with a sealed process, or undefined when it can:
 * Linux, a user that isn't root (root's capabilities read any file), a `setpriv` and `sh` only root can
 * change, `fs.suid_dumpable` at 0 (so a non-dumpable process's `/proc` entries are root's), and a temp
 * directory that executes what is written to it.
 */
function kernelGapOf(): string | undefined {
  if (process.platform !== "linux")
    return `this is ${process.platform}, not Linux`;
  if (process.getuid?.() === 0)
    return "the tests run as root, whose capabilities read any file";
  const { problem } = createSeal("linux", { hideRunner: () => undefined });
  if (problem) return `the seal has a problem here: ${problem}`;
  if (!setprivRuns()) return `no setpriv at ${SETPRIV_PATHS.join(" or ")} runs`;
  const dumpable = suidDumpable();
  if (dumpable !== "0")
    return `fs.suid_dumpable is ${dumpable ?? "unreadable"}, not 0`;
  if (!tmpdirExecutes()) return `files in ${tmpdir()} can't be executed`;
  return undefined;
}

export const kernelGap = kernelGapOf();
export const kernelCanBeAsked = kernelGap === undefined;
