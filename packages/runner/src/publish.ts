import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { fetchCommit } from "./repo.js";
import { git as repoGit } from "./store.js";

const run = promisify(execFile);

/** Where a sprite reaches GitHub's REST API through a Sprites connector; the gateway adds the credential. */
export const DEFAULT_GATEWAY_URL = "https://api.sprites.dev/v1/gateway/github";
/** The env var holding the connector's connection id: a connector secret of this name sets it. */
export const CONNECTOR_ENV = "GITHUB_CONNECTOR";
/** Overrides `DEFAULT_GATEWAY_URL`. */
export const GATEWAY_URL_ENV = "GITHUB_GATEWAY_URL";

/** GitHub, through the gateway, answered something other than success. */
export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** True for GitHub's primary or secondary rate limit, which answer 403 as well as 429. */
    readonly rateLimited = false,
    /** True for a failure that says nothing about the call itself: a 5xx answer or a lost connection. */
    readonly transient = false,
  ) {
    super(message);
  }
}

/** The worktree can't be published as it stands. */
export class PublishError extends Error {}

export type PublishResult = {
  branch: string;
  base: string;
  /** The branch head on GitHub. */
  sha: string;
  /** False when an open pull request for the branch already existed. */
  created: boolean;
  /** True when an already-open pull request was sent a new title or body. */
  updated: boolean;
  pullRequest: { number: number; url: string };
};

/** The directory GitHub refuses a tree change under without the `workflow` scope. */
export const WORKFLOWS_DIR = ".github/workflows";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

async function gitBytes(cwd: string, ...args: string[]): Promise<Buffer> {
  const { stdout } = await run("git", args, {
    cwd,
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout;
}

const lines = (output: string) => output.split("\n").filter(Boolean);

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** A failed git command's own words, not execFile's "Command failed: …" wrapper. */
const gitSaid = (error: unknown) =>
  (error as { stderr?: string }).stderr?.trim() || messageOf(error);

/** `owner/repo` from an https or ssh GitHub remote URL. */
export function parseOrigin(url: string): { owner: string; repo: string } {
  const match = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  if (!match?.[1] || !match[2]) {
    throw new PublishError(`origin is not a GitHub repo: ${url}`);
  }
  return { owner: match[1], repo: match[2] };
}

type PersonName = { name: string; email: string };
type Identity = PersonName & { date: string };

/**
 * A git identity line's `Name <email> <unix seconds> <+hhmm>`, its date in UTC: the
 * `YYYY-MM-DDTHH:MM:SSZ` form GitHub documents, though it drops the commit's own offset.
 */
function parseIdentity(line: string): Identity {
  const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
  if (!match) throw new PublishError(`unreadable commit identity: ${line}`);
  const [, name = "", email = "", seconds] = match;
  const date = `${new Date(Number(seconds) * 1000).toISOString().slice(0, 19)}Z`;
  return { name, email, date };
}

const ATTRIBUTION = [
  /^\s*🤖\s*Generated with .*Claude Code.*$/i,
  // any co-author, not only Claude: some hosting rejects commits that carry one
  /^\s*Co-Authored-By:/i,
];
const isAttribution = (line: string) =>
  ATTRIBUTION.some((pattern) => pattern.test(line));
const TRAILER = /^\s*[\w-]+:\s/;

/**
 * Drops the "Generated with Claude Code" footer and every `Co-authored-by` trailer (whoever the
 * co-author), with the blank lines they leave. Only the trailing run of trailer, footer and blank
 * lines is searched; the same line anywhere above it, a fenced example included, is kept.
 */
export function stripAttribution(text: string): string {
  const all = text.split("\n");
  let start = all.length;
  while (start > 0) {
    const line = all[start - 1] ?? "";
    if (line.trim() && !isAttribution(line) && !TRAILER.test(line)) break;
    start--;
  }
  const block = all.slice(start);
  if (!block.some(isAttribution)) return text;
  const kept = block
    .filter((line) => !isAttribution(line))
    // a dropped paragraph between two kept ones leaves its blank lines doubled
    .filter((line, i, lines) => line.trim() || lines[i - 1]?.trim() !== "");
  const body = [...all.slice(0, start), ...kept].join("\n").trimEnd();
  return text.endsWith("\n") && body ? `${body}\n` : body;
}

/** A commit's author and committer as git stores them; its message less its footer and co-author trailers. */
async function readCommit(
  cwd: string,
  sha: string,
  identity?: { author: PersonName; committer: PersonName },
) {
  const raw = await git(cwd, "cat-file", "commit", sha);
  const split = raw.indexOf("\n\n");
  const headers = lines(split === -1 ? raw : raw.slice(0, split));
  const header = (key: string) => {
    const line = headers.find((h) => h.startsWith(`${key} `));
    if (!line) throw new PublishError(`commit ${sha} has no ${key}`);
    return parseIdentity(line.slice(key.length + 1));
  };
  return {
    message: stripAttribution(split === -1 ? "" : raw.slice(split + 2)),
    author: { ...header("author"), ...identity?.author },
    committer: { ...header("committer"), ...identity?.committer },
  };
}

type TreeEntry = {
  path: string;
  mode: string;
  type: "blob" | "commit";
  sha: string | null;
};

type Change = { path: string; mode: string; sha: string | null };

/** What changed from `from` to `to`: each path's new mode and blob, or a null sha where it went. */
async function changes(cwd: string, from: string, to: string) {
  const out = await git(cwd, "diff-tree", "-r", "-z", "--no-renames", from, to);
  // -z: ":<old mode> <new mode> <old sha> <new sha> <status>\0<path>\0", repeated
  const fields = out.split("\0");
  const result: Change[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [oldMode = "", newMode = "", , newSha = "", status] = (
      fields[i] ?? ""
    )
      .slice(1)
      .split(" ");
    const path = fields[i + 1] ?? "";
    result.push(
      status === "D"
        ? { path, mode: oldMode, sha: null }
        : { path, mode: newMode, sha: newSha },
    );
  }
  return result;
}

/**
 * Each path under `.github/workflows/` that differs between two `.github/workflows` trees, either
 * of which is "" where there is no such tree; a rename names both ends. Both trees must be in this
 * clone.
 */
async function workflowPathsBetween(
  cwd: string,
  from: string,
  to: string,
): Promise<string[]> {
  if (from === to) return [];
  const empty = await repoGit(cwd)(["mktree"], { input: "" });
  const out = await git(
    cwd,
    "diff-tree",
    "-r",
    "-z",
    "--name-only",
    "--no-renames",
    from || empty,
    to || empty,
  );
  return out
    .split("\0")
    .filter(Boolean)
    .map((path) => `${WORKFLOWS_DIR}/${path}`)
    .sort();
}

// GitHub's secondary rate limit answers 403 or 429 with a `retry-after`; a pause this long is waited out
const MAX_RETRY_AFTER_S = 60;
// GitHub's minimum wait for a secondary limit that sends neither `retry-after` nor a spent quota
const SECONDARY_WAIT_S = 60;
const RETRIES = 3;
// the gateway's own 5xx answers and dropped connections pass within seconds, so each retry waits
// the matching TRANSIENT_BACKOFF_MS pause
const TRANSIENT_STATUSES = new Set([500, 502, 503, 504]);
const TRANSIENT_BACKOFF_MS = [1000, 3000, 9000];
// the primary rate limit resets on the hour at the latest; a reset this near is waited out, a farther one fails naming its time
const MAX_RESET_WAIT_S = 300;
// under this many calls left in the hour, calls are spaced out rather than spent as fast as they go
const RATE_FLOOR = 500;
const SLOW_PACE_MS = 1000;
// a stalled gateway call fails rather than holding the caller; bounded by silence, not total time,
// so a large archive that keeps arriving is never cut off
const IDLE_TIMEOUT_MS = 120_000;

/** What the gateway does near GitHub's hourly limit; the defaults are what runs, a test sets its own. */
export type RateLimitPolicy = {
  /** Remaining calls under which each call waits `paceMs` first. */
  floor: number;
  paceMs: number;
  /** The longest wait for a spent limit's reset; a later reset fails naming its time. */
  maxResetWaitS: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

const DEFAULT_POLICY: RateLimitPolicy = {
  floor: RATE_FLOOR,
  paceMs: SLOW_PACE_MS,
  maxResetWaitS: MAX_RESET_WAIT_S,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** How long a call may go with no bytes arriving; the defaults are what runs, a test arms its own. */
export type TimeoutPolicy = {
  idleMs: number;
  /** Runs `onIdle` after `ms` unless the returned function is called first. */
  arm: (onIdle: () => void, ms: number) => () => void;
};

const DEFAULT_TIMEOUT: TimeoutPolicy = {
  idleMs: IDLE_TIMEOUT_MS,
  arm: (onIdle, ms) => {
    const timer = setTimeout(onIdle, ms);
    return () => clearTimeout(timer);
  },
};

/** An abort signal that fires once `policy.idleMs` pass with no `touch()`. */
function inactivity(policy: TimeoutPolicy) {
  const controller = new AbortController();
  const onIdle = () =>
    controller.abort(
      new DOMException(
        `no bytes arrived for ${policy.idleMs / 1000} s`,
        "TimeoutError",
      ),
    );
  let disarm = policy.arm(onIdle, policy.idleMs);
  return {
    signal: controller.signal,
    touch: () => {
      disarm();
      disarm = policy.arm(onIdle, policy.idleMs);
    },
    stop: () => disarm(),
  };
}

/**
 * The whole body, each chunk restarting the idle bound. Cancelling the reader ends a pending read
 * with `done` rather than a rejection, so the abort is checked after every read.
 */
async function readBody(
  response: Response,
  idle: ReturnType<typeof inactivity>,
): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const onAbort = () => {
    reader.cancel(idle.signal.reason).catch(() => {});
  };
  idle.signal.addEventListener("abort", onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (idle.signal.aborted) throw idle.signal.reason;
      if (done) break;
      idle.touch();
      chunks.push(value);
    }
  } finally {
    idle.signal.removeEventListener("abort", onAbort);
  }
  return Buffer.concat(chunks);
}

/** The chunks of a body as they arrive, each restarting the idle bound; ending early cancels the read. */
async function* chunksOf(
  response: Response,
  idle: ReturnType<typeof inactivity>,
  where: string,
): AsyncGenerator<Buffer> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const onAbort = () => {
    reader.cancel(idle.signal.reason).catch(() => {});
  };
  idle.signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      let read: Awaited<ReturnType<typeof reader.read>>;
      try {
        read = await reader.read();
        if (idle.signal.aborted) throw idle.signal.reason;
      } catch (error) {
        throw failedCall(where, error, idle.signal);
      }
      if (read.done) return;
      idle.touch();
      yield Buffer.from(
        read.value.buffer,
        read.value.byteOffset,
        read.value.byteLength,
      );
    }
  } finally {
    idle.signal.removeEventListener("abort", onAbort);
    idle.stop();
    await reader.cancel().catch(() => {});
  }
}

/** A header's number, or NaN when it is absent or empty: `Number("")` is 0. */
const numberHeader = (headers: Headers, name: string) => {
  const value = headers.get(name)?.trim();
  return value ? Number(value) : Number.NaN;
};

// fetch's own message is just "fetch failed", and a cut body's "terminated"; the reason is the
// cause. An abort is told by the signal's reason, whatever error the fetch implementation threw for it
const failedCall = (where: string, thrown: unknown, signal: AbortSignal) => {
  const error = signal.aborted ? signal.reason : thrown;
  const cause = error instanceof Error ? error.cause : undefined;
  return new GatewayError(
    `GitHub gateway: ${where} failed: ${messageOf(error)}${cause ? ` (${messageOf(cause)})` : ""}`,
    undefined,
    false,
    // our own inactivity timeout is never retried: the call may still be running at the far end
    !signal.aborted && connectionLost(error),
  );
};

// the connection reset or closed by the other side, as undici words it, at the call or in its body
const LOST_CODES = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"]);
const LOST_MESSAGE =
  /other side closed|socket hang up|terminated|econnreset|connection (?:was )?(?:reset|closed)/i;
function connectionLost(error: unknown): boolean {
  let current = error;
  for (let depth = 0; current instanceof Error && depth < 4; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && LOST_CODES.has(code)) return true;
    if (LOST_MESSAGE.test(current.message)) return true;
    current = current.cause;
  }
  return false;
}

const detailOf = (body: Buffer, statusText: string) => {
  const text = body.toString("utf8");
  try {
    const parsed = JSON.parse(text) as { message?: unknown };
    if (typeof parsed.message === "string") return parsed.message;
  } catch {}
  return text.trim() || statusText;
};

/** The error for an hourly limit that is used up until `resetAt` (epoch seconds). */
const rateLimitedAt = (resetAt: number, where: string, status: number) =>
  new GatewayError(
    `github_rate_limited: GitHub's hourly API limit is used up until ${new Date(resetAt * 1000).toISOString()} (${where})`,
    status,
    true,
  );

/** GitHub's REST API for one repo, through the gateway, with no credential of its own. */
export function gateway(options: {
  gatewayUrl: string;
  connectorId: string;
  owner: string;
  repo: string;
  rateLimit?: Partial<RateLimitPolicy>;
  timeout?: Partial<TimeoutPolicy>;
  /** Told of each retry of a 5xx answer or a lost connection. */
  progress?: (line: string) => void;
}) {
  const policy = { ...DEFAULT_POLICY, ...options.rateLimit };
  const timeout = { ...DEFAULT_TIMEOUT, ...options.timeout };
  const root = `${options.gatewayUrl.replace(/\/+$/, "")}/${encodeURIComponent(options.connectorId)}`;
  const repoPath = `/repos/${options.owner}/${options.repo}`;
  // the last `x-ratelimit-remaining` this gateway saw, which every call of it shares
  let remaining = Number.POSITIVE_INFINITY;
  // how messages name a call: never the root, which carries the connector id
  const whereOf = (method: string, path: string) =>
    `${method} ${repoPath}${path}`;
  /**
   * Sends the call, waiting out the limits it can; resolves with the answer's headers read and its
   * body not (a 403 or 429 that had to be read to be told apart carries it as `limitBody`).
   */
  async function open(method: string, path: string, body?: unknown) {
    const where = whereOf(method, path);
    let response: Response;
    let idle: ReturnType<typeof inactivity>;
    // the body of a 403 or 429 already read to tell a secondary limit from a refusal
    let limitBody: Buffer | undefined;
    for (let attempt = 0; ; attempt++) {
      if (remaining < policy.floor) await policy.sleep(policy.paceMs);
      idle = inactivity(timeout);
      try {
        response = await fetch(`${root}${repoPath}${path}`, {
          method,
          signal: idle.signal,
          headers: {
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            ...(body !== undefined && { "content-type": "application/json" }),
          },
          ...(body !== undefined && { body: JSON.stringify(body) }),
        });
      } catch (error) {
        idle.stop();
        throw failedCall(where, error, idle.signal);
      }
      const left = numberHeader(response.headers, "x-ratelimit-remaining");
      if (Number.isFinite(left)) remaining = left;
      const retryAfter = numberHeader(response.headers, "retry-after");
      // the primary limit: the quota is spent until `x-ratelimit-reset`, epoch seconds
      const resetAt = numberHeader(response.headers, "x-ratelimit-reset");
      const limitStatus = response.status === 403 || response.status === 429;
      if (limitStatus && left === 0 && Number.isFinite(resetAt)) {
        idle.stop();
        const waitS = Math.max(0, resetAt - policy.now() / 1000);
        await response.body?.cancel();
        if (waitS > policy.maxResetWaitS || attempt >= RETRIES) {
          throw rateLimitedAt(resetAt, where, response.status);
        }
        await policy.sleep(waitS * 1000 + 250);
        // the quota is whole again after the reset
        remaining = Number.POSITIVE_INFINITY;
        continue;
      }
      if (
        limitStatus &&
        retryAfter >= 0 &&
        retryAfter <= MAX_RETRY_AFTER_S &&
        attempt < RETRIES
      ) {
        idle.stop();
        await response.body?.cancel();
        await policy.sleep(retryAfter * 1000);
        continue;
      }
      if (limitStatus && !Number.isFinite(retryAfter) && left !== 0) {
        try {
          limitBody = await readBody(response, idle);
        } catch (error) {
          throw failedCall(where, error, idle.signal);
        } finally {
          idle.stop();
        }
        const secondary =
          response.status === 429 ||
          /secondary rate limit/i.test(
            detailOf(limitBody, response.statusText),
          );
        if (secondary && attempt < RETRIES) {
          limitBody = undefined;
          await policy.sleep(SECONDARY_WAIT_S * 1000);
          continue;
        }
      }
      break;
    }
    return { response, idle, where, limitBody };
  }
  type Opened = Awaited<ReturnType<typeof open>>;
  /** The body of an answer, read whole; anything but success throws a `GatewayError`. */
  async function settle({ response, idle, where, limitBody }: Opened) {
    let answer: Buffer;
    try {
      answer = limitBody ?? (await readBody(response, idle));
    } catch (error) {
      throw failedCall(where, error, idle.signal);
    } finally {
      idle.stop();
    }
    if (response.ok) return answer;
    const detail = detailOf(answer, response.statusText);
    // a rate limit past what is waited out above: GitHub answers a secondary one with a
    // `retry-after` or a message naming it, and a primary one with no remaining quota
    const rateLimited =
      response.status === 429 ||
      (response.status === 403 &&
        (response.headers.has("retry-after") ||
          numberHeader(response.headers, "x-ratelimit-remaining") === 0 ||
          /rate limit/i.test(detail)));
    throw new GatewayError(
      `GitHub gateway: ${where} returned ${response.status}: ${detail}`,
      response.status,
      rateLimited,
      TRANSIENT_STATUSES.has(response.status),
    );
  }
  /**
   * Runs one attempt of a call again, after a growing pause, while it fails transiently; the
   * final error names the last status or failure and how many retries were spent.
   */
  async function retrying<T>(where: string, attempt: () => Promise<T>) {
    for (let retry = 0; ; retry++) {
      try {
        return await attempt();
      } catch (error) {
        if (!(error instanceof GatewayError) || !error.transient) throw error;
        const wait = TRANSIENT_BACKOFF_MS[retry];
        if (wait === undefined) {
          throw new GatewayError(
            `${error.message} (after ${retry} retries)`,
            error.status,
            error.rateLimited,
            true,
          );
        }
        options.progress?.(
          `GitHub gateway: ${where} ${error.status ? `answered ${error.status}` : "lost the connection"}; retrying in ${wait / 1000} s (retry ${retry + 1}/${TRANSIENT_BACKOFF_MS.length})`,
        );
        await policy.sleep(wait);
      }
    }
  }
  const request = (method: string, path: string, body?: unknown) =>
    retrying(whereOf(method, path), async () =>
      settle(await open(method, path, body)),
    );
  const parsed = <T>(where: string, answer: Buffer): T => {
    try {
      return JSON.parse(answer.toString("utf8")) as T;
    } catch (error) {
      throw new GatewayError(
        `GitHub gateway: ${where} answered with a body that isn't JSON: ${messageOf(error)}`,
      );
    }
  };
  const call = async function call<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    return parsed<T>(whereOf(method, path), await request(method, path, body));
  };
  /** One attempt of a call, never sent again on a 5xx or a lost connection. */
  call.once = async <T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> =>
    parsed<T>(
      whereOf(method, path),
      await settle(await open(method, path, body)),
    );
  /** The retries `call` makes, around attempts its caller makes itself. */
  call.retrying = retrying;
  /** The bytes a GET answers with, such as a repo's tarball; only silence times it out. */
  call.bytes = (path: string): Promise<Buffer> => request("GET", path);
  /**
   * A GET's body as it arrives, for one too large to hold: each chunk restarts the idle bound, and
   * stopping early cancels the download. Anything but success throws a `GatewayError` before a chunk.
   */
  call.stream = async (path: string): Promise<AsyncGenerator<Buffer>> => {
    const opened = await retrying(whereOf("GET", path), async () => {
      const attempt = await open("GET", path);
      if (!attempt.response.ok || attempt.limitBody) {
        await settle(attempt);
        throw new GatewayError(
          `GitHub gateway: ${attempt.where} answered with an unexpected body`,
        );
      }
      return attempt;
    });
    return chunksOf(opened.response, opened.idle, opened.where);
  };
  call.where = whereOf;
  return call;
}

/**
 * Every base head a publish fetched into this clone, one ref per commit. A base fetched over REST
 * is usually shallow, so a branch rebased onto it reaches no older base, `origin/<base>` included;
 * these refs are what it is published from after that. Keyed by commit, not branch, they still
 * find the base for a branch renamed or cut from a rebased one, and one rebased onto it by hand.
 * `origin/<base>` stays where it is: every agent's worktree in the clone reads it, and moving it
 * to a shallow commit would cut every other branch off from its own base.
 */
export const FETCHED_BASES = "refs/sky/bases/";

/**
 * The git config key, under `branch.<local branch>.`, naming the GitHub branch the local branch
 * publishes to when that isn't its own name: the runner sets it for an agent that continues an
 * existing GitHub branch.
 */
export const REMOTE_BRANCH_KEY = "sky-remote-branch";

const resolves = (cwd: string, ref: string) =>
  git(cwd, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`).then(
    (sha) => sha.trim(),
    () => "",
  );

/**
 * The branch a rebase stopped in this worktree is rewriting, "" when git didn't record one, or
 * undefined when no rebase is in progress. `rebase-merge` is the merge backend's state directory,
 * `rebase-apply` the apply backend's, and `git am`'s too, marked by an `applying` file.
 */
export async function rebaseInProgress(
  cwd: string,
): Promise<string | undefined> {
  for (const dir of ["rebase-merge", "rebase-apply"]) {
    const path = (
      await git(cwd, "rev-parse", "--path-format=absolute", "--git-path", dir)
    ).trim();
    if (!existsSync(path) || existsSync(join(path, "applying"))) continue;
    const head = await readFile(join(path, "head-name"), "utf8").catch(
      () => "",
    );
    return head.trim().replace(/^refs\/heads\//, "");
  }
  return undefined;
}

/**
 * `-c` flags for a git command that moves commits (rebase, cherry-pick): it commits as whoever git
 * is configured as, and a sandbox may have no identity of its own; the repo's hooks and the user's
 * signing are no part of moving commits, and either could fail it.
 */
export async function movingCommitsConfig(cwd: string): Promise<string[]> {
  const identity = (await git(cwd, "config", "user.email").catch(() => ""))
    ? []
    : ["-c", "user.name=sky-agent", "-c", "user.email=agent@sky.local"];
  return [
    ...identity,
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=/dev/null",
  ];
}

/**
 * Rebases this branch's commits from `mergeBase` onto GitHub's current head of the base, which a
 * sandbox's clone, made once at provisioning, falls behind, so what is published sits on the base
 * as it is now, not as the clone saw it. The head commit is materialized from the REST API when it
 * isn't here, and recorded under `FETCHED_BASES` before the rebase starts, so a rebase that stops
 * or is killed, or is redone by hand, leaves it known. A failed rebase is aborted and fails the
 * publish before anything is sent to GitHub: as a conflict where git stopped on one, else with
 * git's own message.
 */
async function refreshBase(
  cwd: string,
  call: ReturnType<typeof gateway>,
  options: { base: string; branch: string; mergeBase: string },
): Promise<void> {
  const { base, branch, mergeBase } = options;
  const { object } = await call<{ object: { sha: string } }>(
    "GET",
    `/git/ref/heads/${base.split("/").map(encodeURIComponent).join("/")}`,
  ).catch((error: unknown) => {
    if (error instanceof GatewayError && error.status === 404) {
      throw new PublishError(
        `${base} doesn't exist on GitHub, so there is nothing to open a pull request into (${error.message})`,
      );
    }
    throw error;
  });
  if (object.sha === mergeBase) return;
  await fetchCommit(repoGit(cwd), call, object.sha);
  await git(cwd, "update-ref", `${FETCHED_BASES}${object.sha}`, object.sha);
  try {
    await git(
      cwd,
      ...(await movingCommitsConfig(cwd)),
      "rebase",
      "--quiet",
      "--onto",
      object.sha,
      mergeBase,
    );
  } catch (error) {
    // one line per stage of each unmerged path: "<mode> <sha> <stage>\t<path>"
    const conflicted = [
      ...new Set(
        lines(await git(cwd, "ls-files", "--unmerged").catch(() => "")).map(
          (line) => line.slice(line.indexOf("\t") + 1),
        ),
      ),
    ];
    // a rebase refused before it began, as on a held index.lock, leaves nothing to abort
    const stuck =
      (await rebaseInProgress(cwd)) === undefined
        ? ""
        : await git(cwd, "rebase", "--abort").then(
            () => "",
            (abort: unknown) =>
              `; \`git rebase --abort\` failed too, so the worktree is left mid-rebase with HEAD detached, and commits made now land on no branch; run it again once git allows, before anything else (${gitSaid(abort)})`,
          );
    if (conflicted.length) {
      throw new PublishError(
        `${base} moved on GitHub to ${object.sha}, and this branch's commits don't rebase onto it cleanly; rebase them by hand with \`git rebase --onto ${object.sha} ${mergeBase}\`, resolve the conflicts, and publish again (conflict in ${conflicted.join(", ")})${stuck}`,
      );
    }
    throw new PublishError(
      `rebasing ${branch} onto ${base} at ${object.sha} failed: ${gitSaid(error)}${stuck}`,
    );
  }
}

/** Whether GitHub's commit `sha` has `ancestor` on its first-parent line, within a bounded walk. */
async function sitsOn(
  call: ReturnType<typeof gateway>,
  sha: string,
  ancestor: string,
): Promise<boolean> {
  for (let steps = 0; steps < 500; steps++) {
    if (sha === ancestor) return true;
    const { parents } = await call<{ parents: { sha: string }[] }>(
      "GET",
      `/git/commits/${sha}`,
    );
    const next = parents[0]?.sha;
    if (!next) return false;
    sha = next;
  }
  return false;
}

/**
 * Publishes the worktree's branch, or `options.branch`, through the GitHub gateway, which carries
 * no git push: each commit past the base is recreated with GitHub's git data API (blobs, a tree on
 * its parent's tree, the commit with its own message and identities), then the branch ref is
 * created or moved and a pull request into the base opened, or the open one given the new title
 * and body. Claude
 * Code's attribution is stripped from each commit message and the pull request's body, never its
 * title. The base is first refreshed to GitHub's current head, with the branch's commits rebased
 * onto it when it moved (`refreshBase`), unless the branch is a continued one. That rebase flattens
 * a merge: the merge commit is dropped and the commits it brought in that the base lacks are
 * replayed one by one. Otherwise first-parent history is replayed and a merge commit is sent with
 * its other parents as they are, so a merge of the base leaves the base an ancestor of the
 * published head; a merge of a commit GitHub doesn't hold is refused before anything is sent. A
 * branch on GitHub whose head this branch held before a rebase or amend here is force-updated to the
 * rewritten history; one holding a commit neither this branch nor the base has is refused before
 * anything is sent, and the GitHub branch a continued agent works on is only ever fast-forwarded.
 * Trees are sent as they are, `.github/workflows/` included; a ref update GitHub refuses over
 * workflow files fails as `workflow_files_blocked`, naming them.
 */
export async function publish(options: {
  cwd: string;
  gatewayUrl: string;
  connectorId: string;
  /** Required unless the branch already has an open pull request; given for one, it replaces the title. */
  title?: string;
  /** Given for an open pull request, it replaces the body. */
  body?: string;
  /** Defaults to the branch `origin/HEAD` names. */
  base?: string;
  /** The GitHub branch to publish to and open the pull request from; defaults to the worktree's own. */
  branch?: string;
  /** Used when `branch` isn't given and the worktree continues no GitHub branch of its own. */
  defaultBranch?: string;
  /** Replaces the author and committer of each commit sent; their dates stay. */
  identity?: { author: PersonName; committer: PersonName };
  /** Told of each retry of a gateway call. */
  progress?: (line: string) => void;
  /** The gateway's rate-limit policy, whose `sleep` also paces retries; a test sets its own. */
  rateLimit?: Partial<RateLimitPolicy>;
}): Promise<PublishResult> {
  // `ls-files` takes its implicit pathspec relative to the directory it runs in, while
  // `<rev>:<path>` is from the top, so every call runs from the top
  const cwd = (await git(options.cwd, "rev-parse", "--show-toplevel")).trim();
  const rebasing = await rebaseInProgress(cwd);
  if (rebasing !== undefined) {
    // a rebase detaches HEAD until it finishes, so this is checked before the branch is read
    throw new PublishError(
      `a rebase${rebasing ? ` of ${rebasing}` : ""} is in progress here, left by an earlier run that stopped mid-way; run \`git rebase --abort\` to return the branch to where it was, then publish again`,
    );
  }
  const localBranch = (
    await git(cwd, "symbolic-ref", "--quiet", "--short", "HEAD").catch(() => "")
  ).trim();
  if (!localBranch)
    throw new PublishError("HEAD is detached; check out a branch");
  // set by the runner for an agent that continues an existing GitHub branch
  const continued = (
    await git(
      cwd,
      "config",
      "--get",
      `branch.${localBranch}.${REMOTE_BRANCH_KEY}`,
    ).catch(() => "")
  ).trim();
  // the GitHub branch published to; the worktree's own branch keeps its name and its reflog. The
  // flag wins, then the branch a continued agent was started on, then the environment's default
  const chosen = options.branch ?? (continued || options.defaultBranch);
  const remoteBranch = chosen ?? localBranch;
  if (chosen !== undefined && chosen !== continued) {
    // check-ref-format passes these under refs/heads/, but git refuses HEAD as a branch, and a
    // ref path or remote prefix would be taken literally as part of the GitHub branch's name
    const valid =
      !chosen.startsWith("-") &&
      chosen !== "HEAD" &&
      !/^(refs|origin)\//.test(chosen) &&
      (await git(cwd, "check-ref-format", `refs/heads/${chosen}`).then(
        () => true,
        () => false,
      ));
    if (!valid) {
      throw new PublishError(
        `${chosen} is not a valid branch name; see \`git check-ref-format\``,
      );
    }
  }
  if ((await git(cwd, "status", "--porcelain")).trim()) {
    throw new PublishError(
      "the worktree has uncommitted changes; commit them first, publish sends commits only",
    );
  }
  const base =
    options.base ??
    (await git(cwd, "rev-parse", "--abbrev-ref", "origin/HEAD"))
      .trim()
      .replace(/^origin\//, "");
  // `--base` can name another branch, which would leave the default branch open to a fast-forward
  const defaultBranch = (
    await git(cwd, "rev-parse", "--abbrev-ref", "origin/HEAD").catch(() => "")
  )
    .trim()
    .replace(/^origin\//, "");
  if (remoteBranch === base || remoteBranch === defaultBranch) {
    throw new PublishError(
      `${remoteBranch} is the base branch; publish to a branch of its own`,
    );
  }
  const { owner, repo } = parseOrigin(
    (await git(cwd, "remote", "get-url", "origin")).trim(),
  );
  const pending = async () => {
    // the newest of the clone's base and every base a publish fetched; a clone pulled through the
    // connector holds only the default branch, so a branch cut from it is rebased from there onto
    // GitHub's head of any other base
    const clonedRef = (await resolves(cwd, `refs/remotes/origin/${base}`))
      ? `origin/${base}`
      : "origin/HEAD";
    const [cloned, fetched] = await Promise.all([
      resolves(cwd, clonedRef),
      git(cwd, "for-each-ref", "--format=%(objectname)", FETCHED_BASES),
    ]);
    const bases = [cloned, ...lines(fetched)].filter(Boolean);
    const found = lines(
      await git(cwd, "merge-base", "--all", "HEAD", ...bases).catch(() => ""),
    );
    if (found.length > 1) {
      // without --all git outputs an unspecified one of these; from any one, the rebase and the
      // commit list would take the others' history as this branch's own
      const [newest] = lines(await git(cwd, "rev-list", "--no-walk", ...found));
      throw new PublishError(
        `${localBranch} has more than one merge base with ${base} here, none an ancestor of another (${found.join(", ")}), as after a merge of unrelated histories, so which commits are its own is ambiguous; move them onto a new branch with \`git switch -c ${localBranch}-on-${base} ${newest}\` and \`git cherry-pick --no-merges ${found.map((sha) => `^${sha}`).join(" ")} ${localBranch}\`, then publish that`,
      );
    }
    const [mergeBase] = found;
    if (!mergeBase) {
      // a rebase onto the base would replay the branch's root commit, adding every file, and
      // conflict wherever the base has one too
      throw new PublishError(
        `${localBranch} shares no commit here with ${base} or any base a publish fetched, so there is no base to publish it onto; move its commits onto a new branch from ${clonedRef} with \`git switch -c ${localBranch}-on-${base} ${clonedRef}\` and \`git cherry-pick ${clonedRef}..${localBranch}\`, then publish that`,
      );
    }
    const commits = lines(
      await git(
        cwd,
        "rev-list",
        "--reverse",
        "--first-parent",
        `${mergeBase}..HEAD`,
      ),
    );
    return { mergeBase, commits };
  };
  const local = await pending();
  if (local.commits.length === 0) {
    throw new PublishError(
      `no commits on ${localBranch} past ${base}; commit your work first`,
    );
  }

  const call = gateway({ ...options, owner, repo });
  // the ref lookup below reads a 404 as a new branch, which a repo the connector can't see also returns
  await call("GET", "").catch((error: unknown) => {
    if (error instanceof GatewayError && error.status === 404) {
      throw new PublishError(
        `the connector in ${CONNECTOR_ENV} can't see ${owner}/${repo}; check its connection id and the repos it grants (${error.message})`,
      );
    }
    throw error;
  });
  // before the base is refreshed, so a missing title leaves the branch and the clone as they were
  const [existing] = await call<{ number: number; html_url: string }[]>(
    "GET",
    `/pulls?state=open&head=${encodeURIComponent(`${owner}:${remoteBranch}`)}`,
  );
  if (!existing && !options.title) {
    throw new PublishError("a title is needed to open the pull request");
  }
  // a continued branch is someone's pull request as they left it, never rebased onto the base
  if (!continued) {
    await refreshBase(cwd, call, {
      base,
      branch: localBranch,
      mergeBase: local.mergeBase,
    });
  }
  const { mergeBase, commits } = continued ? local : await pending();
  // the rebase drops a commit whose change the base already holds
  if (commits.length === 0) {
    throw new PublishError(
      `the changes on ${localBranch} are already on ${base} on GitHub, so there is nothing left to publish`,
    );
  }
  const refPath = `heads/${remoteBranch.split("/").map(encodeURIComponent).join("/")}`;
  const notFastForward = `${remoteBranch} on GitHub isn't an ancestor of this branch and holds a commit this branch never had, as when someone pushed there; it can't be fast-forwarded and isn't overwritten`;
  const treeOf = async (sha: string) =>
    (await git(cwd, "rev-parse", `${sha}^{tree}`)).trim();
  const workflowsOf = async (sha: string) =>
    (
      await git(
        cwd,
        "rev-parse",
        "--verify",
        "--quiet",
        `${sha}:${WORKFLOWS_DIR}`,
      ).catch(() => "")
    ).trim();

  const remote = await call<{ object: { sha: string } }>(
    "GET",
    `/git/ref/${refPath}`,
  ).then(
    (ref) => ref.object.sha,
    (error: unknown) => {
      if (error instanceof GatewayError && error.status === 404) return null;
      throw error;
    },
  );

  // replay from the last local commit GitHub already holds: the same sha, or else the same tree (a
  // recreated commit's sha differs once its date's offset is dropped; its tree can't differ)
  const known = [mergeBase, ...commits];
  let start = 0;
  let parent = mergeBase;
  // GitHub's head is one this branch held before it was rebased or amended here, so the rewritten
  // history replaces it; a head this branch never held is someone else's, and is never overwritten
  let rewritten = false;
  // GitHub's tree for the commit replay resumes from
  let resumeTree: string | undefined;
  if (remote) {
    let at = known.indexOf(remote);
    if (at !== -1) {
      resumeTree = await treeOf(remote);
    } else {
      const remoteTree = (
        await call<{ tree: { sha: string } }>("GET", `/git/commits/${remote}`)
      ).tree.sha;
      const trees = await Promise.all(known.map(treeOf));
      at = trees.lastIndexOf(remoteTree);
      // a tree this branch also has, on a history that doesn't pass through the base commit the
      // matching local commit forks from (published before the base moved, rebased here since),
      // would keep that stale history under the new commits; a commit from before a merge of the
      // base forks from the older base, so it is compared with that one, not the base as it is now
      const forkedFrom =
        at !== -1 &&
        (await git(cwd, "merge-base", known[at] as string, mergeBase)).trim();
      if (forkedFrom && !(await sitsOn(call, remote, forkedFrom))) {
        at = -1;
        rewritten = true;
      } else if (at === -1) {
        const reflog = await git(
          cwd,
          "log",
          "--walk-reflogs",
          "--format=%H %T",
          `refs/heads/${localBranch}`,
        ).catch(() => "");
        rewritten = lines(reflog)
          .map((line) => line.split(" "))
          .some(([sha, tree]) => sha === remote || tree === remoteTree);
      }
      if (at !== -1) resumeTree = remoteTree;
    }
    // a continued branch is someone's pull request: its head is theirs even when it sits in this
    // branch's reflog, as the head the worktree was made from always does
    if (at === -1 && continued && remoteBranch === continued) {
      const syncIt = `run \`node /opt/sky/runner.mjs sync\` to bring what was pushed to ${remoteBranch} into this worktree (your unpublished commits are rebased onto it), then publish again`;
      // a commit git doesn't know can only have been pushed since the last fetch
      const known = await git(cwd, "cat-file", "-e", `${remote}^{commit}`).then(
        () => true,
        () => false,
      );
      throw new PublishError(
        `${remoteBranch} on GitHub is at ${remote}, which this branch doesn't build on (as after a push there, or an amend or rebase here); a branch this agent continues is only ever fast-forwarded, so nothing was sent. ${
          known
            ? `If someone pushed there, ${syncIt}. If you amended or rebased commits that were already published, put your work back on top of it instead: \`git reset --soft ${remote}\` and \`git commit\` keep your files as they are in a new commit on it, then publish again`
            : `Someone pushed there since this worktree last fetched: ${syncIt}`
        }`,
      );
    }
    // the replay goes onto the base, so a fast-forward from a head that is neither this branch's
    // history nor on the base's is refused: it fails here, before anything is sent
    if (at === -1 && !rewritten) {
      // false as well for a commit that isn't here
      const onBase = await git(
        cwd,
        "merge-base",
        "--is-ancestor",
        remote,
        mergeBase,
      ).then(
        () => true,
        () => false,
      );
      if (!onBase) {
        throw new PublishError(`${notFastForward}, so nothing was sent`);
      }
    }
    if (at !== -1) {
      start = at;
      parent = remote;
    }
  }

  // a merge's other parents are sent as they are, so GitHub must already hold each: one only this
  // clone has would need its own history replayed, and leaving it out would flatten the merge
  const mergedIn = new Map<string, string[]>();
  const onGitHub = new Map<string, Promise<boolean>>();
  for (const sha of known.slice(start + 1)) {
    const [, ...others] = lines(await git(cwd, "rev-parse", `${sha}^@`));
    if (others.length === 0) continue;
    mergedIn.set(sha, others);
    for (const other of others) {
      let found = onGitHub.get(other);
      if (!found) {
        found = call("GET", `/git/commits/${other}`).then(
          () => true,
          (error: unknown) => {
            if (error instanceof GatewayError && error.status === 404) {
              return false;
            }
            throw error;
          },
        );
        onGitHub.set(other, found);
      }
      if (!(await found)) {
        throw new PublishError(
          `commit ${sha} on ${localBranch} merges ${other}, which GitHub doesn't have (as from a branch made only here), and publish sends a merge only with parents GitHub already holds, so nothing was sent; merge only branches GitHub has, or replace the merge with its commits: \`git rebase ${mergeBase}\` replays them onto this branch's own, then publish again`,
        );
      }
    }
  }

  const tip = commits[commits.length - 1] as string;

  // a blob's sha is the hash of its content, on GitHub as here, so one an earlier or failed publish
  // uploaded is found rather than sent again; a lookup costs less of the rate limit than a create
  const uploadBlob = async (sha: string) => {
    const found = await call<{ sha: string }>("GET", `/git/blobs/${sha}`).then(
      (blob) => blob.sha,
      (error: unknown) => {
        if (error instanceof GatewayError && error.status === 404) return null;
        throw error;
      },
    );
    if (found) return found;
    const content = await gitBytes(cwd, "cat-file", "blob", sha);
    return (
      await call<{ sha: string }>("POST", "/git/blobs", {
        content: content.toString("base64"),
        encoding: "base64",
      })
    ).sha;
  };

  // a tree GitHub has: the commit replay resumes from, or the base head
  let tree = resumeTree ?? (await treeOf(mergeBase));
  let fromTree = await treeOf(known[start] ?? mergeBase);
  const blobs = new Map<string, string>();
  for (const sha of known.slice(start + 1)) {
    const next = await treeOf(sha);
    const entries: TreeEntry[] = [];
    for (const change of await changes(cwd, fromTree, next)) {
      // a submodule is a commit sha in the tree, with no blob behind it
      const type = change.mode === "160000" ? "commit" : "blob";
      let remoteSha = change.sha;
      if (remoteSha !== null && type === "blob") {
        remoteSha = blobs.get(remoteSha) ?? (await uploadBlob(remoteSha));
        blobs.set(change.sha as string, remoteSha);
      }
      entries.push({
        path: change.path,
        mode: change.mode,
        type,
        sha: remoteSha,
      });
    }
    const merged = mergedIn.get(sha) ?? [];
    fromTree = next;
    // an empty commit keeps its parent's tree; GitHub refuses a tree request with no entries
    if (entries.length > 0) {
      tree = (
        await call<{ sha: string }>("POST", "/git/trees", {
          base_tree: tree,
          tree: entries,
        })
      ).sha;
    }
    const local = await readCommit(cwd, sha, options.identity);
    parent = (
      await call<{ sha: string }>("POST", "/git/commits", {
        message: local.message,
        tree,
        parents: [parent, ...merged],
        author: local.author,
        committer: local.committer,
      })
    ).sha;
  }

  // GitHub refuses a ref update that changes .github/workflows/ when the token lacks the `workflow`
  // scope, with a 404 or 403 that reads, bare, as lost repo access; this publish's object writes
  // have succeeded by now, so the workflow files the sent commits change are named as the likely cause
  const writeRef = (
    method: string,
    path: string,
    body: unknown,
    send: typeof call.once = call,
  ) =>
    send(method, path, body).catch(async (error: unknown) => {
      if (
        !(error instanceof GatewayError) ||
        error.rateLimited ||
        (error.status !== 404 && error.status !== 403)
      ) {
        throw error;
      }
      // with no file to name, GitHub's own error stands
      const files = await workflowPathsBetween(
        cwd,
        await workflowsOf(known[start] as string),
        await workflowsOf(tip),
      ).catch((): string[] => []);
      if (files.length === 0) throw error;
      throw new PublishError(
        `workflow_files_blocked: GitHub refused to update ${remoteBranch} to commits that change ${files.join(", ")}, and that update needs the \`workflow\` scope, which Sky's GitHub connector may lack; give the connector the \`workflow\` scope, then publish again (${error.message})`,
      );
    });

  // a ref create or fast-forward that GitHub made but answered 5xx for can fail its retry with a
  // 422; the ref already at `parent` is success
  const refIsAtParent = async (error: unknown) =>
    error instanceof GatewayError &&
    error.status === 422 &&
    (
      await call<{ object: { sha: string } }>(
        "GET",
        `/git/ref/${refPath}`,
      ).catch(() => undefined)
    )?.object.sha === parent;
  if (remote === null) {
    await writeRef("POST", "/git/refs", {
      ref: `refs/heads/${remoteBranch}`,
      sha: parent,
    }).catch(async (error: unknown) => {
      if (!(await refIsAtParent(error))) throw error;
    });
  } else if (rewritten) {
    // GitHub's ref update takes no expected old value: it is read again just before the forced
    // update, so a write since the lookup above isn't overwritten
    const refAt = async () => {
      const ref = await call<{ object: { sha: string } }>(
        "GET",
        `/git/ref/${refPath}`,
      );
      return ref.object.sha;
    };
    const moved = (sha: string) =>
      new PublishError(
        `${remoteBranch} moved on GitHub to ${sha} while this publish ran; nothing was overwritten, publish again`,
      );
    const now = await refAt();
    if (now !== remote) throw moved(now);
    // a forced update answered 5xx or cut off may have been made or not, and the branch may have
    // moved since, so it is never sent again blind: the ref is read after each pause, and the
    // update goes again only while the ref still holds `remote`
    const patch = `/git/refs/${refPath}`;
    let sent = false;
    await call.retrying(call.where("PATCH", patch), async () => {
      if (sent) {
        const at = await refAt().catch((error: unknown) => {
          // the read already spent its own retries, so its failure ends the forced update's too
          throw error instanceof GatewayError && error.transient
            ? new GatewayError(error.message, error.status, error.rateLimited)
            : error;
        });
        if (at === parent) return;
        if (at !== remote) throw moved(at);
      }
      sent = true;
      await writeRef("PATCH", patch, { sha: parent, force: true }, call.once);
    });
  } else if (remote !== parent) {
    await writeRef("PATCH", `/git/refs/${refPath}`, {
      sha: parent,
      force: false,
    }).catch(async (error: unknown) => {
      if (await refIsAtParent(error)) return;
      if (error instanceof GatewayError && error.status === 422) {
        throw new PublishError(`${notFastForward} (${error.message})`);
      }
      throw error;
    });
  }

  if (existing) {
    // the title and body are given again on a re-publish so they follow the review fixes
    const update = {
      ...(options.title && { title: options.title }),
      ...(options.body !== undefined && {
        body: stripAttribution(options.body),
      }),
    };
    const updated = Object.keys(update).length > 0;
    if (updated) await call("PATCH", `/pulls/${existing.number}`, update);
    return {
      branch: remoteBranch,
      base,
      sha: parent,
      created: false,
      updated,
      pullRequest: { number: existing.number, url: existing.html_url },
    };
  }
  const pull = await call<{ number: number; html_url: string }>(
    "POST",
    "/pulls",
    {
      title: options.title as string,
      ...(options.body !== undefined && {
        body: stripAttribution(options.body),
      }),
      head: remoteBranch,
      base,
    },
  ).catch(async (error: unknown) => {
    // a pull request GitHub made but answered 5xx for is refused as a duplicate on the retry, so
    // on any 422 a pull request already open for this head is taken as this publish's
    if (!(error instanceof GatewayError) || error.status !== 422) throw error;
    const [made] = await call<{ number: number; html_url: string }[]>(
      "GET",
      `/pulls?state=open&head=${encodeURIComponent(`${owner}:${remoteBranch}`)}`,
    ).catch(() => []);
    if (!made) throw error;
    return made;
  });
  return {
    branch: remoteBranch,
    base,
    sha: parent,
    created: true,
    updated: false,
    pullRequest: { number: pull.number, url: pull.html_url },
  };
}

export const PUBLISH_USAGE =
  "publish --title <title> [--body <text|@file>] [--base <branch>] [--branch <name>]";

/** The env var naming the GitHub branch to publish to when `--branch` isn't given. */
export const BRANCH_ENV = "SKY_PUBLISH_BRANCH";

/**
 * The identity commits are sent under: `GIT_AUTHOR_NAME` and `GIT_AUTHOR_EMAIL` (environment
 * secrets) for the author, the `GIT_COMMITTER_*` pair for the committer, defaulting to the author.
 * Undefined unless both author vars are set, and the commits then keep the identities they were
 * made with; inside a session both are always set, to Claude when the environment doesn't set both
 * (`sessionGitIdentity` in session.ts), so there every commit sent is rewritten.
 */
export function configuredIdentity(env: NodeJS.ProcessEnv) {
  const name = env.GIT_AUTHOR_NAME;
  const email = env.GIT_AUTHOR_EMAIL;
  if (!name || !email) return undefined;
  const author = { name, email };
  return {
    author,
    committer: {
      name: env.GIT_COMMITTER_NAME || name,
      email: env.GIT_COMMITTER_EMAIL || email,
    },
  };
}

/**
 * `runner.mjs publish …`, run by the agent from its worktree: prints the pull request's URL on
 * stdout, and returns the exit status, 2 for a usage or config error.
 */
export async function publishMain(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: { cwd: string; stdout: (s: string) => void; stderr: (s: string) => void },
): Promise<number> {
  let values: {
    title?: string;
    body?: string;
    base?: string;
    branch?: string;
    help?: boolean;
  };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        title: { type: "string" },
        body: { type: "string" },
        base: { type: "string" },
        branch: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (error) {
    io.stderr(
      `sky publish: ${(error as Error).message}\nusage: ${PUBLISH_USAGE}\n`,
    );
    return 2;
  }
  if (values.help) {
    io.stdout(`usage: ${PUBLISH_USAGE}\n`);
    return 0;
  }
  // `--body @path` reads the body from a file, like the CLI's `--prompt=@file`; a relative path is
  // from the working directory
  if (values.body?.startsWith("@")) {
    const file = resolve(io.cwd, values.body.slice(1));
    try {
      values.body = await readFile(file, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      io.stderr(
        `sky publish: cannot read the --body file ${file}${code ? ` (${code})` : ""}\nusage: ${PUBLISH_USAGE}\n`,
      );
      return 2;
    }
  }
  const connectorId = env[CONNECTOR_ENV];
  if (!connectorId) {
    io.stderr(
      `sky publish: ${CONNECTOR_ENV} is not set; set a connector secret: sky secret set <env> ${CONNECTOR_ENV} --connector=<connection id>\n`,
    );
    return 2;
  }
  try {
    const result = await publish({
      cwd: io.cwd,
      gatewayUrl: env[GATEWAY_URL_ENV] || DEFAULT_GATEWAY_URL,
      connectorId,
      ...values,
      ...(values.branch !== undefined && { branch: values.branch }),
      defaultBranch: env[BRANCH_ENV] || undefined,
      identity: configuredIdentity(env),
      progress: (line) => io.stderr(`${line}\n`),
    });
    io.stderr(
      result.created
        ? `sky publish: opened pull request #${result.pullRequest.number}\n`
        : `sky publish: pull request #${result.pullRequest.number} was already open${result.updated ? " and updated" : ""}; ${result.branch} is now ${result.sha}\n`,
    );
    io.stdout(`${result.pullRequest.url}\n`);
    return 0;
  } catch (error) {
    io.stderr(
      `sky publish: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}
