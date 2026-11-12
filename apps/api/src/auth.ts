import { createHash, timingSafeEqual } from "node:crypto";
import { agents, apiKeys, type Db } from "@sky/db";
import type { ApiKeyId, EnvironmentId } from "@sky/shared";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import type { Context } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { apiError } from "./errors.js";
import { type AppEnv, factory } from "./factory.js";

/** Who a `/v1` request acts as: the `SKY_API_KEY` admin, or an issued key limited to its environments and agents. */
export type Principal =
  | { role: "admin" }
  | { role: "runs"; keyId: ApiKeyId; environmentIds: EnvironmentId[] };

const LAST_USED_RESOLUTION_MS = 60_000;

const sha256 = (value: string) => createHash("sha256").update(value).digest();

/** The lowercase-hex sha-256 an issued key's secret is stored as. */
export const keyHashOf = (secret: string) => sha256(secret).toString("hex");

/** The principal `token` authenticates as, or undefined when it is unknown or revoked. */
function principalOf(
  db: Db,
  adminKey: string,
  token: string,
): Principal | undefined {
  const digest = sha256(token);
  if (timingSafeEqual(digest, sha256(adminKey))) return { role: "admin" };
  const row = db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, digest.toString("hex")))
    .get();
  if (!row || !timingSafeEqual(Buffer.from(row.keyHash, "hex"), digest)) {
    return undefined;
  }
  if (row.revokedAt !== null) return undefined;
  const now = new Date();
  const stale = new Date(now.getTime() - LAST_USED_RESOLUTION_MS).toISOString();
  db.update(apiKeys)
    .set({ lastUsedAt: now.toISOString() })
    .where(
      and(
        eq(apiKeys.id, row.id),
        or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, stale)),
      ),
    )
    .run();
  // only `runs` keys are issued, so a stored row of any other role is still held to its own agents
  return { role: "runs", keyId: row.id, environmentIds: row.environmentIds };
}

const unauthorized = (message: string) => (c: Context) =>
  apiError(c, 401, "unauthorized", message);

/** Authenticates `/v1` and `/mcp`, setting `c.var.principal`. */
export const apiKeyGuard = (db: Db, adminKey: string) =>
  // bearerAuth answers a malformed header with 400; every auth failure here is one 401
  bearerAuth<AppEnv>({
    verifyToken: (token, c) => {
      const principal = principalOf(db, adminKey, token);
      if (principal) c.set("principal", principal);
      return principal !== undefined;
    },
    noAuthenticationHeader: { message: unauthorized("missing bearer token") },
    invalidAuthenticationHeader: {
      message: unauthorized("malformed Authorization header"),
    },
    invalidToken: { message: unauthorized("invalid bearer token") },
  });

/** Refuses an issued key with 403 before the route reads anything. */
export const adminOnly = factory.createMiddleware(async (c, next) => {
  if (c.var.principal.role !== "admin") {
    return apiError(
      c,
      403,
      "forbidden",
      "only the admin key (SKY_API_KEY) can do this",
    );
  }
  await next();
});

/** The key a row created by `principal` records as its owner; null for admin. */
export const ownerKeyOf = (principal: Principal) =>
  principal.role === "admin" ? null : principal.keyId;

/** The condition limiting an `agents` query to what `principal` may see; undefined (no limit) for admin. */
export const ownAgents = (principal: Principal) =>
  principal.role === "admin"
    ? undefined
    : eq(agents.ownerKeyId, principal.keyId);

/** Whether `principal` may use environment `id`. */
export const canUseEnv = (principal: Principal, id: EnvironmentId) =>
  principal.role === "admin" || principal.environmentIds.includes(id);
