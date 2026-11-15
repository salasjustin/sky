import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpritesClient } from "@fly/sprites";
import type { RunId } from "@sky/shared";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  collectDiagnostics,
  type Diagnostics,
  killLinesWithin,
  parseFree,
  restartSince,
} from "./memory.js";
import { KnownSecrets } from "./redact.js";
import { SPRITES_TIMEOUT_MS, type SpriteOps } from "./sprites.js";
import { spritesToken, stubSprites } from "./testing/sprites.js";

const header =
  "               total        used        free      shared  buff/cache   available";

test("parseFree reads the Mem row's total, used and available and the Swap row's total and used", () => {
  expect(
    parseFree(`${header}
Mem:           16000        9019        1500         100        5000        6200
Swap:           2048         512        1536
`),
  ).toEqual({
    totalMb: 16_000,
    usedMb: 9019,
    availableMb: 6200,
    swapTotalMb: 2048,
    swapUsedMb: 512,
  });
});

test("parseFree takes a missing Swap row as no swap", () => {
  expect(
    parseFree(`${header}
Mem:           16000        9019        1500         100        5000        6200
`),
  ).toMatchObject({ availableMb: 6200, swapTotalMb: 0, swapUsedMb: 0 });
});

test("parseFree reads nothing from a Mem row whose buff/cache exceeds its total", () => {
  // a nearly idle sprite that reports more page cache than memory, and available 0
  expect(
    parseFree(`${header}
Mem:            8192        8192           0           0        8922           0
Swap:              0           0           0
`),
  ).toBeUndefined();
  // at the total it is still a reading
  expect(
    parseFree(`${header}
Mem:            8192         100           0           0        8192        8000
`),
  ).toMatchObject({ totalMb: 8192, availableMb: 8000 });
});

test("parseFree reads nothing from output it doesn't recognise", () => {
  for (const out of [
    "",
    "free: not found\n",
    `${header}\nMem:           16000        9019\n`,
    // procps before 3.3.10: the last column is `cached`, not what a new process can claim
    `             total       used       free     shared    buffers     cached
Mem:         16000       9019       1500        100        300       4700
Swap:            0          0          0
`,
  ]) {
    expect(parseFree(out)).toBeUndefined();
  }
});

/** A diagnostics report taken `uptimeSec` after the sprite booted, with `ps` and the kernel section as given. */
const report = ({
  uptimeSec = "5000.12",
  ps = "4242 1 3100000 12:03 node server.js",
  kernel = ["== kernel kills"],
}: {
  uptimeSec?: string | null;
  ps?: string;
  kernel?: string[];
}) =>
  [
    "== free -m",
    header,
    "Mem:           16000        9019        1500         100        5000        6200",
    "== uptime",
    " 17:03:01 up 1:23,  0 users,  load average: 9.10, 4.20, 1.70",
    ...(uptimeSec === null ? [] : ["== seconds since boot", uptimeSec]),
    "== top processes by RSS (pid ppid rss_kb elapsed command)",
    ps,
    ...kernel,
    "",
  ].join("\n");

test("killLinesWithin keeps the kernel's kill lines logged within the last `withinSec` seconds, by the sprite's own clock", () => {
  const recent =
    "[ 4990.500000] Out of memory: Killed process 3912 (node) total-vm:9012344kB";
  const reaped = "[ 4991.000000] oom_reaper: reaped process 3912 (node)";
  const old = "[ 1200.000000] Out of memory: Killed process 812 (node)";
  const text = report({ kernel: ["== kernel kills", old, recent, reaped] });
  expect(killLinesWithin(text, 60)).toEqual([recent, reaped]);
  expect(killLinesWithin(text, 4_000)).toEqual([old, recent, reaped]);
  expect(killLinesWithin(text, 5)).toEqual([]);
});

test("killLinesWithin finds no kill lines in a report without the kernel section, whatever the processes say", () => {
  const text = report({
    ps: "77 1 2000 00:10 grep -i killed process",
    kernel: [],
  });
  expect(killLinesWithin(text, 60)).toEqual([]);
});

test("killLinesWithin counts a kill line only after the kernel marker at the start of a line", () => {
  const text = report({
    ps: '91 1 3000 00:01 bash -c { echo "== kernel kills"; [ 4999.0] Out of memory: Killed process 1 (x)',
    kernel: ["== kernel kills", "dmesg not readable"],
  });
  expect(killLinesWithin(text, 60)).toEqual([]);
});

test("killLinesWithin can't place a kill line without the sprite's uptime or the line's timestamp, so counts none", () => {
  const line = "[ 4990.5] Out of memory: Killed process 3912 (node)";
  expect(
    killLinesWithin(
      report({ uptimeSec: null, kernel: ["== kernel kills", line] }),
      60,
    ),
  ).toEqual([]);
  expect(
    killLinesWithin(
      report({ uptimeSec: "garbled", kernel: ["== kernel kills", line] }),
      60,
    ),
  ).toEqual([]);
  expect(
    killLinesWithin(
      report({
        kernel: [
          "== kernel kills",
          "Out of memory: Killed process 3912 (node)",
        ],
      }),
      60,
    ),
  ).toEqual([]);
});

// the diagnostics script, run for real under bash with stand-ins for the sprite's own tools
const STUB_UPTIME_SEC = 90_000;
const realTool = (name: string) => {
  const found = spawnSync("sh", ["-c", `command -v ${name}`], {
    encoding: "utf8",
  }).stdout.trim();
  if (!found) throw new Error(`no ${name} on this machine`);
  return found;
};

let tools: string;
beforeEach(() => {
  tools = mkdtempSync(join(tmpdir(), "sky-memory-tools-"));
});
afterEach(() => {
  rmSync(tools, { recursive: true, force: true });
});

const stubTool = (name: string, body: string) => {
  writeFileSync(join(tools, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(tools, name), 0o755);
};

/** A PATH holding only coreutils the script needs plus stand-ins for `free`, `ps`, `uptime` and `dmesg`. */
function sprite({ dmesg }: { dmesg: string[] | "unreadable" }) {
  for (const name of ["head", "grep", "tail"]) {
    symlinkSync(realTool(name), join(tools, name));
  }
  // `cut` also reads /proc/uptime, which the sprite's own clock must answer here
  stubTool(
    "cut",
    `case "$*" in *"/proc/uptime"*) echo ${STUB_UPTIME_SEC}.00;; *) exec ${realTool("cut")} "$@";; esac`,
  );
  const mem =
    "Mem:           16000        9019        1500         100        5000        6200";
  stubTool(
    "free",
    `printf '%s\\n' '               total        used        free      shared  buff/cache   available' '${mem}' 'Swap:              0           0           0'`,
  );
  stubTool("uptime", `echo ' 17:03:01 up 1 day,  1:00,  0 users'`);
  stubTool(
    "ps",
    `[ "$1" = "-eo" ] || exit 2\nprintf '%s\\n' '4242 1 3100000 12:03 node server.js' '77 1 2000 00:10 sleep 9'`,
  );
  stubTool(
    "dmesg",
    dmesg === "unreadable"
      ? "echo 'dmesg: read kernel buffer failed: Operation not permitted' >&2; exit 1"
      : `printf '%s\\n' ${dmesg.map((l) => `'${l}'`).join(" ")}`,
  );
}

/** Collects diagnostics from the stub sprite, its script run under bash with `tools` as the whole PATH. */
function collectOver(startedAtMsAgo: number) {
  const wire = stubSprites();
  wire.sprites.add("sprite-a");
  const exec = wire.exec;
  wire.exec = (argv) => {
    if (argv[0] !== "bash") return exec(argv);
    const out = join(tools, "report.txt");
    const ran = spawnSync(realTool("bash"), ["-c", argv[2] ?? "", "_", out], {
      env: { PATH: tools },
      encoding: "utf8",
    });
    wire.files.set(argv[4] ?? "", readFileSync(out));
    return { exitCode: ran.status ?? 1, stderr: ran.stderr };
  };
  const ops: SpriteOps = {
    client: new SpritesClient(spritesToken),
    log: () => {},
    secrets: new KnownSecrets(),
    timeoutMs: SPRITES_TIMEOUT_MS,
    longTimeoutMs: SPRITES_TIMEOUT_MS,
  };
  return collectDiagnostics(
    ops,
    "sprite-a",
    "run_x" as RunId,
    Date.now() - startedAtMsAgo,
  );
}

test("the real diagnostics script's report is read by the parser: memory, and only the kill lines within the run's age", async () => {
  const stamp = (agoSec: number) =>
    `[${(STUB_UPTIME_SEC - agoSec).toFixed(6)}]`;
  const old = `${stamp(5 * 3600)} Out of memory: Killed process 812 (node) total-vm:9012344kB`;
  const recent = `${stamp(10)} Out of memory: Killed process 3912 (node) total-vm:9012344kB`;
  sprite({
    dmesg: [old, `${stamp(20)} eth0: link up`, recent],
  });
  const diagnostics = await collectOver(60_000);

  expect(diagnostics.memory).toEqual({
    totalMb: 16_000,
    usedMb: 9019,
    availableMb: 6200,
    swapTotalMb: 0,
    swapUsedMb: 0,
  });
  expect(diagnostics.killLines).toEqual([recent]);
  for (const part of [
    "== free -m",
    "== uptime",
    "== top processes by RSS",
    "4242 1 3100000 12:03 node server.js",
    "== kernel kills",
    old,
  ]) {
    expect(diagnostics.text).toContain(part);
  }
  // the script keeps only the kill lines of dmesg's output
  expect(diagnostics.text).not.toContain("eth0: link up");
});

test("the real diagnostics script reports an unreadable dmesg as such and finds no kill line, the rest of the report intact", async () => {
  sprite({ dmesg: "unreadable" });
  const diagnostics = await collectOver(60_000);

  expect(diagnostics.text).toContain("dmesg not readable");
  expect(diagnostics.killLines).toEqual([]);
  expect(diagnostics.memory?.availableMb).toBe(6200);
});

// the runner up at 1_000 s, the probe set out and the report taken at 1_600 s (epoch ms): with the 30 s
// margin at both edges, only a restart strictly between 1_030 s and 1_570 s is inside the run
const span = {
  runnerStartedAt: 1_000_000,
  probeStartedAt: 1_600_000,
  now: 1_600_000,
};
const ages = (bootAgeSec?: number, initAgeSec?: number): Diagnostics => ({
  text: "",
  killLines: [],
  bootAgeSec,
  initAgeSec,
});

test.each([
  [31, "at 1_569 s, the probe's side"],
  [30.5, "at 1_569.5 s, the probe's side"],
  [569, "at 1_031 s, the runner's side"],
  [569.5, "at 1_030.5 s, the runner's side"],
])("restartSince counts a boot %s s old (%s) as a reboot", (ageSec) => {
  expect(restartSince(ages(ageSec), span)).toEqual({
    kind: "rebooted",
    ageSec,
  });
});

test.each([
  [30, "at 1_570 s, the probe's margin itself"],
  [29.5, "at 1_570.5 s, past the probe's margin"],
  [570, "at 1_030 s, the runner's margin itself"],
  [570.5, "at 1_029.5 s, inside the runner's margin"],
])("restartSince counts a boot %s s old (%s) as no restart", (ageSec) => {
  expect(restartSince(ages(ageSec), span)).toBeUndefined();
});

test("restartSince reads the init age by the same edges, as a processes restart", () => {
  expect(restartSince(ages(24_000, 569.5), span)).toEqual({
    kind: "processes",
    ageSec: 569.5,
  });
  expect(restartSince(ages(24_000, 30.5), span)).toEqual({
    kind: "processes",
    ageSec: 30.5,
  });
  expect(restartSince(ages(24_000, 30), span)).toBeUndefined();
  expect(restartSince(ages(24_000, 570), span)).toBeUndefined();
});

test("restartSince names a reboot over a processes restart when both ages are inside the run", () => {
  expect(restartSince(ages(300, 200), span)).toEqual({
    kind: "rebooted",
    ageSec: 300,
  });
});

test("restartSince counts a report without ages as no restart", () => {
  expect(restartSince(ages(), span)).toBeUndefined();
});

test("restartSince reads each age against the `now` it is given", () => {
  const later = { ...span, now: 1_700_000 };
  // 569.5 s before 1_700 s is 1_130.5 s: inside; 100 s before is 1_600 s: after the probe's margin
  expect(restartSince(ages(569.5), later)).toEqual({
    kind: "rebooted",
    ageSec: 569.5,
  });
  expect(restartSince(ages(100), later)).toBeUndefined();
});
