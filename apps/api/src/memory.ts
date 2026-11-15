import type { RunId } from "@sky/shared";
import { redact } from "./redact.js";
import { execInSprite, type SpriteOps, spriteCall } from "./sprites.js";

/** What `free -m` reports of a sprite, in MB. `availableMb` is what a new process can claim without swapping. */
export type Memory = {
  totalMb: number;
  usedMb: number;
  availableMb: number;
  swapTotalMb: number;
  swapUsedMb: number;
};

/**
 * The Mem row's total, used and available columns and the Swap row's total and used; undefined when
 * `free` printed no Mem row, or a header not ending in `available` (procps before 3.3.10 ends in `cached`).
 * Also undefined when buff/cache exceeds total, which no real page cache can do: a sprite's
 * platform-managed memory can report it, and the sprites that do also report available 0 and used =
 * total while nearly idle, so the row says nothing of what a new process can claim.
 */
export function parseFree(stdout: string): Memory | undefined {
  if (!/^\s+total\s.*\savailable$/m.test(stdout)) return undefined;
  const mem = /^Mem:\s+(\d+)\s+(\d+)\s+\d+\s+\d+\s+(\d+)\s+(\d+)/m.exec(stdout);
  if (!mem) return undefined;
  if (Number(mem[3]) > Number(mem[1])) return undefined;
  const swap = /^Swap:\s+(\d+)\s+(\d+)/m.exec(stdout);
  return {
    totalMb: Number(mem[1]),
    usedMb: Number(mem[2]),
    availableMb: Number(mem[4]),
    swapTotalMb: Number(swap?.[1] ?? 0),
    swapUsedMb: Number(swap?.[2] ?? 0),
  };
}

/**
 * The sprite's memory by `free -m`; undefined when `free` fails or prints something unreadable, which
 * says nothing of the memory. Throws when the sprite can't answer. The exec wakes a sleeping sprite.
 */
export async function readMemory(
  ops: SpriteOps,
  spriteName: string,
): Promise<Memory | undefined> {
  const out = await execInSprite(ops, spriteName, ["free", "-m"], {
    op: "free",
  });
  return out.exitCode === 0 ? parseFree(out.stdout) : undefined;
}

// the lines the kernel logs when it kills a process for memory
const KERNEL_KILL = "out of memory|oom-kill|oom_reaper|killed process";
const KERNEL_KILL_LINE = new RegExp(KERNEL_KILL, "i");
const KERNEL_MARK = "== kernel kills";
const UPTIME_MARK = "== seconds since boot";
const INIT_MARK = "== seconds since pid 1 started";

// into a file rather than back over the exec: its frames carry no length, and a few KB re-chunked by an
// intermediary is misread (see `execLogged`); each command's failure is part of the report, never the script's.
// `LC_ALL=C`: a locale with a comma decimal prints the load as `0,52, 0,58`, which `parseLoad5` misreads
const DIAGNOSTICS_SCRIPT = `{
echo "== free -m"; free -m
echo "== uptime"; LC_ALL=C uptime
echo "${UPTIME_MARK}"; cut -d' ' -f1 /proc/uptime
echo "${INIT_MARK}"; LC_ALL=C ps -o etimes= -p 1
echo "== top processes by RSS (pid ppid rss_kb elapsed command)"; LC_ALL=C ps -eo pid=,ppid=,rss=,etime=,args= --sort=-rss | head -n 12 | cut -c1-240
echo "${KERNEL_MARK}"; if k=$(dmesg 2>&1); then printf '%s\\n' "$k" | grep -iE '${KERNEL_KILL}' | tail -n 8 | cut -c1-240; else echo "dmesg not readable"; fi
} >"$1" 2>&1; exit 0`;

/**
 * The kernel's kill lines in a diagnostics report logged within the last `withinSec` seconds: `dmesg`
 * stamps each line in seconds since boot, which the report's own uptime turns into an age, so no clock
 * is compared across machines. A line without a stamp, or a report without the uptime or the kernel
 * section, can't be placed in the window and counts as no kill.
 */
export function killLinesWithin(report: string, withinSec: number): string[] {
  const kernel = report.search(new RegExp(`^${KERNEL_MARK}$`, "m"));
  const uptime = new RegExp(`^${UPTIME_MARK}\n(\\d+(?:\\.\\d+)?)$`, "m").exec(
    report,
  );
  if (kernel < 0 || !uptime) return [];
  const uptimeSec = Number(uptime[1]);
  return report
    .slice(kernel)
    .split("\n")
    .slice(1)
    .filter((line) => {
      const stamp = /^\[\s*(\d+(?:\.\d+)?)\]/.exec(line);
      return (
        stamp !== null &&
        uptimeSec - Number(stamp[1]) <= withinSec &&
        KERNEL_KILL_LINE.test(line)
      );
    });
}

const secondsAfter = (report: string, mark: string): number | undefined => {
  const found = new RegExp(`^${mark}\n\\s*(\\d+(?:\\.\\d+)?)$`, "m").exec(
    report,
  );
  return found ? Number(found[1]) : undefined;
};

/** The 5-minute load average on the report's `uptime` line; undefined when it isn't there. */
function parseLoad5(report: string): number | undefined {
  const found = /load averages?:\s*[\d.]+[,\s]+([\d.]+)/.exec(report);
  return found ? Number(found[1]) : undefined;
}

/** The most of a sprite's diagnostics kept: under `EVENT_TEXT_MAX`, with room for the event's own heading. */
export const DIAGNOSTICS_MAX = 3_400;

export type Diagnostics = {
  /** The report, redacted and bounded; says why when it couldn't be collected. */
  text: string;
  memory?: Memory;
  /** The kernel's kill lines since the run began: it killed a process for memory meanwhile. */
  killLines: string[];
  /** Seconds since the machine booted, and since its pid 1 started; undefined where the report lacks them. */
  bootAgeSec?: number;
  initAgeSec?: number;
  /** The 5-minute load average. */
  load5?: number;
};

/** How the sprite restarted, and how many seconds before the diagnostics were taken. */
export type Restart = { kind: "rebooted" | "processes"; ageSec: number };

// how far inside the runner's run a restart must fall; it also absorbs the latency between the report's
// ages being taken and the `now` they're read against
const RESTART_MARGIN_SEC = 30;

/**
 * Whether a sprite restarted under a running runner: the machine booted (`rebooted`), or booted
 * earlier but its pid 1 started (`processes`), at `now - ageSec`, more than `RESTART_MARGIN_SEC` after
 * `runnerStartedAt` (the run's `run.started`) and more than that before `probeStartedAt` (when the
 * probe's first exec on the sprite set out), all epoch ms. Not a restart: a boot before the runner was
 * up, such as the launch's wake of a cold sprite, or after the probe set out, which is the probe's own
 * wake of a sprite that slept under the run. A report without the ages counts as no restart.
 */
export function restartSince(
  { bootAgeSec, initAgeSec }: Diagnostics,
  span: { runnerStartedAt: number; probeStartedAt: number; now: number },
): Restart | undefined {
  const after = span.runnerStartedAt + RESTART_MARGIN_SEC * 1000;
  const before = span.probeStartedAt - RESTART_MARGIN_SEC * 1000;
  const within = (ageSec: number) => {
    const at = span.now - ageSec * 1000;
    return at > after && at < before;
  };
  if (bootAgeSec !== undefined && within(bootAgeSec)) {
    return { kind: "rebooted", ageSec: bootAgeSec };
  }
  if (initAgeSec !== undefined && within(initAgeSec)) {
    return { kind: "processes", ageSec: initAgeSec };
  }
  return undefined;
}

const bounded = (text: string) =>
  text.length <= DIAGNOSTICS_MAX
    ? text
    : `${text.slice(0, DIAGNOSTICS_MAX)}\n… (${text.length - DIAGNOSTICS_MAX} characters omitted)`;

/**
 * What a sprite looked like when a run's runner was found gone: memory and swap, the biggest processes
 * by RSS with their command lines, uptime, and the kernel's kill lines where `dmesg` is readable. Only
 * kill lines logged since `startedAt` (epoch ms, the run's creation) are `killLines`: the kernel's
 * buffer outlives runs, and a kill from before this one says nothing of its runner.
 * Never throws: a sprite that can't answer is reported in `text`, and the caller fails the run anyway.
 */
export async function collectDiagnostics(
  ops: SpriteOps,
  spriteName: string,
  runId: RunId,
  startedAt: number,
): Promise<Diagnostics> {
  const path = `/tmp/sky-diagnostics-${runId}.txt`;
  try {
    const out = await execInSprite(
      ops,
      spriteName,
      ["bash", "-c", DIAGNOSTICS_SCRIPT, "_", path],
      { op: "diagnostics" },
    );
    if (out.exitCode !== 0) {
      return {
        text: `diagnostics unavailable: exit ${out.exitCode}: ${out.stderr.trim()}`,
        killLines: [],
      };
    }
    // the report is taken by now, so this window reaches back at least to `startedAt`
    const withinSec = (Date.now() - startedAt) / 1000;
    let raw: string;
    try {
      raw = await spriteCall(ops, spriteName, { op: "read-diagnostics" }, () =>
        ops.client.sprite(spriteName).filesystem("/").readFile(path, "utf8"),
      );
    } finally {
      // best effort: a file left in /tmp holds nothing the sprite's own `ps` doesn't
      void execInSprite(ops, spriteName, ["rm", "-f", path], {
        op: "rm-diagnostics",
      }).catch(() => {});
    }
    // command lines can carry a secret
    const text = redact(raw, [...ops.secrets.values()]);
    return {
      text: bounded(text.trim()),
      memory: parseFree(text),
      killLines: killLinesWithin(text, withinSec),
      bootAgeSec: secondsAfter(text, UPTIME_MARK),
      initAgeSec: secondsAfter(text, INIT_MARK),
      load5: parseLoad5(text),
    };
  } catch (err) {
    return {
      text: `diagnostics unavailable: ${err instanceof Error ? err.message : String(err)}`,
      killLines: [],
    };
  }
}
