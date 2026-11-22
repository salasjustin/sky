import { zValidator } from "@hono/zod-validator";
import {
  type Db,
  environments,
  events,
  webhookDeliveries,
  webhooks,
} from "@sky/db";
import {
  DELIVERY_LIST_DEFAULT_LIMIT,
  DELIVERY_LIST_MAX_LIMIT,
  EnvironmentId,
  EventType,
  OpenBotWebhookSecret,
  StandardWebhookSecret,
  Webhook,
  WebhookFormat,
  WebhookId,
} from "@sky/shared";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  lt,
  max,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import { canUseEnv, ownerKeyOf, type Principal } from "./auth.js";
import { seal, webhookSecretAad } from "./crypto.js";
import { errorKind } from "./deliveries.js";
import { apiError } from "./errors.js";
import { factory } from "./factory.js";
import { mintId } from "./ids.js";
import { redact } from "./redact.js";
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

/** What a webhook's stored deliveries say about it; nothing before its first attempt. */
function health(
  db: Db,
  row: typeof webhooks.$inferSelect,
): Pick<Webhook, "lastAttempt" | "failedStreak" | "failing"> {
  const failing = row.failingSince === null ? {} : { failing: true as const };
  const last = db
    .select({
      at: webhookDeliveries.lastAttemptAt,
      status: webhookDeliveries.lastStatus,
      error: webhookDeliveries.lastError,
      attempt: webhookDeliveries.attempts,
    })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.webhookId, row.id),
        isNotNull(webhookDeliveries.lastAttemptAt),
      ),
    )
    .orderBy(desc(webhookDeliveries.lastAttemptAt), desc(webhookDeliveries.id))
    .limit(1)
    .get();
  if (!last?.at) return failing;
  const delivered = db
    .select({ at: max(webhookDeliveries.lastAttemptAt) })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.webhookId, row.id),
        eq(webhookDeliveries.status, "delivered"),
      ),
    )
    .get();
  // a delivery counts once it ended failed, or is retrying (pending with an attempt behind it)
  const streak = db
    .select({ n: count() })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.webhookId, row.id),
        inArray(webhookDeliveries.status, ["failed", "pending"]),
        gt(webhookDeliveries.lastAttemptAt, delivered?.at ?? ""),
      ),
    )
    .get();
  return {
    lastAttempt: {
      at: last.at,
      status: last.status,
      error: last.status === null ? errorKind(last.error) : null,
      attempt: last.attempt,
    },
    failedStreak: streak?.n ?? 0,
    ...failing,
  };
}

const present = (db: Db, row: typeof webhooks.$inferSelect) => ({
  ...({
    id: row.id,
    url: row.url,
    eventTypes: row.eventTypes,
    format: row.format,
    ...(row.environmentIds === null
      ? {}
      : { environmentIds: row.environmentIds }),
    ...health(db, row),
  } satisfies Webhook),
  createdAt: row.createdAt,
});

const DeliveriesQuery = z.object({
  limit: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.int().min(1).max(DELIVERY_LIST_MAX_LIMIT))
    .default(DELIVERY_LIST_DEFAULT_LIMIT),
  // the id of the last delivery of the previous page
  cursor: z
    .string()
    .regex(/^\d{1,15}$/)
    .transform(Number)
    .optional(),
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
      return c.json({ data: rows.map((row) => present(c.var.db, row)) }, 200);
    })
    .post("/", jsonBody, body(WebhookInput), (c) => {
      const input = c.req.valid("json");
      if (!isAllowedWebhookUrl(input.url)) {
        return apiError(
          c,
          400,
          "url_not_allowed",
          "url must use the default port, carry no username or password, and name a public host, not an internal name or a private, reserved or otherwise non-public address",
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
            "an openbot webhook needs a secret: the routine's signing secret, up to 256 characters",
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
      return c.json(present(c.var.db, row), 201);
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
      return c.json(present(c.var.db, row), 200);
    })
    .get(
      "/:id/deliveries",
      webhookParam,
      zValidator("query", DeliveriesQuery, (result, c) => {
        if (!result.success) {
          return apiError(
            c,
            400,
            "invalid_query",
            z.prettifyError(result.error),
          );
        }
      }),
      (c) => {
        const { id } = c.req.valid("param");
        const { limit, cursor } = c.req.valid("query");
        const owned = c.var.db
          .select({ id: webhooks.id })
          .from(webhooks)
          .where(and(eq(webhooks.id, id), ownWebhooks(c.var.principal)))
          .get();
        if (!owned) return apiError(c, 404, "not_found", notFound);
        // ids rise with creation, so newest first is id descending
        const rows = c.var.db
          .select({
            id: webhookDeliveries.id,
            eventType: events.type,
            runId: events.runId,
            status: webhookDeliveries.status,
            attempts: webhookDeliveries.attempts,
            lastStatus: webhookDeliveries.lastStatus,
            lastError: webhookDeliveries.lastError,
            createdAt: webhookDeliveries.createdAt,
            lastAttemptAt: webhookDeliveries.lastAttemptAt,
            nextAttemptAt: webhookDeliveries.nextAttemptAt,
          })
          .from(webhookDeliveries)
          .innerJoin(events, eq(events.id, webhookDeliveries.eventId))
          .where(
            and(
              eq(webhookDeliveries.webhookId, id),
              cursor === undefined
                ? undefined
                : lt(webhookDeliveries.id, cursor),
            ),
          )
          .orderBy(desc(webhookDeliveries.id))
          .limit(limit + 1)
          .all();
        const page = rows.slice(0, limit);
        const known = c.var.secrets.values();
        const last = page.at(-1);
        return c.json(
          {
            data: page.map(({ nextAttemptAt, lastError, ...row }) => ({
              ...row,
              lastError: lastError === null ? null : redact(lastError, known),
              lastErrorKind: errorKind(lastError),
              nextAttemptAt: row.status === "pending" ? nextAttemptAt : null,
            })),
            ...(rows.length > limit && last
              ? { nextCursor: String(last.id) }
              : {}),
          },
          200,
        );
      },
    )
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
