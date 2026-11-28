import { agents, type Db, environments, runs } from "@sky/db";
import {
  AgentId,
  type AutoApprove,
  apiKeyCredential,
  type BaseProfile,
  CODEX_GATEWAY_SECRET,
  type DrainStatus,
  EnvironmentId,
  isApiKeyCredential,
  POOL_CREDENTIAL,
  REPO_LOCK_FILE,
  REPO_LOCK_TIMED_OUT,
  RunId,
  type Runtime,
  spriteTaskNameFor,
} from "@sky/shared";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import { mintAgentToken } from "./agent-token.js";
import { runEnv } from "./base-profile.js";
import {
  ALL_KEYS_OUT,
  type ApiKeyCredit,
  apiKeyAuth,
  apiKeyCredentials,
  apiKeyValue,
  type ClaudeAuth,
  ClaudeCredentialError,
  credentialNameOf,
  creditRecovery,
  isCloudflareChallenge,
  isCreditExhausted,
  limitedUntil,
  markLimited,
  nextApiKey,
  parseUsageLimit,
  resolveClaudeAuth,
  subscriptionAuth,
  UNKNOWN_RESET_MS,
} from "./claude-credentials.js";
import {
  credentialsTried,
  earliestReset,
  nextInPool,
  poolExhausted,
  poolMembers,
  resolvePoolAuth,
} from "./claude-pool.js";
import type { UsageProbe } from "./claude-usage.js";
import type { Config } from "./config.js";
import { open, runLaunchAad, seal } from "./crypto.js";
import { mintId } from "./ids.js";
import { readMemory } from "./memory.js";
import {
  CodexInstallError,
  ensureCodex,
  ensurePi,
  envFile,
  PiInstallError,
  REPO_DIR,
  RUNNER,
  WITH_PACKAGE_MANAGERS,
  WORKTREES_DIR,
} from "./provision.js";
import { eventText, type KnownSecrets } from "./redact.js";
import type { BundleInstaller } from "./runner-bundle.js";
import {
  activeRunOf,
  failRun,
  isActive,
  isSilentLaunch,
  liveAgentTokens,
  NO_LAUNCH,
  recordEvent,
  type Tx,
} from "./runs.js";
import {
  CLAUDE_UNAVAILABLE,
  crossRuntimePrompt,
  effectiveRuntime,
  isGatewayUnavailable,
  RUNTIME_VARIABLE,
  runtimeName,
  unavailableCode,
  usesGateway,
  withSwitch,
} from "./runtime.js";
import {
  CONNECTOR_NAMES,
  hasConnectorSecret,
  isReservedName,
  openEnvSecrets,
  openRunEnvVars,
  postponeRunEnvVars,
  registerRunEnvVars,
  storeRunEnvVars,
} from "./secrets.js";
import {
  execInSprite,
  type SpriteOps,
  spriteExists,
  startDetached,
  writeSpriteFile,
} from "./sprites.js";

// the sprite's own socket and the task's life before the runner's first PUT refreshes it: long enough
// for a slow boot, short enough that a runner that never comes up lets the sprite pause again soon.
// The runner's first-hold retries give up within this expiry (keepalive.ts), so their failure report
// still lands while the sprite is held. `HOLD_TIMEOUT_MS` is the curl's `--max-time` plus the exec's
// own start; a hold that outlasts it is given up on, and the sprite is left to the runner's hold, if any
const SPRITE_API_SOCKET = "/.sprite/api.sock";
const HOLD_EXPIRE = "2m";
const CURL_MAX_TIME_S = 5;
const HOLD_TIMEOUT_MS = 10_000;

/** A curl to the run's keep-awake task; curl ships on every sprite image, and `-f` makes an HTTP error exit 22. */
const taskArgv = (
  runId: RunId,
  method: "PUT" | "DELETE",
  body: string[],
): [string, ...string[]] => [
  "curl",
  "-sSf",
  "--max-time",
  String(CURL_MAX_TIME_S),
  "--unix-socket",
  SPRITE_API_SOCKET,
  "-X",
  method,
  ...body,
  `http://sprite/v1/tasks/${spriteTaskNameFor(runId)}`,
];

/** The exec that takes the run's keep-awake task. */
export const holdArgv = (runId: RunId) =>
  taskArgv(runId, "PUT", [
    "-H",
    "content-type: application/json",
    "-d",
    JSON.stringify({ expire: HOLD_EXPIRE }),
  ]);

/** The exec that deletes the run's keep-awake task. */
export const releaseArgv = (runId: RunId) => taskArgv(runId, "DELETE", []);

/**
 * Whether a task curl failed on a 404, the Tasks API's answer for a task that doesn't exist. `-f`
 * gives every HTTP error exit 22, so the status comes from the `-S` message on stderr.
 */
const isMissingTask = (out: { exitCode: number; stderr: string }) =>
  out.exitCode === 22 && /returned error: 404\b/.test(out.stderr);

// the session's env reaches the sprite as URL query params, so secrets ride in ENV_FILE, sourced
// then deleted, and the prompt in PROMPT_FILE, which a query param is too short for;
// the run id in argv is what `runnerPattern` matches; the runner refuses to start unless it equals RUN_ID
const RUNNER_COMMAND = `${WITH_PACKAGE_MANAGERS} && set -a && . "$ENV_FILE" && set +a && rm -f "$ENV_FILE" && PROMPT="$(cat "$PROMPT_FILE")" && export PROMPT && exec node ${RUNNER} "$RUN_ID"`;

/**
 * The env-file entries that hand the runner exactly one Claude credential, under the names it reads
 * them by. The API key never goes as ANTHROPIC_API_KEY, which is the project's own variable.
 */
const claudeEnv = (auth: ClaudeAuth): [string, string][] =>
  auth.kind === "api-key"
    ? [
        ["SKY_CLAUDE_AUTH", "api-key"],
        ["SKY_CLAUDE_API_KEY", auth.key],
      ]
    : [
        ["SKY_CLAUDE_AUTH", "oauth"],
        ["CLAUDE_CODE_OAUTH_TOKEN", auth.token],
      ];

/** A launch refused for want of memory on its sprite; its message is the run's error. */
class LowMemoryError extends Error {}

/** A Codex or pi launch refused before any sprite work (no gateway key); its message is the run's error. */
class CodexLaunchError extends Error {}

/**
 * `pgrep -f`/`pkill -f` pattern matching only this run's runner, never its Claude child. Unanchored,
 * so a node started by its full path matches; the bash parent's argv holds a literal `"$RUN_ID"`,
 * and the matcher's own argv a `\.` and a trailing `$`, so neither matches.
 */
export const runnerPattern = (runId: RunId) =>
  `${RUNNER.replaceAll(".", "\\.")} ${runId}$`;

// a sprite that can't answer this fast is logged and left: the signal is best effort, and a caller
// that awaits it (stop, archive) answers its own client within the CLI's request timeout
const SIGNAL_TIMEOUT_MS = 10_000;

/**
 * SIGTERMs the run's runner, which aborts its Claude session and commits before exiting. A failure
 * is logged, not thrown; a runner already gone counts as signalled. Bounded by `SIGNAL_TIMEOUT_MS`.
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
      {
        op: "pkill",
        timeoutMs: Math.min(sprites.timeoutMs, SIGNAL_TIMEOUT_MS),
      },
    );
    // pkill exits 1 when nothing matched
    if (out.exitCode > 1) {
      log(`signalling the runner of ${runId} failed: ${out.stderr.trim()}`);
    }
  } catch (err) {
    log(`signalling the runner of ${runId} failed: ${err}`);
  }
}

/**
 * Whether the run's runner is alive on its sprite. The exec wakes a sleeping sprite, which is the
 * point: a run silent for minutes may have been frozen by a pause. Throws when the sprite can't answer,
 * which says nothing of the runner.
 */
export async function isRunnerAlive(
  sprites: SpriteOps,
  spriteName: string,
  runId: RunId,
): Promise<boolean> {
  const out = await execInSprite(
    sprites,
    spriteName,
    ["pgrep", "-f", runnerPattern(runId)],
    { op: "pgrep" },
  );
  // pgrep exits 1 when nothing matched, 2 or more on its own errors
  if (out.exitCode === 0) return true;
  if (out.exitCode === 1) return false;
  throw new Error(`pgrep exit ${out.exitCode}: ${out.stderr.trim()}`);
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

// a runner a stop or a failure already signalled normally exits within this on its own; a second
// SIGTERM kills a runner at once, so only the caller knowing it wedged signals one still alive.
// Together under the 20 s pre-launch deadline: each wait checks once more after its last sleep
const QUIET_WAIT_S = 5;
const TERM_WAIT_S = 9;
// $0 `term` or `wait`, $1 and $2 the seconds each wait lasts, $3 the pattern. Under `term` a runner
// still alive after the first wait is SIGTERMed; under `wait` the second wait only waits. Exits 0
// once nothing matches, 3 when that took the SIGTERM, 1 when a runner outlives both waits; pgrep's
// own errors exit 2
export const STOP_LINGERING = `gone() { for _ in $(seq "$1"); do pgrep -f "$2" >/dev/null; case $? in 1) return 0;; 0) sleep 1;; *) exit 2;; esac; done; pgrep -f "$2" >/dev/null; case $? in 1) return 0;; 0) return 1;; *) exit 2;; esac; }; gone "$1" "$3" && exit 0; if [ "$0" != term ]; then gone "$2" "$3" && exit 0; exit 1; fi; pkill -TERM -f "$3"; gone "$2" "$3" && exit 3; exit 1`;

export type LingeringRunner = "gone" | "terminated" | "alive";

/**
 * Waits out the runner of an ended run on its sprite: gives it a few seconds to exit, SIGTERMs it
 * when `maySignal`, then gives it time to commit and exit; `alive` when it outlasts both waits.
 * Without `maySignal` both waits only wait, for a runner something already signalled. One exec,
 * bounded by `deadlineMs`, which must cover both waits. Throws when the sprite can't answer in time
 * or pgrep fails on it.
 */
export async function stopLingeringRunner(
  sprites: SpriteOps,
  spriteName: string,
  runId: RunId,
  deadlineMs: number,
  maySignal: boolean,
): Promise<LingeringRunner> {
  const out = await execInSprite(
    sprites,
    spriteName,
    [
      "bash",
      "-c",
      STOP_LINGERING,
      maySignal ? "term" : "wait",
      String(QUIET_WAIT_S),
      String(TERM_WAIT_S),
      runnerPattern(runId),
    ],
    { op: "stop-lingering", timeoutMs: deadlineMs },
  );
  if (out.exitCode === 0) return "gone";
  if (out.exitCode === 3) return "terminated";
  if (out.exitCode === 1) return "alive";
  throw new Error(`exit ${out.exitCode}: ${out.stderr.trim()}`);
}

// bounded: a runner that outlives the wait loses whatever its commit hadn't written. Its 30 s runs
// in the same exec as REMOVE_WORKTREE, so the two waits share `sprites.timeoutMs`
const AWAIT_RUNNER_EXIT = `for _ in $(seq 30); do pgrep -f "$2" >/dev/null || break; sleep 1; done; `;
// fixed, not what is left of a launch's deadline as run setup's wait is: AWAIT_RUNNER_EXIT's 30 s
// plus this plus git's own removal must finish inside `sprites.timeoutMs`, or the exec times out
// before flock can report the lock
const REMOVE_LOCK_WAIT_S = 20;
// a worktree the runner never created (or whose directory is gone) counts as removed. The removal
// writes the shared repo's .git, so it takes the lock run setup takes; REPO_LOCK_TIMED_OUT is a lock
// that stayed held
export const REMOVE_WORKTREE = `flock -x -w ${REMOVE_LOCK_WAIT_S} -E ${REPO_LOCK_TIMED_OUT} .git/${REPO_LOCK_FILE} git worktree remove --force "$1"; case $? in 0) ;; ${REPO_LOCK_TIMED_OUT}) echo "can't take the repo lock ${REPO_DIR}/.git/${REPO_LOCK_FILE} within ${REMOVE_LOCK_WAIT_S}s: another run's setup is holding it" >&2; exit ${REPO_LOCK_TIMED_OUT};; *) ! test -e "$1";; esac`;

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
  /** Keeps pool subscriptions' usage fresh. */
  usage: UsageProbe;
  sprites: SpriteOps;
  ensureBundle: BundleInstaller;
  log: (line: string) => void;
  nudgeDeliveries: () => void;
  /** How long a launch stays attached to catch a runner that dies at start. */
  watchMs: number;
  /** How long after the runner starts a run that hasn't reported in gets its sprite woken. */
  wakeAfterMs: number;
  /**
   * Pauses between the waits on a failed run's runner to exit before its retry, one per extra wait;
   * `DEFAULT_RUNNER_EXIT_BACKOFF_MS` unless a test shortens them.
   */
  runnerExitBackoffMs?: number[];
  /**
   * Wakes the run's sprite and looks for its runner (see `wakeLaunch`): whether it is alive, or
   * `undefined` when the check failed; never throws.
   */
  wake: (runId: RunId, spriteName: string) => Promise<boolean | undefined>;
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
  /** The existing GitHub branch the runner starts from and publishes to; null for the agent's own. */
  remoteBranch: string | null;
  /**
   * Set on a retry of a run that hit its subscription's usage limit: the credential it runs on, the
   * API key or, in a pool environment, the next subscription. One the environment no longer allows
   * when the retry launches is dropped, and the retry resolves as a fresh launch would.
   */
  forceCredential?: string;
  /**
   * Set with `forceCredential` on the retry of a Cloudflare challenge: that credential is used even if
   * it is limited by now. The retry is dropped before it launches when the environment no longer
   * assigns it.
   */
  keepCredential?: boolean;
};

// what the runner is given once its launch deadline has passed: its config rejects 0, and the sweep
// fails the run anyway
const LAUNCH_LEFT_FLOOR_MS = 1_000;

// how long a run that met Cloudflare's challenge waits before its one retry
const CHALLENGE_RETRY_MS = 60_000;

// how long a launch is held for a retry, in memory and on its run's row; a run that long has ended
const REMEMBER_LAUNCH_MS = 12 * 3_600_000;
// the pauses between a failed runner's exit waits: with each wait's 30 s, about four minutes in all
const DEFAULT_RUNNER_EXIT_BACKOFF_MS = [5_000, 15_000, 30_000, 60_000];
// the retry's copy of the failed run's envVars lives this long, as a follow-up's default does
const RETRY_ENV_VARS_TTL_S = 3_600;

/** The prompt of a retry that resumes the agent's session: the original task, which that session may not hold whole. */
const resumedPrompt = (prompt: string) =>
  `Your previous attempt at this task was cut off before it finished. Continue it in this session: check the worktree for what is already done, then finish what remains. The task was:\n\n${prompt}`;

/** `Launch` as a schema: what a stored launch must be once opened. */
const LaunchSchema = z.object({
  envId: EnvironmentId,
  spriteName: z.string(),
  agentId: AgentId,
  runId: RunId,
  prompt: z.string(),
  sessionId: z.string().nullable(),
  approvalPolicy: z.array(z.string()),
  autoApprove: z.object({
    defaults: z.boolean(),
    commands: z.array(z.string()),
  }),
  remoteBranch: z.string().nullable(),
  forceCredential: z.string().optional(),
  keepCredential: z.boolean().optional(),
}) satisfies z.ZodType<Launch>;

/** A launch as kept for a retry: when it started rides with it, for the `REMEMBER_LAUNCH_MS` bound. */
const StoredLaunchSchema = z.object({ launch: LaunchSchema, at: z.number() });
type StoredLaunch = z.infer<typeof StoredLaunchSchema>;

/** Keeps a run's launch on its row, sealed like its env vars with the AAD bound to the run id. */
function storeLaunch(
  db: Db,
  key: Buffer,
  runId: RunId,
  stored: StoredLaunch,
): void {
  const sealed = seal(key, JSON.stringify(stored), runLaunchAad(runId));
  db.update(runs)
    .set({
      launchCiphertext: sealed.ciphertext,
      launchNonce: sealed.nonce,
      launchKeyVersion: sealed.keyVersion,
    })
    .where(eq(runs.id, runId))
    .run();
}

/** Drops the launch kept on a run's row. */
function clearLaunch(db: Db, runId: RunId): void {
  db.update(runs).set(NO_LAUNCH).where(eq(runs.id, runId)).run();
}

/** The launch kept on a run's row; undefined when none is, or one doesn't open under this key and run id or isn't the shape of a launch. */
function readLaunch(
  db: Db,
  key: Buffer,
  runId: RunId,
): StoredLaunch | undefined {
  const row = db
    .select({
      ciphertext: runs.launchCiphertext,
      nonce: runs.launchNonce,
      keyVersion: runs.launchKeyVersion,
    })
    .from(runs)
    .where(eq(runs.id, runId))
    .get();
  if (!row?.ciphertext || !row.nonce || row.keyVersion === null) {
    return undefined;
  }
  try {
    const sealed = {
      ciphertext: row.ciphertext,
      nonce: row.nonce,
      keyVersion: row.keyVersion,
    };
    const parsed = StoredLaunchSchema.safeParse(
      JSON.parse(open(key, sealed, runLaunchAad(runId))),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Where a failed run is retried, or why it is not (the warning left on it). */
type RetryTarget = { target: string } | { skip: string };

/**
 * Starts runners in the background; a launch that fails fails its run with a redacted
 * `launch_failed` error, and its environment too when its sprite is gone.
 */
export function createLauncher({
  db,
  config,
  secrets,
  usage,
  sprites,
  ensureBundle,
  log,
  nudgeDeliveries,
  watchMs,
  wakeAfterMs,
  runnerExitBackoffMs = DEFAULT_RUNNER_EXIT_BACKOFF_MS,
  wake,
}: Deps) {
  // the API keys, by credential, whose run failed with "Credit balance is too low", so launches that
  // would use one skip it, and fail at once when every key is marked, instead of starting a run that
  // dies the same way. A run finishing on a key doesn't clear it (it may have started before the
  // credit ran out); `clearCredit` does, and so does a restart, the way a new or topped-up key
  // reaches the server. In memory
  const keysOutOfCredit = new Set<string>();
  const credit: ApiKeyCredit = {
    outOfCredit: (credential) => keysOutOfCredit.has(credential),
  };

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

  /**
   * What is left of the run's launch deadline, in minutes, for the runner to bound its wait for the
   * repo lock by: the sweep fails the run at its createdAt plus the deadline, so a runner given the
   * whole deadline would still be queued then and its error naming the lock would never be seen.
   * Measured here rather than on the sprite, whose clock may differ.
   */
  function launchMinutesLeft(runId: RunId): number {
    const createdAt = db
      .select({ createdAt: runs.createdAt })
      .from(runs)
      .where(eq(runs.id, runId))
      .get()?.createdAt;
    const leftMs = createdAt
      ? Date.parse(createdAt) + config.launchDeadlineMs - Date.now()
      : 0;
    return Math.max(leftMs, LAUNCH_LEFT_FLOOR_MS) / 60_000;
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

  /**
   * Refuses a launch on a sprite with less than the configured floor of memory available: a runner
   * started there is killed mid-build, and the work since its last commit with it. A sprite whose
   * memory can't be read is launched on, as the floor is a guard, not a gate.
   */
  async function checkMemory(launch: Launch): Promise<void> {
    const floorMb = config.spriteMinFreeMb;
    if (floorMb <= 0) return;
    const memory = await readMemory(sprites, launch.spriteName).catch(
      (err: unknown) => {
        log(
          `launching ${launch.runId}: reading the memory of ${launch.spriteName} failed: ${err}`,
        );
        return undefined;
      },
    );
    if (!memory) {
      log(
        `launching ${launch.runId}: the memory of ${launch.spriteName} could not be read; launching anyway`,
      );
      return;
    }
    if (memory.availableMb < floorMb) {
      throw new LowMemoryError(
        `sprite_low_memory: sprite ${launch.spriteName} has ${memory.availableMb} MB of memory available (of ${memory.totalMb} MB), below the ${floorMb} MB floor; wait for a run on it to finish or lower the environment's concurrency, then retry`,
      );
    }
  }

  /**
   * Takes the run's keep-awake task: before the runner exists, since a sprite that pauses between the
   * launch watch detaching and the runner's own hold freezes the runner, and again on a wake, since a
   * woken launch can pause once more before that hold lands. Never why a launch fails.
   */
  async function holdSprite(launch: Launch, onFail: string): Promise<void> {
    try {
      await step(launch, "hold sprite", async () => {
        const out = await execInSprite(
          sprites,
          launch.spriteName,
          holdArgv(launch.runId),
          { op: "hold", timeoutMs: HOLD_TIMEOUT_MS },
        );
        if (out.exitCode !== 0) {
          throw new Error(`curl exit ${out.exitCode}: ${out.stderr.trim()}`);
        }
      });
    } catch (err) {
      log(`launching ${launch.runId}: hold sprite failed, ${onFail}: ${err}`);
    }
  }

  /**
   * Deletes the run's keep-awake task so its sprite is free to pause on its next idle window, not
   * held for the rest of the expiry. A task that is already gone counts as released; any other
   * failure is logged, never thrown.
   */
  async function releaseSprite(launch: Launch): Promise<void> {
    try {
      const out = await execInSprite(
        sprites,
        launch.spriteName,
        releaseArgv(launch.runId),
        { op: "release", timeoutMs: HOLD_TIMEOUT_MS },
      );
      if (out.exitCode !== 0 && !isMissingTask(out)) {
        throw new Error(`curl exit ${out.exitCode}: ${out.stderr.trim()}`);
      }
    } catch (err) {
      log(
        `launching ${launch.runId}: releasing the sprite hold failed: ${err}`,
      );
    }
  }

  /**
   * One wake for a run that still hasn't reported in `wakeAfterMs` after its runner started, which
   * then takes the run's hold again, so the sprite stays up until the runner refreshes it, unless the
   * wake found no runner to keep awake.
   */
  function wakeIfSilent(launch: Launch): void {
    setTimeout(() => {
      try {
        if (!isSilentLaunch(db, launch.runId)) return;
        log(
          `run ${launch.runId} still starting ${Math.round(wakeAfterMs / 1000)}s after its runner started; waking ${launch.spriteName}`,
        );
        // after the wake, not beside it: its exec is what resumes the sprite, and a resuming sprite's
        // socket may not answer yet. A failed check still holds: a sprite that couldn't be read may
        // hold a frozen runner, and the hold expires on its own. Neither call throws.
        void wake(launch.runId, launch.spriteName).then((alive) =>
          alive === false
            ? undefined
            : holdSprite(launch, "nothing more is tried"),
        );
      } catch (err) {
        log(`checking whether ${launch.runId} needs a wake failed: ${err}`);
      }
    }, wakeAfterMs).unref();
  }

  /**
   * Whether a credential chosen before a wait (a retry's, before the failed runner exits; a pool's
   * pick, before its usage probes answer) is still one the environment allows: the key while its
   * fallback is on, a subscription while the environment is still a pool holding it and it isn't
   * limited.
   */
  function stillAllowed(
    credential: string,
    env: NonNullable<ReturnType<typeof assignmentOf>>,
  ): boolean {
    if (isApiKeyCredential(credential)) {
      return (
        env.claudeFallback !== "none" &&
        apiKeyValue(config, credential) !== undefined &&
        !credit.outOfCredit(credential)
      );
    }
    return (
      env.claudeCredential === POOL_CREDENTIAL &&
      poolMembers(config, env.claudePool).includes(credential) &&
      limitedUntil(db, credential) === undefined
    );
  }

  /** The credential the launch runs on, by its environment's assignment; throws a `ClaudeCredentialError` when none is usable. */
  async function claudeAuthFor(launch: Launch): Promise<ClaudeAuth> {
    const forced = launch.forceCredential;
    if (forced && launch.keepCredential) {
      return isApiKeyCredential(forced)
        ? apiKeyAuth(config, "the retry", credit, forced)
        : subscriptionAuth(config, forced);
    }
    if (forced && stillAllowed(forced, currentAssignment(launch.envId))) {
      return isApiKeyCredential(forced)
        ? apiKeyAuth(config, "the retry", credit, forced)
        : subscriptionAuth(config, forced);
    }
    // a pool's pick waits on usage probes: an admin change meanwhile sends it round again. Each round
    // that waits probes a subscription that is then fresh or held for USAGE_STALE_MS, so the rounds end
    for (;;) {
      const assignment = currentAssignment(launch.envId);
      // only a pool environment's launch may land on a subscription it isn't assigned
      if (assignment.claudeCredential !== POOL_CREDENTIAL) {
        return resolveClaudeAuth(db, config, assignment, new Date(), credit);
      }
      const auth = await resolvePoolAuth(
        { db, config, usage, credit },
        assignment,
      );
      const after = currentAssignment(launch.envId);
      if (
        after.claudeCredential === POOL_CREDENTIAL &&
        stillAllowed(auth.credential, after)
      ) {
        return auth;
      }
    }
  }

  function currentAssignment(envId: EnvironmentId) {
    const assignment = assignmentOf(envId);
    if (!assignment) throw new Error(`environment ${envId} is gone`);
    return assignment;
  }

  /**
   * Whether the environment is ready and still assigns `credential`: as its own, as a member of its
   * pool, or as its API key fallback. Whether it is limited is not asked.
   */
  function stillAssigned(credential: string, envId: EnvironmentId): boolean {
    const env = assignmentOf(envId);
    if (env?.status !== "ready") return false;
    if (isApiKeyCredential(credential)) {
      return (
        (env.claudeCredential !== null &&
          isApiKeyCredential(env.claudeCredential)) ||
        env.claudeFallback !== "none"
      );
    }
    if (env.claudeCredential === POOL_CREDENTIAL) {
      return poolMembers(config, env.claudePool).includes(credential);
    }
    return credentialNameOf(env.claudeCredential) === credential;
  }

  const assignmentOf = (envId: EnvironmentId) =>
    db
      .select({
        status: environments.status,
        claudeCredential: environments.claudeCredential,
        claudeFallback: environments.claudeFallback,
        claudePool: environments.claudePool,
      })
      .from(environments)
      .where(eq(environments.id, envId))
      .get();

  /** The name, stored runtime and refresh script of the launch's environment. */
  function envOf(envId: EnvironmentId) {
    const row = db
      .select({
        name: environments.name,
        runtime: environments.runtime,
        refresh: environments.refresh,
      })
      .from(environments)
      .where(eq(environments.id, envId))
      .get();
    if (!row) throw new Error(`environment ${envId} is gone`);
    return row;
  }

  /**
   * The session the launch resumes and the prompt it gets: as the launch says, unless the agent's
   * session ran on a different runtime, which can't resume it. Then a fresh session on the agent's
   * branch, told so at the top of its prompt with the last run's summary.
   */
  function sessionFor(
    launch: Launch,
    runtime: Runtime,
    unrecordedRuntime: Runtime,
  ): { sessionId: string | null; prompt: string } {
    const same = { sessionId: launch.sessionId, prompt: launch.prompt };
    if (!launch.sessionId) return same;
    const agent = db
      .select({
        sessionRuntime: agents.sessionRuntime,
        branch: agents.branch,
        remoteBranch: agents.remoteBranch,
      })
      .from(agents)
      .where(eq(agents.id, launch.agentId))
      .get();
    if (!agent) return same;
    // a session from before runtimes were recorded ran on what this launch picks with no runtime stored
    const from = agent.sessionRuntime ?? unrecordedRuntime;
    if (from === runtime) return same;
    const last = db
      .select({ summary: runs.summary })
      .from(runs)
      .where(
        and(
          eq(runs.agentId, launch.agentId),
          ne(runs.id, launch.runId),
          isNotNull(runs.summary),
        ),
      )
      .orderBy(desc(runs.createdAt), desc(sql`${runs}.rowid`))
      .get();
    log(
      `launching ${launch.runId}: the agent's session ran on ${from}, not ${runtime}; starting a fresh session`,
    );
    return {
      sessionId: null,
      prompt: crossRuntimePrompt({
        prompt: launch.prompt,
        from,
        to: runtime,
        branch: agent.remoteBranch ?? agent.branch,
        summary: last?.summary ?? null,
      }),
    };
  }

  async function run(launch: Launch, agentToken: string): Promise<void> {
    const known = [agentToken];
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
    const env = envOf(launch.envId);
    // the environment's stored runtime wins; without one, a run's envVars override the env's secrets
    const runtimeVariable =
      envVars.get(RUNTIME_VARIABLE) ?? envSecrets.get(RUNTIME_VARIABLE);
    const runtime = effectiveRuntime(env.runtime, runtimeVariable);
    db.update(runs).set({ runtime }).where(eq(runs.id, launch.runId)).run();
    // before any sprite work: a launch with no usable credential fails at once, not after a dead run.
    // A Codex or pi run's model calls carry the gateway key, never a Claude credential
    let auth: ClaudeAuth | undefined;
    if (usesGateway(runtime)) {
      if (
        !envVars.has(CODEX_GATEWAY_SECRET) &&
        !envSecrets.has(CODEX_GATEWAY_SECRET)
      ) {
        throw new CodexLaunchError(
          withSwitch(
            `${unavailableCode(runtime)} this environment runs on ${runtimeName(runtime)} but has no ${CODEX_GATEWAY_SECRET} secret; set it with sky secret set ${env.name} ${CODEX_GATEWAY_SECRET}`,
            env.name,
            "claude-code",
          ),
        );
      }
      log(`launching ${launch.runId}: runtime ${runtime}`);
    } else {
      try {
        auth = await claudeAuthFor(launch);
      } catch (err) {
        if (
          err instanceof ClaudeCredentialError &&
          err.message.startsWith(CLAUDE_UNAVAILABLE)
        ) {
          throw new ClaudeCredentialError(
            withSwitch(err.message, env.name, "codex"),
          );
        }
        throw err;
      }
      known.push(auth.kind === "api-key" ? auth.key : auth.token);
      db.update(runs)
        .set({ claudeCredential: auth.credential })
        .where(eq(runs.id, launch.runId))
        .run();
      log(`launching ${launch.runId}: Claude credential ${auth.credential}`);
    }
    const session = sessionFor(
      launch,
      runtime,
      effectiveRuntime(null, runtimeVariable),
    );
    await step(launch, "memory check", () => checkMemory(launch));
    await step(launch, "bundle", () =>
      ensureBundle(launch.spriteName, launch.runId),
    );
    // a sprite provisioned before Codex or pi was has no such binary, which the runner would fail on
    if (usesGateway(runtime)) {
      await step(launch, runtime, () =>
        (runtime === "pi" ? ensurePi : ensureCodex)(
          sprites,
          launch.spriteName,
        ).catch((err: unknown) => {
          // the install's own failure is the environment's to fix or leave; the sprite's is not
          if (
            !(err instanceof CodexInstallError) &&
            !(err instanceof PiInstallError)
          )
            throw err;
          throw new CodexLaunchError(
            withSwitch(
              `${unavailableCode(runtime)} ${err.message}`,
              env.name,
              "claude-code",
            ),
          );
        }),
      );
    }
    const promptFile = `/workspace/runs/${launch.runId}.prompt`;
    await step(launch, "prompt file", () =>
      writeSpriteFile(sprites, launch.spriteName, promptFile, session.prompt, {
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
    // a launch or retry stored before the API refused these names: a run's envVars override the env's
    // secrets, and would point the runner's gateway calls, the connection id in them included, anywhere
    for (const name of CONNECTOR_NAMES) {
      if (!envVars.delete(name)) continue;
      log(
        `envVar ${name} on ${launch.envId} is the GitHub connector's; not passed to ${launch.runId}`,
      );
    }
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
          // the env's own script, so no secret can swap it for another; the runner runs it before the session
          ...(env.refresh === ""
            ? []
            : [["SKY_REFRESH", env.refresh] as const]),
          // the runtime resolved here, over the env's secret and the run's envVars
          [RUNTIME_VARIABLE, runtime],
          ...(auth ? claudeEnv(auth) : []),
          ["AGENT_TOKEN", agentToken],
        ]),
        { op: "write-env-file", mode: 0o600, known },
      ),
    );
    await holdSprite(launch, "starting the runner anyway");
    // from here a failure may leave a runner that did start, which `start` signals
    maybeStarted.add(launch.runId);
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
            LAUNCH_DEADLINE_MINUTES: String(launchMinutesLeft(launch.runId)),
            ...(session.sessionId ? { SESSION_ID: session.sessionId } : {}),
            ...(launch.remoteBranch
              ? { START_BRANCH: launch.remoteBranch }
              : {}),
          },
          watchMs,
          op: "start-runner",
          // its failure quotes the runner's output, which can echo any live run's token
          known: [...known, ...liveAgentTokens(db, config.apiKey)],
        },
      ).catch(async (err: unknown) => {
        // the runner never started, so nothing else deletes the file its secrets sit in or the task
        // that keeps its sprite awake until the expiry; neither cleanup replaces `err`
        await Promise.all([
          execInSprite(sprites, launch.spriteName, ["rm", "-f", envFilePath], {
            op: "rm-env-file",
            known,
          }).catch(() => {}),
          releaseSprite(launch),
        ]);
        throw err;
      }),
    );
    maybeStarted.delete(launch.runId);
    wakeIfSilent(launch);
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

  // launches by run, so a run that fails on its subscription's usage limit or Cloudflare's challenge
  // can be retried once. Also stored sealed on the run's row (`storeLaunch`), which a retry reads when the
  // map has no entry after a restart; a restart during a challenge retry's wait still loses the retry,
  // and the run stays failed with the challenge's error
  const launches = new Map<RunId, { launch: Launch; at: number }>();

  /** Takes the held launch of `runId` for its one retry, from memory else from its row; `missing` says why there is none to take. */
  function takeLaunch(runId: RunId): { launch: Launch } | { missing: string } {
    const entry =
      launches.get(runId) ?? readLaunch(db, config.secretEncryptionKey, runId);
    launches.delete(runId);
    // once: a second failure of the same run finds nothing, in memory or in the row
    clearLaunch(db, runId);
    if (!entry?.launch) {
      return {
        missing: `not retried: no record of this run's launch is held (the API restarted since this run launched and it was not recorded, it launched more than ${REMEMBER_LAUNCH_MS / 3_600_000} hours ago, or it was already retried)`,
      };
    }
    if (Date.now() - entry.at > REMEMBER_LAUNCH_MS) {
      return {
        missing: `not retried: this run launched more than ${REMEMBER_LAUNCH_MS / 3_600_000} hours ago`,
      };
    }
    return { launch: entry.launch };
  }

  /** Drops the launch of a run no retry can use, from memory and from its row. */
  function forgetLaunch(runId: RunId): void {
    launches.delete(runId);
    clearLaunch(db, runId);
  }

  /** Leaves `message`, which says why the failed run is not retried, as a warning on it. */
  function skipRetry(failedId: RunId, message: string): void {
    db.transaction(
      (tx) => recordEvent(tx, failedId, "runner.warning", { message }),
      { behavior: "immediate" },
    );
    log(
      message.startsWith("not retried")
        ? `${failedId} is ${message}`
        : `${failedId}: ${message}`,
    );
  }
  // challenge retries waiting out their delay or still launching, by failed run; a stop on the agent
  // cancels its own
  const challengeRetries = new Map<
    RunId,
    { agentId: AgentId; timer: ReturnType<typeof setTimeout> }
  >();
  // usage-limit retries from taking their launch until their transaction, by failed run to its agent;
  // a stop on the agent cancels its own, as it does a challenge retry
  const limitRetries = new Map<RunId, AgentId>();
  // runs whose launch is at or past the runner's start: one that fails there (a start that timed out
  // may still have spawned it) has its runner signalled, as a run failed `runner_timeout` does
  const maybeStarted = new Set<RunId>();

  /**
   * A run failed with `error`, and is retried once, resuming its session, when that is any of:
   *
   * - Cloudflare's challenge on Claude's login: after `CHALLENGE_RETRY_MS`, on the same credential
   *   even if it is limited by then, which is never marked limited. Dropped when the environment is
   *   no longer ready or no longer assigns the credential, and cancelled by a stop on the agent.
   * - its subscription reaching its usage limit: the subscription is marked limited until the reset
   *   time the error gives and the retry launches at once. An environment that isn't a pool retries
   *   on an API key with credit, unless it turns the fallback off or the server has none: never on
   *   another subscription. A pool environment goes on to the next subscription in its pool that its
   *   chain of retries hasn't tried, then to an API key on the same terms, else notes the earliest
   *   reset on the run.
   * - its API key being out of credit: the key is marked out of credit and the retry goes to the next
   *   key with credit that its chain of retries hasn't tried; with none left, the run fails
   *   `claude_unavailable`.
   *
   * Any retry is dropped when the agent has a run created after the failed one.
   */
  function onRunFailed(runId: RunId, error: string): void {
    const failed = db
      .select({
        credential: runs.claudeCredential,
        agentId: runs.agentId,
        runtime: runs.runtime,
      })
      .from(runs)
      .where(eq(runs.id, runId))
      .get();
    // `failureError` already found nothing left to run it on, and a Codex or pi run has no Claude
    // credential to move off
    if (
      usesGateway(failed?.runtime) ||
      error.startsWith(CLAUDE_UNAVAILABLE) ||
      isGatewayUnavailable(error)
    ) {
      forgetLaunch(runId);
      return;
    }
    const credential = failed?.credential;
    if (isCloudflareChallenge(error)) {
      // transient: the credential is untouched and the retry stays on it
      if (!failed || !credential) {
        forgetLaunch(runId);
        return;
      }
      const timer = setTimeout(() => {
        // a stop already cancelled and explained it
        if (!challengeRetries.has(runId)) return;
        void retryFailedRun(
          runId,
          (_, launch) => challengeTarget(launch.envId, credential),
          true,
        )
          .catch((err: unknown) => {
            log(
              `retrying ${runId} after a Cloudflare challenge failed: ${err}`,
            );
          })
          .finally(() => challengeRetries.delete(runId));
      }, CHALLENGE_RETRY_MS);
      timer.unref();
      challengeRetries.set(runId, { agentId: failed.agentId, timer });
      return;
    }
    // a run on an API key that ran out of credit goes on to the next key with credit; any other
    // failure on a key is not a retry candidate
    if (credential && isApiKeyCredential(credential)) {
      if (!isCreditExhausted(error)) {
        forgetLaunch(runId);
        return;
      }
      markOutOfCredit(credential, runId);
      void retryFailedRun(runId, (failedId, launch) =>
        creditTarget(failedId, launch.envId),
      ).catch((err: unknown) => {
        log(
          `retrying ${runId} after its API key ran out of credit failed: ${err}`,
        );
      });
      return;
    }
    const limit = parseUsageLimit(error);
    // not a retry candidate: nothing will use the launch kept for it
    if (!limit || !credential) {
      forgetLaunch(runId);
      return;
    }
    const until = limit.resetsAt ?? new Date(Date.now() + UNKNOWN_RESET_MS);
    markLimited(db, credential, until);
    log(
      `Claude credential ${credential} is at its ${limit.window} usage limit until ${until.toISOString()}`,
    );
    void retryFailedRun(runId, retryTarget).catch((err: unknown) => {
      log(`retrying ${runId} after its usage limit failed: ${err}`);
    });
  }

  /** Where a run that hit its subscription's limit goes next, if anywhere. */
  const retryTarget = (failedId: RunId, launch: Launch): RetryTarget =>
    limitTarget(failedId, launch.envId);

  /**
   * Where a run in `envId` that hit its subscription's limit goes next, if anywhere; with nothing left
   * to try, `unavailable` is the `claude_unavailable` error that says so, its reset time included.
   */
  function limitTarget(
    failedId: RunId,
    envId: EnvironmentId,
  ): RetryTarget | { skip: string; unavailable: string } {
    const env = assignmentOf(envId);
    if (env?.status !== "ready") {
      return { skip: "not retried: its environment is not ready" };
    }
    const key = nextApiKey(config, credit, credentialsTried(db, failedId));
    const noKey =
      env.claudeFallback === "none"
        ? "this environment's API key fallback is off"
        : apiKeyCredentials(config).length === 0
          ? "this server has no SKY_ANTHROPIC_API_KEY to fall back on"
          : key === undefined
            ? "the Anthropic API keys it falls back on are out of credit"
            : undefined;
    const fallback = noKey === undefined ? key : undefined;
    if (env.claudeCredential !== POOL_CREDENTIAL) {
      if (fallback) return { target: fallback };
      const tried = [...credentialsTried(db, failedId)].filter(
        (name) => !isApiKeyCredential(name),
      );
      const reset = earliestReset(db, tried, new Date());
      const which =
        tried.length === 1
          ? `the Claude credential ${JSON.stringify(tried[0])}`
          : "this environment's Claude credential";
      return {
        skip: "not retried: its environment has no other credential to use (the API-key fallback is off, the server has no key, or every key is out of credit)",
        unavailable: `${CLAUDE_UNAVAILABLE} ${which} is at its usage limit${reset ? ` and resets ${reset.toISOString()} (UTC)` : ""}; ${noKey}, so launch again after the reset`,
      };
    }
    const next = nextInPool(
      { db, config },
      env,
      credentialsTried(db, failedId),
    );
    if (next) return { target: next };
    if (fallback) return { target: fallback };
    // nothing is left to try: say when the pool is next available
    const members = poolMembers(config, env.claudePool);
    return {
      skip: poolExhausted(db, members, new Date(), "this run is not retried")
        .message,
      unavailable: poolExhausted(
        db,
        members,
        new Date(),
        `${noKey}, so launch again after the reset`,
      ).message,
    };
  }

  /**
   * The error a failed run is stored with: `error`, unless it says the run's runtime can't run. A
   * Claude run whose subscription hit its limit with no credential left to retry on, or whose API
   * key is out of credit (which marks the key so) with no key left to retry on, fails
   * `claude_unavailable`; a Codex or pi run the runner found refused by the AI Gateway
   * (`codex_unavailable`, `pi_unavailable`) keeps its words. Either gets the command that moves its environment to
   * another runtime. Marks a limited subscription as `onRunFailed` does, so the retry it then
   * picks agrees with what this said.
   */
  function failureError(runId: RunId, error: string): string {
    const row = db
      .select({
        credential: runs.claudeCredential,
        runtime: runs.runtime,
        envId: agents.envId,
        envName: environments.name,
      })
      .from(runs)
      .innerJoin(agents, eq(runs.agentId, agents.id))
      .innerJoin(environments, eq(agents.envId, environments.id))
      .where(eq(runs.id, runId))
      .get();
    if (!row) return error;
    if (usesGateway(row.runtime)) {
      return isGatewayUnavailable(error)
        ? withSwitch(error, row.envName, "claude-code")
        : error;
    }
    const credential = row.credential;
    if (!credential) return error;
    if (isApiKeyCredential(credential)) {
      if (!isCreditExhausted(error)) return error;
      markOutOfCredit(credential, runId);
      const target = creditTarget(runId, row.envId);
      // another key has credit: the run is retried on it, and keeps its own error
      if (!("unavailable" in target)) return error;
      return withSwitch(target.unavailable, row.envName, "codex");
    }
    const limit = parseUsageLimit(error);
    if (!limit) return error;
    markLimited(
      db,
      credential,
      limit.resetsAt ?? new Date(Date.now() + UNKNOWN_RESET_MS),
    );
    const target = limitTarget(runId, row.envId);
    if (!("unavailable" in target)) return error;
    return withSwitch(target.unavailable, row.envName, "codex");
  }

  /** Marks the API key `credential` out of credit, after the failure of `runId`. */
  function markOutOfCredit(credential: string, runId: RunId): void {
    if (keysOutOfCredit.has(credential)) return;
    keysOutOfCredit.add(credential);
    log(
      `the Anthropic API key ${credential} is out of credit (${runId}); launches skip it until it is cleared or the API restarts`,
    );
  }

  /**
   * Where a run in `envId` whose API key ran out of credit goes next, if anywhere: the next key with
   * credit that its chain of retries hasn't tried. With none left, `unavailable` is the
   * `claude_unavailable` error that says every key is out.
   */
  function creditTarget(
    failedId: RunId,
    envId: EnvironmentId,
  ): RetryTarget | { skip: string; unavailable: string } {
    const tried = credentialsTried(db, failedId);
    const next = nextApiKey(config, credit, tried);
    if (next) {
      return stillAssigned(next, envId)
        ? { target: next }
        : {
            skip: "not retried: its environment is not ready or no longer allows an API key",
          };
    }
    // a subscription earlier in the run's chain hit its limit before it fell back on the keys
    const subscriptions = [...tried].filter(
      (name) => !isApiKeyCredential(name),
    );
    const reset = earliestReset(db, subscriptions, new Date());
    const cause = reset
      ? `the Claude subscriptions this run tried are at their usage limit until ${reset.toISOString()} (UTC), and ${ALL_KEYS_OUT}`
      : ALL_KEYS_OUT;
    return {
      skip: "not retried: every Anthropic API key is out of credit",
      unavailable: `${CLAUDE_UNAVAILABLE} ${cause}; ${creditRecovery(config)}`,
    };
  }

  /**
   * Clears the out-of-credit mark of one API key, by its name (`backup`, `default`) or its credential
   * (`api-key:backup`, `api-key`), for after it is topped up. Returns the credential, or undefined
   * when this server holds no key by that name.
   */
  function clearCredit(
    name: string,
  ): { credential: string; wasOut: boolean } | undefined {
    const credential = apiKeyCredentials(config).find(
      (c) => c === name || c === apiKeyCredential(name),
    );
    if (!credential) return undefined;
    const wasOut = keysOutOfCredit.delete(credential);
    if (wasOut)
      log(`the Anthropic API key ${credential} was cleared as having credit`);
    return { credential, wasOut };
  }

  /** Where a run that met Cloudflare's challenge on `credential` goes next: that one, while its environment still assigns it. */
  function challengeTarget(
    envId: EnvironmentId,
    credential: string,
  ): RetryTarget {
    if (stillAssigned(credential, envId)) return { target: credential };
    return {
      skip: `not retried after the Cloudflare challenge: its environment is not ready or no longer assigns Claude credential ${credential}`,
    };
  }

  /** Waits for the failed run's runner to exit, pausing between waits as `runnerExitBackoffMs` says; false if it never does. */
  async function runnerExited(
    spriteName: string,
    failedId: RunId,
  ): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
      if (await awaitRunnerExit(sprites, spriteName, failedId)) return true;
      const pause = runnerExitBackoffMs[attempt];
      if (pause === undefined) return false;
      log(
        `the runner of ${failedId} is still exiting; waiting again in ${Math.round(pause / 1000)}s`,
      );
      await new Promise((resolve) => setTimeout(resolve, pause).unref());
    }
  }

  /** Whether the agent has a run other than `runId` created since it. */
  const hasRunAfter = (tx: Tx, agentId: AgentId, runId: RunId) => {
    const failedAt = tx
      .select({ createdAt: runs.createdAt })
      .from(runs)
      .where(eq(runs.id, runId))
      .get()?.createdAt;
    return (
      failedAt !== undefined &&
      tx
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            eq(runs.agentId, agentId),
            ne(runs.id, runId),
            gte(runs.createdAt, failedAt),
          ),
        )
        .get() !== undefined
    );
  };

  /**
   * Retries a failed run once on the credential `targetOf` names, resuming its session.
   * `keepCredential` marks a challenge retry (see `onRunFailed`).
   */
  async function retryFailedRun(
    failedId: RunId,
    targetOf: (failedId: RunId, launch: Launch) => RetryTarget,
    keepCredential = false,
  ): Promise<void> {
    const taken = takeLaunch(failedId);
    if ("missing" in taken) {
      skipRetry(failedId, taken.missing);
      return;
    }
    if (keepCredential) {
      await retryTaken(failedId, taken.launch, targetOf, true);
      return;
    }
    limitRetries.set(failedId, taken.launch.agentId);
    try {
      await retryTaken(failedId, taken.launch, targetOf, false);
    } finally {
      limitRetries.delete(failedId);
    }
  }

  /** The rest of `retryFailedRun`, once the launch is taken. */
  async function retryTaken(
    failedId: RunId,
    launch: Launch,
    targetOf: (failedId: RunId, launch: Launch) => RetryTarget,
    keepCredential: boolean,
  ): Promise<void> {
    // a stop on the agent dropped the retry's entry, and recorded why it is not retried
    const stopped = () =>
      !(keepCredential ? challengeRetries : limitRetries).has(failedId);
    const picked = targetOf(failedId, launch);
    if ("skip" in picked) {
      skipRetry(failedId, picked.skip);
      return;
    }
    const { target } = picked;
    // the failed runner commits in the worktree the retry resumes in
    let exited: boolean;
    try {
      exited = await runnerExited(launch.spriteName, failedId);
    } catch (err) {
      if (!stopped()) {
        skipRetry(
          failedId,
          "not retried: the sprite could not say whether the runner had exited",
        );
      }
      throw err;
    }
    if (!exited) {
      if (!stopped()) {
        skipRetry(failedId, "not retried: the runner was still exiting");
      }
      return;
    }
    const envVars = Object.fromEntries(
      openRunEnvVars(db, config.secretEncryptionKey, failedId),
    );
    const retryId = mintId("run");
    const outcome = db.transaction(
      (tx) => {
        const found = tx
          .select()
          .from(agents)
          .where(eq(agents.id, launch.agentId))
          .get();
        // an archived agent, or one a follow-up already took, is not run twice
        if (!found || found.archivedAt || activeRunOf(tx, found.id)) {
          return { kind: "taken" } as const;
        }
        // a follow-up sent since the failure moved the agent on, even one that has ended by now
        if (hasRunAfter(tx, found.id, failedId)) {
          return { kind: "superseded" } as const;
        }
        if (stopped()) return { kind: "cancelled" } as const;
        // the assignment can change while the failed runner exits too
        if (keepCredential && "skip" in challengeTarget(launch.envId, target)) {
          return { kind: "unassigned" } as const;
        }
        tx.insert(runs)
          .values({
            id: retryId,
            agentId: found.id,
            status: api.entryStatus(),
            // set by the launch once it settles on one: `target` may be refused there
            claudeCredential: null,
            retryOf: failedId,
          })
          .run();
        storeRunEnvVars(
          tx,
          config.secretEncryptionKey,
          retryId,
          envVars,
          RETRY_ENV_VARS_TTL_S,
        );
        tx.update(agents)
          .set({ status: "running" })
          .where(eq(agents.id, found.id))
          .run();
        return { kind: "created", agent: found } as const;
      },
      { behavior: "immediate" },
    );
    switch (outcome.kind) {
      case "superseded":
        skipRetry(failedId, "not retried: its agent has a newer run");
        return;
      case "taken":
        skipRetry(
          failedId,
          "not retried: its agent was archived or already has a run in progress",
        );
        return;
      case "cancelled":
        // the stop already recorded why
        return;
      case "unassigned":
        skipRetry(
          failedId,
          `not retried after the Cloudflare challenge: its environment is not ready or no longer assigns Claude credential ${target}`,
        );
        return;
    }
    const { agent } = outcome;
    registerRunEnvVars(secrets, retryId, envVars);
    log(`retrying ${failedId} as ${retryId} on Claude credential ${target}`);
    api.start({
      ...launch,
      runId: retryId,
      sessionId: agent.sessionId,
      prompt: agent.sessionId ? resumedPrompt(launch.prompt) : launch.prompt,
      forceCredential: target,
      keepCredential,
    });
  }

  const api = {
    onRunFailed,
    failureError,
    clearCredit,
    /** Whether an API key, by credential, is marked out of credit. */
    outOfCredit: (credential: string) => credit.outOfCredit(credential),
    /**
     * Cancels the agent's pending retries, of a Cloudflare challenge or of a usage limit (one waiting
     * on its failed runner's exit): a stop ends the task, run or not.
     */
    cancelChallengeRetry(agentId: AgentId): void {
      for (const [failedId, retryAgentId] of limitRetries) {
        if (retryAgentId !== agentId) continue;
        limitRetries.delete(failedId);
        skipRetry(failedId, "not retried: its agent was stopped");
      }
      for (const [failedId, pending] of challengeRetries) {
        if (pending.agentId !== agentId) continue;
        clearTimeout(pending.timer);
        challengeRetries.delete(failedId);
        launches.delete(failedId);
        clearLaunch(db, failedId);
        skipRetry(failedId, "not retried: its agent was stopped");
      }
    },
    /**
     * Launches the run, or, when its row says `queued` (see `entryStatus`), holds its launch until
     * the drain ends.
     */
    start(launch: Launch): void {
      if (!isQueued(launch.runId)) {
        begin(launch);
        return;
      }
      hold(launch);
      // a drain whose deadline passed between the run's insert and here has nobody left to release it
      if (!draining()) releaseQueued();
    },
    /**
     * The status a run is inserted with: `queued` while the API drains, else `starting`. Its callers
     * call it inside their own transaction, so a drain that has just passed its deadline releases
     * the held launches there too, in a nested transaction.
     */
    entryStatus: (): "queued" | "starting" =>
      draining() ? "queued" : "starting",
    /**
     * Starts holding new launches, for `timeoutMs`; a drain already on keeps its start and takes the
     * new deadline.
     */
    startDrain(timeoutMs: number): DrainStatus {
      const now = Date.now();
      drainState = {
        since: drainState?.since ?? now,
        deadline: now + timeoutMs,
      };
      armDrainTimer();
      log(`draining: new launches are held until ${iso(drainState.deadline)}`);
      return drainStatus();
    },
    /** Ends the drain and releases the held launches; false when none was on. */
    endDrain(): boolean {
      const was = draining();
      if (was) finishDrain("cancelled");
      return was;
    },
    drainStatus,
    /** Starts every held launch, oldest first; the boot calls this for the launches a previous process held. */
    releaseQueued,
  };

  const iso = (ms: number) => new Date(ms).toISOString();
  // in memory only: a restart ends the drain, and the boot releases what it held
  let drainState: { since: number; deadline: number } | undefined;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;

  /** Ends the drain at its deadline without a request to notice it; a timer that fires early is set again for the rest. */
  function armDrainTimer(): void {
    if (drainTimer) clearTimeout(drainTimer);
    drainTimer = undefined;
    if (!drainState) return;
    drainTimer = setTimeout(
      () => {
        drainTimer = undefined;
        if (draining()) armDrainTimer();
      },
      Math.max(1, drainState.deadline - Date.now()),
    );
    drainTimer.unref();
  }

  /** Whether a drain is on, ending one whose deadline has passed. */
  function draining(): boolean {
    if (drainState && Date.now() >= drainState.deadline) {
      finishDrain("reached its deadline");
    }
    return drainState !== undefined;
  }

  function finishDrain(why: string): void {
    drainState = undefined;
    if (drainTimer) clearTimeout(drainTimer);
    drainTimer = undefined;
    const released = releaseQueued();
    log(`drain ${why}: released ${released} held launches`);
  }

  function drainStatus(): DrainStatus {
    const on = draining() ? drainState : undefined;
    // a failed run whose retry is still in memory: a restart would lose that retry
    const awaitingRetry = [...challengeRetries.keys(), ...limitRetries.keys()];
    const active = db
      .select({ id: runs.id })
      .from(runs)
      .where(
        or(
          inArray(runs.status, ["starting", "running"]),
          awaitingRetry.length > 0
            ? inArray(runs.id, awaitingRetry)
            : undefined,
        ),
      )
      .orderBy(asc(runs.createdAt))
      .all()
      .map((r) => r.id);
    const held = db
      .select({ n: count() })
      .from(runs)
      .where(eq(runs.status, "queued"))
      .get();
    return {
      draining: on !== undefined,
      since: on ? iso(on.since) : null,
      deadline: on ? iso(on.deadline) : null,
      active,
      held: held?.n ?? 0,
      ready: active.length === 0,
    };
  }

  const isQueued = (runId: RunId) =>
    db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.id, runId), eq(runs.status, "queued")))
      .get() !== undefined;

  /** Keeps a queued run's launch, in memory and sealed on its row so a restart still has it. */
  function hold(launch: Launch): void {
    const now = Date.now();
    launches.set(launch.runId, { launch, at: now });
    try {
      storeLaunch(db, config.secretEncryptionKey, launch.runId, {
        launch,
        at: now,
      });
    } catch (err) {
      log(
        `keeping the held launch of ${launch.runId} failed; a restart before its release fails it: ${err}`,
      );
    }
    log(`holding ${launch.runId}: the API is draining`);
  }

  /**
   * Moves every queued run to `starting`, oldest first, and launches it as a fresh launch would be.
   * Its clock restarts, so the launch deadline counts from the release, not from the hold, and its
   * envVars' expiry moves later by as long as it was held. A run whose launch can't be read fails,
   * rather than sit queued. Returns how many it released.
   */
  function releaseQueued(): number {
    const queued = db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.status, "queued"))
      .orderBy(asc(runs.createdAt), sql`${runs}.rowid`)
      .all();
    let released = 0;
    for (const { id } of queued) {
      const claimed = db.transaction(
        (tx) => {
          const isHeld = and(eq(runs.id, id), eq(runs.status, "queued"));
          const heldSince = tx
            .select({ createdAt: runs.createdAt })
            .from(runs)
            .where(isHeld)
            .get()?.createdAt;
          if (heldSince === undefined) return false;
          const now = new Date();
          tx.update(runs)
            .set({ status: "starting", createdAt: now.toISOString() })
            .where(isHeld)
            .run();
          // clamped: a wall clock stepped back never shortens what the caller asked for
          const heldMs = Math.max(0, now.getTime() - Date.parse(heldSince));
          postponeRunEnvVars(tx, id, heldMs);
          return true;
        },
        { behavior: "immediate" },
      );
      if (!claimed) continue;
      released++;
      const held =
        launches.get(id) ?? readLaunch(db, config.secretEncryptionKey, id);
      if (!held) {
        db.transaction(
          (tx) =>
            failRun(
              tx,
              id,
              "launch_failed: the launch held while the API drained could not be read back",
            ),
          { behavior: "immediate" },
        );
        nudgeDeliveries();
        continue;
      }
      begin(held.launch);
    }
    return released;
  }

  /** Launches the run in the background; the rest of what `start` does once it is not held. */
  function begin(launch: Launch): void {
    const now = Date.now();
    for (const [id, held] of launches) {
      if (now - held.at > REMEMBER_LAUNCH_MS) launches.delete(id);
    }
    launches.set(launch.runId, { launch, at: now });
    // what a retry needs survives a restart; rows past the bound drop theirs. A write that fails
    // only loses that: the run's row is already committed, and a throw here would leave it in
    // `starting` with no runner
    try {
      storeLaunch(db, config.secretEncryptionKey, launch.runId, {
        launch,
        at: now,
      });
      db.update(runs)
        .set(NO_LAUNCH)
        .where(
          and(
            isNotNull(runs.launchCiphertext),
            lt(
              runs.createdAt,
              new Date(now - REMEMBER_LAUNCH_MS).toISOString(),
            ),
          ),
        )
        .run();
    } catch (err) {
      log(
        `keeping the launch of ${launch.runId} for a retry failed; a restart before it ends loses the retry: ${err}`,
      );
    }
    const agentToken = mintAgentToken(config.apiKey, launch.runId);
    run(launch, agentToken)
      .catch(async (err: unknown) => {
        // no sprite to blame: the launch never reached one
        if (
          err instanceof ClaudeCredentialError ||
          err instanceof CodexLaunchError
        ) {
          throw err;
        }
        await failEnvIfSpriteGone(launch).catch((checkErr: unknown) => {
          log(
            `checking whether the sprite of environment ${launch.envId} exists failed: ${checkErr}`,
          );
        });
        // rethrown: the next catch still fails the run
        throw err;
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        // the SDK's socket errors quote the session URL, which carries the env, and a sprite's
        // stderr can echo any live run's token. This run's own is listed too: it may have ended
        const known = [
          ...secrets.values(),
          agentToken,
          ...liveAgentTokens(db, config.apiKey),
        ];
        const stored = eventText(message, known);
        log(`launching ${launch.runId} failed: ${stored}`);
        const ended = db.transaction(
          (tx) => {
            return failRun(
              tx,
              launch.runId,
              // already worded as a run error, with its own code
              err instanceof LowMemoryError ||
                err instanceof ClaudeCredentialError ||
                err instanceof CodexLaunchError
                ? stored
                : `launch_failed: ${stored}`,
            );
          },
          { behavior: "immediate" },
        );
        nudgeDeliveries();
        // best effort, not awaited: a sprite that can't be reached is logged by `signalRunner`.
        // A run something else already ended had its runner signalled there; a second SIGTERM kills it
        if (maybeStarted.delete(launch.runId) && ended) {
          void signalRunner(sprites, launch.spriteName, launch.runId, log);
        }
      })
      .catch((err: unknown) => {
        log(`launching ${launch.runId} could not record its outcome: ${err}`);
      });
  }
  return api;
}

export type Launcher = ReturnType<typeof createLauncher>;
