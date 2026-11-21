import { z } from "zod";
import { EventType } from "./event.js";
import { EnvironmentId, WebhookId } from "./ids.js";

/**
 * `sky` signs with `Sky-Signature`; `standard` follows https://www.standardwebhooks.com; `openbot`
 * signs the way OpenBot webhook routines verify.
 */
export const WebhookFormat = z.enum(["sky", "standard", "openbot"]);
export type WebhookFormat = z.infer<typeof WebhookFormat>;

/** A Standard Webhooks secret: `whsec_` and the base64 of a 24–64 byte key. */
export const StandardWebhookSecret = z.string().refine(
  (s) => {
    if (!s.startsWith("whsec_")) return false;
    const b64 = s.slice("whsec_".length);
    const key = Buffer.from(b64, "base64");
    // Buffer's decoder skips bad characters and accepts url-safe and unpadded
    // input; only canonical padded standard base64 re-encodes to itself
    return (
      key.toString("base64") === b64 && key.length >= 24 && key.length <= 64
    );
  },
  {
    message:
      "a standard secret is whsec_ followed by the base64 of a 24-64 byte key",
  },
);

/**
 * An OpenBot routine's signing secret: a non-empty string of at most 256 characters with no
 * leading or trailing whitespace, used as raw key bytes, never base64-decoded. Surrounding
 * whitespace is rejected rather than trimmed, so the stored key is always the one sent.
 */
export const OpenBotWebhookSecret = z
  .string()
  .min(1, { error: "an openbot secret is a non-empty string" })
  .max(256, { error: "an openbot secret is at most 256 characters" })
  .refine((s) => s === s.trim(), {
    error: "an openbot secret has no leading or trailing whitespace",
  });

/** Why an attempt got no HTTP response; `other` covers anything the API can't sort into the rest. */
export const DeliveryErrorKind = z.enum([
  "timeout",
  "connection_refused",
  "connection_reset",
  "dns",
  "tls",
  "other",
]);
export type DeliveryErrorKind = z.infer<typeof DeliveryErrorKind>;

/** The newest attempt on a webhook, whichever delivery it was for. */
export const WebhookLastAttempt = z.object({
  at: z.iso.datetime(),
  /** the HTTP status the receiver answered; null when it never did */
  status: z.int().nullable(),
  /** why there was no response; null when there was one */
  error: DeliveryErrorKind.nullable(),
  /** the attempt number within its delivery, from 1 */
  attempt: z.int().min(1),
});
export type WebhookLastAttempt = z.infer<typeof WebhookLastAttempt>;

export const Webhook = z.object({
  id: WebhookId,
  /** https only: payloads carry tool input and output */
  url: z.url({ protocol: /^https$/, hostname: z.regexes.domain }),
  eventTypes: z.array(EventType).nonempty(),
  format: WebhookFormat,
  /** only events from agents in these environments are delivered; absent means all */
  environmentIds: z.array(EnvironmentId).nonempty().optional(),
  /** the newest attempt; absent until the webhook has had one */
  lastAttempt: WebhookLastAttempt.optional(),
  /**
   * deliveries in a row, since the last delivered one, that ended failed or are retrying after a
   * failed attempt; absent until the webhook has had an attempt
   */
  failedStreak: z.int().min(0).optional(),
  /** true once a delivery gave up after its last attempt, until the next delivered one; absent otherwise */
  failing: z.literal(true).optional(),
});
export type Webhook = z.infer<typeof Webhook>;

export const DELIVERY_LIST_DEFAULT_LIMIT = 20;
export const DELIVERY_LIST_MAX_LIMIT = 100;

/** One delivery of an event to a webhook. Never carries the request body, headers or signature. */
export const WebhookDelivery = z.object({
  id: z.int(),
  eventType: EventType,
  runId: z.string(),
  status: z.enum(["pending", "delivered", "failed"]),
  attempts: z.int().min(0),
  lastStatus: z.int().nullable(),
  /** the failure text, redacted; null when the last attempt got a response */
  lastError: z.string().nullable(),
  lastErrorKind: DeliveryErrorKind.nullable(),
  createdAt: z.iso.datetime(),
  /** null until the first attempt */
  lastAttemptAt: z.iso.datetime().nullable(),
  /** when the next try is due; null once the delivery is delivered or failed */
  nextAttemptAt: z.iso.datetime().nullable(),
});
export type WebhookDelivery = z.infer<typeof WebhookDelivery>;
