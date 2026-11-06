import { request } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { spriteTaskNameFor } from "@sky/shared";

/** The sprite's management socket; the Tasks API answers on it under virtual host `sprite`. */
const SPRITE_API_SOCKET = "/.sprite/api.sock";
// a missed refresh or a runner killed outright leaves the task to lapse on its own
const EXPIRE = "5m";
const REFRESH_MS = 60_000;
const REQUEST_TIMEOUT_MS = 5_000;

// the API holds the sprite under the same task name before the runner starts; the quick retries
// only matter when that hold didn't land and a sprite woken cold may not have its API up yet
// (the socket missing or refusing), leaving the sprite free to pause and freeze the run
const FIRST_HOLD_RETRY_MS = 1_000;
const FIRST_HOLD_ATTEMPTS = 30;

export type SpriteHold = {
  /** Settles once the first hold lands, its quick retries run out or the run stops: true when the sprite is held. */
  ready: Promise<boolean>;
  release: () => Promise<void>;
};

/**
 * Where the runner finds the sprite API: `SKY_SPRITE_API_SOCKET` when set and not empty (tests,
 * other hosts), else the sprite's own socket, where the runner is taken to be on a sprite.
 */
export const spriteApiFrom = (env: NodeJS.ProcessEnv) => {
  const socketPath = env.SKY_SPRITE_API_SOCKET || undefined;
  return { socketPath, onSprite: socketPath === undefined };
};

/**
 * Keeps the sprite from pausing while the runner lives: a sprite pauses once idle and drops
 * open connections even on a warm pause, so the run is held by a Tasks API task the API takes
 * before the runner starts; the runner refreshes it on an interval (a task lives an hour at most)
 * and deletes it on `release`. Never throws: a failed call is one line on `warn`. `report`, which
 * also never throws, sends the API what the runner's local log can't show once the sprite is
 * asleep: the first hold giving up on its quick retries and, once a hold has landed, the first
 * failure of each streak of failed refreshes.
 */
export function holdSprite(options: {
  runId: string;
  warn: (message: string) => void;
  report?: (message: string) => void;
  socketPath?: string;
  /**
   * True on a sprite: a missing socket is a failed PUT like any other, retried and reported.
   * False where the socket path was chosen (tests, other hosts): a missing socket means no sprite,
   * said once on `warn`, never retried or reported. Defaults to true when `socketPath` is unset.
   */
  onSprite?: boolean;
  refreshMs?: number;
  firstRetryMs?: number;
  firstAttempts?: number;
  /** The run's stop: abandons the first hold's retries and its in-flight PUT, settling `ready` unheld. */
  signal?: AbortSignal;
}): SpriteHold {
  const socketPath = options.socketPath ?? SPRITE_API_SOCKET;
  const onSprite = options.onSprite ?? options.socketPath === undefined;
  const path = `/v1/tasks/${spriteTaskNameFor(options.runId)}`;
  const { signal } = options;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  let socketFound: boolean | undefined;
  let held = false;
  // true while the last PUT failed, so a sprite API that stays down is reported once, not every minute
  let failing = false;
  const report = (message: string) => {
    try {
      options.report?.(message);
    } catch {}
  };
  const call = async (
    method: "PUT" | "DELETE",
    body?: string,
    abort?: AbortSignal,
  ) => {
    try {
      await send(socketPath, method, path, body, abort);
      if (method === "PUT") {
        held = true;
        failing = false;
      }
      return true;
    } catch (error) {
      // a stop, said once by the first hold, not a failed call
      if (abort?.aborted) return true;
      const code = (error as NodeJS.ErrnoException).code;
      // off a sprite only a missing socket means no sprite; a refused one is still tried again
      if (!onSprite && socketFound === undefined && code === "ENOENT") {
        options.warn(
          `runner: no sprite API found at ${socketPath}; the run is not held`,
        );
        return false;
      }
      const message = `runner: sprite task ${method} failed: ${error instanceof Error ? error.message : String(error)}`;
      options.warn(message);
      // before the first hold lands a failed PUT may be a cold sprite's API still starting, which
      // the quick retries exist for; only giving up on them is reported
      if (method === "PUT" && held && !failing) report(message);
      if (method === "PUT") failing = true;
      return true;
    }
  };

  const refresh = async () => {
    socketFound = await call("PUT", JSON.stringify({ expire: EXPIRE }));
    if (socketFound && !stopped)
      // unref: the hold never keeps a finished runner alive
      timer = setTimeout(() => {
        inFlight = refresh();
      }, options.refreshMs ?? REFRESH_MS).unref();
  };
  // the first hold, retried every `firstRetryMs` until a PUT lands; then the normal refresh takes over
  const first = async (): Promise<boolean> => {
    const attempts = options.firstAttempts ?? FIRST_HOLD_ATTEMPTS;
    for (let attempt = 1; !signal?.aborted; attempt++) {
      socketFound = await call(
        "PUT",
        JSON.stringify({ expire: EXPIRE }),
        signal,
      );
      if (!socketFound || held || stopped || attempt >= attempts) break;
      await sleep(options.firstRetryMs ?? FIRST_HOLD_RETRY_MS, undefined, {
        signal,
      }).catch(() => {});
    }
    if (signal?.aborted && !held)
      options.warn("runner: sprite hold abandoned: the run is stopping");
    else if (socketFound && !held) {
      const message =
        "runner: sprite not held after the first retries; it may pause the run";
      options.warn(message);
      report(message);
    }
    if (socketFound && !stopped)
      timer = setTimeout(() => {
        inFlight = refresh();
      }, options.refreshMs ?? REFRESH_MS).unref();
    return held;
  };
  const ready = first();
  let inFlight: Promise<void> = ready.then(() => {});

  return {
    ready,
    release: async () => {
      stopped = true;
      clearTimeout(timer);
      // a PUT landing after the DELETE would bring the task back
      await inFlight;
      if (socketFound) await call("DELETE");
    },
  };
}

function send(
  socketPath: string,
  method: string,
  path: string,
  body?: string,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        host: "sprite",
        path,
        method,
        headers: body ? { "content-type": "application/json" } : {},
        timeout: REQUEST_TIMEOUT_MS,
        signal,
      },
      (res) => {
        res.resume();
        res.on("end", () =>
          res.statusCode && res.statusCode < 300
            ? resolve()
            : reject(new Error(`HTTP ${res.statusCode}`)),
        );
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.end(body);
  });
}
