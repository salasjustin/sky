import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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

test.each([
  ["empty", ""],
  ["garbage", "not a pid"],
  ["a pid with trailing junk", `${process.pid}x`],
])("a lock that is %s is stale, and taken over", (_, content) => {
  writeFileSync(join(dir, "run_1.lock"), content);
  const claim = claimRunLog(prompt, 4242);
  expect(claim).toMatchObject({ ok: true, logFile: join(dir, "run_1.log") });
  expect(readFileSync(join(dir, "run_1.lock"), "utf8")).toBe("4242");
  // no temp or moved-aside file is left beside the lock
  expect(readdirSync(dir).sort()).toEqual(["run_1.lock"]);
});

test("a prompt file without the .prompt suffix is never touched: the log and lock go beside it", () => {
  const bare = join(dir, "run_1");
  writeFileSync(bare, "the prompt");
  expect(logPathOf(bare)).toBe(join(dir, "run_1.log"));
  const first = claimRunLog(bare, process.pid);
  expect(first).toMatchObject({ ok: true, logFile: join(dir, "run_1.log") });
  // a second claimer, a stale-lock takeover and a release all leave it alone
  expect(claimRunLog(bare, process.pid + 1).ok).toBe(false);
  if (first.ok) first.release();
  writeFileSync(join(dir, "run_1.lock"), String(deadPid()));
  const taken = claimRunLog(bare, 4242);
  if (taken.ok) taken.release();
  expect(readFileSync(bare, "utf8")).toBe("the prompt");
  expect(readdirSync(dir)).toEqual(["run_1"]);
});

/**
 * Two processes claiming the same run at one instant; each holds its claim until its stdin closes,
 * so the loser finds the winner alive. Resolves to how many won.
 */
async function race(promptFile: string): Promise<number> {
  const module = pathToFileURL(join(import.meta.dirname, "runlog.ts")).href;
  const start = Date.now() + 300;
  const script = `
    const { claimRunLog } = await import(process.argv[1]);
    while (Date.now() < Number(process.argv[3])) {}
    const claim = claimRunLog(process.argv[2]);
    process.stdout.write(claim.ok ? "won\\n" : "lost\\n");
    process.stdin.resume();
    process.stdin.on("end", () => process.exit(0));
  `;
  const children = [0, 1].map(() =>
    spawn(
      process.execPath,
      ["--input-type=module", "-e", script, module, promptFile, String(start)],
      { stdio: ["pipe", "pipe", "inherit"] },
    ),
  );
  const results = await Promise.all(
    children.map(async (child) => {
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      while (!out.includes("\n")) await once(child.stdout, "data");
      return out.trim();
    }),
  );
  for (const child of children) child.stdin.end();
  await Promise.all(children.map((child) => once(child, "exit")));
  return results.filter((r) => r === "won").length;
}

test("two runners claiming at once never both win, with no lock or a stale one", async () => {
  for (let round = 0; round < 5; round++) {
    rmSync(join(dir, "run_1.lock"), { force: true });
    expect(await race(prompt)).toBe(1);
    writeFileSync(join(dir, "run_1.lock"), String(deadPid()));
    expect(await race(prompt)).toBe(1);
  }
}, 30_000);

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
