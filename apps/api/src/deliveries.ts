import { createHmac } from "node:crypto";
import {
  agents,
  type Db,
  events,
  runs,
  webhookDeliveries,
  webhooks,
} from "@sky/db";
import type { AgentId, EnvironmentId, Event, EventType } from "@sky/shared";
import { and, asc, eq, lt, lte, ne } from "drizzle-orm";
import { open, type Sealed, webhookSecretAad } from "./crypto.js";
import { presentEvent } from "./run-events.js";
import type { Tx } from "./runs.js";

const TICK_MS = 5_000;
const BATCH = 20;
const TIMEOUT_MS = 30_000;
// 10 s doubling to the 1 h cap spans about a day over 30 attempts; a delivery held behind its
// webhook's 429 spends none, so a rate-limited receiver doesn't burn the queue behind it
const MAX_ATTEMPTS = 30;
const FIRST_RETRY_MS = 10_000;
const MAX_RETRY_MS = 3_600_000;
// the CHECK on webhook_deliveries.last_error
const MAX_ERROR_LENGTH = 1000;

/**
 * The `Sky-Signature` header for one delivery: `t=<unix seconds>,v1=<hex>`, where hex is
 * HMAC-SHA256 keyed with the UTF-8 bytes of `key` over `<t>.<raw body>`. A receiver recomputes it
 * over the exact bytes it received and rejects a `t` too far from its own clock.
 */
export function signatureHeader(key: string, body: string, t: number): string {
  const v1 = createHmac("sha256", key).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

/**
 * The `webhook-signature` header of a Standard Webhooks delivery: `v1,<base64>`, the base64 of
 * HMAC-SHA256 keyed with the secret's decoded bytes over `<webhook-id>.<webhook-timestamp>.<body>`.
 */
export function standardSignature(
  key: Buffer,
  id: string,
  t: number,
  body: string,
): string {
  const v1 = createHmac("sha256", key).update(`${id}.${t}.${body}`).digest();
  return `v1,${v1.toString("base64")}`;
}

/** The key bytes of a `whsec_<base64>` secret. */
export const secretBytes = (secret: string): Buffer =>
  Buffer.from(secret.slice("whsec_".length), "base64");

/** Backoff before the next try after `attempts` failures: 10s doubling to a 1h cap, ±20% by `random` in [0, 1). */
export function retryDelayMs(attempts: number, random: number): number {
  const base = Math.min(FIRST_RETRY_MS * 2 ** (attempts - 1), MAX_RETRY_MS);
  return base * (0.8 + 0.4 * random);
}

/**
 * The wait a 429's `Retry-After` asks for, as delta-seconds or an HTTP-date measured from `now`,
 * clamped to [5 s, 1 h]; null when absent or unparseable. The floor is the drain tick: a shorter
 * wait comes due again within the same drain, and a receiver answering 0 would spend every attempt
 * in a second.
 */
export function retryAfterMs(header: string | null, now: Date): number | null {
  if (header === null) return null;
  const value = header.trim();
  const ms = /^\d+$/.test(value)
    ? Number(value) * 1000
    : Date.parse(value) - now.getTime();
  if (Number.isNaN(ms)) return null;
  return Math.min(Math.max(ms, TICK_MS), MAX_RETRY_MS);
}

/** Enqueues one pending delivery per subscription to `type`, in the transaction that stored the event. */
export function enqueueDeliveries(
  tx: Tx,
  eventId: number,
  type: EventType,
  at: string,
): number {
  const subscribers = tx
    .select({
      id: webhooks.id,
      eventTypes: webhooks.eventTypes,
      environmentIds: webhooks.environmentIds,
      ownerKeyId: webhooks.ownerKeyId,
    })
    .from(webhooks)
    .all()
    .filter((w) => w.eventTypes.includes(type));
  if (subscribers.length === 0) return 0;
  const agent = tx
    .select({ envId: agents.envId, ownerKeyId: agents.ownerKeyId })
    .from(events)
    .innerJoin(runs, eq(runs.id, events.runId))
    .innerJoin(agents, eq(agents.id, runs.agentId))
    .where(eq(events.id, eventId))
    .get();
  // an issued key's webhook hears only its own agents; an admin's (null owner) hears every agent
  const matching = subscribers.filter(
    (w) =>
      (w.environmentIds === null ||
        (agent && w.environmentIds.includes(agent.envId))) &&
      (w.ownerKeyId === null || w.ownerKeyId === agent?.ownerKeyId),
  );
  if (matching.length === 0) return 0;
  tx.insert(webhookDeliveries)
    .values(
      matching.map((w) => ({
        webhookId: w.id,
        eventId,
        status: "pending" as const,
        nextAttemptAt: at,
      })),
    )
    .onConflictDoNothing({
      target: [webhookDeliveries.webhookId, webhookDeliveries.eventId],
    })
    .run();
  return matching.length;
}

const describeError = (err: unknown): string => {
  if (err instanceof Error && err.name === "TimeoutError") {
    return `timed out after ${TIMEOUT_MS / 1000}s`;
  }
  // fetch's own message is a bare "fetch failed"; the cause says why
  const cause = err instanceof Error ? err.cause : undefined;
  const text = cause instanceof Error ? `${err}: ${cause.message}` : `${err}`;
  return text.slice(0, MAX_ERROR_LENGTH);
};

export type Dispatcher = ReturnType<typeof createDispatcher>;

/**
 * Sends due webhook deliveries from the DB, one drain at a time: a 2xx delivers, anything else (a
 * redirect included, never followed) retries with backoff until the 30th attempt fails it. A 429
 * retries after its `Retry-After` when it parses (capped at 1 h), and holds every other pending
 * delivery of that webhook until then without spending their attempts. Each failed attempt logs
 * one line; the one that gives up is prefixed `warn:`.
 */
export function createDispatcher({
  db,
  signingKey,
  secretEncryptionKey,
  log,
  now = () => new Date(),
  random = Math.random,
}: {
  db: Db;
  signingKey: string;
  /** opens the sealed secrets of `standard` webhooks */
  secretEncryptionKey: Buffer;
  log: (line: string) => void;
  now?: () => Date;
  random?: () => number;
}) {
  const stopping = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let inflight: Promise<void> | null = null;
  let again = false;

  type Due = {
    id: number;
    webhookId: (typeof webhookDeliveries.$inferSelect)["webhookId"];
    attempts: number;
    url: string;
    format: "sky" | "standard";
    secret: Sealed | null;
    agentId: AgentId;
    environmentId: EnvironmentId;
    event: typeof events.$inferSelect;
  };

  /** The body and headers of one attempt; a `standard` delivery's timestamp and signature are per attempt, its id and body are not. */
  function buildRequest(
    row: Due,
    id: string,
    presented: Event,
    t: number,
  ): { body: string; headers: Record<string, string> } {
    if (row.format === "sky") {
      const body = JSON.stringify(presented);
      return {
        body,
        headers: {
          "Content-Type": "application/json",
          "Sky-Event-Id": id,
          "Sky-Event-Type": presented.type,
          "Sky-Signature": signatureHeader(signingKey, body, t),
        },
      };
    }
    const body = JSON.stringify({
      type: presented.type,
      timestamp: presented.ts,
      data: presented,
    });
    return {
      body,
      headers: {
        "Content-Type": "application/json",
        "webhook-id": id,
        "webhook-timestamp": String(t),
        "webhook-signature": standardSignature(
          secretBytes(openSecret(row)),
          id,
          t,
          body,
        ),
      },
    };
  }

  function openSecret(row: Due): string {
    if (!row.secret) throw new Error("webhook has no secret");
    try {
      return open(
        secretEncryptionKey,
        row.secret,
        webhookSecretAad(row.webhookId),
      );
    } catch {
      // the cause could echo key material; say only what failed
      throw new Error("cannot open the webhook's secret");
    }
  }

  async function attempt(row: Due): Promise<void> {
    const { event } = row;
    const id = `evt_${event.id}` as const;
    const presented = presentEvent(event, row);
    const t = Math.floor(now().getTime() / 1000);
    let status: number | null = null;
    let error: string | null = null;
    let retryAfter: number | null = null;
    try {
      const request = buildRequest(row, id, presented, t);
      const res = await fetch(row.url, {
        method: "POST",
        headers: request.headers,
        body: request.body,
        redirect: "manual",
        signal: AbortSignal.any([
          AbortSignal.timeout(TIMEOUT_MS),
          stopping.signal,
        ]),
      });
      status = res.status;
      if (status === 429) {
        retryAfter = retryAfterMs(res.headers.get("retry-after"), now());
      }
      await res.body?.cancel();
    } catch (err) {
      // cut off by shutdown: the attempt doesn't count, and the row resumes at the next boot
      if (stopping.signal.aborted) return;
      error = describeError(err);
    }
    const attempts = row.attempts + 1;
    const delivered = status !== null && status >= 200 && status < 300;
    const failed = !delivered && attempts >= MAX_ATTEMPTS;
    const nextAttemptAt =
      delivered || failed
        ? undefined
        : new Date(
            now().getTime() + (retryAfter ?? retryDelayMs(attempts, random())),
          ).toISOString();
    const holdUntil = status === 429 ? nextAttemptAt : undefined;
    db.transaction((tx) => {
      tx.update(webhookDeliveries)
        .set({
          status: delivered ? "delivered" : failed ? "failed" : "pending",
          attempts,
          lastStatus: status,
          lastError: error,
          ...(nextAttemptAt ? { nextAttemptAt } : {}),
        })
        .where(eq(webhookDeliveries.id, row.id))
        .run();
      if (!holdUntil) return;
      tx.update(webhookDeliveries)
        .set({ nextAttemptAt: holdUntil })
        .where(
          and(
            eq(webhookDeliveries.webhookId, row.webhookId),
            eq(webhookDeliveries.status, "pending"),
            ne(webhookDeliveries.id, row.id),
            lt(webhookDeliveries.nextAttemptAt, holdUntil),
          ),
        )
        .run();
    });
    if (delivered) return;
    const outcome = status === null ? error : `status ${status}`;
    const held = holdUntil ? `; webhook held until ${holdUntil}` : "";
    const line = `webhook ${row.webhookId} ${id}: attempt ${attempts}/${MAX_ATTEMPTS} failed: ${outcome}${held}`;
    log(failed ? `warn: ${line}; giving up` : line);
  }

  /** Sends one batch of due deliveries; true when the batch was full, so more may be due. */
  async function sendBatch(): Promise<boolean> {
    const due = db
      .select({
        id: webhookDeliveries.id,
        webhookId: webhookDeliveries.webhookId,
        attempts: webhookDeliveries.attempts,
        url: webhooks.url,
        format: webhooks.format,
        ciphertext: webhooks.secretCiphertext,
        nonce: webhooks.secretNonce,
        keyVersion: webhooks.secretKeyVersion,
        agentId: runs.agentId,
        environmentId: agents.envId,
        event: events,
      })
      .from(webhookDeliveries)
      .innerJoin(webhooks, eq(webhookDeliveries.webhookId, webhooks.id))
      .innerJoin(events, eq(webhookDeliveries.eventId, events.id))
      .innerJoin(runs, eq(events.runId, runs.id))
      .innerJoin(agents, eq(runs.agentId, agents.id))
      .where(
        and(
          eq(webhookDeliveries.status, "pending"),
          lte(webhookDeliveries.nextAttemptAt, now().toISOString()),
        ),
      )
      .orderBy(asc(webhookDeliveries.nextAttemptAt), asc(webhookDeliveries.id))
      .limit(BATCH)
      .all();
    await Promise.all(
      due.map(({ ciphertext, nonce, keyVersion, ...row }) =>
        attempt({
          ...row,
          secret:
            ciphertext && nonce && keyVersion !== null
              ? { ciphertext, nonce, keyVersion }
              : null,
        }),
      ),
    );
    return due.length === BATCH;
  }

  /** Sends every due delivery; a call during a drain joins it and makes it look again before resolving. */
  function drain(): Promise<void> {
    if (stopping.signal.aborted) return Promise.resolve();
    if (inflight) {
      again = true;
      return inflight;
    }
    inflight = (async () => {
      try {
        do {
          again = false;
          if (await sendBatch()) again = true;
        } while (again && !stopping.signal.aborted);
      } catch (err) {
        log(`delivering webhooks failed: ${err}`);
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  const nudge = () => {
    void drain();
  };

  return {
    drain,
    nudge,
    /** Drains now, then every 5 s. */
    start() {
      timer = setInterval(nudge, TICK_MS);
      timer.unref();
      nudge();
    },
    /** Stops ticking and aborts in-flight sends; resolves once the drain has written its last row. */
    stop(): Promise<void> {
      clearInterval(timer);
      stopping.abort();
      return inflight ?? Promise.resolve();
    },
  };
}
