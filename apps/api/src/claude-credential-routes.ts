import { environments, runs } from "@sky/db";
import { type ClaudeCredentialSummary, POOL_CREDENTIAL } from "@sky/shared";
import { asc, gte, sql } from "drizzle-orm";
import { adminOnly } from "./auth.js";
import {
  apiKeyCredentials,
  credentialNameOf,
  limitedUntil,
  subscriptionNames,
} from "./claude-credentials.js";
import { poolMembers } from "./claude-pool.js";
import { storedUsage } from "./claude-usage.js";
import { apiError } from "./errors.js";
import { factory } from "./factory.js";
import type { Launcher } from "./launch.js";

/**
 * `GET /v1/claude-credentials`: every credential this server holds, who uses it and whether it is
 * limited or out of credit; `POST /v1/claude-credentials/:name/clear-credit` clears an API key's
 * out-of-credit mark once it is topped up. Admin only.
 */
export function claudeCredentialRoutes(launcher: Launcher) {
  return factory
    .createApp()
    .post("/:name/clear-credit", adminOnly, (c) => {
      const cleared = launcher.clearCredit(c.req.param("name"));
      if (!cleared) {
        return apiError(
          c,
          404,
          "not_found",
          `this server holds no Anthropic API key named ${JSON.stringify(c.req.param("name"))}; it has: ${apiKeyCredentials(c.var.config).join(", ") || "none"}`,
        );
      }
      return c.json(
        {
          name: cleared.credential,
          outOfCredit: false,
          wasOutOfCredit: cleared.wasOut,
        },
        200,
      );
    })
    .get("/", adminOnly, (c) => {
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
          .select({
            credential: runs.claudeCredential,
            n: sql<number>`count(*)`,
          })
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
        outOfCredit: kind === "api-key" && launcher.outOfCredit(name),
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
        ...subscriptionNames(config).map((name) =>
          summary(name, "subscription"),
        ),
        ...apiKeyCredentials(config).map((name) => summary(name, "api-key")),
      ];
      return c.json({ data }, 200);
    });
}
