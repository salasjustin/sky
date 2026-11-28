import { z } from "zod";
import { commandEntryProblem } from "./auto-approve.js";
import { BaseProfileName } from "./base-profile.js";
import {
  ClaudeCredentialName,
  ClaudeFallback,
  ClaudeSubscriptionName,
} from "./claude-credential.js";
import { EventType } from "./event.js";
import { EnvironmentId, WebhookId } from "./ids.js";
import { Webhook } from "./webhook.js";

export const EnvironmentStatus = z.enum(["provisioning", "ready", "failed"]);
export type EnvironmentStatus = z.infer<typeof EnvironmentStatus>;

/** Which agent drives an environment's runs: Claude Code, or Codex through the AI Gateway. */
export const Runtime = z.enum(["claude-code", "codex"]);
export type Runtime = z.infer<typeof Runtime>;

/** The env secret a Codex run's model calls carry; switching an environment to Codex needs it. */
export const CODEX_GATEWAY_SECRET = "AI_GATEWAY_API_KEY";

/** Which Bash commands run without an approval request; see `isAutoApproved`. */
export const AutoApproveConfig = z.strictObject({
  /** Keep the built-in read-only commands; false leaves only `commands` (none turns it off). */
  defaults: z.boolean().default(true),
  /** Commands added to the built-ins, each the leading words of a command, e.g. `git tag --list`. */
  commands: z
    .array(
      z
        .string()
        .max(200)
        .superRefine((entry, ctx) => {
          const problem = commandEntryProblem(entry);
          if (problem) ctx.addIssue({ code: "custom", message: problem });
        }),
    )
    .max(64)
    .default(() => []),
});

/** The longest `refresh` script, in characters; it rides in the runner's env file. */
export const REFRESH_MAX = 20_000;

/** What an environment's webhook delivers when `events` is left out. */
export const DEFAULT_ENVIRONMENT_WEBHOOK_EVENTS: [EventType, ...EventType[]] = [
  "run.waiting",
  "run.finished",
  "run.failed",
  "run.stopped",
  "runner.warning",
];

/**
 * The one webhook an environment owns, as `env.yaml` writes it. The signing secret is no field: it is
 * the environment's `SKY_WEBHOOK_SECRET` secret, copied into the webhook when the environment is applied.
 */
export const EnvironmentWebhookSpec = z.strictObject({
  /** https only, like any webhook: payloads carry tool input and output */
  url: Webhook.shape.url,
  format: z.enum(["openbot", "standard"]),
  events: z
    .array(EventType)
    .nonempty()
    .default(() => [...DEFAULT_ENVIRONMENT_WEBHOOK_EVENTS]),
});
export type EnvironmentWebhookSpec = z.infer<typeof EnvironmentWebhookSpec>;

/** The env secret an environment's webhook is signed with. */
export const WEBHOOK_SECRET_NAME = "SKY_WEBHOOK_SECRET";

export const Environment = z.object({
  id: EnvironmentId,
  name: z.string().trim().min(1).max(100),
  /** GitHub `owner/name`; reaches a `git clone` inside the sprite, so nothing beyond the slug charset. */
  repo: z
    .string()
    .regex(
      /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/,
      "expected a GitHub repo as owner/name",
    ),
  /** Shell script run once after clone, before the checkpoint. */
  setup: z.string(),
  /**
   * Shell script the runner runs before every run, on every runtime, with the agent's own env and
   * rights (see `runner/src/refresh.ts`): it brings what `setup` installed up to date without a
   * reprovision. Empty is none; changing it never reprovisions.
   */
  refresh: z.string().max(REFRESH_MAX).default(""),
  /** Name of a server-side base profile applied before `setup`; null applies none. */
  base: BaseProfileName.nullable().default(null),
  status: EnvironmentStatus,
  spriteName: z.string().min(1),
  /** Null until the post-setup checkpoint exists. */
  checkpointId: z.string().min(1).nullable(),
  /** Max agents running at once in this environment's sprite. */
  concurrency: z.int().positive().default(3),
  /** Tool-name patterns whose calls wait for an approval decision. */
  approvalPolicy: z.array(z.string().min(1)).default(() => []),
  /** Read-only Bash commands that skip `approvalPolicy`; anything unlisted keeps asking. */
  autoApprove: AutoApproveConfig.default(() => ({
    defaults: true,
    commands: [],
  })),
  /** Which Claude credential this environment's runs use: a subscription name, `api-key` or `pool`; null is the default token, and `default` is stored as null. */
  claudeCredential: ClaudeCredentialName.nullable().default(null),
  /** With `claudeCredential: pool`, the subscriptions it may use, in failover order; null is every one the server holds. */
  claudePool: z
    .array(ClaudeSubscriptionName)
    .min(1)
    .max(32)
    .refine((names) => new Set(names).size === names.length, {
      error: "a subscription is named once",
    })
    .nullable()
    .default(null),
  /** What a run does while its subscription is at its usage limit: use the API key, or fail the launch. */
  claudeFallback: ClaudeFallback.default("api-key"),
  /** The runtime set by `PUT /v1/environments/:id/runtime`; null follows the env's `SKY_RUNTIME` secret, else Claude Code. */
  runtime: Runtime.nullable().default(null),
  /** The environment's one webhook, kept by `sky apply`; null has none. Never carries the signing secret. */
  webhook: EnvironmentWebhookSpec.extend({ id: WebhookId })
    .nullable()
    .default(null),
});
export type Environment = z.infer<typeof Environment>;
