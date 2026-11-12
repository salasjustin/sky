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
import type { RunId } from "@sky/shared";
import { afterEach, beforeEach, expect, test } from "vitest";
import { runnerPattern, STOP_LINGERING } from "./launch.js";

const runId = "run_abc123" as RunId;
// pgrep -f matches its ERE against each process's whole command line
const matches = (cmdline: string) =>
  new RegExp(runnerPattern(runId)).test(cmdline);

test("the runner pattern matches the runner whatever path its node is started from", () => {
  expect(matches(`node /opt/sky/runner.mjs ${runId}`)).toBe(true);
  expect(
    matches(
      `/home/sprite/.local/share/mise/installs/node/24/bin/node /opt/sky/runner.mjs ${runId}`,
    ),
  ).toBe(true);
});

test("the runner pattern matches neither another run's runner, the bash parent, the Claude child nor the matcher itself", () => {
  expect(matches(`node /opt/sky/runner.mjs ${runId}9`)).toBe(false);
  expect(
    matches(
      `bash -c set -a && . "$ENV_FILE" && set +a && rm -f "$ENV_FILE" && PROMPT="$(cat "$PROMPT_FILE")" && export PROMPT && exec node /opt/sky/runner.mjs "$RUN_ID"`,
    ),
  ).toBe(false);
  expect(
    matches(
      "node /opt/sky/node_modules/@anthropic-ai/claude-agent-sdk/cli.js --output-format stream-json",
    ),
  ).toBe(false);
  expect(matches(`pkill -TERM -f ${runnerPattern(runId)}`)).toBe(false);
  expect(
    matches(
      `bash -c for _ in ... _ /workspace/worktrees/agt_x ${runnerPattern(runId)}`,
    ),
  ).toBe(false);
});

test("the runner pattern matches neither the stop-lingering command line carrying it nor another run's runner", () => {
  // what pgrep -f sees of the exec: argv joined by spaces
  const cmdline = [
    "bash",
    "-c",
    STOP_LINGERING,
    "term",
    "5",
    "9",
    runnerPattern(runId),
  ].join(" ");
  expect(matches(cmdline)).toBe(false);
  expect(matches(`node /opt/sky/runner.mjs run_other77`)).toBe(false);
});

// the script runs under real bash with pgrep, pkill and sleep replaced by fakes first on PATH: sleep
// returns at once, pgrep answers the next code of its script (the last one repeating), pkill records
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sky-stop-lingering-"));
  const fake = (name: string, body: string) => {
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  };
  fake("sleep", "exit 0");
  fake(
    "pgrep",
    `n=$(cat "$STATE/pgrep.count" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > "$STATE/pgrep.count"
i=0
for code in $(cat "$STATE/pgrep.codes"); do
  i=$((i + 1))
  chosen=$code
  [ "$i" -ge "$n" ] && break
done
exit "$chosen"`,
  );
  fake("pkill", `echo "$*" >> "$STATE/pkill.calls"`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Runs the script with `mode`, a 2 s quiet wait and a 3 s term wait; pgrep exits `codes` in turn: 0 alive, 1 gone, 2 error. */
function stopLingering(mode: "term" | "wait", codes: number[]) {
  writeFileSync(join(dir, "pgrep.codes"), codes.join(" "));
  const pattern = runnerPattern(runId);
  const out = spawnSync(
    "bash",
    ["-c", STOP_LINGERING, mode, "2", "3", pattern],
    {
      env: { PATH: `${dir}:${process.env.PATH}`, STATE: dir },
      encoding: "utf8",
    },
  );
  const read = (name: string) => {
    try {
      return readFileSync(join(dir, name), "utf8").trim();
    } catch {
      return "";
    }
  };
  return {
    status: out.status,
    pkills: read("pkill.calls") === "" ? [] : read("pkill.calls").split("\n"),
    pgreps: Number(read("pgrep.count") || 0),
    pattern,
  };
}

test("stop-lingering: a runner gone during the quiet wait exits 0 without a signal", () => {
  const r = stopLingering("term", [0, 1]);
  expect(r.status).toBe(0);
  expect(r.pkills).toEqual([]);
});

test("stop-lingering: a runner alive after the quiet wait is SIGTERMed once, and gone after it exits 3", () => {
  // quiet wait: 2 checks and a last one; then the term wait
  const r = stopLingering("term", [0, 0, 0, 1]);
  expect(r.status).toBe(3);
  expect(r.pkills).toEqual([`-TERM -f ${r.pattern}`]);
});

test("stop-lingering: a runner that survives the SIGTERM too exits 1 after exactly one signal", () => {
  const r = stopLingering("term", [0]);
  expect(r.status).toBe(1);
  expect(r.pkills).toEqual([`-TERM -f ${r.pattern}`]);
});

test("stop-lingering: under wait a runner that never exits exits 1 and is never signalled", () => {
  const r = stopLingering("wait", [0]);
  expect(r.status).toBe(1);
  expect(r.pkills).toEqual([]);
  // both waits ran to their last check: (2 + 1) + (3 + 1)
  expect(r.pgreps).toBe(7);
});

test("stop-lingering: under wait a runner gone in the second wait exits 0 without a signal", () => {
  const r = stopLingering("wait", [0, 0, 0, 0, 1]);
  expect(r.status).toBe(0);
  expect(r.pkills).toEqual([]);
});

test("stop-lingering: a runner gone exactly on the last check of a wait counts as gone", () => {
  expect(stopLingering("term", [0, 0, 1]).status).toBe(0);
  // the last check of the term wait is the 7th pgrep
  const r = stopLingering("term", [0, 0, 0, 0, 0, 0, 1]);
  expect(r.status).toBe(3);
  expect(r.pgreps).toBe(7);
});

test("stop-lingering: a pgrep error exits 2 without a signal", () => {
  const r = stopLingering("term", [2]);
  expect(r.status).toBe(2);
  expect(r.pkills).toEqual([]);
});
