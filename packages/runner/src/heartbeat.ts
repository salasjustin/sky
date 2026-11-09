import { HEARTBEAT_INTERVAL_MS } from "@sky/shared";

type InFlight = { toolName: string; startedAt: number };

/** A background task the session started and is waiting on, as the SDK's `background_tasks_changed` reports it. */
export type BackgroundTask = { taskId: string; taskType: string };

const BACKGROUND_NAMES: Record<string, string> = {
  local_bash: "Bash",
  local_agent: "Agent",
};
const backgroundName = (taskType: string) =>
  `${BACKGROUND_NAMES[taskType] ?? taskType} (background)`;

/**
 * Tells the API a tool call is still running, so a long build or test run isn't probed as a silent
 * run, and a timeout names the tool. Heartbeats are not progress: the API still fails the run at
 * RUN_TIMEOUT_MINUTES. While any call is in flight, `beat` runs every `intervalMs` for the one that
 * has run the longest, with how long that is. With none in flight but a background task live, it
 * beats for the longest-running task as "<tool> (background)": the session is waiting on it, and a
 * timeout names it. Nothing is sent while neither runs, nor for a call held for approval, which isn't
 * `started` until it is let go.
 */
export function createHeartbeat(options: {
  beat: (beat: {
    toolName: string;
    toolUseId: string;
    elapsedMs: number;
  }) => void;
  intervalMs?: number;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const inFlight = new Map<string, InFlight>();
  const background = new Map<string, InFlight>();
  let timer: NodeJS.Timeout | undefined;

  const longest = (calls: Map<string, InFlight>) => {
    let oldest: [string, InFlight] | undefined;
    for (const entry of calls) {
      if (!oldest || entry[1].startedAt < oldest[1].startedAt) oldest = entry;
    }
    return oldest;
  };

  const tick = () => {
    const oldest = longest(inFlight) ?? longest(background);
    if (!oldest) return;
    const [toolUseId, { toolName, startedAt }] = oldest;
    try {
      options.beat({ toolName, toolUseId, elapsedMs: now() - startedAt });
    } catch {}
  };

  const idle = () => {
    if (inFlight.size > 0 || background.size > 0) return;
    clearInterval(timer);
    timer = undefined;
  };

  const arm = () => {
    // unref: a heartbeat never keeps a finished runner alive
    timer ??= setInterval(
      tick,
      options.intervalMs ?? HEARTBEAT_INTERVAL_MS,
    ).unref();
  };

  const stop = () => {
    inFlight.clear();
    background.clear();
    idle();
  };

  return {
    started(toolUseId: string, toolName: string): void {
      inFlight.set(toolUseId, { toolName, startedAt: now() });
      arm();
    },
    ended(toolUseId: string): void {
      inFlight.delete(toolUseId);
      idle();
    },
    /**
     * The session began a new assistant turn, so every call from an earlier one has ended, whether
     * or not its end hook fired. Calls the turn starts afterwards are tracked as usual.
     */
    newTurn(): void {
      inFlight.clear();
      idle();
    },
    /** The background tasks live now; the SDK reports the whole set each time, so this replaces it. */
    setBackground(tasks: BackgroundTask[]): void {
      const live = new Set(tasks.map((task) => task.taskId));
      for (const id of background.keys())
        if (!live.has(id)) background.delete(id);
      for (const { taskId, taskType } of tasks) {
        if (!background.has(taskId))
          background.set(taskId, {
            toolName: backgroundName(taskType),
            startedAt: now(),
          });
      }
      if (background.size > 0) arm();
      else idle();
    },
    /** Ends the heartbeat with the session. */
    stop,
  };
}
