import { claudeUsage, type Db } from "@sky/db";
import type { ClaudeUsage, ClaudeUsageWindow } from "@sky/shared";
import { eq } from "drizzle-orm";
import {
  boundedReset,
  epochDate,
  markLimited,
  tokenOf,
  UNKNOWN_RESET_MS,
} from "./claude-credentials.js";
import type { Config } from "./config.js";

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
/** The cheapest model: the probe asks for one token. */
export const PROBE_MODEL = "claude-haiku-5-5";
/** The system prompt a subscription token is accepted with. */
const CLAUDE_CODE_SYSTEM =
  "You are Claude Code, Anthropic's official CLI for Claude.";
const PROBE_TIMEOUT_MS = 10_000;

/** How old a subscription's usage may be before a launch asks again: a probe costs a request. */
export const USAGE_STALE_MS = 5 * 60_000;

const HEADER = "anthropic-ratelimit-unified";

/** A reset time as the headers give it: epoch seconds or milliseconds, or an ISO time. */
function resetOf(value: string | null, now: Date): string | null {
  if (!value) return null;
  const date = /^\d+(?:\.\d+)?$/.test(value)
    ? epochDate(value)
    : new Date(value);
  return Number.isNaN(date.getTime())
    ? null
    : boundedReset(date, now).toISOString();
}

function windowOf(
  headers: Headers,
  name: "5h" | "7d",
  now: Date,
): ClaudeUsageWindow | null {
  const raw = headers.get(`${HEADER}-${name}-utilization`);
  const utilization = raw === null || raw === "" ? Number.NaN : Number(raw);
  if (Number.isNaN(utilization)) return null;
  return {
    utilization,
    resetsAt: resetOf(headers.get(`${HEADER}-${name}-reset`), now),
  };
}

/** The 5-hour and 7-day usage in a response's `anthropic-ratelimit-unified-*` headers; null when it has neither. */
export function parseUsageHeaders(
  headers: Headers,
  now: Date = new Date(),
): ClaudeUsage | null {
  const fiveHour = windowOf(headers, "5h", now);
  const sevenDay = windowOf(headers, "7d", now);
  if (!fiveHour && !sevenDay) return null;
  return { fiveHour, sevenDay, probedAt: now.toISOString() };
}

/**
 * What a probe learned: the subscription's usage; that it is refused for its limit (429), with the
 * usage that answer carried if any; or that its token was refused (401, 403).
 */
export type ProbeAnswer =
  | { kind: "usage"; usage: ClaudeUsage }
  | { kind: "limited"; usage: ClaudeUsage | null }
  | { kind: "refused"; status: number };

/**
 * Asks Anthropic for one token with the subscription's token and reads the answer's status and its
 * usage headers. Throws when there is no answer, or an answer that is neither a refusal nor carries
 * usage; the message never holds the token.
 */
export async function probeUsage(token: string): Promise<ProbeAnswer> {
  const res = await fetch(MESSAGES_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: PROBE_MODEL,
      max_tokens: 1,
      system: [{ type: "text", text: CLAUDE_CODE_SYSTEM }],
      messages: [{ role: "user", content: "." }],
    }),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  }).catch((err: unknown) => {
    throw new Error(
      `no answer from the usage probe: ${err instanceof Error ? err.name : "error"}`,
    );
  });
  // read to the end, so the connection is released
  await res.text().catch(() => "");
  if (res.status === 401 || res.status === 403) {
    return { kind: "refused", status: res.status };
  }
  const usage = parseUsageHeaders(res.headers);
  if (res.status === 429) return { kind: "limited", usage };
  if (!usage) {
    throw new Error(
      `the usage probe's answer (${res.status}) carried no usage`,
    );
  }
  return { kind: "usage", usage };
}

type UsageRow = typeof claudeUsage.$inferSelect;

const present = (row: UsageRow): ClaudeUsage => ({
  fiveHour:
    row.fiveHourUtilization === null
      ? null
      : {
          utilization: row.fiveHourUtilization,
          resetsAt: row.fiveHourResetsAt,
        },
  sevenDay:
    row.sevenDayUtilization === null
      ? null
      : {
          utilization: row.sevenDayUtilization,
          resetsAt: row.sevenDayResetsAt,
        },
  probedAt: row.probedAt,
});

/** The subscription's last-seen usage, if it was ever probed. */
export function storedUsage(
  db: Db,
  credential: string,
): ClaudeUsage | undefined {
  const row = db
    .select()
    .from(claudeUsage)
    .where(eq(claudeUsage.credential, credential))
    .get();
  return row && present(row);
}

function saveUsage(db: Db, credential: string, usage: ClaudeUsage): void {
  const values = {
    fiveHourUtilization: usage.fiveHour?.utilization ?? null,
    fiveHourResetsAt: usage.fiveHour?.resetsAt ?? null,
    sevenDayUtilization: usage.sevenDay?.utilization ?? null,
    sevenDayResetsAt: usage.sevenDay?.resetsAt ?? null,
    probedAt: usage.probedAt,
  };
  db.insert(claudeUsage)
    .values({ credential, ...values })
    .onConflictDoUpdate({ target: claudeUsage.credential, set: values })
    .run();
}

/**
 * How much of the subscription is spent, the larger of its two windows; a window whose reset has
 * passed has started over. Undefined when it has never been probed.
 */
export function usageScore(
  usage: ClaudeUsage | undefined,
  now: Date,
): number | undefined {
  if (!usage) return undefined;
  const spent = (w: ClaudeUsageWindow | null) =>
    !w || (w.resetsAt !== null && new Date(w.resetsAt) <= now)
      ? 0
      : w.utilization;
  return Math.max(spent(usage.fiveHour), spent(usage.sevenDay));
}

export type UsageProbe = ReturnType<typeof createUsageProbe>;

/**
 * Keeps each subscription's last-seen usage fresh: `refresh` probes it when the stored reading is
 * older than `USAGE_STALE_MS`, at most one probe at a time per subscription, and stores the answer.
 * A subscription the probe finds full, or that is refused with a 429 whatever its usage, is marked
 * limited until the latest reset the answer gives, or for `UNKNOWN_RESET_MS` when it gives none. A
 * probe that fails, or whose token is refused (401, 403), is logged by name, leaves the stored
 * reading as it was, and is not tried again for `USAGE_STALE_MS`; meanwhile `failedRecently` is true
 * for that subscription, and `refusedRecently` too when its token was refused.
 */
export function createUsageProbe({
  db,
  config,
  log,
  probe = probeUsage,
}: {
  db: Db;
  config: Config;
  log: (line: string) => void;
  /** The probe itself; the real one asks Anthropic. */
  probe?: (token: string) => Promise<ProbeAnswer>;
}) {
  const inFlight = new Map<string, Promise<void>>();
  // when each subscription's last probe failed, and whether its token was refused; in memory, as a
  // failure is no reading to store and a refused token is no usage limit
  const failures = new Map<string, { at: number; refused: boolean }>();

  const recentFailure = (name: string, now: Date) => {
    const failure = failures.get(name);
    return failure && now.getTime() - failure.at < USAGE_STALE_MS
      ? failure
      : undefined;
  };

  /** The latest future reset of `windows`, or `UNKNOWN_RESET_MS` ahead when a window gives none. */
  const latestReset = (
    windows: (ClaudeUsageWindow | null)[],
    now: Date,
  ): Date | undefined =>
    windows
      .filter((w): w is ClaudeUsageWindow => w !== null)
      .map((w) =>
        w.resetsAt
          ? new Date(w.resetsAt)
          : new Date(now.getTime() + UNKNOWN_RESET_MS),
      )
      .filter((at) => at > now)
      .sort((a, b) => b.getTime() - a.getTime())[0];

  async function run(name: string, token: string): Promise<void> {
    try {
      const answer = await probe(token);
      const now = new Date();
      if (answer.kind === "refused") {
        failures.set(name, { at: now.getTime(), refused: true });
        log(
          `the token of Claude credential ${name} was refused (${answer.status}); it is left out of pool launches for a few minutes`,
        );
        return;
      }
      failures.delete(name);
      const { usage } = answer;
      if (usage) saveUsage(db, name, usage);
      const windows = usage ? [usage.fiveHour, usage.sevenDay] : [];
      // a 429 is a limit whatever the usage says; any other answer, when a window is full
      const limiting =
        answer.kind === "limited"
          ? windows
          : windows.filter((w) => w !== null && w.utilization >= 1);
      const until = latestReset(limiting, now);
      if (until) {
        markLimited(db, name, until);
      } else if (answer.kind === "limited") {
        markLimited(db, name, new Date(now.getTime() + UNKNOWN_RESET_MS));
      }
    } catch (err) {
      failures.set(name, { at: Date.now(), refused: false });
      log(
        `probing the usage of Claude credential ${name} failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  const failedRecently = (name: string, now: Date = new Date()) =>
    recentFailure(name, now) !== undefined;

  return {
    /** Whether the subscription's last probe failed within `USAGE_STALE_MS`: its stored reading, if any, is not current. */
    failedRecently,
    /** Whether the subscription's token was refused (401, 403) within `USAGE_STALE_MS`: a launch on it would fail. */
    refusedRecently: (name: string, now: Date = new Date()) =>
      recentFailure(name, now)?.refused === true,
    /** Resolves once the subscription's usage is fresh, or the probe has failed; never throws. */
    refresh(name: string, now: Date = new Date()): Promise<void> {
      const stored = storedUsage(db, name);
      if (
        (stored &&
          now.getTime() - Date.parse(stored.probedAt) < USAGE_STALE_MS) ||
        failedRecently(name, now)
      ) {
        return Promise.resolve();
      }
      const token = tokenOf(config, name);
      if (!token) return Promise.resolve();
      const held = inFlight.get(name);
      if (held) return held;
      const started = run(name, token).finally(() => inFlight.delete(name));
      inFlight.set(name, started);
      return started;
    },
  };
}
