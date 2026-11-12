import { z } from "zod";
import { EnvironmentId } from "./ids.js";

/** The credential every environment without an assignment uses: the server's `CLAUDE_CODE_OAUTH_TOKEN`. */
export const DEFAULT_CLAUDE_CREDENTIAL = "default";

/** The pay-per-use Anthropic API key (`SKY_ANTHROPIC_API_KEY`), the only fallback for a limited subscription. */
export const API_KEY_CREDENTIAL = "api-key";

/**
 * The assignment that lets an environment's runs move between subscriptions, and the only one that
 * does. Off unless an environment is assigned it.
 */
export const POOL_CREDENTIAL = "pool";

/**
 * A subscription's name: lowercase letters, digits and `_`; the server's `CLAUDE_OAUTH_TOKEN_<NAME>`.
 * Never `pool`, which is the assignment {@link POOL_CREDENTIAL}.
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
 * lowercased), `default`, `pool` or `api-key`. Names only; no value ever travels with one.
 */
export const ClaudeCredentialName = z
  .string()
  .regex(
    /^(?:[a-z0-9_]{1,64}|api-key)$/,
    "expected a credential name: a subscription (lowercase letters, digits, _), default, pool or api-key",
  );

/** Whether a limited subscription's environment may spend the API key until the reset. */
export const ClaudeFallback = z.enum([API_KEY_CREDENTIAL, "none"]);
export type ClaudeFallback = z.infer<typeof ClaudeFallback>;

/** Last-seen usage of one window: how much of it is used (0 to 1) and when it resets. */
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
  name: z.string(),
  kind: z.enum(["subscription", "api-key"]),
  /** The environments assigned this credential. */
  environments: z.array(z.object({ id: EnvironmentId, name: z.string() })),
  /** While a subscription is at its usage limit, when it resets; null otherwise. */
  limitedUntil: z.iso.datetime().nullable(),
  /** Runs started on it since midnight UTC. */
  runsToday: z.int().nonnegative(),
  /** A subscription's last-seen usage; null before it has been probed, and for the API key. */
  usage: ClaudeUsage.nullable().default(null),
  /** The pool environments that may use this subscription. */
  poolEnvironments: z
    .array(z.object({ id: EnvironmentId, name: z.string() }))
    .default(() => []),
});
export type ClaudeCredentialSummary = z.infer<typeof ClaudeCredentialSummary>;
