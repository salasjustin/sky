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

export const Webhook = z.object({
  id: WebhookId,
  /** https only: payloads carry tool input and output */
  url: z.url({ protocol: /^https$/, hostname: z.regexes.domain }),
  eventTypes: z.array(EventType).nonempty(),
  format: WebhookFormat,
  /** only events from agents in these environments are delivered; absent means all */
  environmentIds: z.array(EnvironmentId).nonempty().optional(),
});
export type Webhook = z.infer<typeof Webhook>;
