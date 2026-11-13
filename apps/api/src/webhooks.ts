import { zValidator } from "@hono/zod-validator";
import { environments, webhooks } from "@sky/db";
import {
  EnvironmentId,
  EventType,
  OpenBotWebhookSecret,
  StandardWebhookSecret,
  Webhook,
  WebhookFormat,
  WebhookId,
} from "@sky/shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { canUseEnv, ownerKeyOf, type Principal } from "./auth.js";
import { seal, webhookSecretAad } from "./crypto.js";
import { apiError } from "./errors.js";
import { factory } from "./factory.js";
import { mintId } from "./ids.js";
import { body, jsonBody } from "./validation.js";
import { isAllowedWebhookUrl } from "./webhook-url.js";

// any https URL here, so an internal host is refused as url_not_allowed before the shared schema's domain-only rule
const WebhookInput = z.strictObject({
  url: z.url({ protocol: /^https$/ }),
  // the shared schema's nonempty() infers a plain array; the column wants the non-empty tuple
  eventTypes: z.tuple([EventType], EventType),
  format: WebhookFormat.default("sky"),
  secret: z.string().optional(),
  environmentIds: z.tuple([EnvironmentId], EnvironmentId).optional(),
});

const present = (row: typeof webhooks.$inferSelect) => ({
  ...({
    id: row.id,
    url: row.url,
    eventTypes: row.eventTypes,
    format: row.format,
    ...(row.environmentIds === null
      ? {}
      : { environmentIds: row.environmentIds }),
  } satisfies Webhook),
  createdAt: row.createdAt,
});

const notFound = "no such webhook";

/** Limits a `webhooks` query to the ones `principal` created; an admin sees every one. */
const ownWebhooks = (principal: Principal) =>
  principal.role === "admin"
    ? undefined
    : eq(webhooks.ownerKeyId, principal.keyId);

const webhookParam = zValidator(
  "param",
  z.object({ id: WebhookId }),
  (result, c) => {
    if (!result.success) return apiError(c, 404, "not_found", notFound);
  },
);

export function webhookRoutes() {
  return factory
    .createApp()
    .get("/", (c) => {
      const rows = c.var.db
        .select()
        .from(webhooks)
        .where(ownWebhooks(c.var.principal))
        // ties within a millisecond go by insert order (rowid); ids are random
        .orderBy(asc(webhooks.createdAt), asc(sql`rowid`))
        .all();
      return c.json({ data: rows.map(present) }, 200);
    })
    .post("/", jsonBody, body(WebhookInput), (c) => {
      const input = c.req.valid("json");
      if (!isAllowedWebhookUrl(input.url)) {
        return apiError(
          c,
          400,
          "url_not_allowed",
          "url must not name localhost or a loopback, private, link-local or unique-local address",
        );
      }
      if (!Webhook.shape.url.safeParse(input.url).success) {
        return apiError(
          c,
          400,
          "invalid_body",
          "url must be an https URL whose host is a domain name",
        );
      }
      const { secret, ...fields } = input;
      if (fields.format === "standard") {
        if (!StandardWebhookSecret.safeParse(secret).success) {
          return apiError(
            c,
            400,
            "invalid_body",
            "a standard webhook needs a secret: whsec_ followed by the base64 of a 24-64 byte key",
          );
        }
      } else if (fields.format === "openbot") {
        if (secret === undefined) {
          return apiError(
            c,
            400,
            "invalid_body",
            "an openbot webhook needs a secret",
          );
        }
        const parsed = OpenBotWebhookSecret.safeParse(secret);
        if (!parsed.success) {
          // the schema's own fixed messages, which never quote the input
          const message =
            parsed.error.issues[0]?.message ?? "invalid openbot secret";
          return apiError(c, 400, "invalid_body", message);
        }
      } else if (secret !== undefined) {
        return apiError(
          c,
          400,
          "invalid_body",
          'secret only goes with format "standard" or "openbot"',
        );
      }
      const environmentIds = fields.environmentIds && [
        ...new Set(fields.environmentIds),
      ];
      if (environmentIds) {
        const known = c.var.db
          .select({ id: environments.id })
          .from(environments)
          .where(inArray(environments.id, environmentIds))
          .all();
        const unknown = environmentIds.filter(
          (id) =>
            !known.some((e) => e.id === id) || !canUseEnv(c.var.principal, id),
        );
        if (unknown.length > 0) {
          return apiError(
            c,
            400,
            "invalid_body",
            `no such environment: ${unknown.join(", ")}`,
          );
        }
      }
      const id = mintId("whk");
      const sealed = secret
        ? seal(c.var.config.secretEncryptionKey, secret, webhookSecretAad(id))
        : undefined;
      const row = c.var.db
        .insert(webhooks)
        .values({
          ...fields,
          id,
          environmentIds: environmentIds as typeof fields.environmentIds,
          ownerKeyId: ownerKeyOf(c.var.principal),
          ...(sealed && {
            secretCiphertext: sealed.ciphertext,
            secretNonce: sealed.nonce,
            secretKeyVersion: sealed.keyVersion,
          }),
        })
        .returning()
        .get();
      c.header("Location", `/v1/webhooks/${row.id}`);
      return c.json(present(row), 201);
    })
    .get("/:id", webhookParam, (c) => {
      const row = c.var.db
        .select()
        .from(webhooks)
        .where(
          and(
            eq(webhooks.id, c.req.valid("param").id),
            ownWebhooks(c.var.principal),
          ),
        )
        .get();
      if (!row) return apiError(c, 404, "not_found", notFound);
      return c.json(present(row), 200);
    })
    .delete("/:id", webhookParam, (c) => {
      const deleted = c.var.db
        .delete(webhooks)
        .where(
          and(
            eq(webhooks.id, c.req.valid("param").id),
            ownWebhooks(c.var.principal),
          ),
        )
        .returning({ id: webhooks.id })
        .get();
      if (!deleted) return apiError(c, 404, "not_found", notFound);
      return c.body(null, 204);
    });
}
