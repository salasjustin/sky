import {
  DRAIN_DEFAULT_TIMEOUT_S,
  DRAIN_MAX_TIMEOUT_S,
  type DrainStatus,
} from "@sky/shared";
import { type Api, ApiError } from "./api.js";
import type { Io } from "./cli.js";
import { type Output, UsageError } from "./output.js";

/**
 * Exit status of `drain --wait` when the drain ended before the wait saw its runs finish: at its
 * deadline, or earlier by a --cancel or an API restart. 1 is a drain that couldn't be started, or a
 * status check refused with an error that isn't a server error; a rejected key is 2.
 */
export const DRAIN_TIMED_OUT = 4;

const pollIntervalMs = 5_000;
/** The last poll lands this long before the API's deadline: at it, the drain has ended and its held launches are starting. */
const lastPollMarginMs = 1_000;

export type DrainValues = {
  timeout?: string;
  wait: boolean;
  status: boolean;
  cancel: boolean;
};

const statusLine = (d: DrainStatus) =>
  `${d.draining ? "draining" : "idle"} deadline=${d.deadline ?? "-"} active=${d.active.length} held=${d.held} ready=${d.ready ? "yes" : "no"}${d.active.length > 0 ? `\nactive ${d.active.join(" ")}` : ""}`;

const parseTimeout = (raw: string | undefined) => {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || n < 1 || n > DRAIN_MAX_TIMEOUT_S) {
    throw new UsageError(
      `--timeout takes a whole number of seconds from 1 to ${DRAIN_MAX_TIMEOUT_S}, not '${raw}'`,
      true,
    );
  }
  return n;
};

/** Checks `sky admin drain`'s arguments and returns what it does. */
export function prepareAdmin(
  positionals: string[],
  values: DrainValues,
): (api: Api, io: Io, out: Output) => Promise<number> {
  const [sub, action, ...rest] = positionals;
  if (sub !== "drain" || action !== undefined || rest.length > 0) {
    throw new UsageError(
      sub === undefined
        ? "admin needs a subcommand: drain"
        : sub === "drain"
          ? "admin drain takes no arguments"
          : `unknown admin subcommand '${sub}'`,
      true,
    );
  }
  const modes = [values.wait, values.status, values.cancel].filter(Boolean);
  if (modes.length > 1) {
    throw new UsageError(
      "--wait, --status and --cancel can't be combined",
      true,
    );
  }
  const timeoutS = parseTimeout(values.timeout);
  if (timeoutS !== undefined && (values.status || values.cancel)) {
    throw new UsageError("--timeout only goes with starting a drain", true);
  }
  if (values.status) {
    return async (api, _io, out) => {
      const d = await api.getDrain();
      out.result(d, statusLine(d));
      return 0;
    };
  }
  if (values.cancel) {
    return async (api, _io, out) => {
      const d = await api.cancelDrain();
      out.result(d, statusLine(d));
      return 0;
    };
  }
  return async (api, io, out) => {
    const started = await api.startDrain(timeoutS);
    if (!values.wait) {
      out.result(started, statusLine(started));
      return 0;
    }
    return await waitUntilReady(
      api,
      started,
      timeoutS ?? DRAIN_DEFAULT_TIMEOUT_S,
      io,
      out,
    );
  };
}

const isTransient = (err: ApiError) => err.status === 0 || err.status >= 500;

const stillActive = (d: DrainStatus) =>
  `${d.active.length} run${d.active.length === 1 ? "" : "s"} still active`;

/**
 * Polls until nothing is starting or running while the drain is still on: 0, with the final status.
 * Polling stops just before the deadline `first` gives, the API's own; then it prints the runs still
 * active and exits `DRAIN_TIMED_OUT`, as it does at once for a status showing the drain already
 * ended. A check that fails with an unreachable API or a 5xx is retried until that deadline; the exit
 * then follows the last status it did give, so such a failure at the deadline is still exit
 * `DRAIN_TIMED_OUT`, never 1. Any other error throws.
 */
async function waitUntilReady(
  api: Api,
  first: DrainStatus,
  timeoutS: number,
  io: Io,
  out: Output,
): Promise<number> {
  const deadline =
    first.deadline === null
      ? io.now()
      : Date.parse(first.deadline) - lastPollMarginMs;
  let latest = first;
  let lastError: ApiError | undefined;
  let announced = -1;
  for (;;) {
    if (lastError === undefined) {
      if (!latest.draining) {
        io.stderr(
          `sky: the drain ended before the runs finished${latest.active.length > 0 ? `; ${stillActive(latest)}: ${latest.active.join(" ")}` : ""}\n`,
        );
        out.result(latest, statusLine(latest));
        return DRAIN_TIMED_OUT;
      }
      if (latest.ready) {
        out.result(latest, statusLine(latest));
        return 0;
      }
      if (latest.active.length !== announced) {
        announced = latest.active.length;
        out.progress(
          `waiting for ${announced} active run${announced === 1 ? "" : "s"}: ${latest.active.join(" ")}`,
        );
      }
    }
    const remaining = deadline - io.now();
    if (remaining <= 0) break;
    await io.sleep(Math.min(pollIntervalMs, remaining));
    try {
      latest = await api.getDrain();
      lastError = undefined;
    } catch (err) {
      if (!(err instanceof ApiError && isTransient(err))) throw err;
      lastError = err;
    }
  }
  // by the last good status, even when the final check failed: a caller such as the deploy workflow
  // must not take a lost API for a drained one while the runs it last showed may still be active
  io.stderr(
    `sky: ${stillActive(latest)} after ${timeoutS}s: ${latest.active.join(" ")}\n`,
  );
  out.result(latest, statusLine(latest));
  return DRAIN_TIMED_OUT;
}
