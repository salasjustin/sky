import { randomBytes } from "node:crypto";
import { zValidator } from "@hono/zod-validator";
import { apiKeys, environments, webhooks } from "@sky/db";
import { ApiKeyId, type ApiKeySecret, KeyInput } from "@sky/shared";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { adminOnly, keyHashOf } from "./auth.js";
import { apiError } from "./errors.js";
import { factory } from "./factory.js";
import { mintId } from "./ids.js";
import { body, jsonBody } from "./validation.js";

// the shared `ApiKey`, never the hash
const present = (row: typeof apiKeys.$inferSelect) => ({
  id: row.id,
  name: row.name,
  role: row.role,
  environmentIds: row.environmentIds,
  createdAt: row.createdAt,
  revokedAt: row.revokedAt,
  lastUsedAt: row.lastUsedAt,
});

const notFound = "no such key";

const keyParam = zValidator(
  "param",
  z.object({ id: ApiKeyId }),
  (result, c) => {
    if (!result.success) return apiError(c, 404, "not_found", notFound);
  },
);

/** `/v1/keys`: issuing, listing and revoking `runs` keys, for the admin key only. */
export function keyRoutes() {
  return factory
    .createApp()
    .post("/", adminOnly, jsonBody, body(KeyInput), (c) => {
      const input = c.req.valid("json");
      const environmentIds = [...new Set(input.environmentIds)];
      const known = c.var.db
        .select({ id: environments.id })
        .from(environments)
        .where(inArray(environments.id, environmentIds))
        .all();
      const unknown = environmentIds.filter(
        (id) => !known.some((e) => e.id === id),
      );
      if (unknown.length > 0) {
        return apiError(
          c,
          400,
          "invalid_body",
          `no such environment: ${unknown.join(", ")}`,
        );
      }
      const id = mintId("key");
      const secret: ApiKeySecret = `sky_${randomBytes(32).toString("base64url")}`;
      const row = c.var.db
        .insert(apiKeys)
        .values({
          id,
          name: input.name,
          role: input.role,
          environmentIds,
          keyHash: keyHashOf(secret),
        })
        .returning()
        .get();
      c.header("Location", `/v1/keys/${id}`);
      return c.json({ ...present(row), secret }, 201);
    })
    .get("/", adminOnly, (c) => {
      const rows = c.var.db
        .select()
        .from(apiKeys)
        // ties within a millisecond go by insert order (rowid); ids are random
        .orderBy(asc(apiKeys.createdAt), asc(sql`rowid`))
        .all();
      return c.json({ data: rows.map(present) }, 200);
    })
    .delete("/:id", adminOnly, keyParam, (c) => {
      const { id } = c.req.valid("param");
      const row = c.var.db.transaction(
        (tx) => {
          const found = tx
            .select()
            .from(apiKeys)
            .where(eq(apiKeys.id, id))
            .get();
          if (!found) return undefined;
          // the key's subscriptions end with it; their deliveries cascade
          tx.delete(webhooks).where(eq(webhooks.ownerKeyId, id)).run();
          if (found.revokedAt !== null) return found;
          return tx
            .update(apiKeys)
            .set({ revokedAt: new Date().toISOString() })
            .where(eq(apiKeys.id, id))
            .returning()
            .get();
        },
        { behavior: "immediate" },
      );
      if (!row) return apiError(c, 404, "not_found", notFound);
      return c.json(present(row), 200);
    });
}
