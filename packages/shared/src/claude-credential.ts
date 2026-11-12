import { z } from "zod";
import { EnvironmentId } from "./ids.js";

/** The credential every environment without an assignment uses: the server's `CLAUDE_CODE_OAUTH_TOKEN`. */
export const DEFAULT_CLAUDE_CREDENTIAL = "default";

/** The pay-per-use Anthropic API key (`SKY_ANTHROPIC_API_KEY`), the only fallback for a limited subscription. */
export const API_KEY_CREDENTIAL = "api-key";

/**
 * What an environment is assigned: the name of a subscription token (`CLAUDE_OAUTH_TOKEN_<NAME>`,
 * lowercased), `api-key`, or `default`. Names only; no value ever travels with one.
 */
export const ClaudeCredentialName = z
  .string()
  .regex(
    /^(?:[a-z0-9_]{1,64}|api-key)$/,
    "expected a credential name: lowercase letters, digits and _, or api-key",
  );

/** Whether a limited subscription's environment may spend the API key until the reset. */
export const ClaudeFallback = z.enum([API_KEY_CREDENTIAL, "none"]);
export type ClaudeFallback = z.infer<typeof ClaudeFallback>;

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
});
export type ClaudeCredentialSummary = z.infer<typeof ClaudeCredentialSummary>;
