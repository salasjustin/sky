import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  type FileHandle,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { anonGitEnabled, cloneOverGit, whyFailed } from "./gitfetch.js";
import {
  CONNECTOR_ENV,
  DEFAULT_GATEWAY_URL,
  GATEWAY_URL_ENV,
  GatewayError,
  gateway,
} from "./publish.js";
import {
  fetchMissing,
  git,
  messageOf,
  type Progress,
  remoteHead,
  type TreeItem,
} from "./store.js";

export const REPO_PULL_USAGE = "repo-pull <owner/repo> <dir>";

type Person = { name: string; email: string; date: string };
type ApiCommit = {
  tree: { sha: string };
  parents: { sha: string }[];
  author: Person;
  committer: Person;
  message: string;
  verification?: { signature?: string | null; payload?: string | null };
};

// the commit API gives each date in UTC, dropping the zone it was written in; the zone is part of
// the commit's bytes, so the sha only comes back by finding it. UTC first: most commits have it
const OFFSETS_MIN = [
  0,
  ...Array.from({ length: 105 }, (_, i) => (i - 48) * 15).filter((m) => m),
];

const zone = (minutes: number) => {
  const abs = Math.abs(minutes);
  const hhmm = `${String(Math.floor(abs / 60)).padStart(2, "0")}${String(abs % 60).padStart(2, "0")}`;
  return `${minutes < 0 ? "-" : "+"}${hhmm}`;
};

const identity = (person: Person, minutes: number) =>
  `${person.name} <${person.email}> ${Math.floor(Date.parse(person.date) / 1000)} ${zone(minutes)}`;

const objectId = (body: string) => {
  const bytes = Buffer.from(body);
  return createHash("sha1")
    .update(`commit ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
};

/**
 * A signed commit's object text: the signed payload with the signature as its last header, where
 * git writes it, so headers the API has no field for (`mergetag`, `encoding`) come back verbatim.
 */
function signedText(payload: string, signature: string): string {
  const gpgsig = `gpgsig ${signature.split("\n").join("\n ")}\n`;
  const blank = payload.indexOf("\n\n");
  const at = blank === -1 ? payload.length : blank + 1;
  return `${payload.slice(0, at)}${gpgsig}${payload.slice(at)}`;
}

/**
 * The commit's raw object text, which hashes to `sha`; throws, saying why, when what GitHub's API
 * returned can't reproduce it. A signed commit comes from its signed payload. An unsigned one is
 * rebuilt from its fields, trying the author's and committer's zone (UTC, then every real one) and
 * the message with and without its final newline.
 */
export function rebuildCommit(sha: string, commit: ApiCommit): string {
  const { signature, payload } = commit.verification ?? {};
  if (signature) {
    if (!payload) {
      throw new Error(
        `commit ${sha} is signed, but GitHub's API gave no signed text to rebuild it from`,
      );
    }
    const text = signedText(payload, signature);
    if (objectId(text) === sha) return text;
    throw new Error(
      `commit ${sha} is signed, but the signed commit rebuilt from GitHub's API doesn't hash to GitHub's sha`,
    );
  }
  const head = [
    `tree ${commit.tree.sha}`,
    ...commit.parents.map((p) => `parent ${p.sha}`),
  ];
  const tries: [number, number][] = [
    ...OFFSETS_MIN.map((m): [number, number] => [m, m]),
    ...OFFSETS_MIN.flatMap((a) =>
      OFFSETS_MIN.filter((c) => c !== a).map((c): [number, number] => [a, c]),
    ),
  ];
  for (const [a, c] of tries) {
    const headers = [
      ...head,
      `author ${identity(commit.author, a)}`,
      `committer ${identity(commit.committer, c)}`,
    ];
    for (const tail of ["", "\n"]) {
      const text = `${headers.join("\n")}\n\n${commit.message}${tail}`;
      if (objectId(text) === sha) return text;
    }
  }
  throw new Error(
    `commit ${sha} is unsigned and carries more than GitHub's API returns (a mergetag or encoding header, or a message that isn't UTF-8), so it can't be rebuilt`,
  );
}

/**
 * Materializes `repo`'s default branch in `dir` through the connector gateway, which carries REST
 * and no git transport: the branch's commit, its tree and every blob are fetched and written as git
 * objects, so the checkout holds the same commit sha as GitHub, and `origin/HEAD` names it, which
 * is what a worktree branches from and what a publish takes as its parent. The commit is shallow:
 * its ancestors stay on GitHub. A failure removes what this run created; a checkout an earlier,
 * killed run left is finished, not refused.
 */
export async function pullRepo(options: {
  repo: string;
  dir: string;
  gatewayUrl: string;
  connectorId: string;
  progress?: (line: string) => void;
}): Promise<{ branch: string; sha: string }> {
  const [owner = "", name = ""] = options.repo.split("/");
  const call = gateway({
    gatewayUrl: options.gatewayUrl,
    connectorId: options.connectorId,
    owner,
    repo: name,
  });
  const progress = options.progress ?? (() => {});
  const remote = await remoteHead(call).catch((error: unknown) => {
    if (error instanceof GatewayError && error.status === 404) {
      throw new Error(
        `the connector in ${CONNECTOR_ENV} can't see ${options.repo}; check its connection id and the repos it grants (${error.message})`,
      );
    }
    // GitHub's answer to a ref lookup in a repo with no commits
    if (error instanceof GatewayError && error.status === 409) {
      throw new Error(
        `${options.repo} is empty: its default branch has no commit to check out; push one first (${error.message})`,
      );
    }
    throw error;
  });
  const commit = await call<ApiCommit>("GET", `/git/commits/${remote.sha}`);
  const listing = await call<{
    tree: TreeItem[];
    truncated: boolean;
  }>("GET", `/git/trees/${commit.tree.sha}?recursive=1`);
  if (listing.truncated) {
    throw new Error(`the tree of ${options.repo} is too large to fetch`);
  }
  let raw: string;
  try {
    raw = rebuildCommit(remote.sha, commit);
  } catch (error) {
    throw new Error(
      `${messageOf(error)}; a checkout would not share GitHub's sha. Move ${remote.branch} to a commit that rebuilds, such as a new one on top`,
    );
  }

  const dir = resolve(options.dir);
  const hadGit = existsSync(join(dir, ".git"));
  // the first directory mkdir made, which a failure takes back with it
  const created = await mkdir(dir, { recursive: true });
  try {
    await writeCheckout(dir, options.repo, remote, commit, listing.tree, raw, {
      call,
      progress,
    });
  } catch (error) {
    if (created) await rm(created, { recursive: true, force: true });
    else if (!hadGit)
      await rm(join(dir, ".git"), { recursive: true, force: true });
    throw error;
  }
  return remote;
}

const INDEX_PREFIX = "sky-pull-index-";

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, under another user
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Temporary indexes a killed fetch left behind: each is named for its process, gone or not. */
async function removeAbandonedIndexes(gitDir: string): Promise<void> {
  const entries = await readdir(gitDir).catch(() => []);
  await Promise.all(
    entries
      .filter((name) => {
        const match = new RegExp(`^${INDEX_PREFIX}(\\d+)-`).exec(name);
        return match && !isRunning(Number(match[1]));
      })
      .map((name) => rm(join(gitDir, name), { force: true })),
  );
}

/**
 * Writes the commit, its tree and every blob into the repo `g` runs in as git objects, so
 * `remote.sha` resolves there; the checkout and refs are the caller's.
 */
async function writeObjects(
  g: ReturnType<typeof git>,
  gitDir: string,
  sha: string,
  commit: ApiCommit,
  tree: TreeItem[],
  raw: string,
  source: { call: ReturnType<typeof gateway>; progress: Progress },
): Promise<void> {
  const blobs = tree.filter((item) => item.type === "blob");
  await fetchMissing(g, source.call, blobs, source.progress, "repo pull");
  // a submodule is a gitlink: a commit sha in the tree with nothing behind it here
  const entries = tree.filter(
    (item) => item.type === "blob" || item.type === "commit",
  );
  await removeAbandonedIndexes(gitDir);
  // one per call: every worktree shares the git dir, and another agent's fetch may be writing its own
  const index = join(gitDir, `${INDEX_PREFIX}${process.pid}-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    await g(["update-index", "-z", "--add", "--index-info"], {
      input: entries
        .map((item) => `${item.mode} ${item.sha}\t${item.path}\0`)
        .join(""),
      env,
    });
    const built = await g(["write-tree"], { env });
    if (built !== commit.tree.sha) {
      throw new Error(`tree ${commit.tree.sha} arrived as ${built}`);
    }
  } finally {
    await rm(index, { force: true });
  }
  const written = await g(["hash-object", "-t", "commit", "-w", "--stdin"], {
    input: raw,
  });
  if (written !== sha) throw new Error(`commit ${sha} arrived as ${written}`);
}

/**
 * Makes GitHub's commit `sha` resolvable in the repo `g` runs in, with its tree and blobs, and
 * treats it as shallow when its parents aren't here: its ancestors stay on GitHub.
 */
export async function fetchCommit(
  g: ReturnType<typeof git>,
  call: ReturnType<typeof gateway>,
  sha: string,
  progress: Progress = () => {},
): Promise<void> {
  const commit = await call<ApiCommit>("GET", `/git/commits/${sha}`);
  const listing = await call<{ tree: TreeItem[]; truncated: boolean }>(
    "GET",
    `/git/trees/${commit.tree.sha}?recursive=1`,
  );
  if (listing.truncated) {
    throw new Error(`the tree of commit ${sha} is too large to fetch`);
  }
  const raw = rebuildCommit(sha, commit);
  const gitDir = await g(["rev-parse", "--absolute-git-dir"]);
  await writeObjects(g, gitDir, sha, commit, listing.tree, raw, {
    call,
    progress,
  });
  const here = async (parent: string) =>
    g(["cat-file", "-e", `${parent}^{commit}`]).then(
      () => true,
      () => false,
    );
  const parents = await Promise.all(commit.parents.map((p) => here(p.sha)));
  if (parents.includes(false)) await editShallow(g, (held) => held.add(sha));
}

const shallowPath = (g: ReturnType<typeof git>) =>
  g(["rev-parse", "--path-format=absolute", "--git-path", "shallow"]);

const linesOf = (text: string) => new Set(text.split("\n").filter(Boolean));

/** The commits `shallow` lists: here, with their parents left on GitHub. */
export async function shallowCommits(
  g: ReturnType<typeof git>,
): Promise<Set<string>> {
  return linesOf(await readFile(await shallowPath(g), "utf8").catch(() => ""));
}

const SHALLOW_LOCK_WAIT_MS = 10_000;

/** Creates `lock` exclusively, waiting a while for another holder to let it go. */
async function takeLock(lock: string): Promise<FileHandle> {
  const deadline = Date.now() + SHALLOW_LOCK_WAIT_MS;
  for (;;) {
    try {
      return await open(lock, "wx");
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "EEXIST" ||
        Date.now() > deadline
      ) {
        throw new Error(
          `can't take ${lock} (${messageOf(error)}); if no git command or run is using the repo, remove it`,
        );
      }
      await sleep(50);
    }
  }
}

/**
 * Rewrites `shallow` under `shallow.lock`, git's own lock for it: every worktree shares the file,
 * and another agent's fetch may be changing it at once. The new list is written to the lock and
 * renamed into place, so a reader never sees half of it.
 */
export async function editShallow(
  g: ReturnType<typeof git>,
  edit: (held: Set<string>) => Set<string>,
): Promise<void> {
  const path = await shallowPath(g);
  const lock = `${path}.lock`;
  const handle = await takeLock(lock);
  let placed = false;
  try {
    const held = linesOf(await readFile(path, "utf8").catch(() => ""));
    const next = edit(new Set(held));
    if (next.size === held.size && [...next].every((sha) => held.has(sha))) {
      return;
    }
    if (next.size === 0) {
      await rm(path, { force: true });
      return;
    }
    await handle.writeFile([...next].map((sha) => `${sha}\n`).join(""));
    await handle.close();
    await rename(lock, path);
    placed = true;
  } finally {
    await handle.close().catch(() => {});
    if (!placed) await rm(lock, { force: true });
  }
}

/**
 * Writes the fetched commit into `dir` as a checkout of it. Each step converges on a repo an
 * earlier, killed run left, so a re-run finishes it.
 */
async function writeCheckout(
  dir: string,
  repo: string,
  remote: { branch: string; sha: string },
  commit: ApiCommit,
  tree: TreeItem[],
  raw: string,
  source: { call: ReturnType<typeof gateway>; progress: Progress },
): Promise<void> {
  const g = git(dir);
  await g(["init", "-q", "-b", remote.branch]);
  await writeObjects(
    g,
    join(dir, ".git"),
    remote.sha,
    commit,
    tree,
    raw,
    source,
  );
  const shallow = join(dir, ".git", "shallow");
  if (commit.parents.length > 0) await writeFile(shallow, `${remote.sha}\n`);
  else await rm(shallow, { force: true });
  const remoteRef = `refs/remotes/origin/${remote.branch}`;
  // what `git remote add` writes, set rather than added so an existing origin is overwritten
  await g(["config", "remote.origin.url", `https://github.com/${repo}.git`]);
  await g([
    "config",
    "--replace-all",
    "remote.origin.fetch",
    "+refs/heads/*:refs/remotes/origin/*",
  ]);
  await g(["update-ref", remoteRef, remote.sha]);
  await g(["symbolic-ref", "refs/remotes/origin/HEAD", remoteRef]);
  await g(["update-ref", `refs/heads/${remote.branch}`, remote.sha]);
  await g(["config", `branch.${remote.branch}.remote`, "origin"]);
  await g([
    "config",
    `branch.${remote.branch}.merge`,
    `refs/heads/${remote.branch}`,
  ]);
  await g(["reset", "--quiet", "--hard", remote.sha]);
}

/**
 * `runner.mjs repo-pull <owner/repo> <dir>`: the API's, at provisioning, for a repo a plain clone
 * can't reach. It tries an anonymous git clone first (a public repo costs no REST calls), and
 * pulls through the connector when that fails, saying why on stderr. Returns the exit status: 2 for a usage or config error, 1 for a failed pull.
 */
export async function repoPullMain(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: { stdout: (s: string) => void; stderr: (s: string) => void },
): Promise<number> {
  const [repo, dir, ...rest] = argv;
  if (!repo || !dir || rest.length > 0 || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    io.stderr(`usage: ${REPO_PULL_USAGE}\n`);
    return 2;
  }
  const connectorId = env[CONNECTOR_ENV];
  if (!connectorId) {
    io.stderr(`repo pull: ${CONNECTOR_ENV} is not set\n`);
    return 2;
  }
  if (anonGitEnabled(env)) {
    try {
      const { branch, sha } = await cloneOverGit({
        repo,
        dir,
        progress: (line) => io.stderr(`${line}\n`),
      });
      io.stdout(`repo pull: ${repo} ${branch} at ${sha} (over git)\n`);
      return 0;
    } catch (error) {
      io.stderr(
        `repo pull: anonymous git fetch failed (${whyFailed(error)}); pulling through the connector\n`,
      );
    }
  }
  try {
    const { branch, sha } = await pullRepo({
      repo,
      dir,
      gatewayUrl: env[GATEWAY_URL_ENV] || DEFAULT_GATEWAY_URL,
      connectorId,
      progress: (line) => io.stderr(`${line}\n`),
    });
    io.stdout(`repo pull: ${repo} ${branch} at ${sha}\n`);
    return 0;
  } catch (error) {
    io.stderr(`repo pull: failed: ${messageOf(error)}\n`);
    return 1;
  }
}
