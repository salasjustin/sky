// Relays Doop comment webhooks to an OpenBot webhook listener, translating the signature.
// Secrets: DOOP_WEBHOOK_SECRET, OPENBOT_WEBHOOK_SECRET. Var: OPENBOT_WEBHOOK_URL.
// Logs event id, type and status only, never the body.

export interface Env {
  DOOP_WEBHOOK_SECRET?: string;
  OPENBOT_WEBHOOK_SECRET?: string;
  OPENBOT_WEBHOOK_URL?: string;
}

const MAX_BODY = 64 * 1024; // OpenBot's limit; a raw event above it can't fit once wrapped
const MAX_SKEW_MS = 5 * 60_000;
const FORWARD_TIMEOUT_MS = 9_000; // Doop gives up at 10 s
const FORWARDED_TYPES = new Set(["comment.created", "comment.replied"]);
// OpenBot's delivery id rule
const DELIVERY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

const encoder = new TextEncoder();
const empty = (status: number) => new Response(null, { status });
const log = (fields: Record<string, unknown>) =>
  console.log(JSON.stringify(fields));

function hmacKey(secret: string, usage: "sign" | "verify") {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

function concat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

// Returns the raw bytes, or null when the body is over the limit.
async function readCapped(request: Request) {
  if (Number(request.headers.get("content-length")) > MAX_BODY) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return concat(...chunks);
}

// crypto.subtle.verify compares in constant time, over the raw bytes.
async function validDoopSignature(
  secret: string,
  request: Request,
  raw: Uint8Array,
) {
  const timestamp = request.headers.get("x-doop-timestamp") ?? "";
  if (!/^\d{1,16}$/.test(timestamp)) return false;
  if (Math.abs(Date.now() - Number(timestamp)) > MAX_SKEW_MS) return false;

  const match = /^sha256=([0-9a-f]{64})$/.exec(
    request.headers.get("x-doop-signature") ?? "",
  );
  if (!match?.[1]) return false;
  const given = Uint8Array.from(match[1].match(/../g) ?? [], (byte) =>
    Number.parseInt(byte, 16),
  );

  const key = await hmacKey(secret, "verify");
  return crypto.subtle.verify(
    "HMAC",
    key,
    given,
    concat(encoder.encode(`${timestamp}.`), raw),
  );
}

async function signForOpenBot(
  secret: string,
  timestamp: string,
  deliveryId: string,
  body: Uint8Array,
) {
  const key = await hmacKey(secret, "sign");
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    concat(encoder.encode(`${timestamp}.${deliveryId}.`), body),
  );
  return `sha256=${Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") return empty(405);

    // No secret means nothing can be checked or signed: fail closed so Doop retries.
    if (!env.DOOP_WEBHOOK_SECRET) {
      log({ outcome: "missing_secret", secret: "DOOP_WEBHOOK_SECRET" });
      return empty(503);
    }

    const raw = await readCapped(request);
    if (!raw) {
      log({ outcome: "too_large" });
      return empty(413);
    }

    if (!(await validDoopSignature(env.DOOP_WEBHOOK_SECRET, request, raw))) {
      log({ outcome: "bad_signature" });
      return empty(401);
    }

    let event: {
      id?: unknown;
      type?: unknown;
      at?: unknown;
      actor?: { kind?: unknown } | null;
    } | null;
    try {
      event = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      log({ outcome: "bad_json" });
      return empty(400);
    }

    const { id, type, at, actor } = event ?? {};
    if (
      typeof type !== "string" ||
      !FORWARDED_TYPES.has(type) ||
      actor?.kind === "agent"
    ) {
      log({ outcome: "dropped", id, type });
      return empty(200);
    }

    if (
      typeof id !== "string" ||
      !DELIVERY_ID.test(id) ||
      typeof at !== "number" ||
      Number.isNaN(new Date(at).getTime())
    ) {
      log({ outcome: "bad_event", type });
      return empty(400);
    }

    const body = encoder.encode(
      JSON.stringify({
        type,
        occurredAt: new Date(at).toISOString(),
        data: event,
      }),
    );
    if (body.byteLength > MAX_BODY) {
      log({ outcome: "too_large", id, type });
      return empty(413);
    }

    if (!env.OPENBOT_WEBHOOK_SECRET || !env.OPENBOT_WEBHOOK_URL) {
      log({
        outcome: "missing_secret",
        secret: "OPENBOT_WEBHOOK_SECRET or OPENBOT_WEBHOOK_URL",
        id,
      });
      return empty(503);
    }

    const timestamp = String(Math.floor(Date.now() / 1000));
    try {
      const response = await fetch(env.OPENBOT_WEBHOOK_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-openbot-timestamp": timestamp,
          "x-openbot-delivery-id": id,
          "x-openbot-signature": await signForOpenBot(
            env.OPENBOT_WEBHOOK_SECRET,
            timestamp,
            id,
            body,
          ),
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
      });
      await response.body?.cancel();
      log({ outcome: "forwarded", id, type, status: response.status });
      return empty(response.status);
    } catch (error) {
      log({
        outcome: "forward_failed",
        id,
        type,
        error: error instanceof Error ? error.name : undefined,
      });
      return empty(503);
    }
  },
};
