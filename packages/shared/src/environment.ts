import { z } from "zod";
import { commandEntryProblem } from "./auto-approve.js";
import { BaseProfileName } from "./base-profile.js";
import { ClaudeCredentialName, ClaudeFallback } from "./claude-credential.js";
import { EnvironmentId } from "./ids.js";

export const EnvironmentStatus = z.enum(["provisioning", "ready", "failed"]);
export type EnvironmentStatus = z.infer<typeof EnvironmentStatus>;

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
  /** Which Claude credential this environment's runs use: a subscription name or `api-key`; null is the default token. */
  claudeCredential: ClaudeCredentialName.nullable().default(null),
  /** What a run does while its subscription is at its usage limit: use the API key, or fail the launch. */
  claudeFallback: ClaudeFallback.default("api-key"),
});
export type Environment = z.infer<typeof Environment>;
