import { EVENT_TEXT_MAX, truncationMarker } from "@sky/shared";
import type { Config } from "./config.js";

const REDACTED = "[redacted]";

// shorter values would shred ordinary text wherever they happen to occur
const MIN_KNOWN_LENGTH = 8;

// \b keeps words like "task-list" (which contains "sk-") out of the sk- match
const tokenPatterns = [
  /\bsk-ant-oat[0-9A-Za-z_-]+/g,
  /\bsk-[0-9A-Za-z_-]{16,}/g,
  /\bgh[pousr]_[0-9A-Za-z]{20,}/g,
  /\bgithub_pat_[0-9A-Za-z_]{20,}/g,
  /\bsky_[0-9A-Za-z_-]{20,}/g,
  /\beyJ[0-9A-Za-z_-]+\.[0-9A-Za-z_-]+\.[0-9A-Za-z_-]+/g,
];

/** The exact secret values this process holds, which `redact` scrubs wherever they appear. */
export class KnownSecrets {
  readonly #values = new Map<string, string>();

  static fromConfig(
    config: Pick<
      Config,
      | "apiKey"
      | "spritesToken"
      | "claudeOauthToken"
      | "webhookSigningKey"
      | "secretEncryptionKey"
    > &
      Partial<Pick<Config, "claudeOauthTokens" | "anthropicApiKey">>,
  ): KnownSecrets {
    const secrets = new KnownSecrets();
    secrets.add("SKY_API_KEY", config.apiKey);
    secrets.add("SPRITES_TOKEN", config.spritesToken);
    secrets.add("CLAUDE_CODE_OAUTH_TOKEN", config.claudeOauthToken);
    for (const [name, token] of Object.entries(
      config.claudeOauthTokens ?? {},
    )) {
      secrets.add(`CLAUDE_OAUTH_TOKEN_${name}`, token);
    }
    if (config.anthropicApiKey) {
      secrets.add("SKY_ANTHROPIC_API_KEY", config.anthropicApiKey);
    }
    secrets.add("WEBHOOK_SIGNING_KEY", config.webhookSigningKey);
    secrets.add(
      "SECRET_ENCRYPTION_KEY",
      config.secretEncryptionKey.toString("base64"),
    );
    return secrets;
  }

  /** Registers `value` under `name`, replacing that name's previous value; a value under 8 characters is ignored. */
  add(name: string, value: string): void {
    if (value.length >= MIN_KNOWN_LENGTH) this.#values.set(name, value);
  }

  remove(name: string): void {
    this.#values.delete(name);
  }

  values(): string[] {
    return [...this.#values.values()];
  }
}

/** Scrubs credential-shaped strings and every `known` value from text bound for storage, an API response or a log. */
export function redact(text: string, known: readonly string[]): string {
  let out = text;
  for (const secret of known) {
    if (!secret) continue;
    out = out.split(secret).join(REDACTED);
    // as it appears inside JSON text, such as a tool's `input`: `"`, `\` and control characters escaped
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret) out = out.split(escaped).join(REDACTED);
  }
  for (const pattern of tokenPatterns) out = out.replace(pattern, REDACTED);
  return out;
}

/**
 * Raw output kept past a tail's bound, so the tail is taken only after redaction. Longer than any
 * secret or token, so one the raw cut splits has its fragment in this margin, which the tail drops.
 */
export const REDACTION_MARGIN = 8_192;

/** `text` cut to `max`, marking how much it dropped. */
export const cut = (text: string, max: number) =>
  text.length > max
    ? text.slice(0, max) + truncationMarker(text.length - max)
    : text;

/**
 * `text` redacted by `known`, then cut to `EVENT_TEXT_MAX` with the truncation marker: cut only after
 * redaction, so a cut can't split a secret out of its match. For text from a sprite that an event stores.
 */
export const eventText = (text: string, known: readonly string[]) =>
  cut(redact(text, known), EVENT_TEXT_MAX);

/** `redact` applied to every string leaf of a JSON value, object and array nesting included. */
export function redactDeep<T>(value: T, known: readonly string[]): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return redact(v, known);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v).map(([k, inner]) => [k, walk(inner)]),
      );
    }
    return v;
  };
  return walk(value) as T;
}
