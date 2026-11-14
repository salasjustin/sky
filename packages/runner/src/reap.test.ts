import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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
/** Notes each SIGTERM at `$TERMED` and survives it; `$READY` exists once that handler is installed. */
const IGNORES_SIGTERM = `const fs = require("node:fs"); process.on("SIGTERM", () => fs.writeFileSync(process.env.TERMED, "")); fs.writeFileSync(process.env.READY, ""); ${SLEEP}`;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

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

/**
 * A run id no other process on the machine carries: the reap matches on `RUN_ID` across all of `/proc`,
 * so a fixed id would also match the same test running in another checkout or worker.
 */
const uniqueRun = (name: string) => `run_${name}_${randomUUID()}`;

/**
 * A stand-in for the runner (a shell) with a node under it, as the runner's own `claude` is. Reaping
 * with the shell's pid as `pid` makes the node its only descendant, whatever else this process runs.
 */
async function runnerWithChild(
  env: Record<string, string>,
): Promise<{ runner: number; worker: number }> {
  const runner = spawn(
    "sh",
    ["-c", `node -e '${SLEEP}' >/dev/null 2>&1 </dev/null & echo $!; wait`],
    {
      env: { PATH: process.env.PATH ?? "", ...env },
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  started.push(runner.pid as number);
  let out = "";
  for await (const chunk of runner.stdout) {
    out += chunk;
    if (out.includes("\n")) break;
  }
  const worker = Number(out.trim());
  started.push(worker);
  return { runner: runner.pid as number, worker };
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
    const runId = uniqueRun("aaa");
    const daemon = await orphan({ RUN_ID: runId });
    // an environment scrubbed of the mark still hangs off the runner
    const { runner, worker } = await runnerWithChild({});
    const otherRun = await orphan({ RUN_ID: uniqueRun("bbb") });
    // a run whose id merely starts with this one's is another run
    const prefixed = await orphan({ RUN_ID: `${runId}2` });
    const bystander = await orphan({});
    await settled(daemon, worker, otherRun, prefixed, bystander);

    const warnings: string[] = [];
    const ended = await endSessionProcesses({
      runId,
      pid: runner,
      graceMs: 2_000,
      warn: (line) => warnings.push(line),
    });

    expect(ended).toBe(2);
    expect(await running(daemon)).toBe(false);
    expect(await running(worker)).toBe(false);
    // another run's processes on the same sprite, and a process of nobody's run, are left alone
    expect(await running(otherRun)).toBe(true);
    expect(await running(prefixed)).toBe(true);
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
    const dir = mkdtempSync(join(tmpdir(), "sky-reap-"));
    roots.push(dir);
    const ready = join(dir, "ready");
    const termed = join(dir, "termed");
    const runId = uniqueRun("ccc");
    const stubborn = await orphan(
      { RUN_ID: runId, READY: ready, TERMED: termed },
      IGNORES_SIGTERM,
    );
    // the handler is installed before the marker is written
    for (let i = 0; i < 250 && !existsSync(ready); i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(existsSync(ready)).toBe(true);

    await endSessionProcesses({
      runId,
      graceMs: 300,
      warn: () => {},
    });

    // it outlived the SIGTERM, so the SIGKILL is what ended it
    expect(existsSync(termed)).toBe(true);
    expect(await running(stubborn)).toBe(false);
  },
);

test_(
  "a session that left nothing running signals nothing and says nothing",
  async () => {
    const warnings: string[] = [];
    const ended = await endSessionProcesses({
      runId: uniqueRun("ddd"),
      warn: (line) => warnings.push(line),
    });
    expect(ended).toBe(0);
    expect(warnings).toEqual([]);
  },
);

/** A process in a fake `/proc`: its `stat`, and its `environ` holding `env`. */
function fakeProc(
  root: string,
  pid: number,
  ppid: number,
  { state = "S", env = "A=1" }: { state?: string; env?: string } = {},
) {
  mkdirSync(join(root, String(pid)), { recursive: true });
  writeFileSync(
    join(root, String(pid), "stat"),
    `${pid} (node) ${state} ${ppid} 0 0`,
  );
  writeFileSync(join(root, String(pid), "environ"), `${env}\0`);
}

/**
 * A fake `/proc` holding the runner (9000200) under its exec session (9000100); removed after the test.
 * Pids above any pid_max (2^22 at most), so a signal that reaches the real `process.kill` finds no one.
 */
function fakeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "sky-proc-"));
  roots.push(root);
  fakeProc(root, 9000100, 1);
  fakeProc(root, 9000200, 9000100);
  return root;
}

/** Records every signal sent; a pid in `exits` leaves the fake `/proc` on its first signal, the rest never do. */
function recorder(root: string, exits: number[] = []) {
  const sent: string[] = [];
  const kill = (pid: number, sig: NodeJS.Signals) => {
    sent.push(`${sig} ${pid}`);
    if (exits.includes(pid))
      rmSync(join(root, String(pid)), { recursive: true, force: true });
  };
  return { sent, kill };
}

test("never signals the runner or the processes that started it, even carrying the run's id", async () => {
  const root = mkdtempSync(join(tmpdir(), "sky-proc-"));
  roots.push(root);
  // the runner (9000200) under the shell (9000150) under the exec session (9000100), all holding the mark
  fakeProc(root, 9000200, 9000150, { env: "A=1\0RUN_ID=run_eee" });
  fakeProc(root, 9000150, 9000100, { env: "A=1\0RUN_ID=run_eee" });
  fakeProc(root, 9000100, 1, { env: "A=1\0RUN_ID=run_eee" });
  const ended = await endSessionProcesses({
    runId: "run_eee",
    pid: 9000200,
    procRoot: root,
    warn: () => {},
  });
  expect(ended).toBe(0);
});

test("a process it may not signal is reported as not ended, signalled once, and waited on never", async () => {
  const root = fakeRoot();
  // a server started through sudo, and one the run started itself
  fakeProc(root, 9000300, 9000200);
  fakeProc(root, 9000301, 9000200);
  const { sent, kill } = recorder(root, [9000301]);
  const warnings: string[] = [];
  const started = Date.now();
  const ended = await endSessionProcesses({
    runId: "run_fff",
    pid: 9000200,
    procRoot: root,
    graceMs: 2_000,
    kill: (pid, sig) => {
      if (pid === 9000300)
        throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      kill(pid, sig);
    },
    warn: (line) => warnings.push(line),
  });
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(ended).toBe(1);
  expect(sent).toEqual(["SIGTERM 9000301"]);
  expect(warnings).toEqual([
    "runner: ended 1 process(es) the session left running: node[9000301]",
    "runner: could not end 1 process(es) the session left running, not permitted to signal them: node[9000300]",
  ]);
});

test("a process still dying after its SIGKILL is not signalled or waited on again", async () => {
  const root = fakeRoot();
  // ignores SIGTERM, and outlives its SIGKILL: stuck in uninterruptible sleep
  fakeProc(root, 9000300, 9000200);
  const { sent, kill } = recorder(root);
  const started = Date.now();
  const ended = await endSessionProcesses({
    runId: "run_ggg",
    pid: 9000200,
    procRoot: root,
    graceMs: 300,
    kill,
    warn: () => {},
  });
  expect(sent).toEqual(["SIGTERM 9000300", "SIGKILL 9000300"]);
  expect(ended).toBe(1);
  // one grace and one bounded wait for the SIGKILL to land, not a grace per round
  expect(Date.now() - started).toBeLessThan(300 + 1_000 + 300);
});

test("a process that starts another as it ends is followed for three rounds, then left", async () => {
  const root = fakeRoot();
  fakeProc(root, 9000300, 9000200);
  const sent: string[] = [];
  const ended = await endSessionProcesses({
    runId: "run_hhh",
    pid: 9000200,
    procRoot: root,
    graceMs: 200,
    // each one, as it ends, starts the next under the runner
    kill: (pid, sig) => {
      sent.push(`${sig} ${pid}`);
      rmSync(join(root, String(pid)), { recursive: true, force: true });
      fakeProc(root, pid + 1, 9000200);
    },
    warn: () => {},
  });
  expect(sent).toEqual([
    "SIGTERM 9000300",
    "SIGTERM 9000301",
    "SIGTERM 9000302",
  ]);
  expect(ended).toBe(3);
});

test("a zombie is already dead: it is neither signalled nor counted", async () => {
  const root = fakeRoot();
  fakeProc(root, 9000300, 9000200, { state: "Z" });
  const { sent, kill } = recorder(root);
  const warnings: string[] = [];
  const ended = await endSessionProcesses({
    runId: "run_iii",
    pid: 9000200,
    procRoot: root,
    kill,
    warn: (line) => warnings.push(line),
  });
  expect({ ended, sent, warnings }).toEqual({
    ended: 0,
    sent: [],
    warnings: [],
  });
});

test("a host with no /proc warns once and signals nothing", async () => {
  const { sent, kill } = recorder("/nonexistent");
  const warnings: string[] = [];
  const ended = await endSessionProcesses({
    runId: "run_jjj",
    procRoot: join(tmpdir(), "sky-no-proc-here"),
    kill,
    warn: (line) => warnings.push(line),
  });
  expect(ended).toBe(0);
  expect(sent).toEqual([]);
  expect(warnings).toEqual([
    expect.stringMatching(
      /^runner: ending the session's processes failed: .*ENOENT/,
    ),
  ]);
});
