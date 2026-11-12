import { environments, runs } from "@sky/db";
import {
  API_KEY_CREDENTIAL,
  type ClaudeCredentialSummary,
  POOL_CREDENTIAL,
} from "@sky/shared";
import { asc, gte, sql } from "drizzle-orm";
import { adminOnly } from "./auth.js";
import {
  credentialNameOf,
  limitedUntil,
  subscriptionNames,
} from "./claude-credentials.js";
import { poolMembers } from "./claude-pool.js";
import { storedUsage } from "./claude-usage.js";
import { factory } from "./factory.js";

/** `GET /v1/claude-credentials`: every credential this server holds, who uses it and whether it is limited. Admin only. */
export function claudeCredentialRoutes() {
  return factory.createApp().get("/", adminOnly, (c) => {
    const { db, config } = c.var;
    const now = new Date();
    const midnight = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    ).toISOString();
    const assigned = db
      .select({
        id: environments.id,
        name: environments.name,
        credential: environments.claudeCredential,
        pool: environments.claudePool,
      })
      .from(environments)
      .orderBy(asc(environments.createdAt), asc(sql`rowid`))
      .all();
    const todays = new Map(
      db
        .select({ credential: runs.claudeCredential, n: sql<number>`count(*)` })
        .from(runs)
        .where(gte(runs.createdAt, midnight))
        .groupBy(runs.claudeCredential)
        .all()
        .map((r) => [r.credential, Number(r.n)]),
    );
    const summary = (
      name: string,
      kind: ClaudeCredentialSummary["kind"],
    ): ClaudeCredentialSummary => ({
      name,
      kind,
      environments: assigned
        .filter((e) => credentialNameOf(e.credential) === name)
        .map(({ id, name }) => ({ id, name })),
      limitedUntil:
        kind === "subscription"
          ? (limitedUntil(db, name, now)?.toISOString() ?? null)
          : null,
      runsToday: todays.get(name) ?? 0,
      usage: kind === "subscription" ? (storedUsage(db, name) ?? null) : null,
      poolEnvironments:
        kind === "subscription"
          ? assigned
              .filter(
                (e) =>
                  e.credential === POOL_CREDENTIAL &&
                  poolMembers(config, e.pool).includes(name),
              )
              .map(({ id, name }) => ({ id, name }))
          : [],
    });
    const data = [
      ...subscriptionNames(config).map((name) => summary(name, "subscription")),
      ...(config.anthropicApiKey
        ? [summary(API_KEY_CREDENTIAL, "api-key")]
        : []),
    ];
    return c.json({ data }, 200);
  });
}
