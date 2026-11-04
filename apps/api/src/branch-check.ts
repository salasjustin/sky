import { randomUUID } from "node:crypto";
import type { Db } from "@sky/db";
import type { BranchName, EnvironmentId } from "@sky/shared";
import { envFile, REPO_DIR, RUNNER } from "./provision.js";
import { type KnownSecrets, redact } from "./redact.js";
import type { BundleInstaller } from "./runner-bundle.js";
import { hasConnectorSecret, openEnvSecrets } from "./secrets.js";
import { execInSprite, type SpriteOps, writeSpriteFile } from "./sprites.js";

// the connector and gateway ride in a file, as the repo pull's do: an exec's argv reaches the sprite
// as URL query params
const CHECK_BRANCH = `. "$1" && exec node ${RUNNER} branch-check "$2"`;
const TAIL_CHARS = 2000;

// the runner's `branch-check` exit codes; 0 means the branch exists. Its 2 (usage or no connector)
// is a failure: the connector is checked here before the exec, and sh also exits 2 when `.` can't read
const outcomeOfExit = new Map<number, "not_found" | "is_default">([
  [3, "not_found"],
  [4, "is_default"],
]);

export type BranchCheck =
  | { kind: "exists" | "needs_connector" | "not_found" | "is_default" }
  | { kind: "failed"; detail: string };

type Deps = {
  db: Db;
  secretEncryptionKey: Buffer;
  secrets: KnownSecrets;
  sprites: SpriteOps;
  ensureBundle: BundleInstaller;
  log: (line: string) => void;
};

/**
 * Asks the runner, in the env's sprite, whether `branch` exists on GitHub and isn't the repo's
 * default branch. It reaches GitHub only through the connector, so an env without one fails before
 * any exec. A sprite or transport error, a timeout included, comes back as `failed` with its detail
 * redacted; the env file is removed whatever happens.
 */
export function createBranchChecker({
  db,
  secretEncryptionKey,
  secrets,
  sprites,
  ensureBundle,
  log,
}: Deps) {
  return async function checkBranch(
    env: { id: EnvironmentId; spriteName: string },
    branch: BranchName,
  ): Promise<BranchCheck> {
    if (!hasConnectorSecret(db, env.id, "GITHUB_CONNECTOR")) {
      return { kind: "needs_connector" };
    }
    let known: string[] = [];
    const scrub = (text: string) =>
      redact(text, [...secrets.values(), ...known]).slice(-TAIL_CHARS);
    // per check, so two concurrent checks in one sprite never remove each other's file
    const envFilePath = `/tmp/sky-branch-check-${randomUUID()}.env`;
    try {
      // in the try: a value that won't decrypt is a failed check, not a 500
      const pulled = openEnvSecrets(db, secretEncryptionKey, env.id, [
        "GITHUB_CONNECTOR",
        "GITHUB_GATEWAY_URL",
      ]);
      known = [...pulled.values()];
      await ensureBundle(env.spriteName, `branch-check-${randomUUID()}`);
      // in the try: a write that errors client-side may still have landed
      await writeSpriteFile(
        sprites,
        env.spriteName,
        envFilePath,
        envFile(pulled),
        { op: "write-branch-check-env", mode: 0o600, known },
      );
      const out = await execInSprite(
        sprites,
        env.spriteName,
        ["sh", "-c", CHECK_BRANCH, "sh", envFilePath, branch],
        { op: "branch-check", cwd: REPO_DIR, known },
      );
      if (out.exitCode === 0) return { kind: "exists" };
      const kind = outcomeOfExit.get(out.exitCode);
      if (kind) return { kind };
      return {
        kind: "failed",
        detail: scrub(out.stderr.trim() || `exited with code ${out.exitCode}`),
      };
    } catch (err) {
      return {
        kind: "failed",
        detail: scrub(err instanceof Error ? err.message : String(err)),
      };
    } finally {
      // the check's outcome stands; a file left behind is only logged
      await execInSprite(sprites, env.spriteName, ["rm", "-f", envFilePath], {
        op: "rm-branch-check-env",
        known,
      })
        .then((out) => {
          if (out.exitCode !== 0) throw new Error(out.stderr.trim());
        })
        .catch((err: unknown) => {
          const detail = err instanceof Error ? err.message : String(err);
          log(
            `sprite ${env.spriteName} kept ${envFilePath} after a branch check: ${scrub(detail)}`,
          );
        });
    }
  };
}

export type BranchChecker = ReturnType<typeof createBranchChecker>;
