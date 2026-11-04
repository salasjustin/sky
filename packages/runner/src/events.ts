import { type RunId, RunnerEventPost } from "@sky/shared";
import { isTransient, RetryError, type RetryTiming, retry } from "./retry.js";

const TIMEOUT_MS = 10_000;
/** The timeout on the one attempt an event queued behind a stop gets: each holds up the ending event. */
const GIVEN_UP_TIMEOUT_MS = 2_000;
/**
 * How long an event that matters past its moment keeps trying: long enough to ride out an API
 * redeploy. An ending event that never lands leaves the run open until the API's sweep fails it,
 * and a lost `claude.PreToolUse` leaves a gated call missing from the timeline.
 */
const RIDE_OUT_MS = 120_000;
const RIDES_OUT = new Set(["run.finished", "run.failed", "claude.PreToolUse"]);
/** Other progress gives up fast; losing it costs one line on a timeline. */
const PROGRESS_ATTEMPTS = 3;

export type PostEvent = (
  event: RunnerEventPost,
  options?: {
    /** Epoch ms the retries stop at; `run.waiting` passes its wait's deadline. */
    deadline?: number;
    /** A stop: the post rejects with its reason at once. */
    signal?: AbortSignal;
    /** A stop that ends retrying, not sending: once aborted, the post gets one short attempt, then is dropped. */
    giveUp?: AbortSignal;
  },
) => Promise<void>;

/**
 * Posts an event, retrying a dropped connection, a timeout, a 5xx, 408 or 429; any other 4xx is
 * final. A `run.waiting` that doesn't land rejects, since the run can't wait on a request the API
 * never stored, and rejects with a `RunEndedError` when the API has already ended the run. Every
 * other event is dropped with one line on `warn`: losing it must not take down the run that
 * produced it.
 */
export function createPoster(
  options: RetryTiming & {
    apiBaseUrl: string;
    agentToken: string;
    warn: (message: string) => void;
  },
): PostEvent {
  const url = new URL("/internal/events", options.apiBaseUrl);
  const now = options.now ?? Date.now;
  return async (event, { deadline, signal, giveUp } = {}) => {
    const body = JSON.stringify(RunnerEventPost.parse(event));
    const waiting = event.type === "run.waiting";
    let landed: "stored" | "run_ended" | undefined;
    try {
      landed = await retry<"stored" | "run_ended">(
        async (attempt, cut) => {
          const res = await fetch(url, {
            method: "POST",
            headers: {
              authorization: `Bearer ${options.agentToken}`,
              "content-type": "application/json",
            },
            body,
            signal: cut,
          });
          // read every body so the keep-alive socket is released
          const text = await res.text();
          if (res.ok) return { done: "stored" };
          // an earlier attempt opened this request, and only its response was lost
          if (
            attempt > 1 &&
            waiting &&
            res.status === 409 &&
            errorCode(text) === "request_open"
          )
            return { done: "stored" };
          if (waiting && res.status === 401 && errorCode(text) === "run_ended")
            return { done: "run_ended" };
          const failure = `HTTP ${res.status}`;
          return isTransient(res.status)
            ? { retry: failure }
            : { fail: failure };
        },
        {
          sleep: options.sleep,
          random: options.random,
          now,
          deadline: deadline ?? now() + RIDE_OUT_MS,
          attemptTimeoutMs: giveUp?.aborted ? GIVEN_UP_TIMEOUT_MS : TIMEOUT_MS,
          ...(!waiting &&
            !RIDES_OUT.has(event.type) && { maxAttempts: PROGRESS_ATTEMPTS }),
          signal,
          giveUp,
        },
      );
    } catch (error) {
      if (!(error instanceof RetryError)) throw error;
      const failure = `after ${error.attempts} attempts: ${error.lastFailure ?? "no reply by the deadline"}`;
      if (event.type === "run.waiting")
        throw new Error(
          `run.waiting for request ${event.payload.request.requestId} not recorded ${failure}`,
        );
      options.warn(`runner: dropped ${event.type} ${failure}`);
    }
    if (landed === "run_ended") throw new RunEndedError();
  };
}

/**
 * A callback that posts its message as the run's `runner.warning` event, for problems the runner
 * survives but the API should know of. Never throws or rejects; a post that doesn't land is already
 * a line on the poster's `warn`.
 */
export const warningReporter =
  (post: PostEvent, runId: RunId) =>
  (message: string): void => {
    post({ runId, type: "runner.warning", payload: { message } }).catch(
      () => {},
    );
  };

/** A `run.waiting` the API refused because it already stopped or failed the run, and recorded how. */
export class RunEndedError extends Error {
  constructor() {
    super("the run has already ended");
  }
}

function errorCode(body: string): unknown {
  try {
    return (JSON.parse(body) as { error?: { code?: unknown } }).error?.code;
  } catch {
    return undefined;
  }
}
