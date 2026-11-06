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

/** The Mem row's total, used and available columns and the Swap row's total and used; undefined when `free` printed neither. */
export function parseFree(stdout: string): Memory | undefined {
  const mem = /^Mem:\s+(\d+)\s+(\d+)\s+\d+\s+\d+\s+\d+\s+(\d+)/m.exec(stdout);
  if (!mem) return undefined;
  const swap = /^Swap:\s+(\d+)\s+(\d+)/m.exec(stdout);
  return {
    totalMb: Number(mem[1]),
    usedMb: Number(mem[2]),
    availableMb: Number(mem[3]),
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
const KERNEL_MARK = "== kernel kills";

// into a file rather than back over the exec: its frames carry no length, and a few KB re-chunked by an
// intermediary is misread (see `execLogged`); each command's failure is part of the report, never the script's
const DIAGNOSTICS_SCRIPT = `{
echo "== free -m"; free -m
echo "== uptime"; uptime
echo "== top processes by RSS (pid ppid rss_kb elapsed command)"; ps -eo pid=,ppid=,rss=,etime=,args= --sort=-rss | head -n 12 | cut -c1-240
echo "${KERNEL_MARK}"; if k=$(dmesg 2>&1); then printf '%s\\n' "$k" | grep -iE '${KERNEL_KILL}' | tail -n 8 | cut -c1-240; else echo "dmesg not readable"; fi
} >"$1" 2>&1; exit 0`;

/** The most of a sprite's diagnostics kept: under `EVENT_TEXT_MAX`, with room for the event's own heading. */
export const DIAGNOSTICS_MAX = 3_400;

export type Diagnostics = {
  /** The report, redacted and bounded; says why when it couldn't be collected. */
  text: string;
  memory?: Memory;
  /** The kernel's kill lines: it killed a process for memory. */
  killLines: string[];
};

const bounded = (text: string) =>
  text.length <= DIAGNOSTICS_MAX
    ? text
    : `${text.slice(0, DIAGNOSTICS_MAX)}\n… (${text.length - DIAGNOSTICS_MAX} characters omitted)`;

/**
 * What a sprite looked like when a run's runner was found gone: memory and swap, the biggest processes
 * by RSS with their command lines, uptime, and the kernel's kill lines where `dmesg` is readable.
 * Never throws: a sprite that can't answer is reported in `text`, and the caller fails the run anyway.
 */
export async function collectDiagnostics(
  ops: SpriteOps,
  spriteName: string,
  runId: RunId,
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
    const raw = await spriteCall(
      ops,
      spriteName,
      { op: "read-diagnostics" },
      () =>
        ops.client.sprite(spriteName).filesystem("/").readFile(path, "utf8"),
    );
    // best effort: a file left in /tmp holds nothing the sprite's own `ps` doesn't
    void execInSprite(ops, spriteName, ["rm", "-f", path], {
      op: "rm-diagnostics",
    }).catch(() => {});
    // command lines can carry a secret
    const text = redact(raw, [...ops.secrets.values()]);
    const kernel = text.slice(Math.max(0, text.indexOf(KERNEL_MARK)));
    return {
      text: bounded(text.trim()),
      memory: parseFree(text),
      killLines: kernel
        .split("\n")
        .slice(1)
        .filter((line) => new RegExp(KERNEL_KILL, "i").test(line)),
    };
  } catch (err) {
    return {
      text: `diagnostics unavailable: ${err instanceof Error ? err.message : String(err)}`,
      killLines: [],
    };
  }
}

/**
 * Whether the diagnostics show the sprite killed a process for memory, or had less than `floorMb`
 * available: a runner found gone then was most likely killed, not lost. Memory is read after the kill
 * freed what it did, so the kernel's own lines are the stronger sign.
 */
export const showsMemoryKill = (d: Diagnostics, floorMb: number): boolean =>
  d.killLines.length > 0 ||
  (d.memory !== undefined && d.memory.availableMb < floorMb);
