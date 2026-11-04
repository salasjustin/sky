import { HEARTBEAT_INTERVAL_MS } from "@sky/shared";

type InFlight = { toolName: string; startedAt: number };

/**
 * Tells the API a tool call is still running, so a long build or test run isn't mistaken for a dead
 * runner: while any call is in flight, `beat` runs every `intervalMs` for the one that has run the
 * longest, with how long that is. Nothing is sent while no call runs, nor for one held for approval,
 * which isn't `started` until it is let go.
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
  let timer: NodeJS.Timeout | undefined;

  const tick = () => {
    let oldest: [string, InFlight] | undefined;
    for (const entry of inFlight) {
      if (!oldest || entry[1].startedAt < oldest[1].startedAt) oldest = entry;
    }
    if (!oldest) return;
    const [toolUseId, { toolName, startedAt }] = oldest;
    try {
      options.beat({ toolName, toolUseId, elapsedMs: now() - startedAt });
    } catch {}
  };

  const stop = () => {
    inFlight.clear();
    clearInterval(timer);
    timer = undefined;
  };

  return {
    started(toolUseId: string, toolName: string): void {
      inFlight.set(toolUseId, { toolName, startedAt: now() });
      // unref: a heartbeat never keeps a finished runner alive
      timer ??= setInterval(
        tick,
        options.intervalMs ?? HEARTBEAT_INTERVAL_MS,
      ).unref();
    },
    ended(toolUseId: string): void {
      inFlight.delete(toolUseId);
      if (inFlight.size === 0) stop();
    },
    /** Ends the heartbeat with the session. */
    stop,
  };
}
