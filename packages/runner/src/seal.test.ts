import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSync } from "esbuild";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { credentialDir, sweepCredentialFiles } from "./claude-auth.js";
import {
  createSeal,
  hideRunner,
  isHidden,
  removeSealedCopiesNow,
} from "./seal.js";
import { kernelCanBeAsked, kernelGap } from "./testing/kernel.js";

// the real `rmSync` unless a test makes one call fail
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, rmSync: vi.fn(actual.rmSync) };
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sky-seal-"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  removeSealedCopiesNow();
  rmSync(dir, { recursive: true, force: true });
});

describe("isHidden", () => {
  const procWith = (pid: string) => {
    mkdirSync(join(dir, pid), { recursive: true });
    writeFileSync(join(dir, pid, "environ"), "");
  };
  const owner = () => {
    const uid = process.geteuid?.();
    if (uid === undefined) throw new Error("no uid on this platform");
    return uid;
  };

  test.skipIf(process.geteuid === undefined)(
    "a process whose environ belongs to someone else is hidden from this user; one that belongs to it is not",
    () => {
      procWith("42");
      expect(isHidden(42, { procRoot: dir, uid: owner() })).toBe(false);
      expect(isHidden(42, { procRoot: dir, uid: owner() + 1 })).toBe(true);
    },
  );

  test("a process that isn't there is not claimed hidden", () => {
    expect(isHidden(43, { procRoot: dir, uid: 1000 })).toBe(false);
  });
});

describe("hideRunner", () => {
  const syscalls = (hidden: boolean, failStep?: string) => {
    const calls: number[] = [];
    return {
      calls,
      geteuid: () => 1001,
      seteuid: (uid: number) => {
        calls.push(uid);
        if (failStep && calls.length === 1) throw error(failStep);
      },
      hidden: () => hidden,
    };
  };
  const error = (code: string) =>
    Object.assign(new Error(`seteuid ${code}`), { code });

  test("steps the effective user to another and back, and says nothing once the kernel hides the runner", () => {
    const fake = syscalls(true);
    expect(hideRunner(fake)).toBeUndefined();
    expect(fake.calls).toEqual([65534, 1001]);
  });

  test("steps through a different user than its own", () => {
    const fake = { ...syscalls(true), geteuid: () => 65534 };
    expect(hideRunner(fake)).toBeUndefined();
    expect(fake.calls).toEqual([65533, 65534]);
  });

  test("a runner that may not change its user says so, naming the error, and stays itself", () => {
    const fake = syscalls(false, "EPERM");
    expect(hideRunner(fake)).toMatch(
      /can't change its effective user \(EPERM\)/,
    );
    expect(fake.calls).toEqual([65534, 1001]);
  });

  test("a kernel that still lets the runner's commands read it is reported", () => {
    expect(hideRunner(syscalls(false))).toMatch(
      /still lets the runner's commands/,
    );
  });

  test("a platform without effective users is reported, never thrown", () => {
    expect(hideRunner(null)).toMatch(/no effective user/);
  });
});

describe("createSeal", () => {
  // a host's files as the seal sees them, so no test depends on this machine's: what isn't listed is absent
  type Entry = { uid: number; mode: number; realpath?: string };
  const ROOT_DIR: Entry = { uid: 0, mode: 0o040755 };
  const ROOT_PROGRAM: Entry = { uid: 0, mode: 0o100755 };
  const SPRITE_USER = 1000;
  const SANDBOX: Record<string, Entry> = {
    "/": ROOT_DIR,
    "/usr": ROOT_DIR,
    "/usr/bin": ROOT_DIR,
    "/usr/bin/setpriv": ROOT_PROGRAM,
    "/usr/bin/dash": ROOT_PROGRAM,
    // merged /usr: /bin is /usr/bin, and sh is dash
    "/bin": { ...ROOT_DIR, realpath: "/usr/bin" },
    "/bin/sh": { ...ROOT_PROGRAM, realpath: "/usr/bin/dash" },
    "/home": ROOT_DIR,
    "/home/sprite": { uid: SPRITE_USER, mode: 0o040755 },
    "/home/sprite/.local": { uid: SPRITE_USER, mode: 0o040755 },
    "/home/sprite/.local/bin": { uid: SPRITE_USER, mode: 0o040755 },
  };
  const filesOf = (host: Record<string, Entry | undefined>) => {
    const at = (path: string) => {
      const entry = host[path];
      if (!entry)
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return entry;
    };
    return {
      stat: (path: string) => at(at(path).realpath ?? path),
      realpath: (path: string) => at(path).realpath ?? path,
    };
  };
  const sealOn = (
    host: Record<string, Entry | undefined>,
    over: Parameters<typeof createSeal>[1] = {},
  ) =>
    createSeal("linux", {
      hideRunner: () => undefined,
      files: filesOf(host),
      ...over,
    });

  test.each(["darwin", "win32"] as const)(
    "on %s, where the kernel can't hide a process's environment, the seal's problem says so and nothing is spawned",
    (platform) => {
      const seal = createSeal(platform);
      expect(seal.problem).toMatch(
        new RegExp(`only Linux .* and this is ${platform}`),
      );
      expect(() =>
        seal.spawn({
          command: process.execPath,
          args: [],
          env: {},
          signal: new AbortController().signal,
        }),
      ).toThrow(seal.problem);
    },
  );

  test("a runner the kernel can't hide is the seal's problem", () => {
    const seal = sealOn(SANDBOX, {
      hideRunner: () => "the runner can't change its effective user (EPERM)",
    });
    expect(seal.problem).toBe(
      "the runner can't change its effective user (EPERM)",
    );
  });

  test("a hidden runner with a root-owned setpriv and sh has no problem", () => {
    expect(sealOn(SANDBOX).problem).toBeUndefined();
  });

  test("a sandbox with no setpriv at a fixed path is the seal's problem, whatever its PATH holds", () => {
    const seal = sealOn({
      ...SANDBOX,
      "/usr/bin/setpriv": undefined,
      "/home/sprite/.local/bin/setpriv": ROOT_PROGRAM,
    });
    expect(seal.problem).toBe(
      "no setpriv (util-linux) that only root can change, at /usr/bin/setpriv or /bin/setpriv: it drops the capabilities that read around a file's mode",
    );
  });

  const setprivAs = (entry: Entry) => ({ "/usr/bin/setpriv": entry });
  test.each([
    [
      "owned by the sprite's user",
      setprivAs({ uid: SPRITE_USER, mode: 0o100755 }),
    ],
    ["writable by its group", setprivAs({ uid: 0, mode: 0o100775 })],
    ["writable by anyone", setprivAs({ uid: 0, mode: 0o100757 })],
    ["that is no regular file", setprivAs({ uid: 0, mode: 0o040755 })],
    [
      "in a directory the sprite's user owns",
      { "/usr/bin": { uid: SPRITE_USER, mode: 0o040755 } },
    ],
    [
      "under a directory anyone can write",
      { "/usr": { uid: 0, mode: 0o040777 } },
    ],
    [
      "linked to a file in the sprite's user's own bin",
      {
        ...setprivAs({
          ...ROOT_PROGRAM,
          realpath: "/home/sprite/.local/bin/setpriv",
        }),
        "/home/sprite/.local/bin/setpriv": ROOT_PROGRAM,
      },
    ],
  ])("a setpriv %s isn't trusted", (_, change) => {
    const seal = sealOn({ ...SANDBOX, ...change });
    expect(seal.problem).toMatch(
      /^no setpriv \(util-linux\) that only root can change/,
    );
  });

  test("a sandbox with no sh only root can change is the seal's problem", () => {
    const seal = sealOn({
      ...SANDBOX,
      "/bin/sh": { uid: SPRITE_USER, mode: 0o100755 },
      "/usr/bin/sh": undefined,
    });
    expect(seal.problem).toBe(
      "no sh that only root can change, at /bin/sh or /usr/bin/sh",
    );
  });

  describe("starting Claude", () => {
    /** The command and argv the seal starts Claude with, on `host`; nothing is run. */
    const startedOn = (host: Record<string, Entry | undefined>) => {
      const started: { command: string; args: readonly string[] }[] = [];
      const seal = sealOn(host, {
        dir,
        spawn: (command, args) => {
          started.push({ command, args });
          return Object.assign(new EventEmitter(), {
            pid: 4242,
            exitCode: null,
            signalCode: null,
          }) as unknown as ChildProcess;
        },
      });
      const claude = join(dir, "claude-binary");
      writeFileSync(claude, "");
      seal.spawn({
        command: claude,
        args: ["--print"],
        env: { PATH: "/home/sprite/.local/bin:/usr/bin" },
        signal: new AbortController().signal,
      });
      return started;
    };

    test("goes through the root-owned setpriv and sh by the files they resolve to, never by name on PATH", () => {
      const [start] = startedOn(SANDBOX);
      expect(start?.command).toBe("/usr/bin/setpriv");
      expect(start?.args.slice(2, 5)).toEqual([
        "/usr/bin/dash",
        "-c",
        'exec "$0" "$@"',
      ]);
      expect(start?.args.at(-1)).toBe("--print");
    });

    test("takes the next fixed path when the first isn't trusted", () => {
      const [start] = startedOn({
        ...SANDBOX,
        "/usr/bin/setpriv": { uid: SPRITE_USER, mode: 0o100755 },
        "/bin": ROOT_DIR,
        "/bin/setpriv": ROOT_PROGRAM,
        "/bin/sh": { uid: 0, mode: 0o100777 },
        "/usr/bin/sh": ROOT_PROGRAM,
      });
      expect(start?.command).toBe("/bin/setpriv");
      expect(start?.args[2]).toBe("/usr/bin/sh");
    });
  });

  test("before Claude is started, its process can't be vouched for", () => {
    expect(sealOn(SANDBOX).check()).toMatch(/not started/);
  });

  describe("the copy of Claude's binary", () => {
    let copies: string;
    let binary: string;
    beforeEach(() => {
      copies = join(dir, "copies");
      binary = join(dir, "claude-binary");
      writeFileSync(binary, "");
    });
    const fakeProcess = (over: object = {}) =>
      Object.assign(new EventEmitter(), {
        pid: process.pid,
        exitCode: null,
        signalCode: null,
        ...over,
      }) as unknown as ChildProcess;
    const start = (seal: ReturnType<typeof createSeal>, command = binary) =>
      seal.spawn({
        command,
        args: [],
        env: {},
        signal: new AbortController().signal,
      });

    test("a start that fails leaves no copy behind, and the failure reaches the caller", () => {
      const seal = sealOn(SANDBOX, {
        dir: copies,
        spawn: () => {
          throw new Error("exec failed");
        },
      });
      expect(() => start(seal)).toThrow("exec failed");
      expect(readdirSync(copies)).toEqual([]);
    });

    test("a binary that can't be copied is never started, leaves no copy, and the failure reaches the caller", () => {
      const started: string[] = [];
      const seal = sealOn(SANDBOX, {
        dir: copies,
        spawn: (command) => {
          started.push(command);
          return fakeProcess();
        },
      });
      expect(() => start(seal, join(dir, "no-such-binary"))).toThrow(/ENOENT/);
      expect(started).toEqual([]);
      expect(readdirSync(copies)).toEqual([]);
    });

    test.each([
      ["exit", 0],
      ["error", new Error("spawn failed")],
    ])("is removed when the process emits %s", (event, payload) => {
      const claude = fakeProcess();
      start(sealOn(SANDBOX, { dir: copies, spawn: () => claude }));
      expect(readdirSync(copies)).toHaveLength(1);
      claude.emit(event, payload);
      expect(readdirSync(copies)).toEqual([]);
    });

    test("a missing directory is created as this user's alone, and the copy lands in it", () => {
      start(sealOn(SANDBOX, { dir: copies, spawn: () => fakeProcess() }));
      expect(statSync(copies).mode & 0o777).toBe(0o700);
      expect(readdirSync(copies)).toEqual([
        expect.stringMatching(/^sky-claude-/),
      ]);
    });

    test("a directory already there looser is held to this user alone before the copy lands in it", () => {
      mkdirSync(copies);
      // set outright: a mode passed to mkdir is masked by the umask
      chmodSync(copies, 0o755);
      start(sealOn(SANDBOX, { dir: copies, spawn: () => fakeProcess() }));
      expect(statSync(copies).mode & 0o777).toBe(0o700);
      expect(readdirSync(copies)).toHaveLength(1);
    });

    test("a directory that is a symlink is refused, nothing is written where it points, and no copy is left to remove", () => {
      const elsewhere = join(dir, "elsewhere");
      mkdirSync(elsewhere);
      symlinkSync(elsewhere, copies);
      const started: string[] = [];
      const seal = sealOn(SANDBOX, {
        dir: copies,
        spawn: (command) => {
          started.push(command);
          return fakeProcess();
        },
      });
      expect(() => start(seal)).toThrow(
        `${copies} is not a directory of this user; remove it, and the next run creates its own`,
      );
      expect(started).toEqual([]);
      expect(readdirSync(elsewhere)).toEqual([]);
      vi.mocked(rmSync).mockClear();
      removeSealedCopiesNow();
      expect(rmSync).not.toHaveBeenCalled();
    });

    test("a directory another user owns is refused, and nothing is written there", () => {
      mkdirSync(copies);
      // lstat reports the real owner, so the runner's uid is moved instead
      const owner = lstatSync(copies).uid;
      const getuid = vi.spyOn(process, "getuid").mockReturnValue(owner + 1);
      try {
        expect(() =>
          start(sealOn(SANDBOX, { dir: copies, spawn: () => fakeProcess() })),
        ).toThrow(
          `${copies} is not a directory of this user; remove it, and the next run creates its own`,
        );
      } finally {
        getuid.mockRestore();
      }
      expect(readdirSync(copies)).toEqual([]);
    });

    test("by default it lands in the runner's credential directory, where a dead runner's sweep finds it", () => {
      // the OS temp directory is TMPDIR where it is set, so the default directory is under this test's own
      const osTmp = join(dir, "os-tmp");
      mkdirSync(osTmp);
      vi.stubEnv("TMPDIR", osTmp);
      start(sealOn(SANDBOX, { spawn: () => fakeProcess() }));
      expect(readdirSync(credentialDir(osTmp))).toEqual([
        expect.stringMatching(/^sky-claude-/),
      ]);
    });

    test("a copy a killed runner left in its credential directory is swept with the directory", () => {
      const runner = credentialDir(copies, 4242);
      start(sealOn(SANDBOX, { dir: runner, spawn: () => fakeProcess() }));
      expect(readdirSync(runner)).toHaveLength(1);
      sweepCredentialFiles(() => false, copies, process.pid);
      expect(readdirSync(copies)).toEqual([]);
    });

    test("a copy a live runner is still running from is left alone by another runner's sweep", () => {
      const runner = credentialDir(copies, 4242);
      start(sealOn(SANDBOX, { dir: runner, spawn: () => fakeProcess() }));
      const [copy] = readdirSync(runner);
      // the sweeping runner is another pid, and 4242 is alive
      sweepCredentialFiles((pid) => pid === 4242, copies, 1);
      expect(readdirSync(runner)).toEqual([copy]);
    });

    test("removeSealedCopiesNow goes on to the next copy when one can't be removed, and never throws", () => {
      const spawnFake = () => fakeProcess();
      start(sealOn(SANDBOX, { dir: join(dir, "a"), spawn: spawnFake }));
      start(sealOn(SANDBOX, { dir: join(dir, "b"), spawn: spawnFake }));
      // copies go in the order they were made: `a`'s is the one that fails
      vi.mocked(rmSync).mockImplementationOnce(() => {
        throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
      });
      expect(() => removeSealedCopiesNow()).not.toThrow();
      expect(readdirSync(join(dir, "b"))).toEqual([]);
      expect(readdirSync(join(dir, "a"))).toHaveLength(1);
    });
  });

  describe("check", () => {
    const started = (over: object) => {
      const claude = Object.assign(new EventEmitter(), {
        pid: process.pid,
        exitCode: null,
        signalCode: null,
        ...over,
      }) as unknown as ChildProcess;
      const seal = sealOn(SANDBOX, { dir, spawn: () => claude });
      const source = join(dir, "claude-binary");
      writeFileSync(source, "");
      seal.spawn({
        command: source,
        args: [],
        env: {},
        signal: new AbortController().signal,
      });
      return seal;
    };

    test.each([
      ["exited", { exitCode: 0 }],
      ["killed by a signal", { signalCode: "SIGKILL" }],
    ])("a process that %s holds nothing to read", (_, over) => {
      expect(started(over).check()).toBeUndefined();
    });

    // this test's own process: its environ is its user's to read, on any host
    test("a running process whose /proc entries are its user's own is reported", () => {
      expect(started({}).check()).toBe(
        "the kernel lets the repo's commands read Claude's environment",
      );
    });
  });
});

// A runner that dies of an uncaught exception never reaches the session's own cleanup: the 'exit'
// listener `main` registers is what takes the copy of Claude's binary with it. The child
// registers it the way `main` does (or leaves it out), starts a seal on a fake spawn, and exits. It is
// bundled first, because Node alone won't resolve this package's `./x.js` imports to their `.ts` files.
describe("the copy of Claude's binary when the runner exits", () => {
  const CHILD_SCRIPT = (registerListener: boolean) => `
    import { EventEmitter } from "node:events";
    import { readdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { createSeal, removeSealedCopiesNow } from "./seal.js";
    ${registerListener ? 'process.on("exit", removeSealedCopiesNow);' : ""}
    const { SEAL_DIR, BINARY } = process.env;
    const rootOnly = { stat: () => ({ uid: 0, mode: 0o100755 }), realpath: (path) => path };
    const claude = Object.assign(new EventEmitter(), { pid: 1, exitCode: null, signalCode: null });
    const seal = createSeal("linux", {
      dir: SEAL_DIR,
      hideRunner: () => undefined,
      files: rootOnly,
      spawn: () => claude,
    });
    writeFileSync(BINARY, "");
    seal.spawn({ command: BINARY, args: [], env: {}, signal: new AbortController().signal });
    process.stdout.write(String(readdirSync(SEAL_DIR).length));
    process.exit(0);
  `;

  const runChild = (registerListener: boolean) => {
    const script = join(dir, "child.mjs");
    buildSync({
      stdin: {
        contents: CHILD_SCRIPT(registerListener),
        resolveDir: import.meta.dirname,
        loader: "js",
      },
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: script,
      logLevel: "silent",
    });
    const sealDir = join(dir, "copies");
    const child = spawnSync(process.execPath, [script], {
      env: {
        PATH: process.env.PATH,
        SEAL_DIR: sealDir,
        BINARY: join(dir, "claude-binary"),
      },
      encoding: "utf8",
    });
    return { child, sealDir };
  };

  test("is deleted by the exit listener when the runner ends with Claude still running", () => {
    const { child, sealDir } = runChild(true);
    // the copy was on disk before the exit
    expect(child.stdout).toBe("1");
    expect(child.status).toBe(0);
    expect(readdirSync(sealDir)).toEqual([]);
  });

  test("is left on disk when no listener removes it, so the removal above is the listener's", () => {
    const { child, sealDir } = runChild(false);
    expect(child.stdout).toBe("1");
    expect(child.status).toBe(0);
    expect(readdirSync(sealDir)).toEqual([
      expect.stringMatching(/^sky-claude-/),
    ]);
  });
});

// the kernel itself, where it can be asked (see testing/kernel.ts). CI installs what it takes, so a gap
// there is a setup problem to fail on, not coverage to skip: without this the three tests below, which
// show that a sealed Claude's environment is closed to the repo's commands, could skip on every run and
// nobody would know
test.runIf(process.env.CI)(
  "the kernel can be asked, so the real-kernel tests below run",
  () => {
    expect(kernelGap).toBeUndefined();
  },
);

// what a command the repo starts does: read its parent's environment, as `cat /proc/$PPID/environ` or
// `ps auxe` do, and report whether the secret was there to be read
const CHILD = `
const { spawnSync } = require("node:child_process");
const read = spawnSync("sh", ["-c", "cat /proc/$PPID/environ"], { encoding: "utf8" });
console.log(JSON.stringify({
  readable: read.status === 0 && read.stdout.includes("only-in-the-parents-env"),
  project: process.env.PROJECT_TEST_VALUE,
}));
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
`;

const ENV = {
  PATH: process.env.PATH,
  CLAUDE_CODE_OAUTH_TOKEN: "only-in-the-parents-env",
  PROJECT_TEST_VALUE: "project-value",
};

/** Starts `child` and waits for the report its script prints first; a child that ends without one is the failure. */
const firstReport = (child: ReturnType<typeof spawn>) =>
  new Promise<{ readable: boolean; project: string }>((resolve, reject) => {
    let out = "";
    child.stdout?.on("data", (chunk) => {
      out += chunk;
      const end = out.indexOf("\n");
      if (end >= 0) resolve(JSON.parse(out.slice(0, end)));
    });
    // `close`: after the child's stdout has been read to its end
    child.once("close", (code, signal) =>
      reject(
        new Error(
          `the child ended (${code ?? signal}) before it reported; it printed ${JSON.stringify(out)}`,
        ),
      ),
    );
  });

const ended = (child: ReturnType<typeof spawn>) =>
  new Promise<void>((resolve) => child.once("exit", () => resolve()));

describe.skipIf(!kernelCanBeAsked)("the kernel's hiding of a process", () => {
  test("an ordinary child's environment is readable by the commands it starts", async () => {
    const child = spawn(process.execPath, ["-e", CHILD], {
      env: ENV,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const report = await firstReport(child);
    expect(report.readable).toBe(true);
    expect(isHidden(child.pid ?? 0)).toBe(false);
    child.stdin?.end();
    await ended(child);
  });

  test("a sealed child's environment is not, while the project's own values still reach it", async () => {
    const seal = createSeal("linux", { dir, hideRunner: () => undefined });
    expect(seal.problem).toBeUndefined();
    const child = seal.spawn({
      command: process.execPath,
      args: ["-e", CHILD],
      env: ENV,
      signal: new AbortController().signal,
    }) as ReturnType<typeof spawn>;
    const report = await firstReport(child);
    expect(report.readable).toBe(false);
    expect(report.project).toBe("project-value");
    expect(seal.check()).toBeUndefined();
    expect(isHidden(child.pid ?? 0)).toBe(true);
    child.stdin?.end();
    await ended(child);
    // the copy of the binary goes with the process
    expect(readdirSync(dir)).toEqual([]);
  });

  test("removeSealedCopiesNow deletes a copy of the binary a dying runner would leave behind", async () => {
    const seal = createSeal("linux", { dir, hideRunner: () => undefined });
    const child = seal.spawn({
      command: process.execPath,
      args: ["-e", CHILD],
      env: ENV,
      signal: new AbortController().signal,
    }) as ReturnType<typeof spawn>;
    await firstReport(child);
    expect(readdirSync(dir)).toHaveLength(1);
    removeSealedCopiesNow();
    expect(readdirSync(dir)).toEqual([]);
    child.stdin?.end();
    await ended(child);
  });
});
