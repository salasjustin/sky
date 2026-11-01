import { createHash } from "node:crypto";
import { request } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

/** The sprite's management socket; the Tasks API answers on it under virtual host `sprite`. */
const SPRITE_API_SOCKET = "/.sprite/api.sock";
// a missed refresh or a runner killed outright leaves the task to lapse on its own
const EXPIRE = "5m";
const REFRESH_MS = 60_000;
const REQUEST_TIMEOUT_MS = 5_000;

// a sprite woken cold can answer on its socket a few seconds after the runner starts; until the
// first hold lands the sprite may pause and freeze the run, so the first PUT retries quickly
const FIRST_HOLD_RETRY_MS = 1_000;
const FIRST_HOLD_ATTEMPTS = 30;

export type SpriteHold = {
  /** Settles once the first hold lands, its quick retries run out or the run stops: true when the sprite is held. */
  ready: Promise<boolean>;
  release: () => Promise<void>;
};

/**
 * The run's task name, hashed into the lowercase letters, digits and hyphens the Sprites API takes
 * for a sprite's name: a run id's capitals and underscore fall outside them.
 */
const taskNameFor = (runId: string) =>
  `sky-run-${createHash("sha256").update(runId).digest("hex").slice(0, 24)}`;

/**
 * Keeps the sprite from pausing while the runner lives: a sprite pauses once idle and drops
 * open connections even on a warm pause, so the runner holds a Tasks API task, refreshed on an
 * interval (a task lives an hour at most), and deletes it on `release`. Never throws: with no
 * socket (tests, local runs) it says so once on `warn`; a failed call is one line on `warn`.
 */
export function holdSprite(options: {
  runId: string;
  warn: (message: string) => void;
  socketPath?: string;
  refreshMs?: number;
  firstRetryMs?: number;
  firstAttempts?: number;
  /** The run's stop: abandons the first hold's retries and its in-flight PUT, settling `ready` unheld. */
  signal?: AbortSignal;
}): SpriteHold {
  const socketPath = options.socketPath ?? SPRITE_API_SOCKET;
  const path = `/v1/tasks/${taskNameFor(options.runId)}`;
  const { signal } = options;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  let socketFound: boolean | undefined;
  let held = false;
  const call = async (
    method: "PUT" | "DELETE",
    body?: string,
    abort?: AbortSignal,
  ) => {
    try {
      await send(socketPath, method, path, body, abort);
      if (method === "PUT") held = true;
      return true;
    } catch (error) {
      // a stop, said once by the first hold, not a failed call
      if (abort?.aborted) return true;
      const code = (error as NodeJS.ErrnoException).code;
      // only a missing socket means no sprite; a refused one may be an API not up yet, so keep trying
      if (socketFound === undefined && code === "ENOENT") {
        options.warn(
          `runner: no sprite API at ${socketPath}; the sprite may pause while the run is idle`,
        );
        return false;
      }
      options.warn(
        `runner: sprite task ${method} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
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
    else if (socketFound && !held)
      options.warn(
        "runner: sprite not held after the first retries; it may pause the run",
      );
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
