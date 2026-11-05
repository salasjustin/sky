import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { server } from "../../../test/msw.js";
import worker, { type Env } from "./worker.js";

const OPENBOT_URL = "https://openbot.test/hooks/doop";
const env: Env = {
  DOOP_WEBHOOK_SECRET: "doop-secret",
  OPENBOT_WEBHOOK_SECRET: "openbot-secret",
  OPENBOT_WEBHOOK_URL: OPENBOT_URL,
};

const encoder = new TextEncoder();
const hex = (buf: ArrayBuffer) =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );

async function hmac(secret: string, message: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

const commentEvent = {
  id: "evt_01.abc:2-x",
  type: "comment.created",
  at: Date.UTC(2026, 10, 5, 12, 0, 0),
  actor: { kind: "user", name: "Ada" },
  comment: { text: "ünïcode  body" },
};

async function doopRequest(
  event: unknown,
  {
    method = "POST",
    secret = env.DOOP_WEBHOOK_SECRET as string,
    timestamp = String(Date.now()),
    raw = typeof event === "string" ? event : JSON.stringify(event),
  } = {},
) {
  const signature = `sha256=${await hmac(secret, `${timestamp}.${raw}`)}`;
  return new Request("https://relay.test/", {
    method,
    headers: {
      "x-doop-timestamp": timestamp,
      "x-doop-signature": signature,
    },
    body: method === "POST" ? raw : undefined,
  });
}

type Seen = { headers: Headers; body: string };

/** Answers OpenBot with `status`, recording what arrived. */
function openbot(status = 200) {
  const seen: Seen[] = [];
  server.use(
    http.post(OPENBOT_URL, async ({ request }) => {
      seen.push({
        headers: request.headers,
        body: await request.text(),
      });
      return new HttpResponse(null, { status });
    }),
  );
  return seen;
}

describe("doop-relay", () => {
  it("forwards a good event with the exact body and a recomputable OpenBot signature", async () => {
    const seen = openbot();
    const res = await worker.fetch(await doopRequest(commentEvent), env);

    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    const { headers, body } = seen[0] as Seen;
    expect(JSON.parse(body)).toEqual({
      type: "comment.created",
      occurredAt: "2026-11-05T12:00:00.000Z",
      data: commentEvent,
    });
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-openbot-delivery-id")).toBe(commentEvent.id);
    const timestamp = headers.get("x-openbot-timestamp") as string;
    expect(Math.abs(Date.now() / 1000 - Number(timestamp))).toBeLessThan(5);
    expect(headers.get("x-openbot-signature")).toBe(
      `sha256=${await hmac("openbot-secret", `${timestamp}.${commentEvent.id}.${body}`)}`,
    );
  });

  it("forwards comment.replied", async () => {
    const seen = openbot();
    const event = { ...commentEvent, type: "comment.replied" };
    const res = await worker.fetch(await doopRequest(event), env);
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
  });

  it("answers 401 to a bad signature and forwards nothing", async () => {
    const seen = openbot();
    const res = await worker.fetch(
      await doopRequest(commentEvent, { secret: "wrong" }),
      env,
    );
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("answers 401 to a signature over a different body", async () => {
    const seen = openbot();
    const signed = await doopRequest(commentEvent);
    const tampered = new Request(signed, {
      body: JSON.stringify({ ...commentEvent, id: "other" }),
    });
    expect((await worker.fetch(tampered, env)).status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("answers 401 to a timestamp more than 5 minutes off, either way", async () => {
    const seen = openbot();
    for (const offset of [-6 * 60_000, 6 * 60_000]) {
      const timestamp = String(Date.now() + offset);
      const res = await worker.fetch(
        await doopRequest(commentEvent, { timestamp }),
        env,
      );
      expect(res.status).toBe(401);
    }
    expect(seen).toHaveLength(0);
  });

  it("answers 200 and forwards nothing for a ping", async () => {
    const seen = openbot();
    const ping = { id: "evt_ping", type: "ping", at: Date.now() };
    const res = await worker.fetch(await doopRequest(ping), env);
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(0);
  });

  it("answers 200 and forwards nothing for an agent actor", async () => {
    const seen = openbot();
    const event = { ...commentEvent, actor: { kind: "agent" } };
    const res = await worker.fetch(await doopRequest(event), env);
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(0);
  });

  it("answers 405 to anything but POST", async () => {
    const seen = openbot();
    for (const method of ["GET", "PUT", "DELETE"]) {
      const res = await worker.fetch(
        await doopRequest(commentEvent, { method }),
        env,
      );
      expect(res.status).toBe(405);
    }
    expect(seen).toHaveLength(0);
  });

  it("passes OpenBot's 503 through so Doop retries", async () => {
    openbot(503);
    const res = await worker.fetch(await doopRequest(commentEvent), env);
    expect(res.status).toBe(503);
  });

  it("answers 200 when OpenBot answers 200 for a duplicate delivery", async () => {
    const seen = openbot(200);
    const first = await worker.fetch(await doopRequest(commentEvent), env);
    const again = await worker.fetch(await doopRequest(commentEvent), env);
    expect([first.status, again.status]).toEqual([200, 200]);
    expect(seen).toHaveLength(2);
  });

  it("answers 503 when OpenBot is unreachable", async () => {
    server.use(http.post(OPENBOT_URL, () => HttpResponse.error()));
    const res = await worker.fetch(await doopRequest(commentEvent), env);
    expect(res.status).toBe(503);
  });

  it("answers 413 to an oversized body and forwards nothing", async () => {
    const seen = openbot();
    const big = { ...commentEvent, comment: { text: "x".repeat(70 * 1024) } };
    const res = await worker.fetch(await doopRequest(big), env);
    expect(res.status).toBe(413);
    expect(seen).toHaveLength(0);
  });

  it("answers 413 when the wrapped body would pass the limit", async () => {
    const seen = openbot();
    // under 64 KB raw, over once wrapped in {type,occurredAt,data}
    const overhead = JSON.stringify({ ...commentEvent, pad: "" }).length;
    const edge = { ...commentEvent, pad: "x".repeat(64 * 1024 - overhead - 8) };
    expect(JSON.stringify(edge).length).toBeLessThan(64 * 1024);
    const res = await worker.fetch(await doopRequest(edge), env);
    expect(res.status).toBe(413);
    expect(seen).toHaveLength(0);
  });

  it("answers 400 to a delivery id OpenBot would refuse", async () => {
    const seen = openbot();
    for (const id of ["-lead", "has space", "a".repeat(201), ""]) {
      const res = await worker.fetch(
        await doopRequest({ ...commentEvent, id }),
        env,
      );
      expect(res.status).toBe(400);
    }
    expect(seen).toHaveLength(0);
  });

  it("accepts a 200-character delivery id", async () => {
    const seen = openbot();
    const id = `a${"b".repeat(199)}`;
    const res = await worker.fetch(
      await doopRequest({ ...commentEvent, id }),
      env,
    );
    expect(res.status).toBe(200);
    expect(seen[0]?.headers.get("x-openbot-delivery-id")).toBe(id);
  });

  it("answers 503 when a secret is not configured", async () => {
    const res = await worker.fetch(await doopRequest(commentEvent), {
      ...env,
      DOOP_WEBHOOK_SECRET: undefined,
    });
    expect(res.status).toBe(503);
  });

  it("logs the delivery id, type and outcome, never the body", async () => {
    openbot();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await worker.fetch(await doopRequest(commentEvent), env);
    const logged = log.mock.calls.flat().join("\n");
    log.mockRestore();
    expect(logged).toContain(commentEvent.id);
    expect(logged).toContain("forwarded");
    expect(logged).not.toContain("ünïcode");
    expect(logged).not.toContain("secret");
  });
});
