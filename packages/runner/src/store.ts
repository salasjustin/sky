import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { BaseProfileStoreLayout } from "@sky/shared";
import {
  CONNECTOR_ENV,
  DEFAULT_GATEWAY_URL,
  GATEWAY_URL_ENV,
  GatewayError,
  gateway,
} from "./publish.js";

/** The env var naming the store repo (`owner/repo`); unset, nothing syncs. */
export const STORE_REPO_ENV = "SKY_STORE_REPO";
/** The env var holding the store's layout as JSON (`BaseProfileStoreLayout`); unset, the defaults. */
export const STORE_LAYOUT_ENV = "SKY_STORE_LAYOUT";
/** Kill switch for store sync. */
export const NO_SYNC_ENV = "SKY_NO_STORE_SYNC";
/** The kill switch's earlier name, still honored. */
const LEGACY_NO_SYNC_ENV = "KRU_NO_STORE_SYNC";
export const STORE_SYNC_USAGE = "store-sync <pull|push>";

// the store's git repo is local; GitHub, reachable only through the gateway's REST API, holds the
// remote. `SYNCED_REF` is the last remote state this checkout merged, as a commit whose tree is the
// remote's tree; local commits past it are what a push sends
const SYNCED_REF = "refs/sky/synced";
const PRE_SYNC_REF = "refs/sky/pre-sync";
const REMOTE_SHA_KEY = "sky.remoteSha";
const LOCK_FILE = ".sky-store.lock";
const LOCK_WAIT_S = 600;
// `flock -E`: what flock exits with when the wait runs out; it prints nothing then, and the
// `--locked` child only ever exits 0, 1 or 2
const LOCK_TIMED_OUT = 75;
const PUSH_ATTEMPTS = 4;
// blob downloads in flight at once through the connector gateway during a pull
const BLOB_FETCH_CONCURRENCY = 8;
const PROGRESS_EVERY = 100;
// `git hash-object -t tree /dev/null`
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
// our lock stays out of the store, with whatever the layout keeps local to the sprite
const ALWAYS_EXCLUDED = [".DS_Store", LOCK_FILE];

export const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** The store's remote moved between the pull and the push. */
class PushRaced extends Error {}

const GIT_CONFIG = [
  "-c",
  "user.name=sky-agent",
  "-c",
  "user.email=agent@sky.local",
  "-c",
  "commit.gpgsign=false",
];

type GitOptions = {
  input?: string | Buffer;
  env?: NodeJS.ProcessEnv;
  /** Kills git and rejects when it runs longer. */
  timeoutMs?: number;
};

/** Runs git in `home`; resolves with stdout bytes, rejects with git's stderr. */
const gitBytes =
  (home: string) =>
  (args: string[], options: GitOptions = {}): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const child = spawn("git", [...GIT_CONFIG, ...args], {
        cwd: home,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...options.env },
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on("data", (d: Buffer) => out.push(d));
      child.stderr.on("data", (d: Buffer) => err.push(d));
      const timer =
        options.timeoutMs &&
        setTimeout(() => {
          child.kill("SIGKILL");
          reject(
            new Error(
              `git ${args[0]} timed out after ${Math.round((options.timeoutMs ?? 0) / 1000)}s`,
            ),
          );
        }, options.timeoutMs);
      child.on("error", reject);
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        if (code === 0) return resolve(Buffer.concat(out));
        const stderr = Buffer.concat(err).toString().trim();
        reject(new Error(`git ${args[0]} failed: ${stderr || `exit ${code}`}`));
      });
      child.stdin.on("error", () => {});
      child.stdin.end(options.input);
    });

export const git =
  (home: string) =>
  async (args: string[], options: GitOptions = {}): Promise<string> =>
    (await gitBytes(home)(args, options)).toString().trim();

/** The store's checkout: the layout's directory under `$HOME`, or `SKY_STORE_HOME` when set. */
export const resolveStoreHome = (
  env: NodeJS.ProcessEnv,
  layout: BaseProfileStoreLayout,
): string => join(homedir(), env.SKY_STORE_HOME || layout.home);

/** The layout the env carries; throws on JSON that isn't one, naming the variable and not its value. */
export function storeLayoutOf(env: NodeJS.ProcessEnv): BaseProfileStoreLayout {
  const raw = env[STORE_LAYOUT_ENV];
  if (!raw) return BaseProfileStoreLayout.parse({});
  let parsed: ReturnType<typeof BaseProfileStoreLayout.safeParse>;
  try {
    parsed = BaseProfileStoreLayout.safeParse(JSON.parse(raw));
  } catch {
    throw new Error(`${STORE_LAYOUT_ENV} is not JSON`);
  }
  if (!parsed.success)
    throw new Error(`${STORE_LAYOUT_ENV} is not a store layout`);
  return parsed.data;
}

type StoreOptions = {
  home: string;
  /** How the checkout treats local-only and line files; the defaults when absent. */
  layout?: BaseProfileStoreLayout;
  /** `owner/repo` of the store on GitHub. */
  repo: string;
  gatewayUrl: string;
  connectorId: string;
  /** The commit message for what this call pushes. */
  message: string;
  /** Gets a line (no trailing newline) as a pull downloads blobs; silent when none are missing. */
  progress?: Progress;
};

export type Progress = (line: string) => void;

export type TreeItem = {
  path: string;
  mode: string;
  type: string;
  sha: string;
};

/** Makes `home` a git repo that knows the store's local-only files and merge driver; safe to repeat. */
async function ensureRepo(
  home: string,
  layout: BaseProfileStoreLayout = BaseProfileStoreLayout.parse({}),
): Promise<void> {
  await mkdir(home, { recursive: true });
  const g = git(home);
  if (!existsSync(join(home, ".git"))) await g(["init", "-q", "-b", "main"]);
  const info = (await g(["rev-parse", "--git-path", "info"])).trim();
  await mkdir(join(home, info), { recursive: true });
  const excluded = [...layout.exclude, ...ALWAYS_EXCLUDED];
  await writeFile(join(home, info, "exclude"), `${excluded.join("\n")}\n`);
  const attributes = layout.lineFiles.map((p) => `${p} merge=sky-lines`);
  await writeFile(
    join(home, info, "attributes"),
    attributes.length > 0 ? `${attributes.join("\n")}\n` : "",
  );
  await g(["config", "merge.sky-lines.name", "line files"]);
  const script = layout.mergeScript && join(homedir(), layout.mergeScript);
  await g([
    "config",
    "merge.sky-lines.driver",
    script && existsSync(script)
      ? `bash '${script}' %O %A %B`
      : "git merge-file --union %A %O %B",
  ]);
}

const hasRef = (g: ReturnType<typeof git>, ref: string) =>
  g(["rev-parse", "--verify", "--quiet", ref]).then(
    () => true,
    () => false,
  );

/** Commits whatever is in the store, so a merge never touches an uncommitted file. */
async function commitLocal(
  g: ReturnType<typeof git>,
  message: string,
): Promise<void> {
  await g(["add", "--all"]);
  if (!(await g(["status", "--porcelain"]))) return;
  await g(["commit", "--quiet", "--no-verify", "-m", message]);
}

/**
 * Anchors the checkout to an empty base commit the first time, so what was already in the directory
 * becomes one local commit on top of it and merges with the remote's files, never replaces them. A
 * repo with history of its own keeps that tip under `PRE_SYNC_REF` and carries its files as that one
 * commit.
 */
async function anchor(g: ReturnType<typeof git>): Promise<void> {
  if (await hasRef(g, SYNCED_REF)) return;
  await g(["hash-object", "-t", "tree", "-w", "--stdin"], { input: "" });
  const base = await g(["commit-tree", EMPTY_TREE, "-m", "sky store base"]);
  if (await hasRef(g, "HEAD")) {
    await g(["update-ref", PRE_SYNC_REF, "HEAD"]);
    await g(["reset", "--quiet", "--soft", base]);
  } else {
    await g(["update-ref", "HEAD", base]);
  }
  await g(["update-ref", SYNCED_REF, base]);
}

/** The commit of `repo`'s default branch on GitHub, and the branch's name. */
export async function remoteHead(call: ReturnType<typeof gateway>) {
  const { default_branch: branch } = await call<{ default_branch: string }>(
    "GET",
    "",
  );
  const ref = await call<{ object: { sha: string } }>(
    "GET",
    `/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`,
  );
  return { branch, sha: ref.object.sha };
}

/** Merges the remote's current files into the checkout; a no-op when the remote hasn't moved. */
async function pull(
  g: ReturnType<typeof git>,
  call: ReturnType<typeof gateway>,
  home: string,
  message: string,
  progress: Progress = () => {},
): Promise<{ sha: string; branch: string }> {
  await anchor(g);
  await commitLocal(g, message);
  const remote = await remoteHead(call);
  const known = await g(["config", "--get", REMOTE_SHA_KEY]).catch(() => "");
  if (known === remote.sha) return remote;

  const { tree } = await call<{ tree: { sha: string } }>(
    "GET",
    `/git/commits/${remote.sha}`,
  );
  const listing = await call<{ tree: TreeItem[]; truncated: boolean }>(
    "GET",
    `/git/trees/${tree.sha}?recursive=1`,
  );
  if (listing.truncated)
    throw new Error("the store's tree is too large to sync");
  const index = join(home, ".git", "sky-sync-index");
  const blobs = listing.tree.filter((item) => item.type === "blob");
  const lines = blobs.map((item) => `${item.mode} ${item.sha}\t${item.path}\0`);
  try {
    await fetchMissing(g, call, blobs, progress);
    const env = { GIT_INDEX_FILE: index };
    await rm(index, { force: true });
    // -z takes each path literally; without it a path starting with `"` would be unquoted
    await g(["update-index", "-z", "--add", "--index-info"], {
      input: lines.join(""),
      env,
    });
    const treeId = await g(["write-tree"], { env });
    const synced = await g(["rev-parse", SYNCED_REF]);
    const snapshot = await g([
      "commit-tree",
      treeId,
      "-p",
      synced,
      "-m",
      `store ${remote.sha}`,
    ]);
    await rebaseOnto(g, home, snapshot, synced);
    await g(["update-ref", SYNCED_REF, snapshot]);
    await g(["config", REMOTE_SHA_KEY, remote.sha]);
  } finally {
    await rm(index, { force: true });
  }
  return remote;
}

/** The shas among `shas` the object store lacks, asked of one `cat-file` rather than one per sha. */
async function missingObjects(
  g: ReturnType<typeof git>,
  shas: string[],
): Promise<string[]> {
  if (!shas.length) return [];
  const answers = await g(["cat-file", "--batch-check"], {
    input: `${shas.join("\n")}\n`,
  });
  return answers
    .split("\n")
    .filter((line) => line.endsWith(" missing"))
    .map((line) => line.slice(0, -" missing".length));
}

/**
 * Downloads every blob of `items` the object store lacks, `BLOB_FETCH_CONCURRENCY` at a time, and checks
 * each one hashes to the sha GitHub listed it under.
 */
export async function fetchMissing(
  g: ReturnType<typeof git>,
  call: ReturnType<typeof gateway>,
  items: TreeItem[],
  progress: Progress,
  label = "store sync",
): Promise<void> {
  const listed = [...new Set(items.map((item) => item.sha))];
  const missing = await missingObjects(g, listed);
  if (!missing.length) return;
  const total = missing.length;
  progress(`${label}: fetching ${total} of ${listed.length} blobs`);
  let fetched = 0;
  await eachLimited(missing, BLOB_FETCH_CONCURRENCY, async (sha) => {
    const blob = await call<{ content: string }>("GET", `/git/blobs/${sha}`);
    const written = await writeBlob(g, Buffer.from(blob.content, "base64"));
    if (written !== sha) throw new Error(`blob ${sha} arrived as ${written}`);
    fetched++;
    if (fetched % PROGRESS_EVERY === 0 || fetched === total)
      progress(`${label}: fetched ${fetched}/${total} blobs`);
  });
}

/**
 * Runs `task` over `items`, at most `limit` at once. After the first rejection no new task starts;
 * the running ones settle, then this rejects with that first error.
 */
async function eachLimited<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async () => {
    while (!failure && next < items.length) {
      const item = items[next++] as T;
      try {
        await task(item);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  if (failure) throw failure.error;
}

/** Writes the blob through `hash-object` so its sha is git's own, whatever GitHub said it was. */
async function writeBlob(
  g: ReturnType<typeof git>,
  content: Buffer,
): Promise<string> {
  return g(["hash-object", "-w", "--stdin"], { input: content });
}

/**
 * Replays the local commits past `from` onto the remote's snapshot. A conflict the line-file driver can't
 * settle is retried with the local side winning; the remote's version stays in the history.
 */
async function rebaseOnto(
  g: ReturnType<typeof git>,
  home: string,
  onto: string,
  from: string,
): Promise<void> {
  try {
    await g(["rebase", "--quiet", "--onto", onto, from]);
    return;
  } catch {
    await g(["rebase", "--abort"]).catch(() => {});
  }
  // `-X theirs` settles content conflicts only; a file deleted on one side and changed on the
  // other still stops the rebase, so those are settled here, commit by commit
  let step = g(["rebase", "--quiet", "-X", "theirs", "--onto", onto, from]);
  for (;;) {
    try {
      await step;
      return;
    } catch (error) {
      const settled = await keepLocalSide(g, home).catch(() => false);
      if (!settled) {
        await g(["rebase", "--abort"]).catch(() => {});
        throw error;
      }
    }
    step = g(["rebase", "--continue"], { env: { GIT_EDITOR: "true" } });
  }
}

/**
 * Resolves every unmerged path of a stopped rebase to the commit being replayed (the local side):
 * its copy where it has one, else the path's deletion. False when nothing was unmerged.
 */
async function keepLocalSide(
  g: ReturnType<typeof git>,
  home: string,
): Promise<boolean> {
  const local = new Set<string>();
  const unmerged = new Set<string>();
  for (const entry of nulSeparated(
    await gitBytes(home)(["ls-files", "--unmerged", "-z"]),
  )) {
    const [meta, path] = splitOnce(entry, "\t");
    unmerged.add(path);
    // stage 3 is the replayed commit's side during a rebase
    if (meta.endsWith(" 3")) local.add(path);
  }
  if (!unmerged.size) return false;
  const env = { GIT_LITERAL_PATHSPECS: "1" };
  const kept = [...local];
  const dropped = [...unmerged].filter((path) => !local.has(path));
  if (kept.length) {
    await g(["checkout", "--theirs", "--", ...kept], { env });
    await g(["add", "--", ...kept], { env });
  }
  if (dropped.length) await g(["rm", "--quiet", "--", ...dropped], { env });
  return true;
}

const nulSeparated = (bytes: Buffer) =>
  bytes.toString("utf8").split("\0").filter(Boolean);

const splitOnce = (s: string, separator: string): [string, string] => {
  const at = s.indexOf(separator);
  return [s.slice(0, at), s.slice(at + separator.length)];
};

async function uploadBlob(
  call: ReturnType<typeof gateway>,
  home: string,
  sha: string,
): Promise<void> {
  const content = await gitBytes(home)(["cat-file", "blob", sha]);
  await call("POST", "/git/blobs", {
    content: content.toString("base64"),
    encoding: "base64",
  });
}

/** Sends the checkout's tree as one commit on the remote's branch; throws `PushRaced` when it moved. */
async function push(
  g: ReturnType<typeof git>,
  home: string,
  call: ReturnType<typeof gateway>,
  remote: { sha: string; branch: string },
  message: string,
): Promise<boolean> {
  const head = await g(["rev-parse", "HEAD"]);
  if (
    (await g(["rev-parse", `${head}^{tree}`])) ===
    (await g(["rev-parse", `${SYNCED_REF}^{tree}`]))
  ) {
    return false;
  }
  // only what changed since the remote's tree goes up, on top of it: a request carrying the whole
  // store's tree (thousands of entries) is refused with a 502. -z: without it git C-quotes a path
  // with non-ASCII or special characters
  const raw = nulSeparated(
    await gitBytes(home)([
      "diff-tree",
      "-r",
      "-z",
      "--raw",
      "--no-renames",
      SYNCED_REF,
      head,
    ]),
  );
  const changes: {
    path: string;
    mode: string;
    type: string;
    sha: string | null;
  }[] = [];
  // each change is `:<old mode> <new mode> <old sha> <new sha> <status>` then its path
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const [, , newMode = "", , newSha = "", status = ""] = (raw[i] ?? "").split(
      /[ :]/,
    );
    const deleted = status === "D";
    changes.push({
      path: raw[i + 1] ?? "",
      mode: deleted ? "100644" : newMode,
      type: newMode === "160000" ? "commit" : "blob",
      sha: deleted ? null : newSha,
    });
  }
  for (const change of changes) {
    if (change.sha !== null && change.type === "blob") {
      await uploadBlob(call, home, change.sha);
    }
  }
  const tree = await call<{ sha: string }>("POST", "/git/trees", {
    base_tree: await g(["rev-parse", `${SYNCED_REF}^{tree}`]),
    tree: changes,
  });
  const identity = { name: "sky-agent", email: "agent@sky.local" };
  const commit = await call<{ sha: string }>("POST", "/git/commits", {
    message,
    tree: tree.sha,
    parents: [remote.sha],
    author: identity,
    committer: identity,
  });
  try {
    await call(
      "PATCH",
      `/git/refs/heads/${remote.branch.split("/").map(encodeURIComponent).join("/")}`,
      { sha: commit.sha, force: false },
    );
  } catch (error) {
    // GitHub answers 422 for a missing or protected ref too, which no retry fixes
    if (
      error instanceof GatewayError &&
      error.status === 422 &&
      /not a fast.forward/i.test(error.message)
    ) {
      throw new PushRaced(error.message);
    }
    throw error;
  }
  await g(["update-ref", SYNCED_REF, head]);
  await g(["config", REMOTE_SHA_KEY, commit.sha]);
  return true;
}

/** Brings the store checkout up to date with GitHub, keeping every local file. Run under the lock. */
export async function pullStore(options: StoreOptions): Promise<void> {
  await ensureRepo(options.home, options.layout);
  const g = git(options.home);
  await pull(
    g,
    callFor(options),
    options.home,
    options.message,
    options.progress,
  );
}

/**
 * Commits the checkout and sends it to GitHub. A push that finds the remote moved pulls (a rebase)
 * and tries again, a few times. Returns whether anything was pushed. Run under the lock.
 */
export async function pushStore(options: StoreOptions): Promise<boolean> {
  await ensureRepo(options.home, options.layout);
  const g = git(options.home);
  const call = callFor(options);
  for (let attempt = 1; ; attempt++) {
    const remote = await pull(
      g,
      call,
      options.home,
      options.message,
      options.progress,
    );
    try {
      return await push(g, options.home, call, remote, options.message);
    } catch (error) {
      if (!(error instanceof PushRaced) || attempt >= PUSH_ATTEMPTS) {
        throw error instanceof PushRaced
          ? new Error(
              `the store moved on GitHub ${PUSH_ATTEMPTS} times while pushing: ${error.message}`,
            )
          : error;
      }
    }
  }
}

function callFor(options: StoreOptions) {
  const [owner = "", repo = ""] = options.repo.split("/");
  return gateway({
    gatewayUrl: options.gatewayUrl,
    connectorId: options.connectorId,
    owner,
    repo,
  });
}

type Mode = "pull" | "push";

/**
 * Runs `runner.mjs store-sync <mode> --locked` under an exclusive `flock` on a file in the store
 * root, so agents sharing a sprite take turns; resolves with the child's exit status, or 1 when
 * the lock stayed held for `waitS` seconds.
 */
export function underLock(
  home: string,
  mode: Mode,
  io: { stdout: (s: string) => void; stderr: (s: string) => void },
  self: [string, ...string[]] = [process.execPath, process.argv[1] as string],
  waitS = LOCK_WAIT_S,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(
      "flock",
      [
        "-x",
        "-w",
        String(waitS),
        "-E",
        String(LOCK_TIMED_OUT),
        join(home, LOCK_FILE),
        ...self,
        "store-sync",
        mode,
        "--locked",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout.on("data", (d: Buffer) => io.stdout(d.toString()));
    child.stderr.on("data", (d: Buffer) => io.stderr(d.toString()));
    child.on("error", (error) => {
      io.stderr(`store sync: flock failed to start: ${messageOf(error)}\n`);
      resolve(1);
    });
    child.on("close", (code) => {
      if (code !== LOCK_TIMED_OUT) return resolve(code ?? 1);
      io.stderr(
        `store sync: ${mode} skipped: another sync held the store's lock for over ${waitS}s\n`,
      );
      resolve(1);
    });
  });
}

/**
 * `runner.mjs store-sync <pull|push>`: syncs the profile's store with GitHub through the connector, one
 * agent at a time. Exits 0 without doing anything when no store repo is set or the kill switch is.
 * Returns the exit status: 2 for a usage or config error, 1 for a failed sync.
 */
export async function storeSyncMain(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: { stdout: (s: string) => void; stderr: (s: string) => void },
): Promise<number> {
  let positionals: string[];
  let locked: boolean;
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { locked: { type: "boolean" } },
    });
    positionals = parsed.positionals;
    locked = parsed.values.locked ?? false;
  } catch (error) {
    io.stderr(`store sync: ${messageOf(error)}\nusage: ${STORE_SYNC_USAGE}\n`);
    return 2;
  }
  const mode = positionals[0];
  if (positionals.length !== 1 || (mode !== "pull" && mode !== "push")) {
    io.stderr(`usage: ${STORE_SYNC_USAGE}\n`);
    return 2;
  }
  const repo = env[STORE_REPO_ENV];
  if (!repo || env[NO_SYNC_ENV] || env[LEGACY_NO_SYNC_ENV]) return 0;
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    io.stderr(`store sync: ${STORE_REPO_ENV} must be owner/repo\n`);
    return 2;
  }
  const connectorId = env[CONNECTOR_ENV];
  if (!connectorId) {
    io.stderr(
      `store sync: ${CONNECTOR_ENV} is not set; nothing to sync through\n`,
    );
    return 2;
  }
  let layout: BaseProfileStoreLayout;
  try {
    layout = storeLayoutOf(env);
  } catch (error) {
    io.stderr(`store sync: ${messageOf(error)}\n`);
    return 2;
  }
  const home = resolveStoreHome(env, layout);
  if (!locked) {
    await mkdir(home, { recursive: true });
    return underLock(home, mode, io);
  }
  const options: StoreOptions = {
    home,
    layout,
    repo,
    gatewayUrl: env[GATEWAY_URL_ENV] || DEFAULT_GATEWAY_URL,
    connectorId,
    message: env.RUN_ID
      ? `agent ${env.AGENT_ID ?? "?"} run ${env.RUN_ID}`
      : "sky: sync the store",
    progress: (line) => io.stderr(`${line}\n`),
  };
  try {
    if (mode === "pull") {
      await pullStore(options);
    } else {
      const sent = await pushStore(options);
      io.stderr(`store sync: ${sent ? "pushed" : "nothing new to push"}\n`);
    }
    return 0;
  } catch (error) {
    io.stderr(`store sync: ${mode} failed: ${messageOf(error)}\n`);
    return 1;
  }
}

/** Syncs for a run: a failure is logged through `warn`, never thrown, so it can't fail the run. */
export async function syncStoreQuietly(
  mode: Mode,
  env: NodeJS.ProcessEnv,
  warn: (line: string) => void,
): Promise<void> {
  let stderr = "";
  try {
    const code = await storeSyncMain([mode], env, {
      stdout: () => {},
      stderr: (s) => {
        stderr += s;
      },
    });
    if (code !== 0)
      warn(`runner: ${stderr.trim() || `store ${mode} exited ${code}`}`);
  } catch (error) {
    warn(`runner: store ${mode} failed: ${messageOf(error)}`);
  }
}
