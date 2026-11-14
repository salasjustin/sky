import { claudeLimits, type Db } from "@sky/db";
import {
  API_KEY_CREDENTIAL,
  type ClaudeFallback,
  DEFAULT_CLAUDE_CREDENTIAL,
  POOL_CREDENTIAL,
} from "@sky/shared";
import { eq } from "drizzle-orm";
import type { Config } from "./config.js";

/** What a run's Claude session authenticates with; `credential` is the name recorded on the run. */
export type ClaudeAuth =
  | { kind: "subscription"; credential: string; token: string }
  | { kind: "api-key"; credential: typeof API_KEY_CREDENTIAL; key: string };

/** The env's assignment as it reaches a launch. */
export type ClaudeAssignment = {
  claudeCredential: string | null;
  claudeFallback: ClaudeFallback;
};

/** A launch refused for want of a usable credential; its message is the run's error. */
export class ClaudeCredentialError extends Error {}

/** `default` and unset are the same assignment. */
export const credentialNameOf = (assigned: string | null) =>
  assigned ?? DEFAULT_CLAUDE_CREDENTIAL;

/** The subscription names this server holds a token for, the default first. */
export const subscriptionNames = (config: Config) => [
  DEFAULT_CLAUDE_CREDENTIAL,
  ...Object.keys(config.claudeOauthTokens).sort(),
];

/** Why `assigned` can't be given to an environment on this server; undefined when it can. */
export function assignmentProblem(
  config: Config,
  assigned: string | null,
): string | undefined {
  if (
    assigned === null ||
    assigned === DEFAULT_CLAUDE_CREDENTIAL ||
    assigned === POOL_CREDENTIAL
  ) {
    return undefined;
  }
  if (assigned === API_KEY_CREDENTIAL) {
    return config.anthropicApiKey
      ? undefined
      : "this server has no SKY_ANTHROPIC_API_KEY";
  }
  return Object.hasOwn(config.claudeOauthTokens, assigned)
    ? undefined
    : `unknown Claude credential ${JSON.stringify(assigned)}; this server has: ${[...subscriptionNames(config), ...(config.anthropicApiKey ? [API_KEY_CREDENTIAL] : [])].join(", ")}`;
}

export const tokenOf = (config: Config, name: string): string | undefined =>
  name === DEFAULT_CLAUDE_CREDENTIAL
    ? config.claudeOauthToken
    : config.claudeOauthTokens[name];

/** When the subscription's limit lifts, if it is limited at `now`. */
export function limitedUntil(
  db: Db,
  credential: string,
  now: Date = new Date(),
): Date | undefined {
  const row = db
    .select({ until: claudeLimits.limitedUntil })
    .from(claudeLimits)
    .where(eq(claudeLimits.credential, credential))
    .get();
  if (!row) return undefined;
  const until = new Date(row.until);
  return until > now ? until : undefined;
}

/** The furthest a reset can be: no Claude window resets later than its weekly one. */
export const MAX_RESET_MS = 7 * 24 * 3_600_000;

/** `at`, held to at most `MAX_RESET_MS` after `now`: a reset read from runner output or headers is not trusted further. */
export const boundedReset = (at: Date, now: Date = new Date()): Date =>
  at.getTime() - now.getTime() > MAX_RESET_MS
    ? new Date(now.getTime() + MAX_RESET_MS)
    : at;

/** An all-digit time: up to 10 whole digits is epoch seconds, more is milliseconds. */
export function epochDate(digits: string): Date {
  const n = Number(digits);
  return new Date((digits.split(".")[0] ?? "").length <= 10 ? n * 1000 : n);
}

/** Marks the subscription limited until `until`, at most `MAX_RESET_MS` ahead, persisted so a restart keeps it. */
export function markLimited(db: Db, credential: string, until: Date): void {
  const limitedUntil = boundedReset(until).toISOString();
  db.insert(claudeLimits)
    .values({ credential, limitedUntil })
    .onConflictDoUpdate({
      target: claudeLimits.credential,
      set: { limitedUntil },
    })
    .run();
}

/**
 * The credential a launch in an environment with this assignment runs on. The assigned subscription,
 * unless it is at its usage limit: then the API key, when set and the env allows it. Never another
 * subscription. Throws a `ClaudeCredentialError` naming the reset time when no credential is usable.
 */
export function resolveClaudeAuth(
  db: Db,
  config: Config,
  env: ClaudeAssignment,
  now: Date = new Date(),
): ClaudeAuth {
  const name = credentialNameOf(env.claudeCredential);
  // a pool is resolved by `resolvePoolAuth`; reaching here with one would use a subscription by luck
  if (name === POOL_CREDENTIAL) {
    throw new Error("a pool assignment goes through resolvePoolAuth");
  }
  if (name === API_KEY_CREDENTIAL) return apiKeyAuth(config, "the environment");
  const token = tokenOf(config, name);
  if (!token) {
    throw new ClaudeCredentialError(
      `claude_credential_missing: this server has no token for the Claude credential ${JSON.stringify(name)} this environment is assigned`,
    );
  }
  const until = limitedUntil(db, name, now);
  if (!until) return { kind: "subscription", credential: name, token };
  const resets = `resets ${until.toISOString()} (UTC)`;
  if (env.claudeFallback === "none") {
    throw new ClaudeCredentialError(
      `claude_limited: the Claude credential ${JSON.stringify(name)} is at its usage limit and ${resets}; this environment's API key fallback is off, so launch again after the reset`,
    );
  }
  if (!config.anthropicApiKey) {
    throw new ClaudeCredentialError(
      `claude_limited: the Claude credential ${JSON.stringify(name)} is at its usage limit and ${resets}; this server has no SKY_ANTHROPIC_API_KEY to fall back on, so launch again after the reset`,
    );
  }
  return apiKeyAuth(config, "the fallback");
}

/** A subscription as a credential, by name; throws when this server holds no token for it. */
export function subscriptionAuth(config: Config, name: string): ClaudeAuth {
  const token = tokenOf(config, name);
  if (!token) {
    throw new ClaudeCredentialError(
      `claude_credential_missing: this server has no token for the Claude credential ${JSON.stringify(name)}`,
    );
  }
  return { kind: "subscription", credential: name, token };
}

/** The API key as a credential, for an env assigned it or a launch that fell back to it. */
export function apiKeyAuth(config: Config, role: string): ClaudeAuth {
  if (!config.anthropicApiKey) {
    throw new ClaudeCredentialError(
      `claude_credential_missing: ${role} is the Anthropic API key, but this server has no SKY_ANTHROPIC_API_KEY`,
    );
  }
  return {
    kind: "api-key",
    credential: API_KEY_CREDENTIAL,
    key: config.anthropicApiKey,
  };
}

/** A usage-limit failure of a Claude subscription, and when it lifts if the message said. */
export type UsageLimit = { window: "5-hour" | "weekly"; resetsAt: Date | null };

// Claude's wordings: "You've hit your 5-hour limit · resets 10:20am (UTC)", "You've hit your weekly
// limit · resets Nov 15, 10am (UTC)", "5-hour limit reached ∙ resets 3pm", and the older
// "Claude AI usage limit reached|1731432000"
const LIMIT_MESSAGE =
  /\bhit your\b[^.\n·∙|]*\blimit\b|\busage limit reached\b|\b(?:5-hour|weekly|session)\s+limit\s+reached\b/i;

const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

/** The wall-clock parts `date` shows in `timeZone`; throws a RangeError for a zone it doesn't know. */
function partsIn(date: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    })
      .formatToParts(date)
      .map((p) => [p.type, Number(p.value)]),
  ) as Record<"year" | "month" | "day" | "hour" | "minute" | "second", number>;
  return parts;
}

/** The instant the wall clock in `timeZone` shows `year-month-day hour:minute`. */
function zonedInstant(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let instant = wall;
  // twice: the zone's offset at the first guess may differ from its offset at the answer
  for (let i = 0; i < 2; i++) {
    const shown = partsIn(new Date(instant), timeZone);
    const offset =
      Date.UTC(
        shown.year,
        shown.month - 1,
        shown.day,
        shown.hour,
        shown.minute,
        shown.second,
      ) -
      Math.floor(instant / 60_000) * 60_000;
    instant = wall - offset;
  }
  return new Date(instant);
}

/** When the limit lifts, from the text after "resets"; null when it names no time this can read. */
function resetTime(text: string, now: Date): Date | null {
  const epoch = /\|(\d{9,13})\b/.exec(text)?.[1];
  if (epoch) return epochDate(epoch);
  const m =
    /\bresets?\s+(?:at\s+)?(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,|\s+at)?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([^)]+)\))?/i.exec(
      text,
    );
  if (!m) return null;
  const [, monthName, dayText, hourText, minuteText, meridiem, zone] = m;
  let hour = Number(hourText) % 12;
  if (meridiem?.toLowerCase() === "pm") hour += 12;
  const minute = Number(minuteText ?? 0);
  const timeZone = zone?.trim() || "UTC";
  try {
    const today = partsIn(now, timeZone);
    const at = (year: number, month: number, day: number) =>
      zonedInstant(timeZone, year, month, day, hour, minute);
    if (monthName) {
      const month = MONTHS.indexOf(monthName.toLowerCase()) + 1;
      if (month === 0) return null;
      const dated = at(today.year, month, Number(dayText));
      // a date already past in this year is next year's
      return dated.getTime() < now.getTime() - 86_400_000
        ? at(today.year + 1, month, Number(dayText))
        : dated;
    }
    const sameDay = at(today.year, today.month, today.day);
    return sameDay > now ? sameDay : at(today.year, today.month, today.day + 1);
  } catch {
    // an unknown zone name
    return null;
  }
}

/** The usage limit in a run's error, or null when the error is something else. */
export function parseUsageLimit(
  error: string,
  now: Date = new Date(),
): UsageLimit | null {
  const found = LIMIT_MESSAGE.exec(error);
  if (!found) return null;
  const window = /weekly|7-day/i.test(error) ? "weekly" : "5-hour";
  const resetsAt = resetTime(error, now);
  return {
    window,
    resetsAt: resetsAt && resetsAt > now ? boundedReset(resetsAt, now) : null,
  };
}

/**
 * Whether a run's error is Claude's login meeting a Cloudflare challenge in front of Anthropic's API:
 * a transient block on the path, neither a usage limit nor a bad credential.
 */
export const isCloudflareChallenge = (error: string): boolean =>
  /Failed to authenticate/i.test(error) &&
  /\b403\b/.test(error) &&
  /Attention Required! \| Cloudflare/i.test(error);

/** The error of a run whose retry met the Cloudflare challenge too. */
export const UPSTREAM_BLOCKED =
  "upstream_blocked: Anthropic's API answered with a Cloudflare challenge twice; retry later";

/** How long a limit whose reset the message didn't give is held: short, so a wrong guess costs one failed launch. */
export const UNKNOWN_RESET_MS = 15 * 60_000;
