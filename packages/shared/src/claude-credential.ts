import { z } from "zod";
import { EnvironmentId } from "./ids.js";

/** The credential every environment without an assignment uses: the server's `CLAUDE_CODE_OAUTH_TOKEN`. */
export const DEFAULT_CLAUDE_CREDENTIAL = "default";

/**
 * The plain pay-per-use Anthropic API key (`SKY_ANTHROPIC_API_KEY`); the API keys are the only
 * fallback for a limited subscription. It is the key named `default`; a named key
 * `SKY_ANTHROPIC_API_KEY_<NAME>` is {@link apiKeyCredential}`(name)`, `api-key:<name>`.
 */
export const API_KEY_CREDENTIAL = "api-key";

/** The credential recorded for the API key called `name`; the plain key, `default`, stays `api-key`. */
export const apiKeyCredential = (name: string): string =>
  name === DEFAULT_CLAUDE_CREDENTIAL
    ? API_KEY_CREDENTIAL
    : `${API_KEY_CREDENTIAL}:${name}`;

/** Whether a credential is one of the API keys, the plain one or a named one. */
export const isApiKeyCredential = (credential: string): boolean =>
  credential === API_KEY_CREDENTIAL ||
  credential.startsWith(`${API_KEY_CREDENTIAL}:`);

/** The name of the API key a credential is (`default` for the plain key); undefined for a subscription. */
export const apiKeyNameOf = (credential: string): string | undefined =>
  credential === API_KEY_CREDENTIAL
    ? DEFAULT_CLAUDE_CREDENTIAL
    : credential.startsWith(`${API_KEY_CREDENTIAL}:`)
      ? credential.slice(API_KEY_CREDENTIAL.length + 1)
      : undefined;

/**
 * The assignment that lets an environment's runs move between subscriptions, and the only one that
 * does. Off unless an environment is assigned it.
 */
export const POOL_CREDENTIAL = "pool";

/**
 * A subscription's name: up to 64 lowercase letters, digits and `_`. `default` is the server's
 * `CLAUDE_CODE_OAUTH_TOKEN`; any other is its `CLAUDE_OAUTH_TOKEN_<NAME>`. Never `pool`, which is the
 * assignment {@link POOL_CREDENTIAL}.
 */
export const ClaudeSubscriptionName = z
  .string()
  .regex(
    /^[a-z0-9_]{1,64}$/,
    "expected a subscription name: lowercase letters, digits and _",
  )
  .refine(
    (name) => name !== POOL_CREDENTIAL,
    "pool is reserved and can't be a subscription name",
  );

/**
 * What an environment is assigned: the name of a subscription token (`CLAUDE_OAUTH_TOKEN_<NAME>`,
 * lowercased), `default`, `pool`, `api-key` or `api-key:<name>`. Names only; no value ever travels
 * with one.
 */
export const ClaudeCredentialName = z
  .string()
  .regex(
    /^(?:[a-z0-9_]{1,64}|api-key(?::[a-z0-9_]{1,64})?)$/,
    "expected a credential name: a subscription (lowercase letters, digits, _), default, pool, api-key or api-key:<name>",
  );

/** Whether a limited subscription's environment may spend the API keys until the reset. */
export const ClaudeFallback = z.enum([API_KEY_CREDENTIAL, "none"]);
export type ClaudeFallback = z.infer<typeof ClaudeFallback>;

/** Last-seen usage of one window: the fraction of it used, where 1 or more is full, and when it resets. */
export const ClaudeUsageWindow = z.object({
  utilization: z.number().min(0),
  resetsAt: z.iso.datetime().nullable(),
});
export type ClaudeUsageWindow = z.infer<typeof ClaudeUsageWindow>;

/** A subscription's last-seen 5-hour and 7-day usage, from its latest probe. */
export const ClaudeUsage = z.object({
  fiveHour: ClaudeUsageWindow.nullable(),
  sevenDay: ClaudeUsageWindow.nullable(),
  probedAt: z.iso.datetime(),
});
export type ClaudeUsage = z.infer<typeof ClaudeUsage>;

/** One credential as `GET /v1/claude-credentials` lists it. */
export const ClaudeCredentialSummary = z.object({
  /** A subscription's name, or an API key's credential: `api-key`, or `api-key:<name>` for a named one. */
  name: z.string(),
  kind: z.enum(["subscription", "api-key"]),
  /** The environments assigned this credential. */
  environments: z.array(z.object({ id: EnvironmentId, name: z.string() })),
  /** While a subscription is at its usage limit, when it resets; null otherwise. */
  limitedUntil: z.iso.datetime().nullable(),
  /** An API key whose run failed with "Credit balance is too low", until it is cleared; false for a subscription. */
  outOfCredit: z.boolean().default(false),
  /** Runs started on it since midnight UTC. */
  runsToday: z.int().nonnegative(),
  /** A subscription's last-seen usage; null before it has been probed, and for an API key. */
  usage: ClaudeUsage.nullable().default(null),
  /** The pool environments that may use this subscription. */
  poolEnvironments: z
    .array(z.object({ id: EnvironmentId, name: z.string() }))
    .default(() => []),
});
export type ClaudeCredentialSummary = z.infer<typeof ClaudeCredentialSummary>;

/** What `POST /v1/claude-credentials/:name/clear-credit` answers: the key's credential and whether it was marked. */
export const ClaudeCreditCleared = z.object({
  name: z.string(),
  outOfCredit: z.literal(false),
  wasOutOfCredit: z.boolean(),
});
export type ClaudeCreditCleared = z.infer<typeof ClaudeCreditCleared>;
