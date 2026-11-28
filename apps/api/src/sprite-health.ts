import { APIError } from "@fly/sprites";
import { type Db, environments } from "@sky/db";
import { and, eq, isNotNull } from "drizzle-orm";
import { type KnownSecrets, redact } from "./redact.js";

// failures in a row, with no call getting through between, before an environment is marked: one
// blip is not an outage, and a sprite that answers anything has not stopped answering
const MARK_AFTER = 3;
const ERROR_MAX = 500;

// what a refused or lost connection leaves on the error or its cause
const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * Whether `err` says the sprite is not answering: the Sprites API's 5xx (a 503 "Storage not ready"
 * among them), or a connection that could not be made or was lost. An error the sprite answered
 * with (a 4xx, a nonzero exit) says it is reachable, as does a stream it answered but the SDK could
 * not read.
 */
export function isSpriteUnavailable(err: unknown): boolean {
  if (err instanceof APIError) return (err.statusCode ?? 0) >= 500;
  for (let e: unknown = err, depth = 0; e && depth < 4; depth++) {
    if (!(e instanceof Error)) return false;
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && NETWORK_CODES.has(code)) return true;
    // the SDK words its other HTTP failures `... (status 503): <body>` or `... failed with status 503`
    if (/\bstatus 5\d\d\b/.test(e.message)) return true;
    if (e instanceof TypeError && e.message === "fetch failed") return true;
    e = e.cause;
  }
  return false;
}

/** What `SpriteOps` tells about each call that reached for a sprite. */
export type SpriteHealth = {
  /** A call to `spriteName` got an answer. */
  contact(spriteName: string): void;
  /** A call to `spriteName` failed with `err`; `timedOut` for a call that ran out of its bound. */
  failed(spriteName: string, err: unknown, timedOut?: boolean): void;
};

type Deps = {
  db: Db;
  secrets: KnownSecrets;
  log: (line: string) => void;
  markAfter?: number;
  now?: () => Date;
};

/**
 * Keeps an environment's `health` as its sprite answers: `unreachable`, with the last error and its
 * time, after `markAfter` failures in a row, and cleared by the next call that gets an answer.
 * Counting is in memory; a mark outlives a restart, and the first contact after one clears it.
 */
export function createSpriteHealth({
  db,
  secrets,
  log,
  markAfter = MARK_AFTER,
  now = () => new Date(),
}: Deps): SpriteHealth {
  const failures = new Map<string, number>();
  // sprites known to carry no mark, so a healthy sprite's calls cost no write
  const clean = new Set<string>();
  function contact(spriteName: string) {
    failures.delete(spriteName);
    if (clean.has(spriteName)) return;
    try {
      const cleared = db
        .update(environments)
        .set({ health: null, healthError: null, healthAt: null })
        .where(
          and(
            eq(environments.spriteName, spriteName),
            isNotNull(environments.health),
          ),
        )
        .run();
      if (cleared.changes > 0) log(`sprite ${spriteName} answers again`);
      clean.add(spriteName);
    } catch (err) {
      log(`clearing the health of ${spriteName} failed: ${err}`);
    }
  }
  function failed(spriteName: string, err: unknown, timedOut = false) {
    // an error the sprite answered with is contact
    if (!timedOut && !isSpriteUnavailable(err)) return contact(spriteName);
    const count = (failures.get(spriteName) ?? 0) + 1;
    failures.set(spriteName, count);
    if (count < markAfter) return;
    try {
      const detail = redact(err instanceof Error ? err.message : String(err), [
        ...secrets.values(),
      ]).slice(0, ERROR_MAX);
      const marked = db
        .update(environments)
        .set({
          health: "unreachable",
          healthError: detail,
          healthAt: now().toISOString(),
        })
        .where(eq(environments.spriteName, spriteName))
        .run();
      if (marked.changes > 0) {
        clean.delete(spriteName);
        if (count === markAfter) {
          log(`sprite ${spriteName} stopped answering: ${detail}`);
        }
      }
    } catch (markErr) {
      log(`marking ${spriteName} unreachable failed: ${markErr}`);
    }
  }
  return { contact, failed };
}
