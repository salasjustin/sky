import { stringify } from "yaml";
import type { ApiEnvironment, SecretSummary } from "./api.js";

/**
 * The environment as an `env.yaml` that `sky apply` takes as a no-op: every field of the file, multi-line
 * scripts as block scalars. What the file can't hold rides in comments: the runtime (`sky env
 * set-runtime` sets it) and the secrets' names, never their values. `secrets` is undefined when the
 * key can't list them.
 */
export function envYaml(
  env: ApiEnvironment,
  secrets: SecretSummary[] | undefined,
): string {
  const spec = {
    name: env.name,
    repo: env.repo,
    setup: env.setup,
    refresh: env.refresh,
    base: env.base,
    concurrency: env.concurrency,
    approvalPolicy: env.approvalPolicy,
    autoApprove: env.autoApprove,
    // `default` is how a file says the default token, and the API stores it as null
    claudeCredential: env.claudeCredential ?? "default",
    claudePool: env.claudePool,
    claudeFallback: env.claudeFallback,
  };
  const notes = [
    `# ${env.name} (${env.id}), exported by sky env show --yaml; sky apply takes it as is.`,
    `# runtime: ${env.runtime ?? "default (the SKY_RUNTIME secret, else claude-code)"}; not a field of this file: set it with sky env set-runtime ${env.name} <claude-code|codex|pi|default>`,
    secrets === undefined
      ? "# secrets: not listed with this key; secret values are never exported"
      : `# secrets (names only; values are never exported; set one with sky secret set ${env.name} <NAME>): ${
          secrets.length === 0
            ? "none"
            : secrets
                .map((s) =>
                  s.kind === "value" ? s.name : `${s.name} (${s.kind})`,
                )
                .join(", ")
        }`,
  ];
  // no folding: a long command stays on its line
  return `${notes.join("\n")}\n${stringify(spec, { lineWidth: 0 })}`;
}
