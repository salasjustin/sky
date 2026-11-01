import { type Db, environments, runs } from "@sky/db";
import type {
  AgentId,
  AutoApprove,
  BaseProfile,
  EnvironmentId,
  RunId,
} from "@sky/shared";
import { and, eq } from "drizzle-orm";
import { mintAgentToken } from "./agent-token.js";
import { runEnv } from "./base-profile.js";
import type { Config } from "./config.js";
import {
  envFile,
  REPO_DIR,
  RUNNER,
  WITH_PACKAGE_MANAGERS,
  WORKTREES_DIR,
} from "./provision.js";
import { type KnownSecrets, redact } from "./redact.js";
import type { BundleInstaller } from "./runner-bundle.js";
import { failRun, isActive } from "./runs.js";
import {
  hasConnectorSecret,
  isReservedName,
  openEnvSecrets,
  openRunEnvVars,
} from "./secrets.js";
import {
  execInSprite,
  type SpriteOps,
  spriteExists,
  startDetached,
  writeSpriteFile,
} from "./sprites.js";

// the session's env reaches the sprite as URL query params, so secrets ride in ENV_FILE, sourced
// then deleted, and the prompt in PROMPT_FILE, which a query param is too short for;
// the run id in argv is what `runnerPattern` matches; the runner itself ignores it
const RUNNER_COMMAND = `${WITH_PACKAGE_MANAGERS} && set -a && . "$ENV_FILE" && set +a && rm -f "$ENV_FILE" && PROMPT="$(cat "$PROMPT_FILE")" && export PROMPT && exec node ${RUNNER} "$RUN_ID"`;

/**
 * `pgrep -f`/`pkill -f` pattern matching only this run's runner, never its Claude child. Unanchored,
 * so a node started by its full path matches; the bash parent's argv holds a literal `"$RUN_ID"`,
 * and the matcher's own argv a `\.` and a trailing `$`, so neither matches.
 */
export const runnerPattern = (runId: RunId) =>
  `${RUNNER.replaceAll(".", "\\.")} ${runId}$`;

/**
 * SIGTERMs the run's runner, which aborts its Claude session and commits before exiting. A failure
 * is logged, not thrown; a runner already gone counts as signalled.
 */
export async function signalRunner(
  sprites: SpriteOps,
  spriteName: string,
  runId: RunId,
  log: (line: string) => void,
): Promise<void> {
  try {
    const out = await execInSprite(
      sprites,
      spriteName,
      ["pkill", "-TERM", "-f", runnerPattern(runId)],
      { op: "pkill" },
    );
    // pkill exits 1 when nothing matched
    if (out.exitCode > 1) {
      log(`signalling the runner of ${runId} failed: ${out.stderr.trim()}`);
    }
  } catch (err) {
    log(`signalling the runner of ${runId} failed: ${err}`);
  }
}

// exit 0 once nothing matches, 1 while a runner still does after 30 s; pgrep's own errors exit 2.
// The wait stays well under `sprites.timeoutMs`, which bounds the exec
const AWAIT_EXIT_OR_REPORT = `for _ in $(seq 30); do pgrep -f "$1" >/dev/null; case $? in 1) exit 0;; 0) sleep 1;; *) exit 2;; esac; done; exit 1`;

/**
 * Waits up to 30 s for the run's runner to exit: true once it is gone, false while it lives on.
 * Throws when the sprite can't answer.
 */
export async function awaitRunnerExit(
  sprites: SpriteOps,
  spriteName: string,
  runId: RunId,
): Promise<boolean> {
  const out = await execInSprite(
    sprites,
    spriteName,
    ["bash", "-c", AWAIT_EXIT_OR_REPORT, "_", runnerPattern(runId)],
    { op: "await-exit" },
  );
  if (out.exitCode === 0) return true;
  if (out.exitCode === 1) return false;
  throw new Error(`exit ${out.exitCode}: ${out.stderr.trim()}`);
}

// bounded: a runner that outlives the wait loses whatever its commit hadn't written; the 30 s stays
// well under `sprites.timeoutMs`, which bounds the exec
const AWAIT_RUNNER_EXIT = `for _ in $(seq 30); do pgrep -f "$2" >/dev/null || break; sleep 1; done; `;
// a worktree the runner never created (or whose directory is gone) counts as removed
const REMOVE_WORKTREE = `git worktree remove --force "$1" || ! test -e "$1"`;

/**
 * Removes the agent's worktree; its branch stays. With `stoppedRunId`, first waits for that run's
 * runner to exit, so the commit it makes on SIGTERM lands. Throws when the removal fails.
 */
export async function removeWorktree(
  sprites: SpriteOps,
  spriteName: string,
  agentId: AgentId,
  stoppedRunId: RunId | null,
): Promise<void> {
  const path = `${WORKTREES_DIR}/${agentId}`;
  const argv: [string, ...string[]] = stoppedRunId
    ? [
        "bash",
        "-c",
        AWAIT_RUNNER_EXIT + REMOVE_WORKTREE,
        "_",
        path,
        runnerPattern(stoppedRunId),
      ]
    : ["bash", "-c", REMOVE_WORKTREE, "_", path];
  const out = await execInSprite(sprites, spriteName, argv, {
    op: "rm-worktree",
    cwd: REPO_DIR,
  });
  if (out.exitCode !== 0) {
    throw new Error(`exit ${out.exitCode}: ${out.stderr.trim()}`);
  }
}

type Deps = {
  db: Db;
  config: Config;
  secrets: KnownSecrets;
  sprites: SpriteOps;
  ensureBundle: BundleInstaller;
  log: (line: string) => void;
  nudgeDeliveries: () => void;
  /** How long a launch stays attached to catch a runner that dies at start. */
  watchMs: number;
};
export type Launch = {
  envId: EnvironmentId;
  spriteName: string;
  agentId: AgentId;
  runId: RunId;
  prompt: string;
  /** The Claude session to resume; null starts a fresh one. */
  sessionId: string | null;
  /** The env's tool patterns that wait for an approval. */
  approvalPolicy: string[];
  /** The env's read-only Bash commands that skip the approval policy. */
  autoApprove: AutoApprove;
};

/**
 * Starts runners in the background; a launch that fails fails its run with a redacted
 * `launch_failed` error, and its environment too when its sprite is gone.
 */
export function createLauncher({
  db,
  config,
  secrets,
  sprites,
  ensureBundle,
  log,
  nudgeDeliveries,
  watchMs,
}: Deps) {
  /** The env's base profile, without its store when there is no connector to reach GitHub with. */
  function profileFor(
    envId: EnvironmentId,
    connector: boolean,
  ): BaseProfile | undefined {
    const row = db
      .select({ base: environments.base })
      .from(environments)
      .where(eq(environments.id, envId))
      .get();
    const profile = row?.base ? config.baseProfiles[row.base] : undefined;
    // a run without its profile would skip the env's checks and store sync unnoticed
    if (row?.base && !profile) {
      throw new Error(
        `base profile ${JSON.stringify(row.base)} of ${envId} is not configured on this server`,
      );
    }
    return profile && !connector
      ? { ...profile, storeRepo: undefined }
      : profile;
  }

  /** Runs one launch step, logging how long it took, so a stuck launch shows where it stopped. */
  async function step<T>(
    launch: Launch,
    name: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const started = Date.now();
    log(`launching ${launch.runId}: ${name} started`);
    const result = await task();
    log(`launching ${launch.runId}: ${name} ok in ${Date.now() - started}ms`);
    return result;
  }

  async function run(launch: Launch, agentToken: string): Promise<void> {
    const known = [agentToken];
    await step(launch, "bundle", () =>
      ensureBundle(launch.spriteName, launch.runId),
    );
    const promptFile = `/workspace/runs/${launch.runId}.prompt`;
    await step(launch, "prompt file", () =>
      writeSpriteFile(sprites, launch.spriteName, promptFile, launch.prompt, {
        op: "write-prompt",
        known,
      }),
    );
    // a stop that landed mid-launch found no runner to signal
    const current = db
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, launch.runId))
      .get();
    if (!current || !isActive(current.status)) {
      log(`${launch.runId} ended before its runner started`);
      return;
    }
    const key = config.secretEncryptionKey;
    // a name reserved after it was stored would override the runner's own variable once sourced
    const unreserved = (vars: Map<string, string>, kind: string) => {
      for (const name of vars.keys()) {
        if (!isReservedName(name)) continue;
        vars.delete(name);
        log(
          `${kind} ${name} on ${launch.envId} is reserved by sky; not passed to ${launch.runId}`,
        );
      }
      return vars;
    };
    const envSecrets = unreserved(
      openEnvSecrets(db, key, launch.envId),
      "secret",
    );
    const envVars = unreserved(openRunEnvVars(db, key, launch.runId), "envVar");
    db.update(runs)
      .set({
        secretNames: [
          ...new Set([...envSecrets.keys(), ...envVars.keys()]),
        ].sort(),
      })
      .where(eq(runs.id, launch.runId))
      .run();
    const envFilePath = `/workspace/runs/${launch.runId}.env`;
    await step(launch, "env file", () =>
      writeSpriteFile(
        sprites,
        launch.spriteName,
        envFilePath,
        envFile([
          ...envSecrets,
          ...envVars,
          // after the secrets, so no secret points the runner at another store or other checks than the
          // env's base profile; without the connector it has nothing to sync a store through
          ...runEnv(
            profileFor(
              launch.envId,
              hasConnectorSecret(db, launch.envId, "GITHUB_CONNECTOR"),
            ),
          ),
          ["CLAUDE_CODE_OAUTH_TOKEN", config.claudeOauthToken],
          ["AGENT_TOKEN", agentToken],
        ]),
        { op: "write-env-file", mode: 0o600, known },
      ),
    );
    await step(launch, "start runner", () =>
      startDetached(
        sprites,
        launch.spriteName,
        ["bash", "-c", RUNNER_COMMAND],
        {
          cwd: REPO_DIR,
          env: {
            AGENT_ID: launch.agentId,
            RUN_ID: launch.runId,
            API_BASE_URL: config.publicBaseUrl,
            ENV_FILE: envFilePath,
            PROMPT_FILE: promptFile,
            REPO_DIR,
            WORKTREES_DIR,
            APPROVAL_POLICY: JSON.stringify(launch.approvalPolicy),
            AUTO_APPROVE: JSON.stringify(launch.autoApprove),
            WAIT_TIMEOUT_MINUTES: String(config.waitTimeoutMs / 60_000),
            ...(launch.sessionId ? { SESSION_ID: launch.sessionId } : {}),
          },
          watchMs,
          op: "start-runner",
          known,
        },
      ).catch(async (err: unknown) => {
        // the runner never started, so nothing else deletes the file its secrets sit in
        await execInSprite(
          sprites,
          launch.spriteName,
          ["rm", "-f", envFilePath],
          {
            op: "rm-env-file",
            known,
          },
        ).catch(() => {});
        throw err;
      }),
    );
  }

  /**
   * A failed launch may mean the sprite is gone (an org move, a manual delete). The SDK reports a
   * missing sprite differently per call (an `APIError` from exec, a `FilesystemError` from a file
   * write, a socket error from a session), so the lookup decides, not the error. When it confirms
   * the sprite is gone, a ready environment fails at `create`, so `POST /v1/environments/:id/retry`
   * recreates the sprite. Throws when the lookup fails.
   */
  async function failEnvIfSpriteGone(launch: Launch): Promise<void> {
    if (await spriteExists(sprites, launch.spriteName)) return;
    const marked = db
      .update(environments)
      .set({
        status: "failed",
        failureStep: "create",
        failureStderr: `sprite ${launch.spriteName} no longer exists; a retry recreates it`,
      })
      .where(
        and(
          eq(environments.id, launch.envId),
          eq(environments.status, "ready"),
        ),
      )
      .run();
    if (marked.changes > 0) {
      log(
        `sprite ${launch.spriteName} is gone; environment ${launch.envId} marked failed`,
      );
    }
  }

  return {
    start(launch: Launch): void {
      const agentToken = mintAgentToken(config.apiKey, launch.runId);
      run(launch, agentToken)
        .catch(async (err: unknown) => {
          await failEnvIfSpriteGone(launch).catch((checkErr: unknown) => {
            log(
              `checking whether the sprite of environment ${launch.envId} exists failed: ${checkErr}`,
            );
          });
          // rethrown: the next catch still fails the run
          throw err;
        })
        .catch((err: unknown) => {
          // the SDK's socket errors quote the session URL, which carries the env
          const detail = redact(
            err instanceof Error ? err.message : String(err),
            [...secrets.values(), agentToken],
          );
          log(`launching ${launch.runId} failed: ${detail}`);
          db.transaction(
            (tx) => failRun(tx, launch.runId, `launch_failed: ${detail}`),
            { behavior: "immediate" },
          );
          nudgeDeliveries();
        })
        .catch((err: unknown) => {
          log(`launching ${launch.runId} could not record its outcome: ${err}`);
        });
    },
  };
}

export type Launcher = ReturnType<typeof createLauncher>;
