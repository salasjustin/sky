import { readdirSync, readFileSync } from "node:fs";

type Proc = { ppid: number; zombie: boolean; comm: string };

/** One process from its `stat`; undefined once it has exited. */
function readProc(procRoot: string, pid: number | string): Proc | undefined {
  try {
    const stat = readFileSync(`${procRoot}/${pid}/stat`, "utf8");
    // `pid (comm) state ppid …`; comm may hold spaces and parentheses, so cut at the last ')'
    const close = stat.lastIndexOf(")");
    const [state, ppid] = stat.slice(close + 2).split(" ");
    return {
      ppid: Number(ppid),
      zombie: state === "Z",
      comm: stat.slice(stat.indexOf("(") + 1, close),
    };
  } catch {
    return undefined;
  }
}

/** Every process in `procRoot` by pid; one that exits mid-scan is skipped. */
function processes(procRoot: string): Map<number, Proc> {
  const all = new Map<number, Proc>();
  for (const name of readdirSync(procRoot)) {
    if (!/^\d+$/.test(name)) continue;
    const proc = readProc(procRoot, name);
    if (proc) all.set(Number(name), proc);
  }
  return all;
}

/** Whether the process's environment holds exactly `entry`; false when it can't be read (another user's, or gone). */
function hasEnv(procRoot: string, pid: number, entry: string): boolean {
  try {
    return readFileSync(`${procRoot}/${pid}/environ`, "utf8")
      .split("\0")
      .includes(entry);
  } catch {
    return false;
  }
}

/**
 * The processes of the run's session still alive: its descendants, which the process tree finds, and
 * any process whose environment carries the run's `RUN_ID`, which the launcher gave the runner and the
 * runner's session passes on to everything it starts. The second reaches what daemonised and was
 * reparented to init (a dev server started with `nohup … &`), which no tree walk does, and it is what
 * keeps another run's processes out: theirs carry their own run's id. The runner and its ancestors
 * (the shell and exec session that started it) are never among them.
 */
function sessionProcesses(
  runId: string,
  self: number,
  procRoot: string,
): Map<number, Proc> {
  const all = processes(procRoot);
  const spared = new Set<number>([self]);
  for (
    let up = all.get(self)?.ppid;
    up !== undefined && up > 0 && !spared.has(up);
    up = all.get(up)?.ppid
  ) {
    spared.add(up);
  }
  const children = new Map<number, number[]>();
  for (const [pid, { ppid }] of all) {
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const entry = `RUN_ID=${runId}`;
  const mine = new Map<number, Proc>();
  // descendants whatever their environment (`env -i` clears the mark, not the parent), and the marked
  const queue = [self];
  for (const parent of queue) {
    for (const pid of children.get(parent) ?? []) {
      queue.push(pid);
      mine.set(pid, all.get(pid) as Proc);
    }
  }
  for (const [pid, proc] of all) {
    if (hasEnv(procRoot, pid, entry)) mine.set(pid, proc);
  }
  for (const [pid, proc] of mine) {
    if (spared.has(pid) || proc.zombie) mine.delete(pid);
  }
  return mine;
}

const isAlive = (procRoot: string, pid: number) => {
  const proc = readProc(procRoot, pid);
  return proc !== undefined && !proc.zombie;
};

const signal = (pids: Iterable<number>, sig: NodeJS.Signals) => {
  for (const pid of pids) {
    try {
      process.kill(pid, sig);
    } catch {
      // gone already, or not ours to signal
    }
  }
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type ReapOptions = {
  runId: string;
  /** The runner's own pid; `process.pid` when absent. */
  pid?: number;
  /** `/proc` unless a test points elsewhere. */
  procRoot?: string;
  /** How long a SIGTERMed process has to exit before SIGKILL; 3 s when absent. */
  graceMs?: number;
  warn: (line: string) => void;
};

/**
 * Ends the processes the run's session left behind: dev servers, watchers, test workers, a nested
 * `claude -p`. The Agent SDK ends only the `claude` process it spawned, so anything that process
 * started and that outlives it is reparented to init and keeps its memory until the sprite is reset.
 * SIGTERM first, then SIGKILL for what is still alive after `graceMs`, over up to three rounds, since
 * a dying process can start another. Another run's processes on the sprite are not touched (see
 * `sessionProcesses`). Never throws; a host with no `/proc` has nothing to scan, which warns once.
 * Returns how many processes it signalled.
 */
export async function endSessionProcesses({
  runId,
  pid = process.pid,
  procRoot = "/proc",
  graceMs = 3_000,
  warn,
}: ReapOptions): Promise<number> {
  const ended = new Map<number, Proc>();
  try {
    for (let round = 0; round < 3; round++) {
      const targets = sessionProcesses(runId, pid, procRoot);
      if (targets.size === 0) break;
      for (const [id, proc] of targets) ended.set(id, proc);
      signal(targets.keys(), "SIGTERM");
      const deadline = Date.now() + graceMs;
      while (
        Date.now() < deadline &&
        [...targets.keys()].some((id) => isAlive(procRoot, id))
      ) {
        await sleep(50);
      }
      signal(
        [...targets.keys()].filter((id) => isAlive(procRoot, id)),
        "SIGKILL",
      );
    }
  } catch (error) {
    warn(
      `runner: ending the session's processes failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (ended.size > 0) {
    warn(
      `runner: ended ${ended.size} process(es) the session left running: ${[
        ...ended,
      ]
        .map(([id, proc]) => `${proc.comm}[${id}]`)
        .join(" ")}`,
    );
  }
  return ended.size;
}
