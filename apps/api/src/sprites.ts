import { createHash } from "node:crypto";
import { APIError, ExecError, type SpritesClient } from "@fly/sprites";
import { type KnownSecrets, redact } from "./redact.js";

/**
 * The one sprite an environment owns. Hashed because the API rejects names outside lowercase
 * letters, digits and hyphens, and env ids carry uppercase and an underscore.
 */
export const spriteNameFor = (envId: string) =>
  `sky-${createHash("sha256").update(envId).digest("hex").slice(0, 24)}`;

/** The Sprites client, with what every call through `spriteCall` logs to and is bounded by. */
export type SpriteOps = {
  client: SpritesClient;
  log: (line: string) => void;
  secrets: KnownSecrets;
  /** The bound on a call that should answer promptly: a file write, a check, a short command. */
  timeoutMs: number;
  /** The bound on clone, installs, the setup script, the store steps and checkpoint. */
  longTimeoutMs: number;
  /**
   * Called with the sprite's name when an exec on it exits 137 (SIGKILL): something on the sprite is
   * being killed, most often for memory. Not awaited, and its failure never reaches the exec's caller.
   */
  onExecKilled?: (spriteName: string) => void;
};

export const SPRITES_TIMEOUT_MS = 60_000;

export type CallOptions = {
  /** A fixed short name for the log and a timeout's error; never argv or a user's script. */
  op: string;
  /** `ops.timeoutMs` when absent. */
  timeoutMs?: number;
  /** Values the caller holds, scrubbed from the log alongside `ops.secrets`. */
  known?: readonly string[];
};

export class SpriteTimeoutError extends Error {}

const formatBound = (ms: number) =>
  ms % 60_000 === 0
    ? `${ms / 60_000} min`
    : ms % 1000 === 0
      ? `${ms / 1000} s`
      : `${ms} ms`;

/**
 * Runs one Sprites call, bounded by `timeoutMs`, logging a start line and an end line (ok, failed,
 * or timed out, with the duration). At the bound it aborts `signal`, for `call` to cut its request
 * or close what it holds, and rejects with a `SpriteTimeoutError` naming sprite, op and bound
 * whether or not `call` ever settles. `outcome` words a resolved value for the end line.
 */
export async function spriteCall<T>(
  ops: SpriteOps,
  name: string,
  { op, timeoutMs = ops.timeoutMs, known = [] }: CallOptions,
  call: (signal: AbortSignal) => Promise<T>,
  outcome: (value: T) => string = () => "ok",
): Promise<T> {
  const log = (line: string) =>
    ops.log(
      redact(`sprite ${name} ${op}: ${line}`, [
        ...ops.secrets.values(),
        ...known,
      ]),
    );
  log("start");
  const started = Date.now();
  const abort = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new SpriteTimeoutError(
        `sprite ${name}: ${op} timed out after ${formatBound(timeoutMs)}`,
      );
      abort.abort(err);
      reject(err);
    }, timeoutMs);
  });
  try {
    const value = await Promise.race([call(abort.signal), timedOut]);
    log(`${outcome(value)} in ${Date.now() - started}ms`);
    return value;
  } catch (err) {
    log(
      err instanceof SpriteTimeoutError
        ? `timed out after ${timeoutMs}ms`
        : `failed in ${Date.now() - started}ms: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const isNotFound = (err: unknown) =>
  err instanceof APIError && err.statusCode === 404;

/** Whether the sprite exists; any error but a 404 throws. */
export function spriteExists(ops: SpriteOps, name: string): Promise<boolean> {
  return spriteCall(
    ops,
    name,
    { op: "get" },
    async () => {
      try {
        await ops.client.getSprite(name);
        return true;
      } catch (err) {
        if (isNotFound(err)) return false;
        throw err;
      }
    },
    (exists) => (exists ? "ok" : "not found"),
  );
}

/**
 * The labels on an environment's base sprite. Agents run as worktrees on it rather than on
 * sprites of their own, so `role:base` is the only role a sky sprite carries.
 */
export const baseSpriteLabels = (envId: string, repo: string) => [
  "sky",
  `env:${envId}`,
  `repo:${repo}`,
  "role:base",
];

/**
 * Creates the sprite unless it exists, so a rerun after any interruption starts from one, then
 * sets `labels` on it, new or existing: the update writes the full list, so a changed repo or a
 * sprite whose earlier label call never landed is brought up to date on the next provision. Only
 * `labels` is sent; the update leaves the fields it omits, url settings included, as they stand.
 */
export async function ensureSprite(
  ops: SpriteOps,
  name: string,
  labels: string[],
): Promise<void> {
  if (!(await spriteExists(ops, name))) {
    await spriteCall(ops, name, { op: "create" }, () =>
      ops.client.createSprite(name),
    );
  }
  // best-effort: a sprite without labels still works, so a failure is logged by `spriteCall` and not thrown
  await spriteCall(ops, name, { op: "label" }, () =>
    ops.client.updateSprite(name, { labels }),
  ).catch(() => {});
}

export type ExecOutcome = { exitCode: number; stdout: string; stderr: string };

/**
 * Runs `argv` in the sprite over the SDK's HTTP exec (no WebSocket, no TTY) and waits for it to
 * exit. A nonzero exit resolves with its outcome; only transport and API errors throw, the bound
 * running out included, which also cuts the request (and with it the process).
 */
export function execInSprite(
  ops: SpriteOps,
  name: string,
  [file, ...args]: [string, ...string[]],
  options: CallOptions & { cwd?: string },
): Promise<ExecOutcome> {
  return spriteCall(
    ops,
    name,
    options,
    async (signal) => {
      try {
        const result = await ops.client
          .sprite(name)
          .execFileHTTP(file, args, { cwd: options.cwd, signal });
        return toOutcome(result);
      } catch (err) {
        if (err instanceof ExecError) return toOutcome(err.result);
        throw err;
      }
    },
    (out) => (out.exitCode === 0 ? "ok" : `exited ${out.exitCode}`),
  ).then((out) => {
    if (out.exitCode === SIGKILLED) {
      try {
        ops.onExecKilled?.(name);
      } catch (err) {
        ops.log(`sprite ${name} ${options.op}: onExecKilled failed: ${err}`);
      }
    }
    return out;
  });
}

// 128 + SIGKILL: what the kernel's OOM killer, or the sprite's own, leaves as an exit status
const SIGKILLED = 137;

const toOutcome = (r: ExecError["result"]): ExecOutcome => ({
  exitCode: r.exitCode,
  stdout: r.stdout.toString(),
  stderr: r.stderr.toString(),
});

// $1 the log, $2 the tail's byte count, the rest the argv; only a failure writes `<log>.tail`
export const LOGGED_EXEC =
  'log=$1; bytes=$2; shift 2; "$@" >"$log" 2>&1 || { rc=$?; tail -c "$bytes" "$log" >"$log.tail"; exit $rc; }';

/**
 * Runs `argv` like `execInSprite`, but with its stdout and stderr together in `log` in the sprite,
 * so nothing but the exit frame crosses the HTTP exec: its frames carry no length, and output an
 * intermediary re-chunks is misread or rejected. On a nonzero exit, `tail` is the log's last
 * `tailBytes` bytes, read back over the filesystem API; empty when that read fails.
 */
export async function execLogged(
  ops: SpriteOps,
  name: string,
  argv: [string, ...string[]],
  {
    log,
    tailBytes,
    ...options
  }: CallOptions & {
    cwd?: string;
    log: string;
    tailBytes: number;
  },
): Promise<{ exitCode: number; tail: string }> {
  const { exitCode } = await execInSprite(
    ops,
    name,
    ["sh", "-c", LOGGED_EXEC, "sh", log, `${tailBytes}`, ...argv],
    options,
  );
  if (exitCode === 0) return { exitCode, tail: "" };
  const tail = await spriteCall(
    ops,
    name,
    { op: "read-tail", known: options.known },
    () =>
      ops.client.sprite(name).filesystem("/").readFile(`${log}.tail`, "utf8"),
  ).catch(() => "");
  return { exitCode, tail };
}

// the API names the new checkpoint only in the `complete` message's text
const CREATED = /^Checkpoint (\S+) created/;

/** Checkpoints the sprite, bounded by `ops.longTimeoutMs`, and resolves with the new checkpoint's id. */
export function checkpointSprite(
  ops: SpriteOps,
  name: string,
  comment?: string,
): Promise<string> {
  return spriteCall(
    ops,
    name,
    { op: "checkpoint", timeoutMs: ops.longTimeoutMs },
    async (signal) => {
      const stream = await ops.client.sprite(name).createCheckpoint(comment);
      if (signal.aborted) stream.close();
      else
        signal.addEventListener("abort", () => stream.close(), { once: true });
      let id: string | undefined;
      for await (const message of stream) {
        if (message.type === "error") {
          throw new Error(message.error ?? "checkpoint failed");
        }
        if (message.type === "complete") {
          id = CREATED.exec(message.data ?? "")?.[1];
        }
      }
      if (!id) throw new Error("checkpoint completed without naming its id");
      return id;
    },
  );
}

/** Destroys the sprite; one already gone counts as destroyed. */
export function destroySprite(ops: SpriteOps, name: string): Promise<void> {
  return spriteCall(
    ops,
    name,
    { op: "delete" },
    async () => {
      try {
        await ops.client.deleteSprite(name);
        return "ok";
      } catch (err) {
        if (isNotFound(err)) return "already gone";
        throw err;
      }
    },
    (outcome) => outcome,
  ).then(() => {});
}

/**
 * Writes `data` to an absolute path in the sprite, creating parent directories. The SDK's write
 * takes no signal, so a timeout leaves its request to finish or fail on its own.
 */
export async function writeSpriteFile(
  ops: SpriteOps,
  name: string,
  path: string,
  data: string | Buffer,
  { mode, ...options }: CallOptions & { mode?: number },
): Promise<void> {
  await spriteCall(ops, name, options, () =>
    ops.client.sprite(name).filesystem("/").writeFile(path, data, { mode }),
  );
}

// past any run: the runner holds the sprite itself and exits on its own; the server default is undocumented
const RUN_AFTER_DISCONNECT = "24h";
const OUTPUT_TAIL = 2000;

/**
 * Starts `argv` in a detachable session, stays attached for `watchMs`, then disconnects: the process
 * keeps running in the sprite with nothing held open to it. A plain exec's process is reaped when
 * its connection drops, so this is the one way to leave a process running. Rejects when the process
 * exits nonzero inside the window, with its exit code and output tail. A TTY merges stderr into
 * that output, and the SDK reads its exit code from the socket's close, so it is only ever 0 or 1.
 * Bounded by `ops.timeoutMs` past `watchMs`, so a session that never spawns can't hang the caller;
 * the session is closed when the bound runs out.
 */
export function startDetached(
  ops: SpriteOps,
  name: string,
  [file, ...args]: [string, ...string[]],
  {
    cwd,
    env,
    watchMs,
    ...options
  }: Omit<CallOptions, "timeoutMs"> & {
    cwd: string;
    env: Record<string, string>;
    watchMs: number;
  },
): Promise<void> {
  return spriteCall(
    ops,
    name,
    { ...options, timeoutMs: ops.timeoutMs + watchMs },
    (signal) =>
      watchSession(ops.client, name, [file, ...args], {
        cwd,
        env,
        watchMs,
        signal,
      }),
  );
}

function watchSession(
  client: SpritesClient,
  name: string,
  [file, ...args]: [string, ...string[]],
  options: {
    cwd: string;
    env: Record<string, string>;
    watchMs: number;
    signal: AbortSignal;
  },
): Promise<void> {
  const session = client.sprite(name).createSession(file, args, {
    cwd: options.cwd,
    env: options.env,
    maxRunAfterDisconnect: RUN_AFTER_DISCONNECT,
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    let watch: NodeJS.Timeout | undefined;
    let output = "";
    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(watch);
      session.close();
      if (err) reject(err);
      else resolve();
    };
    session.stdout.on("data", (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-OUTPUT_TAIL);
    });
    session.once("spawn", () => {
      watch = setTimeout(() => settle(), options.watchMs);
    });
    session.once("exit", (code: number) => {
      // output pushed to the stream just before 'exit' may not have reached 'data' yet
      setImmediate(() =>
        settle(
          code === 0
            ? undefined
            : new Error(`runner exited ${code} at launch: ${output.trim()}`),
        ),
      );
    });
    // `on`, not `once`: an 'error' emitted after the first, with no listener, would crash the process
    session.on("error", (err: Error) => settle(err));
    options.signal.addEventListener(
      "abort",
      () => settle(options.signal.reason),
      {
        once: true,
      },
    );
  });
}
