import { createHash, randomBytes } from "node:crypto";
import {
  APIError,
  type ServiceLogEvent,
  type ServiceRequest,
} from "@fly/sprites";
import { agents, type Db, environments, previews } from "@sky/db";
import {
  type AgentId,
  type EnvironmentId,
  PREVIEW_APP_SERVICE,
  PREVIEW_BUILD_NONE,
  PREVIEW_LINK_PATH,
  PREVIEW_PROXY_PORT,
  PREVIEW_PROXY_SERVICE,
  type PreviewStart,
  type PreviewState,
} from "@sky/shared";
import { and, eq, inArray, lte } from "drizzle-orm";
import { canUseEnv, ownAgents, type Principal } from "./auth.js";
import type { Config } from "./config.js";
import {
  envFile,
  REPO_DIR,
  RUNNER,
  WITH_PACKAGE_MANAGERS,
  WORKTREES_DIR,
} from "./provision.js";
import { cut, redact } from "./redact.js";
import type { BundleInstaller } from "./runner-bundle.js";
import { isReservedName, openEnvSecrets } from "./secrets.js";
import {
  execInSprite,
  execLogged,
  type SpriteOps,
  SpriteTimeoutError,
  spriteCall,
  writeSpriteFile,
} from "./sprites.js";

// how long a created service is watched for an immediate exit; one that dies in this window fails the start,
// with its last output
const WATCH = "2s";
const OUTPUT_TAIL = 1500;

/** How long the one-off production build may run before it is stopped. */
export const BUILD_CAP_MS = 15 * 60_000;
// how long the app has, once its service exists, to listen on its port, and how often that is asked
const READY_TIMEOUT_MS = 120_000;
const READY_POLL_MS = 2_000;
// a start's row outlives its build cap by this, until the start succeeds and extends it to the TTL
const START_GRACE_MS = 5 * 60_000;
// a failed preview stays readable this long, then the sweep removes it
const FAILED_KEEP_MS = 10 * 60_000;

// exits 10 when something listens on port $1: the kernel's table of listening TCP sockets (state 0A), v4 and v6
const PORT_HELD = `hex=$(printf '%04X' "$1"); cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | awk -v p=":$hex" '$4 == "0A" && toupper($2) ~ p "$" { held = 1 } END { exit (held ? 10 : 0) }'`;
const HELD = 10;

// which package manager's lockfile the worktree holds, as the exit status: the first of pnpm, yarn, bun, npm; 0 for none
const LOCKFILES = `for f in pnpm-lock.yaml:10 yarn.lock:11 bun.lock:12 bun.lockb:12 package-lock.json:13; do [ -e "\${f%%:*}" ] && exit "\${f##*:}"; done; exit 0`;
const MANAGERS = {
  10: { build: "pnpm build", start: "pnpm start" },
  11: { build: "yarn build", start: "yarn start" },
  12: { build: "bun run build", start: "bun run start" },
  13: { build: "npm run build", start: "npm start" },
} as const;

// the user's command, whole, as $1 of a shell of its own: `cd web && pnpm start` and `FOO=1 pnpm start` run as
// written, and a single program still replaces that shell as the service's process
const RUN_APP_SERVER = `${WITH_PACKAGE_MANAGERS} && exec bash -c "$1"`;
// the build, run under `setsid` so it and everything it starts are one process group: $1 the preview's
// directory, where it leaves the group's id for `KILL_BUILD` and finds the env file it sources for the app's
// own variables; $2 the command, whole
const RUN_BUILD = `echo $$ >"$1/pid" && ${WITH_PACKAGE_MANAGERS} && set -a && . "$1/env" && set +a && exec bash -c "$2"`;
// TERM to the build's process group, KILL to what of it outlives 5 s; a group never recorded has nothing to end
const KILL_BUILD = `pid=$(cat "$1/pid" 2>/dev/null) || exit 0; case $pid in ''|*[!0-9]*) exit 0;; esac; [ "$pid" -gt 1 ] || exit 0; kill -TERM -- "-$pid" 2>/dev/null || exit 0; for _ in 1 2 3 4 5; do kill -0 -- "-$pid" 2>/dev/null || exit 0; sleep 1; done; kill -KILL -- "-$pid" 2>/dev/null; exit 0`;

/** One preview's build files in the sprite (`env`, `build.log`, `pid`): by its token's hash, so no other preview's teardown or late kill reaches them. */
const previewDir = (tokenHash: string) =>
  `/tmp/sky-preview-${tokenHash.slice(0, 16)}`;

const sha256Hex = (value: string) =>
  createHash("sha256").update(value).digest("hex");

type PreviewRow = typeof previews.$inferSelect;

/** What teardown needs of a preview: which one it is, and where it runs. */
type Running = Pick<PreviewRow, "envId" | "agentId" | "tokenHash"> & {
  spriteName: string;
};

const runningOf = (db: Db) =>
  db
    .select({
      envId: previews.envId,
      agentId: previews.agentId,
      tokenHash: previews.tokenHash,
      port: previews.port,
      state: previews.state,
      spriteName: environments.spriteName,
    })
    .from(previews)
    .innerJoin(environments, eq(previews.envId, environments.id));

const isGone = (err: unknown) =>
  (err instanceof APIError && err.statusCode === 404) ||
  (err instanceof Error && /not found/i.test(err.message));

// one start, stop or sweep at a time per environment: a sprite has one HTTP port
const chains = new Map<string, Promise<unknown>>();
function serialized<T>(
  envId: EnvironmentId,
  work: () => Promise<T>,
): Promise<T> {
  const run = (chains.get(envId) ?? Promise.resolve()).then(work, work);
  const tail = run.catch(() => {});
  chains.set(envId, tail);
  void tail.then(() => {
    if (chains.get(envId) === tail) chains.delete(envId);
  });
  return run;
}

// the build and start of each environment's preview that is still under way, in this process
type Job = {
  tokenHash: string;
  abort: AbortController;
  /** Settles once the job has stopped touching the sprite. */
  done: Promise<void>;
};
const jobs = new Map<EnvironmentId, Job>();

/** Stops the environment's job for this preview, if it has one, and waits until it has let go of the sprite. */
async function stopJob(envId: EnvironmentId, tokenHash: string) {
  const job = jobs.get(envId);
  if (job?.tokenHash !== tokenHash) return;
  job.abort.abort();
  await job.done;
}

/** Removes the preview's build files from the sprite; under `force`, a 404 (sprite or directory gone) counts as removed. */
function removeFiles(
  sprites: SpriteOps,
  name: string,
  tokenHash: string,
): Promise<void> {
  return spriteCall(sprites, name, { op: "rm-preview-files" }, () =>
    sprites.client
      .sprite(name)
      .filesystem("/")
      .rm(previewDir(tokenHash), { recursive: true, force: true }),
  );
}

/**
 * The sprite's URL goes private first, so nothing is public a moment longer than it must be; then both
 * services go, then a build still running (its process group, which outlives its exec and this process),
 * then the build's files, whose env holds the app's secrets.
 */
async function takeDown(
  sprites: SpriteOps,
  { spriteName: name, tokenHash }: Pick<Running, "spriteName" | "tokenHash">,
): Promise<void> {
  await spriteCall(sprites, name, { op: "url-private" }, () =>
    sprites.client.updateSprite(name, { urlSettings: { auth: "sprite" } }),
  ).catch((err: unknown) => {
    if (!isGone(err)) throw err;
  });
  // the app first: it was created needing the proxy, which then outlives it
  for (const service of [PREVIEW_APP_SERVICE, PREVIEW_PROXY_SERVICE]) {
    await spriteCall(sprites, name, { op: "service-delete" }, () =>
      sprites.client.sprite(name).deleteService(service),
    ).catch((err: unknown) => {
      if (!isGone(err)) throw err;
    });
  }
  // before the files go: the group's id is in them
  await execInSprite(
    sprites,
    name,
    ["bash", "-c", KILL_BUILD, "bash", previewDir(tokenHash)],
    { op: "preview-build-kill" },
  ).catch((err: unknown) => {
    if (!isGone(err)) throw err;
  });
  await removeFiles(sprites, name, tokenHash);
}

/**
 * Ends a preview: its build or start is stopped, the sprite is taken down (see `takeDown`), then the token's row
 * goes, which is what makes the token dead to Sky. A sprite or service already gone counts as removed; anything
 * else throws and leaves the row, so a retry finishes it.
 */
async function endPreview(
  db: Db,
  sprites: SpriteOps,
  running: Running,
): Promise<void> {
  await stopJob(running.envId, running.tokenHash);
  await takeDown(sprites, running);
  db.delete(previews)
    .where(
      and(
        eq(previews.envId, running.envId),
        eq(previews.tokenHash, running.tokenHash),
      ),
    )
    .run();
}

export type StartResult =
  | { kind: "not_found" }
  | { kind: "archived" }
  | { kind: "not_ready" }
  | { kind: "no_worktree" }
  /** The worktree holds no lockfile to choose commands from, and a command wasn't given. */
  | { kind: "commands_needed"; missing: ("build" | "start")[] }
  | { kind: "port_busy"; port: number }
  /** Another principal's preview runs in the environment, and this one may not replace it. */
  | { kind: "preview_busy" }
  /** The running preview could not be ended, so this one was not started; its row stays for a retry. */
  | { kind: "replace_failed" }
  | { kind: "failed"; detail: string }
  | {
      kind: "started";
      preview: PresentedPreview & { link: string; replaced: AgentId | null };
    };

export type PresentedPreview = {
  agentId: AgentId;
  envId: EnvironmentId;
  port: number;
  /** The build command; null when there is none. */
  build: string | null;
  start: string;
  state: PreviewState;
  /** The redacted tail of the output of what failed, once `state` is `failed`. */
  detail: string | null;
  /** Whose a failed preview's failure is: `command` the user's build or start, `sprite` the sprite's; null unless `failed`. */
  failure: PreviewRow["failure"];
  startedAt: string;
  /** When the link stops working; on a `failed` preview, when the sweep removes it instead. */
  expiresAt: string;
};

const present = (row: PreviewRow): PresentedPreview => ({
  agentId: row.agentId,
  envId: row.envId,
  port: row.port,
  build: row.buildCmd,
  start: row.startCmd,
  state: row.state,
  detail: row.detail,
  failure: row.failure,
  startedAt: row.createdAt,
  expiresAt: row.expiresAt,
});

type Deps = {
  db: Db;
  config: Config;
  sprites: SpriteOps;
  ensureBundle: BundleInstaller;
  log: (line: string) => void;
  /** The build's bound; `BUILD_CAP_MS` unless a test shortens it. */
  buildCapMs?: number;
  /** How long the app has to listen once started; 2 minutes unless a test shortens it. */
  readyTimeoutMs?: number;
  /** How often the port is asked; 2 s unless a test shortens it. */
  readyPollMs?: number;
};

/** The user's own build or start command failed; its message is the output, redacted. */
class CommandFailed extends Error {}

/** A service's own words for how it did, when it ended within the watch: `undefined` while it runs. */
function failureOf(
  service: string,
  events: ServiceLogEvent[],
  known: readonly string[],
): string | undefined {
  const ended = events.find((e) => e.type === "exit" || e.type === "error");
  if (!ended) return undefined;
  const output = events
    .filter((e) => e.type === "stdout" || e.type === "stderr")
    .map((e) => e.data ?? "")
    .join("")
    .trim();
  const how =
    ended.type === "exit"
      ? `exited ${ended.exitCode ?? "?"} within ${WATCH} of starting`
      : `failed to start: ${ended.data ?? "no reason given"}`;
  const tail = output ? `: ${output.slice(-OUTPUT_TAIL)}` : "";
  return redact(`${service} ${how}${tail}`, known);
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/** `work`'s result, or `undefined` once `signal` aborts first; `work` is left to settle on its own. */
function unlessAborted<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T | undefined> {
  if (signal.aborted) {
    work.catch(() => {});
    return Promise.resolve(undefined);
  }
  return new Promise<T | undefined>((resolve, reject) => {
    signal.addEventListener("abort", () => resolve(undefined), { once: true });
    work.then(resolve, reject);
  });
}

export function createPreviews({
  db,
  config,
  sprites,
  ensureBundle,
  log,
  buildCapMs = BUILD_CAP_MS,
  readyTimeoutMs = READY_TIMEOUT_MS,
  readyPollMs = READY_POLL_MS,
}: Deps) {
  /** The agent and its env, when `principal` may act on it. */
  const find = (agentId: AgentId, principal: Principal) => {
    const found = db
      .select({
        agent: agents,
        envStatus: environments.status,
        spriteName: environments.spriteName,
        base: environments.base,
      })
      .from(agents)
      .innerJoin(environments, eq(agents.envId, environments.id))
      .where(and(eq(agents.id, agentId), ownAgents(principal)))
      .get();
    return found && canUseEnv(principal, found.agent.envId) ? found : undefined;
  };

  /** Creates a service and watches it for `WATCH`; throws with the service's own output when it dies in that time. */
  async function createService(
    spriteName: string,
    service: string,
    request: ServiceRequest,
    known: readonly string[],
  ): Promise<void> {
    const events = await spriteCall(
      sprites,
      spriteName,
      { op: "service-create", known },
      async () => {
        const stream = await sprites.client
          .sprite(spriteName)
          .createService(service, request, WATCH);
        const seen: ServiceLogEvent[] = [];
        for await (const event of stream) seen.push(event);
        return seen;
      },
    );
    const failure = failureOf(service, events, known);
    if (!failure) return;
    // only the app's own exit is the user's command; a proxy that dies, or a service the sprite can't spawn,
    // is the sprite's
    const exited = events.some((e) => e.type === "exit");
    throw service === PREVIEW_APP_SERVICE && exited
      ? new CommandFailed(failure)
      : new Error(failure);
  }

  /**
   * What the app's commands get, build and server alike: the environment's secrets and its profile's session
   * variables, in a production environment, never a Claude credential or one of Sky's tokens. `secretValues` are
   * the secrets alone, what output is redacted by: the session variables are switches and `PORT` a number the
   * output must keep.
   */
  function appEnv(envId: EnvironmentId, base: string | null, port: number) {
    const profile = base ? config.baseProfiles[base] : undefined;
    const secrets = new Map(
      openEnvSecrets(db, config.secretEncryptionKey, envId),
    );
    // reserved names are the runner's own (the Claude credential, the agent token, PATH…): never passed on
    for (const name of [...secrets.keys()]) {
      if (isReservedName(name)) secrets.delete(name);
    }
    return {
      env: {
        ...Object.fromEntries(secrets),
        ...(profile?.sessionEnv ?? {}),
        PORT: String(port),
        NODE_ENV: "production",
      },
      secretValues: [...secrets.values()],
    };
  }

  /** `port_busy` or `failed` when the port check refuses `port`; `undefined` when nothing listens on it. */
  async function refusedPort(
    spriteName: string,
    port: number,
  ): Promise<StartResult | undefined> {
    const held = await execInSprite(
      sprites,
      spriteName,
      ["sh", "-c", PORT_HELD, "sh", String(port)],
      { op: "preview-port" },
    );
    if (held.exitCode === HELD) return { kind: "port_busy", port };
    if (held.exitCode !== 0) {
      return {
        kind: "failed",
        detail: `checking port ${port} on the sprite exited ${held.exitCode}`,
      };
    }
    return undefined;
  }

  /** Whether `principal` may end the preview of `agentId`: the admin key may, a `runs` key only one on an agent it started. */
  function mayReplace(principal: Principal, agentId: AgentId): boolean {
    if (principal.role === "admin") return true;
    const owner = db
      .select({ ownerKeyId: agents.ownerKeyId })
      .from(agents)
      .where(eq(agents.id, agentId))
      .get()?.ownerKeyId;
    return owner === principal.keyId;
  }

  /** The commands to run: those given, the rest from the worktree's lockfile; the names still missing when it has none. */
  async function commandsFor(
    spriteName: string,
    worktree: string,
    input: PreviewStart,
  ): Promise<
    | { build: string | null; start: string }
    | { missing: ("build" | "start")[] }
    | { failed: string }
  > {
    let found: (typeof MANAGERS)[keyof typeof MANAGERS] | undefined;
    if (input.build === undefined || input.start === undefined) {
      const out = await execInSprite(
        sprites,
        spriteName,
        ["sh", "-c", LOCKFILES],
        { op: "preview-lockfile", cwd: worktree },
      );
      if (out.exitCode !== 0) {
        found = MANAGERS[out.exitCode as keyof typeof MANAGERS];
        if (!found) {
          return {
            failed: `looking for the worktree's lockfile exited ${out.exitCode}`,
          };
        }
      }
    }
    const missing: ("build" | "start")[] = [];
    if (input.build === undefined && !found) missing.push("build");
    if (input.start === undefined && !found) missing.push("start");
    if (missing.length > 0) return { missing };
    const build = input.build ?? found?.build ?? null;
    return {
      build: build === PREVIEW_BUILD_NONE ? null : build,
      start: input.start ?? (found?.start as string),
    };
  }

  /** Writes a row's new state; `false` when the row is no longer this preview's (it was stopped or replaced). */
  function setState(
    envId: EnvironmentId,
    tokenHash: string,
    set: Partial<typeof previews.$inferInsert>,
  ): boolean {
    return (
      db
        .update(previews)
        .set(set)
        .where(
          and(eq(previews.envId, envId), eq(previews.tokenHash, tokenHash)),
        )
        .run().changes > 0
    );
  }

  type Start = {
    agentId: AgentId;
    envId: EnvironmentId;
    spriteName: string;
    tokenHash: string;
    worktree: string;
    port: number;
    build: string | null;
    start: string;
    env: Record<string, string>;
    /** Every value the output must not carry. */
    known: string[];
    /** When the link stops working. */
    expiresAt: string;
    signal: AbortSignal;
  };

  /** The one-off production build, in the worktree, with the app's own env; throws `CommandFailed` with its output tail when it fails or runs past its cap. */
  async function build(s: Start & { build: string }): Promise<void> {
    // a throw or a stop from here on ends in `takeDown`, which ends the build and removes these files
    const dir = previewDir(s.tokenHash);
    await writeSpriteFile(
      sprites,
      s.spriteName,
      `${dir}/env`,
      envFile(Object.entries(s.env)),
      { op: "write-preview-env", mode: 0o600, known: s.known },
    );
    if (s.signal.aborted) return;
    let out: { exitCode: number; tail: string } | undefined;
    try {
      out = await unlessAborted(
        execLogged(
          sprites,
          s.spriteName,
          ["setsid", "-w", "bash", "-c", RUN_BUILD, "bash", dir, s.build],
          {
            op: "preview-build",
            cwd: s.worktree,
            log: `${dir}/build.log`,
            tailBytes: OUTPUT_TAIL,
            timeoutMs: buildCapMs,
            known: s.known,
            // a stop drops the exec's connection, as the cap does
            signal: s.signal,
          },
        ),
        s.signal,
      );
    } catch (err) {
      if (!(err instanceof SpriteTimeoutError)) throw err;
      throw new CommandFailed(
        `the build ran past its ${buildCapMs % 60_000 === 0 ? `${buildCapMs / 60_000}-minute` : `${Math.round(buildCapMs / 1000)}-second`} limit and was stopped`,
      );
    }
    if (out === undefined) return;
    if (out.exitCode !== 0) {
      const tail = redact(out.tail.trim(), s.known);
      throw new CommandFailed(
        `the build exited ${out.exitCode}${tail ? `: ${tail}` : ""}`,
      );
    }
    // the env holds the secrets, and the build is over; what this misses, the preview's teardown removes
    await removeFiles(sprites, s.spriteName, s.tokenHash).catch(() => {});
  }

  /** The tail of the app service's output, redacted; empty when it can't be read. */
  async function appOutput(s: Start): Promise<string> {
    const text = await spriteCall(
      sprites,
      s.spriteName,
      { op: "service-logs", known: s.known },
      async () => {
        const stream = await sprites.client
          .sprite(s.spriteName)
          .getServiceLogs(PREVIEW_APP_SERVICE, { lines: 40 });
        let out = "";
        for await (const event of stream) {
          if (event.type === "stdout" || event.type === "stderr") {
            out += event.data ?? "";
          }
        }
        return out;
      },
    ).catch(() => "");
    return redact(text.trim().slice(-OUTPUT_TAIL), s.known);
  }

  /** Polls until the app listens on its port; throws `CommandFailed` with its output when it doesn't in time. */
  async function awaitListening(s: Start): Promise<void> {
    const deadline = Date.now() + readyTimeoutMs;
    for (;;) {
      if (s.signal.aborted) return;
      const held = await execInSprite(
        sprites,
        s.spriteName,
        ["sh", "-c", PORT_HELD, "sh", String(s.port)],
        { op: "preview-ready" },
      );
      if (held.exitCode === HELD) return;
      if (held.exitCode !== 0) {
        throw new Error(
          `checking port ${s.port} on the sprite exited ${held.exitCode}`,
        );
      }
      if (Date.now() >= deadline) {
        const output = await appOutput(s);
        throw new CommandFailed(
          `the app didn't listen on port ${s.port} within ${readyTimeoutMs / 1000}s of starting${output ? `: ${output}` : ""}`,
        );
      }
      await sleep(readyPollMs, s.signal);
    }
  }

  /**
   * Everything after the answer: the build, the app's service, the wait for its port. A failure takes the
   * sprite down again and leaves the row `failed` with why; one that is the job being stopped leaves the row to
   * whatever stopped it.
   */
  async function finish(s: Start): Promise<void> {
    try {
      if (s.build !== null) await build({ ...s, build: s.build });
      if (s.signal.aborted) return;
      if (!setState(s.envId, s.tokenHash, { state: "starting" })) return;
      await createService(
        s.spriteName,
        PREVIEW_APP_SERVICE,
        {
          cmd: "bash",
          args: ["-c", RUN_APP_SERVER, "bash", s.start],
          dir: s.worktree,
          env: s.env,
          needs: [PREVIEW_PROXY_SERVICE],
        },
        s.known,
      );
      if (s.signal.aborted) return;
      await awaitListening(s);
      if (s.signal.aborted) return;
      setState(s.envId, s.tokenHash, {
        state: "ready",
        expiresAt: s.expiresAt,
      });
    } catch (err) {
      if (s.signal.aborted) return;
      const detail = cut(
        redact(err instanceof Error ? err.message : String(err), s.known),
        2000,
      );
      const failure = err instanceof CommandFailed ? "command" : "sprite";
      log(`the preview of ${s.agentId} failed (${failure}): ${detail}`);
      // taken down first, so nothing stays public; a failed teardown is the sweep's to retry once the row expires
      await takeDown(sprites, s).catch((downErr: unknown) => {
        log(
          `taking down the failed preview of ${s.agentId} failed: ${downErr}`,
        );
      });
      setState(s.envId, s.tokenHash, {
        state: "failed",
        failure,
        detail,
        expiresAt: new Date(Date.now() + FAILED_KEEP_MS).toISOString(),
      });
    }
  }

  return {
    /**
     * Starts the agent's preview and answers as soon as the link works: the token proxy is up and the sprite's
     * URL public, showing a page that says it is building. The production build, the app's service and the
     * wait for its port go on in the background, `state` following them. Replaces the env's running preview,
     * whichever agent's it is.
     */
    async start(
      agentId: AgentId,
      principal: Principal,
      input: PreviewStart,
    ): Promise<StartResult> {
      const found = find(agentId, principal);
      if (!found) return { kind: "not_found" };
      if (found.agent.archivedAt) return { kind: "archived" };
      if (found.envStatus !== "ready") return { kind: "not_ready" };
      const { agent, spriteName } = found;
      return serialized(agent.envId, async (): Promise<StartResult> => {
        const current = runningOf(db)
          .where(eq(previews.envId, agent.envId))
          .get();
        // a key replaces its own previews and the admin key anyone's; a failed one runs nothing, so it is
        // anyone's to replace. All before anything reaches the sprite
        if (
          current &&
          current.state !== "failed" &&
          !mayReplace(principal, current.agentId)
        ) {
          return { kind: "preview_busy" };
        }
        const worktree = `${WORKTREES_DIR}/${agentId}`;
        const there = await execInSprite(
          sprites,
          spriteName,
          ["test", "-d", worktree],
          { op: "preview-worktree", cwd: REPO_DIR },
        );
        if (there.exitCode !== 0) return { kind: "no_worktree" };
        const commands = await commandsFor(spriteName, worktree, input);
        if ("failed" in commands) {
          return { kind: "failed", detail: commands.failed };
        }
        if ("missing" in commands) {
          return { kind: "commands_needed", missing: commands.missing };
        }
        // every refusal that doesn't hinge on the running preview's own services comes before it is ended
        const url = (
          await spriteCall(sprites, spriteName, { op: "get-url" }, () =>
            sprites.client.getSprite(spriteName),
          )
        ).url;
        if (!url) {
          return {
            kind: "failed",
            detail: "the sprite has no URL to preview on",
          };
        }
        const appPortCheckedFirst =
          current !== undefined && current.port !== input.port;
        if (appPortCheckedFirst) {
          const refused = await refusedPort(spriteName, input.port);
          if (refused) return refused;
        }
        if (current) {
          try {
            await endPreview(db, sprites, current);
          } catch (err) {
            log(
              `ending the preview of ${current.agentId} to start ${agentId}'s failed: ${err}`,
            );
            return { kind: "replace_failed" };
          }
        }
        // a running preview's proxy holds 8080, and its app the app's port when this one asks for the same:
        // checked once its services are gone, so neither is counted
        const afterTeardown = appPortCheckedFirst
          ? [PREVIEW_PROXY_PORT]
          : [PREVIEW_PROXY_PORT, input.port];
        for (const port of afterTeardown) {
          const refused = await refusedPort(spriteName, port);
          if (refused) return refused;
        }
        const token = randomBytes(32).toString("base64url");
        const tokenHash = sha256Hex(token);
        const expiresAt = new Date(
          Date.now() + input.ttlSeconds * 1000,
        ).toISOString();
        // the row first, and with only minutes to live until the start succeeds: a start that dies midway,
        // and then can't clean up after itself, leaves a row the sweep ends soon rather than at the full TTL
        const row = db
          .insert(previews)
          .values({
            envId: agent.envId,
            agentId,
            port: input.port,
            buildCmd: commands.build,
            startCmd: commands.start,
            state: commands.build === null ? "starting" : "building",
            tokenHash,
            expiresAt: new Date(
              Math.min(
                Date.parse(expiresAt),
                Date.now() + buildCapMs + START_GRACE_MS,
              ),
            ).toISOString(),
          })
          .returning()
          .get();
        const { env, secretValues } = appEnv(
          agent.envId,
          found.base,
          input.port,
        );
        const known = [...secretValues, token];
        try {
          await ensureBundle(spriteName, `preview-${agentId}`);
          // the proxy and the public URL first: the link works from now on, showing a page that says the
          // preview is building, and the proxy holds 8080 before the app opens a port of its own (a
          // sprite's URL goes to 8080, or else to the first HTTP port opened)
          await createService(
            spriteName,
            PREVIEW_PROXY_SERVICE,
            {
              cmd: "bash",
              args: [
                "-c",
                `${WITH_PACKAGE_MANAGERS} && exec node ${RUNNER} preview-proxy`,
              ],
              env: {
                PREVIEW_TOKEN_HASH: tokenHash,
                PREVIEW_UPSTREAM_PORT: String(input.port),
                PREVIEW_EXPIRES_AT: expiresAt,
                PREVIEW_LISTEN_PORT: String(PREVIEW_PROXY_PORT),
              },
              httpPort: PREVIEW_PROXY_PORT,
            },
            known,
          );
          await spriteCall(sprites, spriteName, { op: "url-public" }, () =>
            sprites.client.updateSprite(spriteName, {
              urlSettings: { auth: "public" },
            }),
          );
        } catch (err) {
          const detail = redact(
            err instanceof Error ? err.message : String(err),
            known,
          );
          log(`starting the preview of ${agentId} failed: ${detail}`);
          await endPreview(db, sprites, {
            envId: agent.envId,
            agentId,
            tokenHash,
            spriteName,
          }).catch((endErr: unknown) => {
            log(`ending the failed preview of ${agentId} failed: ${endErr}`);
          });
          return { kind: "failed", detail: cut(detail, 2000) };
        }
        const abort = new AbortController();
        const job: Job = {
          tokenHash,
          abort,
          done: finish({
            agentId,
            envId: agent.envId,
            spriteName,
            tokenHash,
            worktree,
            port: input.port,
            build: commands.build,
            start: commands.start,
            env,
            known,
            expiresAt,
            signal: abort.signal,
          }).catch((err: unknown) => {
            log(`the preview job of ${agentId} failed: ${err}`);
          }),
        };
        jobs.set(agent.envId, job);
        void job.done.then(() => {
          if (jobs.get(agent.envId) === job) jobs.delete(agent.envId);
        });
        return {
          kind: "started",
          preview: {
            ...present(row),
            // the TTL counts from this request, whatever the build takes
            expiresAt,
            link: `${url.replace(/\/+$/, "")}${PREVIEW_LINK_PATH}?t=${token}`,
            replaced:
              current &&
              current.state !== "failed" &&
              current.agentId !== agentId
                ? current.agentId
                : null,
          },
        };
      });
    },

    /** Ends the agent's preview and returns it; `null` when it had none, `undefined` when `principal` may not act on the agent. */
    async stop(
      agentId: AgentId,
      principal: Principal,
    ): Promise<PresentedPreview | null | undefined> {
      const found = find(agentId, principal);
      if (!found) return undefined;
      return serialized(found.agent.envId, async () => {
        const row = db
          .select()
          .from(previews)
          .where(
            and(
              eq(previews.envId, found.agent.envId),
              eq(previews.agentId, agentId),
            ),
          )
          .get();
        if (!row) return null;
        await endPreview(db, sprites, { ...row, spriteName: found.spriteName });
        return present(row);
      });
    },

    /**
     * The agent's preview, its state included, with how its two services are doing; `null` when it has none,
     * `undefined` for an agent `principal` may not see.
     */
    async state(agentId: AgentId, principal: Principal) {
      const found = find(agentId, principal);
      if (!found) return undefined;
      const row = db
        .select()
        .from(previews)
        .where(
          and(
            eq(previews.envId, found.agent.envId),
            eq(previews.agentId, agentId),
          ),
        )
        .get();
      if (!row) return null;
      const services = await spriteCall(
        sprites,
        found.spriteName,
        { op: "services-list" },
        () => sprites.client.sprite(found.spriteName).listServices(),
      ).catch((err: unknown) => {
        log(`listing the services of ${found.spriteName} failed: ${err}`);
        return undefined;
      });
      const status = (name: string) =>
        services?.find((s) => s.name === name)?.state?.status ?? "missing";
      return {
        ...present(row),
        services: services && {
          app: status(PREVIEW_APP_SERVICE),
          proxy: status(PREVIEW_PROXY_SERVICE),
        },
      };
    },

    /** Ends the preview of an agent (archive), or the environment's, whichever agent's (delete). Throws when it can't. */
    stopForAgent(agentId: AgentId, envId: EnvironmentId): Promise<void> {
      return serialized(envId, async () => {
        const row = runningOf(db).where(eq(previews.agentId, agentId)).get();
        if (row) await endPreview(db, sprites, row);
      });
    },
    stopForEnv(envId: EnvironmentId): Promise<void> {
      return serialized(envId, async () => {
        const row = runningOf(db).where(eq(previews.envId, envId)).get();
        if (row) await endPreview(db, sprites, row);
      });
    },
  };
}

export type Previews = ReturnType<typeof createPreviews>;

/**
 * Fails the previews a previous process left building or starting: their job died with it. They expire at
 * once, so the first sweep takes their services down.
 */
export function failInterruptedPreviews(
  db: Db,
  now: Date = new Date(),
): number {
  return db
    .update(previews)
    .set({
      state: "failed",
      failure: "sprite",
      detail:
        "interrupted: the API restarted during the start; start the preview again",
      expiresAt: now.toISOString(),
    })
    .where(inArray(previews.state, ["building", "starting"]))
    .run().changes;
}

/**
 * Ends every preview past its expiry: a ready one at its TTL, a failed one once it has been readable long
 * enough, one that never got ready past its start deadline. Each failure is logged and left for the next
 * sweep, since the row stays until its services are gone; the proxy stops honouring the token at its expiry
 * regardless.
 */
export async function sweepExpiredPreviews(
  db: Db,
  sprites: SpriteOps,
  log: (line: string) => void,
  now: Date = new Date(),
): Promise<number> {
  const due = runningOf(db)
    .where(lte(previews.expiresAt, now.toISOString()))
    .all();
  let ended = 0;
  await Promise.all(
    due.map((row) =>
      serialized(row.envId, async () => {
        try {
          // a start that ran while this waited replaced the preview: its services are not this row's to end
          const still = runningOf(db)
            .where(
              and(
                eq(previews.envId, row.envId),
                eq(previews.tokenHash, row.tokenHash),
              ),
            )
            .get();
          if (!still) return;
          await endPreview(db, sprites, still);
          ended += 1;
          log(`preview of ${row.agentId} ended: its TTL passed`);
        } catch (err) {
          log(`ending the expired preview of ${row.agentId} failed: ${err}`);
        }
      }),
    ),
  );
  return ended;
}
