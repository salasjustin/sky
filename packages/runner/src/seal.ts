import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  constants,
  copyFileSync,
  mkdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type {
  SpawnedProcess,
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";

// Every command the repo starts runs as the user the runner and Claude run as, and `/proc/<pid>/environ`,
// `mem` and `fd` of a process are readable by every other process of its user, unless the kernel marks
// the process non-dumpable (proc(5), prctl(2) PR_SET_DUMPABLE): then they belong to root, and reading
// them takes CAP_SYS_PTRACE, which the sprite's bounding set doesn't hold, for root through `sudo`
// included. A process becomes non-dumpable when its effective user changes, or when it execs a file its
// own capabilities can't read. The runner does the first to itself; Claude gets the second, because the
// copy of its binary it execs is mode 0111. Processes the repo starts are new execs of readable files,
// so they stay ordinary, and the credential is theirs to ask for and the kernel's to refuse.

/** The capabilities that read a file the permission bits close to its owner; the sprite's user holds one. */
const READ_OVERRIDES = "-dac_override,-dac_read_search";

/** The uid the runner steps through; any other than its own will do. */
const OTHER_USER = 65534;

type Probe = {
  /** `/proc`, unless a test points elsewhere. */
  procRoot?: string;
  /** The effective uid the process runs as. */
  uid?: number;
};

/**
 * Whether the kernel keeps this user's other processes out of the process's `/proc` entries: a
 * non-dumpable process's `environ` is owned by root. False when it can't be told, such as a process that
 * is gone.
 */
export function isHidden(pid: number | "self", probe: Probe = {}): boolean {
  const { procRoot = "/proc", uid = process.geteuid?.() } = probe;
  if (uid === undefined) return false;
  try {
    return statSync(`${procRoot}/${pid}/environ`).uid !== uid;
  } catch {
    return false;
  }
}

type RunnerSyscalls = {
  geteuid: () => number;
  seteuid: (uid: number) => void;
  hidden: () => boolean;
};

const processSyscalls = (): RunnerSyscalls | null => {
  const { geteuid, seteuid } = process;
  if (!geteuid || !seteuid) return null;
  return {
    geteuid: () => geteuid.call(process),
    seteuid: (uid) => seteuid.call(process, uid),
    hidden: () => isHidden("self"),
  };
};

/**
 * Makes the runner non-dumpable by stepping its effective user to another and back, which takes
 * CAP_SETUID and no file. Returns why it couldn't, or undefined once the runner's `/proc` entries are
 * out of its commands' reach.
 */
export function hideRunner(
  syscalls: RunnerSyscalls | null = processSyscalls(),
): string | undefined {
  if (!syscalls) return "this platform has no effective user to step";
  const uid = syscalls.geteuid();
  try {
    syscalls.seteuid(uid === OTHER_USER ? OTHER_USER - 1 : OTHER_USER);
  } catch (error) {
    return `the runner can't change its effective user (${errorCode(error)}), which the kernel needs to take its environment out of its commands' reach`;
  } finally {
    // back to its own user whatever the step did; stepping to one's own real user is always allowed
    syscalls.seteuid(uid);
  }
  return syscalls.hidden()
    ? undefined
    : "the kernel still lets the runner's commands read its environment (fs.suid_dumpable is not 0?)";
}

const errorCode = (error: unknown) =>
  error instanceof Error && "code" in error ? String(error.code) : "failed";

/** Whether `command` is a file in a directory of `path`. */
function onPath(command: string, path: string | undefined): boolean {
  return (path ?? "").split(delimiter).some((dir) => {
    try {
      return dir !== "" && statSync(join(dir, command)).isFile();
    } catch {
      return false;
    }
  });
}

// the directories of the copies of Claude's binary that haven't been deleted yet
const copies = new Set<string>();

/**
 * Deletes every copy of Claude's binary still on disk, synchronously: for a process about to die by a
 * signal, which never reaches the session's own cleanup. Never throws, so the death goes ahead.
 */
export function removeSealedCopiesNow(): void {
  for (const dir of copies)
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  copies.clear();
}

/**
 * What stands between the run's credential and the repo's processes, for the run's session: a runner
 * and a Claude process the kernel won't let the repo's commands read, which is the credential's only
 * place besides the API's request.
 */
export type Seal = {
  /** Why the boundary couldn't be set up, which fails the run before Claude starts; undefined when it is. */
  problem: string | undefined;
  /** The Agent SDK's spawn of the Claude process: from a copy of its binary the kernel keeps unreadable. */
  spawn: (options: SpawnOptions) => SpawnedProcess;
  /** Once Claude is running: why its `/proc` entries are open to the repo's commands, or undefined. */
  check: () => string | undefined;
};

export type SealOptions = {
  /** Where the copy of Claude's binary lives while it runs; the temp directory when absent. */
  dir?: string;
  /** The env the session's commands resolve `setpriv` in; the runner's when absent. */
  env?: NodeJS.ProcessEnv;
  /** Steps the runner out of its commands' reach; the real one when absent. */
  hideRunner?: () => string | undefined;
};

/**
 * Hides the runner, and returns the seal for the run's Claude process; undefined where there is no
 * `/proc` to hide it from. The runner's own credential stays in its environment, which only it can read
 * now, so call this before the runner starts anything.
 *
 * The Claude process is exec'd, through `setpriv`, from a mode 0111 copy of its binary by a process
 * without the capabilities that read around that mode, so it is non-dumpable from its first
 * instruction. `setpriv` drops those capabilities and nothing else: what the repo's commands could
 * do with the sprite's other capabilities, they still can.
 */
export function createSeal(
  platform: NodeJS.Platform = process.platform,
  options: SealOptions = {},
): Seal | undefined {
  if (platform !== "linux") return undefined;
  const { dir = tmpdir(), env = process.env } = options;
  const problem =
    (options.hideRunner ?? hideRunner)() ??
    (onPath("setpriv", env.PATH)
      ? undefined
      : "setpriv (util-linux), which drops the capabilities that read around a file's mode, isn't installed");
  let claude: ChildProcess | undefined;
  return {
    problem,
    spawn: (spawnOptions) => {
      const copyDir = join(dir, `sky-claude-${randomUUID()}`);
      // before the copy: a signal can land while it is in flight
      copies.add(copyDir);
      const remove = () => {
        copies.delete(copyDir);
        rmSync(copyDir, { recursive: true, force: true });
      };
      try {
        mkdirSync(copyDir, { recursive: true, mode: 0o700 });
        const binary = join(copyDir, "claude");
        copyFileSync(spawnOptions.command, binary, constants.COPYFILE_FICLONE);
        chmodSync(binary, 0o111);
        // setpriv's own exec leaves it the sprite's capabilities, which it drops for the next one: the
        // shell, which runs the unreadable binary without them
        claude = spawn(
          "setpriv",
          [
            `--inh-caps=${READ_OVERRIDES}`,
            `--ambient-caps=${READ_OVERRIDES}`,
            "sh",
            "-c",
            'exec "$0" "$@"',
            binary,
            ...spawnOptions.args,
          ],
          {
            cwd: spawnOptions.cwd,
            env: spawnOptions.env,
            signal: spawnOptions.signal,
            stdio: ["pipe", "pipe", "ignore"],
          },
        );
      } catch (error) {
        remove();
        throw error;
      }
      claude.once("exit", remove);
      claude.once("error", remove);
      return claude as SpawnedProcess;
    },
    check: () => {
      if (!claude?.pid) return "Claude's process was not started";
      // a process that has ended holds nothing to read
      if (claude.exitCode !== null || claude.signalCode !== null)
        return undefined;
      return isHidden(claude.pid)
        ? undefined
        : "the kernel lets the repo's commands read Claude's environment";
    },
  };
}
