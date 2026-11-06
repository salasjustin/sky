import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { endSessionProcesses } from "./reap.js";

// real processes, found through the real /proc
const linux = existsSync("/proc/self/stat");
const test_ = test.skipIf(!linux);

const SLEEP = "setInterval(() => {}, 1000)";
const IGNORES_SIGTERM = `process.on("SIGTERM", () => {}); ${SLEEP}`;

const started: number[] = [];
afterEach(() => {
  for (const pid of started.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
});

/** A node left running by its shell, so reparented to init as a daemonised dev server is. */
async function orphan(
  env: Record<string, string>,
  script = SLEEP,
): Promise<number> {
  const shell = spawn(
    "sh",
    ["-c", `node -e '${script}' >/dev/null 2>&1 </dev/null & echo $!`],
    {
      env: { PATH: process.env.PATH ?? "", ...env },
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  let out = "";
  for await (const chunk of shell.stdout) out += chunk;
  const pid = Number(out.trim());
  started.push(pid);
  return pid;
}

/** A node that is a child of this process, as the runner's own `claude` is. */
function child(env: Record<string, string>): number {
  const proc = spawn("node", ["-e", SLEEP], {
    env: { PATH: process.env.PATH ?? "", ...env },
    stdio: "ignore",
  });
  started.push(proc.pid as number);
  return proc.pid as number;
}

const running = async (pid: number) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return (
      stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z"
    );
  } catch {
    return false;
  }
};

/** Gives a node that is still starting time to exist, so a scan can see its environment. */
const settled = async (...pids: number[]) => {
  for (let i = 0; i < 100; i++) {
    if ((await Promise.all(pids.map(running))).every(Boolean)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

test_(
  "ends the run's descendants and its daemonised leftovers, and no other run's processes",
  async () => {
    const daemon = await orphan({ RUN_ID: "run_aaa" });
    // an environment scrubbed of the mark still hangs off the runner
    const worker = child({});
    const otherRun = await orphan({ RUN_ID: "run_bbb" });
    const bystander = await orphan({});
    await settled(daemon, worker, otherRun, bystander);

    const warnings: string[] = [];
    const ended = await endSessionProcesses({
      runId: "run_aaa",
      graceMs: 2_000,
      warn: (line) => warnings.push(line),
    });

    expect(ended).toBe(2);
    expect(await running(daemon)).toBe(false);
    expect(await running(worker)).toBe(false);
    // another run's processes on the same sprite, and a process of nobody's run, are left alone
    expect(await running(otherRun)).toBe(true);
    expect(await running(bystander)).toBe(true);
    expect(warnings).toEqual([
      expect.stringMatching(
        new RegExp(
          `^runner: ended 2 process\\(es\\) the session left running: .*\\[${daemon}\\]`,
        ),
      ),
    ]);
  },
);

test_(
  "kills a process that ignores SIGTERM once the grace runs out",
  async () => {
    const stubborn = await orphan({ RUN_ID: "run_ccc" }, IGNORES_SIGTERM);
    await settled(stubborn);
    // a handler is installed a moment after the process starts
    await new Promise((resolve) => setTimeout(resolve, 300));

    await endSessionProcesses({
      runId: "run_ccc",
      graceMs: 300,
      warn: () => {},
    });

    expect(await running(stubborn)).toBe(false);
  },
);

test_(
  "a session that left nothing running signals nothing and says nothing",
  async () => {
    const warnings: string[] = [];
    const ended = await endSessionProcesses({
      runId: "run_ddd",
      warn: (line) => warnings.push(line),
    });
    expect(ended).toBe(0);
    expect(warnings).toEqual([]);
  },
);

test("never signals the runner or the processes that started it, even carrying the run's id", async () => {
  const root = mkdtempSync(join(tmpdir(), "sky-proc-"));
  try {
    // the runner (200) under the shell (150) under the exec session (100), all holding the mark
    for (const [pid, ppid] of [
      [200, 150],
      [150, 100],
      [100, 1],
    ] as const) {
      mkdirSync(join(root, String(pid)));
      writeFileSync(
        join(root, String(pid), "stat"),
        `${pid} (node) S ${ppid} 0 0`,
      );
      writeFileSync(
        join(root, String(pid), "environ"),
        "A=1\0RUN_ID=run_eee\0",
      );
    }
    const ended = await endSessionProcesses({
      runId: "run_eee",
      pid: 200,
      procRoot: root,
      warn: () => {},
    });
    expect(ended).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
