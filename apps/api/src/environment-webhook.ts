import { apiKeys, type Db, environments, webhooks } from "@sky/db";
import {
  type EnvironmentWebhookSpec,
  WEBHOOK_SECRET_NAME,
  type WebhookId,
} from "@sky/shared";
import { and, eq, sql } from "drizzle-orm";
import { ownerKeyOf, type Principal } from "./auth.js";
import { open, seal, webhookSecretAad } from "./crypto.js";
import { mintId } from "./ids.js";
import type { Tx } from "./runs.js";
import { hasConnectorSecret, openEnvSecrets } from "./secrets.js";
import { isAllowedWebhookUrl } from "./webhook-url.js";
import { secretProblem } from "./webhooks.js";

type EnvRow = typeof environments.$inferSelect;
type WebhookRow = typeof webhooks.$inferSelect;

/** What applying the environment's webhook did; `none` is a request that asked for no webhook of an environment with none. */
export type WebhookChange =
  | "created"
  | "updated"
  | "unchanged"
  | "removed"
  | "none";

export type WebhookApplied =
  | { ok: true; change: WebhookChange }
  | {
      ok: false;
      code:
        | "webhook_secret_missing"
        | "webhook_secret_invalid"
        | "url_not_allowed"
        | "webhook_owned";
      message: string;
    };

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

/** The key's name and id, for a message that tells someone whose row it is. */
function ownerLabel(db: Db | Tx, row: WebhookRow): string {
  if (row.ownerKeyId === null) return "the admin key";
  const key = db
    .select({ name: apiKeys.name })
    .from(apiKeys)
    .where(eq(apiKeys.id, row.ownerKeyId))
    .get();
  return key
    ? `the key ${JSON.stringify(key.name)} (${row.ownerKeyId})`
    : `the key ${row.ownerKeyId}`;
}

/** The row to keep: the one the environment already points at, else one for this environment and url. */
function existingRow(
  tx: Tx,
  env: EnvRow,
  url?: string,
): WebhookRow | undefined {
  if (env.webhookId !== null) {
    const stored = tx
      .select()
      .from(webhooks)
      .where(eq(webhooks.id, env.webhookId))
      .get();
    if (stored) return stored;
  }
  if (url === undefined) return undefined;
  // a row made by hand with `sky webhook add --env`: this environment alone, at this url
  return tx
    .select()
    .from(webhooks)
    .where(
      and(
        eq(webhooks.url, url),
        sql`${webhooks.environmentIds} = json_array(${env.id})`,
      ),
    )
    .get();
}

/**
 * Makes `desired` the environment's one webhook, or deletes it when `desired` is null. The signing
 * secret is the environment's `SKY_WEBHOOK_SECRET`, copied in, so a rotation lands on the next apply.
 * Everything is checked before anything is written, so a refusal leaves the rows as they were.
 * A row for this environment and url that another key owns is taken over by an admin and refused
 * to anyone else, so two rows never deliver to one receiver.
 */
export function applyEnvWebhook(
  tx: Tx,
  encryptionKey: Buffer,
  principal: Principal,
  env: EnvRow,
  desired: EnvironmentWebhookSpec | null,
): WebhookApplied {
  const owner = ownerKeyOf(principal);
  const refuse = (row: WebhookRow): WebhookApplied | undefined =>
    principal.role === "admin" || row.ownerKeyId === owner
      ? undefined
      : {
          ok: false,
          code: "webhook_owned",
          message: `this environment's webhook belongs to ${ownerLabel(tx, row)}; ask the admin to apply it, or delete it with that key`,
        };

  if (desired === null) {
    const row = existingRow(tx, env);
    if (!row) return { ok: true, change: "none" };
    const refused = refuse(row);
    if (refused) return refused;
    // the deliveries cascade, and the environment's webhook_id is set null with the row
    tx.delete(webhooks).where(eq(webhooks.id, row.id)).run();
    return { ok: true, change: "removed" };
  }

  if (!isAllowedWebhookUrl(desired.url)) {
    return {
      ok: false,
      code: "url_not_allowed",
      message:
        "the webhook url must use the default port, carry no username or password, and name a public host, not an internal name or a private, reserved or otherwise non-public address",
    };
  }
  if (hasConnectorSecret(tx, env.id, WEBHOOK_SECRET_NAME)) {
    return {
      ok: false,
      code: "webhook_secret_invalid",
      message: `${WEBHOOK_SECRET_NAME} is a connector secret; the webhook is signed with a value, so set it with sky secret set ${env.name} ${WEBHOOK_SECRET_NAME}`,
    };
  }
  const secret = openEnvSecrets(tx, encryptionKey, env.id, [
    WEBHOOK_SECRET_NAME,
  ]).get(WEBHOOK_SECRET_NAME);
  if (secret === undefined) {
    return {
      ok: false,
      code: "webhook_secret_missing",
      message: `this environment has no ${WEBHOOK_SECRET_NAME} secret, which signs its webhook; set it with sky secret set ${env.name} ${WEBHOOK_SECRET_NAME}, then apply again`,
    };
  }
  const problem = secretProblem(desired.format, secret);
  if (problem) {
    return {
      ok: false,
      code: "webhook_secret_invalid",
      message: `${WEBHOOK_SECRET_NAME} doesn't suit a ${desired.format} webhook: ${problem}`,
    };
  }

  const events = [...new Set(desired.events)] as [
    (typeof desired.events)[number],
    ...(typeof desired.events)[number][],
  ];
  const row = existingRow(tx, env, desired.url);
  if (!row) {
    const id = mintId("whk");
    const sealed = seal(encryptionKey, secret, webhookSecretAad(id));
    tx.insert(webhooks)
      .values({
        id,
        url: desired.url,
        eventTypes: events,
        format: desired.format,
        environmentIds: [env.id],
        ownerKeyId: owner,
        secretCiphertext: sealed.ciphertext,
        secretNonce: sealed.nonce,
        secretKeyVersion: sealed.keyVersion,
      })
      .run();
    link(tx, env, id);
    return { ok: true, change: "created" };
  }

  const refused = refuse(row);
  if (refused) return refused;
  const sameSecret =
    row.secretCiphertext !== null &&
    row.secretNonce !== null &&
    row.secretKeyVersion !== null &&
    open(
      encryptionKey,
      {
        ciphertext: row.secretCiphertext,
        nonce: row.secretNonce,
        keyVersion: row.secretKeyVersion,
      },
      webhookSecretAad(row.id),
    ) === secret;
  const unchanged =
    env.webhookId === row.id &&
    row.url === desired.url &&
    row.format === desired.format &&
    sameSet(row.eventTypes, events) &&
    row.environmentIds !== null &&
    sameSet(row.environmentIds, [env.id]) &&
    row.ownerKeyId === owner &&
    sameSecret;
  if (unchanged) return { ok: true, change: "unchanged" };

  const sealed = sameSecret
    ? undefined
    : seal(encryptionKey, secret, webhookSecretAad(row.id));
  tx.update(webhooks)
    .set({
      url: desired.url,
      eventTypes: events,
      format: desired.format,
      environmentIds: [env.id],
      ownerKeyId: owner,
      ...(sealed && {
        secretCiphertext: sealed.ciphertext,
        secretNonce: sealed.nonce,
        secretKeyVersion: sealed.keyVersion,
      }),
    })
    .where(eq(webhooks.id, row.id))
    .run();
  link(tx, env, row.id);
  return { ok: true, change: "updated" };
}

function link(tx: Tx, env: EnvRow, id: WebhookId) {
  if (env.webhookId === id) return;
  tx.update(environments)
    .set({ webhookId: id })
    .where(eq(environments.id, env.id))
    .run();
}
