import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { claimRunLog, logPathOf } from "./runlog.js";

let dir: string;
let prompt: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "runner-runlog-"));
  prompt = join(dir, "run_1.prompt");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A pid that belonged to a process that has since exited. */
const deadPid = () => {
  const child = spawnSync(process.execPath, ["-e", ""]);
  if (!child.pid) throw new Error("no pid");
  return child.pid;
};

test("the log sits beside the prompt file", () => {
  expect(logPathOf("/workspace/runs/run_1.prompt")).toBe(
    "/workspace/runs/run_1.log",
  );
});

test("the first claim gets the log and a lock naming its pid; release removes the lock", () => {
  const claim = claimRunLog(prompt, 4242);
  expect(claim).toMatchObject({ ok: true, logFile: join(dir, "run_1.log") });
  expect(readFileSync(join(dir, "run_1.lock"), "utf8")).toBe("4242");
  if (claim.ok) claim.release();
  expect(existsSync(join(dir, "run_1.lock"))).toBe(false);
});

test("a second process for the run, while the first lives, is refused and touches nothing", () => {
  writeFileSync(join(dir, "run_1.log"), "the runner's own lines\n");
  const first = claimRunLog(prompt, process.pid);
  expect(first.ok).toBe(true);
  const second = claimRunLog(prompt, process.pid + 1);
  expect(second).toEqual({
    ok: false,
    reason: `another runner (pid ${process.pid}) already runs this run`,
  });
  expect(readFileSync(join(dir, "run_1.log"), "utf8")).toBe(
    "the runner's own lines\n",
  );
  // the refused process's release is not even offered, so it can't free the first's lock
  expect(readFileSync(join(dir, "run_1.lock"), "utf8")).toBe(
    String(process.pid),
  );
});

test("a lock left by a killed runner is taken over", () => {
  writeFileSync(join(dir, "run_1.lock"), String(deadPid()));
  const claim = claimRunLog(prompt, process.pid);
  expect(claim.ok).toBe(true);
  expect(readFileSync(join(dir, "run_1.lock"), "utf8")).toBe(
    String(process.pid),
  );
});

test("release leaves a lock that is another process's", () => {
  const claim = claimRunLog(prompt, 1111);
  writeFileSync(join(dir, "run_1.lock"), "2222");
  if (claim.ok) claim.release();
  expect(readFileSync(join(dir, "run_1.lock"), "utf8")).toBe("2222");
});

test("a lock that can't be made doesn't cost the run its log", () => {
  const claim = claimRunLog(join(dir, "missing", "run_1.prompt"), 1);
  expect(claim).toMatchObject({ ok: true });
});
