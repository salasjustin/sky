import { type Db, runs } from "@sky/db";
import { POOL_CREDENTIAL } from "@sky/shared";
import { eq } from "drizzle-orm";
import {
  apiKeyAuth,
  type ClaudeAssignment,
  type ClaudeAuth,
  ClaudeCredentialError,
  limitedUntil,
  subscriptionAuth,
  subscriptionNames,
} from "./claude-credentials.js";
import { storedUsage, type UsageProbe, usageScore } from "./claude-usage.js";
import type { Config } from "./config.js";

/** An environment's pool assignment: the subscriptions it may use, in failover order; null is every one. */
export type PoolAssignment = ClaudeAssignment & { claudePool: string[] | null };

/** Why `pool` can't be set beside `credential` on this server; undefined when it can. */
export function poolProblem(
  config: Config,
  credential: string | null | undefined,
  pool: string[] | null | undefined,
): string | undefined {
  if (!pool) return undefined;
  if (credential !== POOL_CREDENTIAL) {
    return "claudePool lists the subscriptions of a pool; it goes with claudeCredential: pool";
  }
  const held = subscriptionNames(config);
  const unknown = pool.filter((name) => !held.includes(name));
  return unknown.length === 0
    ? undefined
    : `the pool names ${unknown.map((n) => JSON.stringify(n)).join(", ")}, which this server holds no subscription token for; it has: ${held.join(", ")}`;
}

/** The subscriptions a pool environment may use, in order; one the server no longer holds is skipped. */
export function poolMembers(config: Config, pool: string[] | null): string[] {
  const held = subscriptionNames(config);
  return pool === null ? held : pool.filter((name) => held.includes(name));
}

/** The credentials a run was tried on, itself and the runs it retries, oldest last. */
export function credentialsTried(db: Db, runId: string): Set<string> {
  const tried = new Set<string>();
  let next: string | null = runId;
  // a chain is at most a run per subscription and one on the key
  for (let i = 0; next !== null && i < 64; i++) {
    const row:
      | { credential: string | null; retryOf: string | null }
      | undefined = db
      .select({ credential: runs.claudeCredential, retryOf: runs.retryOf })
      .from(runs)
      .where(eq(runs.id, next as `run_${string}`))
      .get();
    if (!row) break;
    if (row.credential) tried.add(row.credential);
    next = row.retryOf;
  }
  return tried;
}

/** When the first of `names` to reset is available again; undefined when none is limited. */
export function earliestReset(
  db: Db,
  names: string[],
  now: Date,
): Date | undefined {
  const resets = names
    .map((name) => limitedUntil(db, name, now))
    .filter((d): d is Date => d !== undefined);
  return resets.sort((a, b) => a.getTime() - b.getTime())[0];
}

/**
 * Why a pool has nothing to run on: every subscription in it is at its usage limit, or `refused`
 * by Anthropic, and the earliest limit lifts at the time named. The API key, when set and allowed,
 * is the caller's.
 */
export function poolExhausted(
  db: Db,
  members: string[],
  now: Date,
  detail: string,
  refused: string[] = [],
): ClaudeCredentialError {
  const first = earliestReset(db, members, now);
  const refusedNote =
    refused.length === 0
      ? ""
      : ` or had its token refused (${refused.map((n) => JSON.stringify(n)).join(", ")})`;
  return new ClaudeCredentialError(
    `claude_limited: every subscription in this environment's pool is at its usage limit${refusedNote}${first ? `; the earliest resets ${first.toISOString()} (UTC)` : ""}; ${detail}`,
  );
}

/**
 * The credential a launch in a pool environment runs on: the subscription in its pool that isn't
 * limited and has the most headroom (the lowest of its 5-hour and 7-day use), from usage no older
 * than `USAGE_STALE_MS`; ties go to the earlier in the list, and a subscription never probed, or
 * whose last probe failed, ranks after those that answered. One whose token the probe found refused
 * is left out, like a limited one. With every subscription out, the API key when the environment
 * allows it and the server has one, else an error naming the earliest reset in UTC.
 */
export async function resolvePoolAuth(
  deps: { db: Db; config: Config; usage: UsageProbe },
  env: PoolAssignment,
): Promise<ClaudeAuth> {
  const { db, config, usage } = deps;
  const members = poolMembers(config, env.claudePool);
  if (members.length === 0) {
    throw new ClaudeCredentialError(
      "claude_credential_missing: none of the subscriptions in this environment's pool is held by this server",
    );
  }
  await Promise.all(
    members
      .filter((name) => limitedUntil(db, name) === undefined)
      .map((name) => usage.refresh(name)),
  );
  const now = new Date();
  const best = members
    .map((name, order) => {
      const reading = usage.failedRecently(name, now)
        ? undefined
        : storedUsage(db, name);
      return { name, order, score: usageScore(reading, now) ?? 2 };
    })
    .filter(
      ({ name }) =>
        limitedUntil(db, name, now) === undefined &&
        !usage.refusedRecently(name, now),
    )
    .sort((a, b) => a.score - b.score || a.order - b.order)[0];
  if (best) return subscriptionAuth(config, best.name);
  const refused = members.filter((name) => usage.refusedRecently(name, now));
  if (env.claudeFallback === "none") {
    throw poolExhausted(
      db,
      members,
      now,
      "this environment's API key fallback is off, so launch again after the reset",
      refused,
    );
  }
  if (!config.anthropicApiKey) {
    throw poolExhausted(
      db,
      members,
      now,
      "this server has no SKY_ANTHROPIC_API_KEY to fall back on, so launch again after the reset",
      refused,
    );
  }
  return apiKeyAuth(config, "the fallback");
}

/**
 * The subscription a pool run that hit its limit goes on to: the next in the pool's order that
 * isn't limited and that the run's chain hasn't tried, so no subscription is tried twice.
 */
export function nextInPool(
  deps: { db: Db; config: Config },
  env: PoolAssignment,
  tried: Set<string>,
  now: Date = new Date(),
): string | undefined {
  return poolMembers(deps.config, env.claudePool).find(
    (name) =>
      !tried.has(name) && limitedUntil(deps.db, name, now) === undefined,
  );
}
