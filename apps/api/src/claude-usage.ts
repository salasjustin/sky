import { claudeUsage, type Db } from "@sky/db";
import type { ClaudeUsage, ClaudeUsageWindow } from "@sky/shared";
import { eq } from "drizzle-orm";
import { markLimited, tokenOf } from "./claude-credentials.js";
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

/** A reset time as the headers give it: epoch seconds, or an ISO time. */
function resetOf(value: string | null): string | null {
  if (!value) return null;
  const date = /^\d+(?:\.\d+)?$/.test(value)
    ? new Date(Number(value) * 1000)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function windowOf(
  headers: Headers,
  name: "5h" | "7d",
): ClaudeUsageWindow | null {
  const raw = headers.get(`${HEADER}-${name}-utilization`);
  const utilization = raw === null || raw === "" ? Number.NaN : Number(raw);
  if (Number.isNaN(utilization)) return null;
  return {
    utilization,
    resetsAt: resetOf(headers.get(`${HEADER}-${name}-reset`)),
  };
}

/** The 5-hour and 7-day usage in a response's `anthropic-ratelimit-unified-*` headers; null when it has neither. */
export function parseUsageHeaders(
  headers: Headers,
  now: Date = new Date(),
): ClaudeUsage | null {
  const fiveHour = windowOf(headers, "5h");
  const sevenDay = windowOf(headers, "7d");
  if (!fiveHour && !sevenDay) return null;
  return { fiveHour, sevenDay, probedAt: now.toISOString() };
}

/**
 * Asks Anthropic for one token with the subscription's token and reads its usage from the response
 * headers, which a rejected (429) answer carries too. Throws when there is no answer or its headers
 * hold no usage; the message never holds the token.
 */
export async function probeUsage(token: string): Promise<ClaudeUsage> {
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
  const usage = parseUsageHeaders(res.headers);
  if (!usage) {
    throw new Error(
      `the usage probe's answer (${res.status}) carried no usage`,
    );
  }
  return usage;
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
 * A subscription the probe finds full is marked limited until its window resets. A probe that fails
 * is logged by name and leaves the stored reading as it was.
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
  probe?: (token: string) => Promise<ClaudeUsage>;
}) {
  const inFlight = new Map<string, Promise<void>>();

  async function run(name: string, token: string): Promise<void> {
    try {
      const usage = await probe(token);
      saveUsage(db, name, usage);
      const full = [usage.fiveHour, usage.sevenDay].filter(
        (w): w is ClaudeUsageWindow => w !== null && w.utilization >= 1,
      );
      const until = full
        .map((w) => (w.resetsAt ? new Date(w.resetsAt) : undefined))
        .filter((d): d is Date => d !== undefined && d > new Date())
        .sort((a, b) => b.getTime() - a.getTime())[0];
      if (until) markLimited(db, name, until);
    } catch (err) {
      log(
        `probing the usage of Claude credential ${name} failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  return {
    /** Resolves once the subscription's usage is fresh, or the probe has failed; never throws. */
    refresh(name: string, now: Date = new Date()): Promise<void> {
      const stored = storedUsage(db, name);
      if (
        stored &&
        now.getTime() - Date.parse(stored.probedAt) < USAGE_STALE_MS
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
