import { agents, type Db, environments, runs } from "@sky/db";
import {
  type AgentId,
  API_KEY_CREDENTIAL,
  type AutoApprove,
  type BaseProfile,
  type EnvironmentId,
  POOL_CREDENTIAL,
  type RunId,
  spriteTaskNameFor,
} from "@sky/shared";
import { and, eq } from "drizzle-orm";
import { mintAgentToken } from "./agent-token.js";
import { runEnv } from "./base-profile.js";
import {
  apiKeyAuth,
  type ClaudeAuth,
  ClaudeCredentialError,
  markLimited,
  parseUsageLimit,
  resolveClaudeAuth,
  subscriptionAuth,
  UNKNOWN_RESET_MS,
} from "./claude-credentials.js";
import {
  credentialsTried,
  nextInPool,
  poolExhausted,
  poolMembers,
  resolvePoolAuth,
} from "./claude-pool.js";
import type { UsageProbe } from "./claude-usage.js";
import type { Config } from "./config.js";
import { mintId } from "./ids.js";
import { readMemory } from "./memory.js";
import {
  envFile,
  REPO_DIR,
  RUNNER,
  WITH_PACKAGE_MANAGERS,
  WORKTREES_DIR,
} from "./provision.js";
import { type KnownSecrets, redact } from "./redact.js";
import type { BundleInstaller } from "./runner-bundle.js";
import {
  activeRunOf,
  failRun,
  isActive,
  isSilentLaunch,
  recordEvent,
} from "./runs.js";
import {
  hasConnectorSecret,
  isReservedName,
  openEnvSecrets,
  openRunEnvVars,
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
   * API key or, in a pool environment, the next subscription, whatever the environment's assignment.
   */
  forceCredential?: string;
};

// how long a launch is kept in memory for a retry after a usage limit; a run that long has ended
const REMEMBER_LAUNCH_MS = 12 * 3_600_000;
// the retry's copy of the failed run's envVars lives this long, as a follow-up's default does
const RETRY_ENV_VARS_TTL_S = 3_600;

/** The prompt of a retry that resumes the agent's session: the original task, which that session may not hold whole. */
const resumedPrompt = (prompt: string) =>
  `Your previous attempt at this task was cut off before it finished. Continue it in this session: check the worktree for what is already done, then finish what remains. The task was:\n\n${prompt}`;

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
  wake,
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

  /** The credential the launch runs on, by its environment's assignment; throws a `ClaudeCredentialError` when none is usable. */
  async function claudeAuthFor(launch: Launch): Promise<ClaudeAuth> {
    if (launch.forceCredential === API_KEY_CREDENTIAL) {
      return apiKeyAuth(config, "the retry");
    }
    if (launch.forceCredential) {
      return subscriptionAuth(config, launch.forceCredential);
    }
    const assignment = assignmentOf(launch.envId);
    if (!assignment) throw new Error(`environment ${launch.envId} is gone`);
    // only a pool environment's launch may land on a subscription it isn't assigned
    return assignment.claudeCredential === POOL_CREDENTIAL
      ? resolvePoolAuth({ db, config, usage }, assignment)
      : resolveClaudeAuth(db, config, assignment);
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

  async function run(launch: Launch, agentToken: string): Promise<void> {
    const known = [agentToken];
    // before any sprite work: a launch with no usable credential fails at once, not after a dead run
    const auth = await claudeAuthFor(launch);
    known.push(auth.kind === "api-key" ? auth.key : auth.token);
    db.update(runs)
      .set({ claudeCredential: auth.credential })
      .where(eq(runs.id, launch.runId))
      .run();
    log(`launching ${launch.runId}: Claude credential ${auth.credential}`);
    await step(launch, "memory check", () => checkMemory(launch));
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
          ...claudeEnv(auth),
          ["AGENT_TOKEN", agentToken],
        ]),
        { op: "write-env-file", mode: 0o600, known },
      ),
    );
    await holdSprite(launch, "starting the runner anyway");
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
            ...(launch.remoteBranch
              ? { START_BRANCH: launch.remoteBranch }
              : {}),
          },
          watchMs,
          op: "start-runner",
          known,
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

  // launches by run, so a run that fails on its subscription's usage limit can be retried once on the
  // API key. In memory: a restart between the launch and the failure loses the retry, never the limit
  const launches = new Map<RunId, { launch: Launch; at: number }>();

  /**
   * A run failed with `error`. When that is its subscription reaching its usage limit, the
   * subscription is marked limited until the reset time the error gives, and the run is retried
   * once, resuming its session. An environment that isn't a pool retries on the API key, unless it
   * turns the fallback off or the server has none: never on another subscription. A pool
   * environment goes on to the next subscription in its pool that its chain of retries hasn't
   * tried, then to the API key on the same terms, else notes the earliest reset on the run.
   */
  function onRunFailed(runId: RunId, error: string): void {
    const limit = parseUsageLimit(error);
    if (!limit) return;
    const credential = db
      .select({ credential: runs.claudeCredential })
      .from(runs)
      .where(eq(runs.id, runId))
      .get()?.credential;
    // a run on the API key hit something other than a subscription's limit
    if (!credential || credential === API_KEY_CREDENTIAL) return;
    const until = limit.resetsAt ?? new Date(Date.now() + UNKNOWN_RESET_MS);
    markLimited(db, credential, until);
    log(
      `Claude credential ${credential} is at its ${limit.window} usage limit until ${until.toISOString()}`,
    );
    void retryAfterLimit(runId).catch((err: unknown) => {
      log(`retrying ${runId} after its usage limit failed: ${err}`);
    });
  }

  /** Where a run that hit its subscription's limit goes next, if anywhere. */
  function retryTarget(failedId: RunId, launch: Launch): string | undefined {
    const env = assignmentOf(launch.envId);
    if (env?.status !== "ready") return undefined;
    const fallback =
      env.claudeFallback !== "none" && config.anthropicApiKey
        ? API_KEY_CREDENTIAL
        : undefined;
    if (env.claudeCredential !== POOL_CREDENTIAL) return fallback;
    const next = nextInPool(
      { db, config },
      env,
      credentialsTried(db, failedId),
    );
    if (next) return next;
    if (fallback) return fallback;
    // nothing is left to try: say when the pool is next available
    const members = poolMembers(config, env.claudePool);
    const warning = poolExhausted(
      db,
      members,
      new Date(),
      "this run is not retried",
    ).message;
    db.transaction(
      (tx) => recordEvent(tx, failedId, "runner.warning", { message: warning }),
      { behavior: "immediate" },
    );
    log(`${failedId}: ${warning}`);
    return undefined;
  }

  async function retryAfterLimit(failedId: RunId): Promise<void> {
    const entry = launches.get(failedId);
    if (!entry) {
      log(`no launch of ${failedId} is held; it is not retried`);
      return;
    }
    // once: a second failure of the same run finds nothing
    launches.delete(failedId);
    const { launch } = entry;
    const target = retryTarget(failedId, launch);
    if (!target) return;
    // the failed runner commits in the worktree the retry resumes in
    if (!(await awaitRunnerExit(sprites, launch.spriteName, failedId))) {
      log(`the runner of ${failedId} is still exiting; not retried`);
      return;
    }
    const envVars = Object.fromEntries(
      openRunEnvVars(db, config.secretEncryptionKey, failedId),
    );
    const retryId = mintId("run");
    const agent = db.transaction(
      (tx) => {
        const found = tx
          .select()
          .from(agents)
          .where(eq(agents.id, launch.agentId))
          .get();
        // an archived agent, or one a follow-up already took, is not run twice
        if (!found || found.archivedAt || activeRunOf(tx, found.id)) {
          return undefined;
        }
        tx.insert(runs)
          .values({
            id: retryId,
            agentId: found.id,
            status: "starting",
            claudeCredential: target,
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
        return found;
      },
      { behavior: "immediate" },
    );
    if (!agent) return;
    registerRunEnvVars(secrets, retryId, envVars);
    log(`retrying ${failedId} as ${retryId} on Claude credential ${target}`);
    api.start({
      ...launch,
      runId: retryId,
      sessionId: agent.sessionId,
      prompt: agent.sessionId ? resumedPrompt(launch.prompt) : launch.prompt,
      forceCredential: target,
    });
  }

  const api = {
    onRunFailed,
    start(launch: Launch): void {
      const now = Date.now();
      for (const [id, held] of launches) {
        if (now - held.at > REMEMBER_LAUNCH_MS) launches.delete(id);
      }
      launches.set(launch.runId, { launch, at: now });
      const agentToken = mintAgentToken(config.apiKey, launch.runId);
      run(launch, agentToken)
        .catch(async (err: unknown) => {
          // no sprite to blame: the launch never reached one
          if (err instanceof ClaudeCredentialError) throw err;
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
            (tx) =>
              failRun(
                tx,
                launch.runId,
                // already worded as a run error, with its own code
                err instanceof LowMemoryError ||
                  err instanceof ClaudeCredentialError
                  ? detail
                  : `launch_failed: ${detail}`,
              ),
            { behavior: "immediate" },
          );
          nudgeDeliveries();
        })
        .catch((err: unknown) => {
          log(`launching ${launch.runId} could not record its outcome: ${err}`);
        });
    },
  };
  return api;
}

export type Launcher = ReturnType<typeof createLauncher>;
