import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createSeal,
  hideRunner,
  isHidden,
  removeSealedCopiesNow,
} from "./seal.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sky-seal-"));
});
afterEach(() => {
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
  const withSetpriv = () => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "setpriv"), "#!/bin/sh\n");
    chmodSync(join(bin, "setpriv"), 0o755);
    return { PATH: bin };
  };

  test("there is no seal where there is no /proc to hide", () => {
    expect(createSeal("darwin")).toBeUndefined();
    expect(createSeal("win32")).toBeUndefined();
  });

  test("a runner the kernel can't hide is the seal's problem", () => {
    const seal = createSeal("linux", {
      env: withSetpriv(),
      hideRunner: () => "the runner can't change its effective user (EPERM)",
    });
    expect(seal?.problem).toBe(
      "the runner can't change its effective user (EPERM)",
    );
  });

  test("a sandbox without setpriv is the seal's problem", () => {
    const seal = createSeal("linux", {
      env: { PATH: join(dir, "empty") },
      hideRunner: () => undefined,
    });
    expect(seal?.problem).toMatch(/setpriv .* isn't installed/);
  });

  test("a hidden runner with setpriv at hand has no problem", () => {
    const seal = createSeal("linux", {
      env: withSetpriv(),
      hideRunner: () => undefined,
    });
    expect(seal?.problem).toBeUndefined();
  });

  test("before Claude is started, its process can't be vouched for", () => {
    const seal = createSeal("linux", {
      env: withSetpriv(),
      hideRunner: () => undefined,
    });
    expect(seal?.check()).toMatch(/not started/);
  });
});

// the kernel itself, on a machine where it can be asked: Linux, not root (root's capabilities read any
// file), with a `setpriv` that runs here, and core dumps of non-dumpable processes off
const setprivRuns =
  process.platform === "linux" &&
  spawnSync("setpriv", [
    "--inh-caps=-dac_override,-dac_read_search",
    "--ambient-caps=-dac_override,-dac_read_search",
    "true",
  ]).status === 0;
const dumpableRespected = (() => {
  try {
    return readFileSync("/proc/sys/fs/suid_dumpable", "utf8").trim() === "0";
  } catch {
    return false;
  }
})();
const kernelCanBeAsked =
  setprivRuns && dumpableRespected && process.getuid?.() !== 0;

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

/** Starts `child` and waits for the report its script prints first. */
async function firstReport(child: ReturnType<typeof spawn>) {
  let out = "";
  for await (const chunk of child.stdout ?? []) {
    out += chunk;
    if (out.includes("\n")) break;
  }
  return JSON.parse(out) as { readable: boolean; project: string };
}

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
    if (!seal) throw new Error("no seal on Linux");
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
    const child = seal?.spawn({
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
