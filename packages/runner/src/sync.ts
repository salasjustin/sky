import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { type AgentId, agentBranch } from "@sky/shared";
import { anonGitEnabled, fetchOverGit, whyFailed } from "./gitfetch.js";
import {
  BRANCH_ENV,
  CONNECTOR_ENV,
  DEFAULT_GATEWAY_URL,
  FETCHED_BASES,
  GATEWAY_URL_ENV,
  GatewayError,
  gateway,
  movingCommitsConfig,
  parseOrigin,
  REMOTE_BRANCH_KEY,
  rebaseInProgress,
} from "./publish.js";
import { editShallow, fetchCommit, shallowCommits } from "./repo.js";
import { RepoLockBusyError, withRepoLock } from "./repo-lock.js";
import { git, messageOf } from "./store.js";
import { adoptAgentBranch, ensureWorktree } from "./worktree.js";

type Call = ReturnType<typeof gateway>;
type Git = ReturnType<typeof git>;

/** GitHub has no branch of that name. */
export class BranchNotFoundError extends Error {
  constructor(
    readonly branch: string,
    message: string,
  ) {
    super(message);
  }
}

/** The branch is more commits ahead of anything here than a fetch takes. */
export class TooFarError extends Error {}

export const DEFAULT_MAX_COMMITS = 100;
/** Pages of the default branch's listing `fetchStartBranch` reads before calling a branch too far. */
const MAX_LISTING_PAGES = 10;

const segments = (branch: string) =>
  branch.split("/").map(encodeURIComponent).join("/");

const isNotFound = (error: unknown) =>
  error instanceof GatewayError && error.status === 404;

/**
 * GitHub's tip of `branch`; a branch GitHub doesn't have throws `BranchNotFoundError`. GitHub
 * answers 404 for a repo the connector can't see too, so a 404 counts as a missing branch only once
 * the repo itself answers.
 */
export async function remoteTip(call: Call, branch: string): Promise<string> {
  const ref = await call<{ object: { sha: string } }>(
    "GET",
    `/git/ref/heads/${segments(branch)}`,
  ).catch(async (error: unknown) => {
    if (!isNotFound(error)) throw error;
    await call("GET", "").catch((probe: unknown) => {
      if (!isNotFound(probe)) throw probe;
      throw new Error(
        `the connector in ${CONNECTOR_ENV} can't see the repo; check its connection id and the repos it grants (${messageOf(probe)})`,
      );
    });
    throw new BranchNotFoundError(
      branch,
      `${branch} doesn't exist on GitHub (${messageOf(error)})`,
    );
  });
  return ref.object.sha;
}

const present = (g: Git, sha: string) =>
  g(["cat-file", "-e", `${sha}^{commit}`]).then(
    () => true,
    () => false,
  );

const isAncestorIn = (g: Git, sha: string, of: string) =>
  g(["merge-base", "--is-ancestor", sha, of]).then(
    () => true,
    () => false,
  );

const resolved = (g: Git, ref: string) =>
  g(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).catch(() => "");

/** Commits are immutable, so one lookup serves the walk and `fetchCommit` after it. */
function cachingCommits(call: Call): Call {
  const commits = new Map<string, Promise<unknown>>();
  return (<T>(method: string, path: string, body?: unknown): Promise<T> => {
    if (method !== "GET" || !path.startsWith("/git/commits/"))
      return call<T>(method, path, body);
    let held = commits.get(path);
    if (!held) {
      held = call<T>(method, path);
      // a failed lookup is asked again, not remembered
      held.catch(() => commits.delete(path));
      commits.set(path, held);
    }
    return held as Promise<T>;
  }) as Call;
}

/**
 * Brings GitHub's `branch` into `repoDir` through the gateway and points
 * `refs/remotes/origin/<branch>` at it. Walks from the tip over every parent until it reaches
 * commits already here, and fetches what it walked oldest-first, so each commit's parents exist
 * when it is written and the history stays connected rather than shallow. A commit `shallow` lists
 * (a base a publish fetched alone, say) counts as here only where it is an ancestor of a sha in
 * `connected`, the history the caller needs to stay joined to; elsewhere it is walked through, and
 * leaves `shallow` once its parents are written. A sha in `stopAt` is fetched but its parents are
 * not walked; `tipOnly` fetches the tip alone, shallow. More than `maxCommits` to walk throws
 * `TooFarError` before anything is written. Every write converges, so another agent's run fetching
 * the same branch at once does no harm.
 */
export async function fetchBranch(options: {
  repoDir: string;
  call: Call;
  branch: string;
  /** GitHub's tip, when the caller has already looked it up. */
  tip?: string;
  stopAt?: string[];
  connected?: string[];
  maxCommits?: number;
  tipOnly?: boolean;
}): Promise<{
  branch: string;
  sha: string;
  previous: string | null;
  /** Each commit the walk met that wasn't here, with its parents; none for one in `stopAt`. */
  walked: Map<string, string[]>;
}> {
  const { repoDir, branch } = options;
  const g = git(repoDir);
  const call = cachingCommits(options.call);
  const sha = options.tip ?? (await remoteTip(call, branch));
  const maxCommits = options.maxCommits ?? DEFAULT_MAX_COMMITS;
  const stopAt = new Set(options.stopAt ?? []);
  const shallow = await shallowCommits(g);
  const connected = options.connected ?? [];
  const here = async (commit: string) => {
    if (!(await present(g, commit))) return false;
    if (!shallow.has(commit)) return true;
    for (const joined of connected) {
      if (await isAncestorIn(g, commit, joined)) return true;
    }
    return false;
  };

  const parentsOf = new Map<string, string[]>();
  let bodies = 0;
  if (!(await here(sha))) {
    const queue = [sha];
    while (queue.length > 0) {
      const next = queue.shift() as string;
      if (parentsOf.has(next) || (await here(next))) continue;
      if (options.tipOnly || stopAt.has(next)) {
        parentsOf.set(next, []);
        continue;
      }
      if (bodies >= maxCommits) {
        throw new TooFarError(
          `${branch} on GitHub is more than ${maxCommits} commits past anything this clone has`,
        );
      }
      bodies++;
      const { parents } = await call<{ parents: { sha: string }[] }>(
        "GET",
        `/git/commits/${next}`,
      );
      parentsOf.set(
        next,
        parents.map((p) => p.sha),
      );
      queue.push(...parents.map((p) => p.sha));
    }
  }
  for (const commit of oldestFirst(sha, parentsOf)) {
    // a shallow commit walked through is already written; only its parents were missing
    if (!(await present(g, commit))) await fetchCommit(g, call, commit);
  }
  const joined = [...parentsOf]
    .filter(([commit, parents]) => parents.length > 0 && shallow.has(commit))
    .map(([commit]) => commit);
  if (joined.length > 0) {
    await editShallow(g, (held) => {
      for (const commit of joined) held.delete(commit);
      return held;
    });
  }

  const ref = `refs/remotes/origin/${branch}`;
  const previous = (await resolved(g, ref)) || null;
  await moveRef(g, ref, sha, previous);
  return { branch, sha, previous, walked: parentsOf };
}

/** The walked commits, each after every walked parent of it. */
function oldestFirst(tip: string, parentsOf: Map<string, string[]>): string[] {
  const order: string[] = [];
  const done = new Set<string>();
  // iterative post-order: a long history would overflow a recursive one
  const stack: [string, boolean][] = [[tip, false]];
  while (stack.length > 0) {
    const [sha, expanded] = stack.pop() as [string, boolean];
    if (!parentsOf.has(sha) || done.has(sha)) continue;
    if (expanded) {
      done.add(sha);
      order.push(sha);
      continue;
    }
    stack.push([sha, true]);
    for (const parent of parentsOf.get(sha) ?? []) stack.push([parent, false]);
  }
  return order;
}

/**
 * Points `ref` at `sha` unless another run moved it past `sha` meanwhile: the update names the
 * value it replaces, so two runs racing leave the newer tip, not whichever wrote last.
 */
async function moveRef(
  g: Git,
  ref: string,
  sha: string,
  expected: string | null,
): Promise<void> {
  let old = expected;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (old === sha) return;
    const moved = await g(["update-ref", ref, sha, old ?? ""]).then(
      () => true,
      () => false,
    );
    if (moved) return;
    old = (await resolved(g, ref)) || null;
    if (
      old &&
      (await g(["merge-base", "--is-ancestor", sha, old]).then(
        () => true,
        () => false,
      ))
    )
      return;
  }
  await g(["update-ref", ref, sha]);
}

export type DefaultSync = {
  default: string;
  previous: string | null;
  sha: string;
  moved: boolean;
  tooFar: boolean;
};

/** The clone's default branch: where `origin/HEAD` points. */
async function defaultBranchOf(g: Git): Promise<string> {
  return (await g(["symbolic-ref", "refs/remotes/origin/HEAD"])).replace(
    /^refs\/remotes\/origin\//,
    "",
  );
}

/**
 * Moves `origin/<default>` to GitHub's tip, connected to where it was: every worktree's
 * `merge-base origin/HEAD HEAD`, and publish's merge base, need the new tip to reach what the
 * worktrees branched from. A tip too far ahead to connect leaves it where it was.
 */
export async function syncDefaultBranch(options: {
  repoDir: string;
  call: Call;
}): Promise<DefaultSync> {
  const g = git(options.repoDir);
  const name = await defaultBranchOf(g);
  const previous = (await resolved(g, `refs/remotes/origin/${name}`)) || null;
  const sha = await remoteTip(options.call, name);
  const result = { default: name, previous, sha, moved: false, tooFar: false };
  if (sha === previous) return result;
  try {
    await fetchBranch({
      ...options,
      branch: name,
      tip: sha,
      connected: previous ? [previous] : [],
    });
  } catch (error) {
    if (error instanceof TooFarError) return { ...result, tooFar: true };
    throw error;
  }
  await g(["update-ref", `${FETCHED_BASES}${sha}`, sha]);
  return { ...result, moved: true };
}

/**
 * `syncDefaultBranch` over git without a credential: no REST calls, and `origin/<default>`
 * moves to GitHub's tip with the history between.
 */
export async function syncDefaultOverGit(options: {
  repoDir: string;
}): Promise<DefaultSync> {
  const g = git(options.repoDir);
  const name = await defaultBranchOf(g);
  const previous = (await resolved(g, `refs/remotes/origin/${name}`)) || null;
  const sha = await fetchOverGit({ repoDir: options.repoDir, branch: name });
  const result = { default: name, previous, sha, moved: false, tooFar: false };
  if (sha === previous) return result;
  await g(["update-ref", `${FETCHED_BASES}${sha}`, sha]);
  return { ...result, moved: true };
}

/** GitHub's answer to a fetch of a branch it doesn't have. */
const NO_REMOTE_REF = /couldn't find remote ref/;

/**
 * `fetchStartBranch` over git without a credential: fetches the branch with its history and
 * records its merge base with the default branch under `FETCHED_BASES`. Returns the branch's tip.
 */
async function fetchStartBranchOverGit(options: {
  repoDir: string;
  startBranch: string;
  defaultBranch: string;
}): Promise<string> {
  const { startBranch, defaultBranch } = options;
  const g = git(options.repoDir);
  const tip = await fetchOverGit({
    repoDir: options.repoDir,
    branch: startBranch,
  }).catch((error: unknown) => {
    if (NO_REMOTE_REF.test(messageOf(error))) {
      throw new BranchNotFoundError(
        startBranch,
        `the start branch ${startBranch} doesn't exist on GitHub (${messageOf(error)})`,
      );
    }
    throw error;
  });
  const onDefault = await resolved(g, `refs/remotes/origin/${defaultBranch}`);
  const mergeBase = onDefault
    ? await g(["merge-base", onDefault, tip]).catch(() => "")
    : "";
  if (mergeBase) {
    await g(["update-ref", `${FETCHED_BASES}${mergeBase}`, mergeBase]);
  }
  return tip;
}

const run = promisify(execFile);

/**
 * git in a worktree, as the repo is configured: `store.ts`'s helper pins the sky-agent identity,
 * which would take the place of the user's own on a rebase.
 */
async function inTree(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.trim();
}

/**
 * Text from the repository or git for a note: whoever can push to the branch writes it, and notes
 * reach the system prompt, so it goes in as one quoted, capped line, which the notes' heading marks
 * as data.
 */
const quoted = (text: string, max = 120) => {
  const line = text.replace(/\s+/g, " ").trim();
  return JSON.stringify(
    line.length > max ? `${line.slice(0, max - 1)}…` : line,
  );
};

/** A failed git command's own words, not execFile's "Command failed: …" wrapper, quoted. */
const gitSaid = (error: unknown) =>
  quoted(
    (error as { stderr?: string }).stderr?.trim() || messageOf(error),
    300,
  );

const short = (sha: string | null) => (sha ?? "").slice(0, 7);
const commits = (n: number) => `${n} commit${n === 1 ? "" : "s"}`;

/** Paths a stopped rebase or cherry-pick left unmerged. */
async function unmerged(cwd: string): Promise<string[]> {
  // one entry per stage of each unmerged path: "<mode> <sha> <stage>\t<path>", NUL-ended, so a
  // path comes as it is rather than in git's C quoting
  const out = await inTree(cwd, "ls-files", "-z", "--unmerged").catch(
    () => "",
  );
  return [
    ...new Set(
      out
        .split("\0")
        .filter(Boolean)
        .map((entry) => entry.slice(entry.indexOf("\t") + 1)),
    ),
  ];
}

/** Paths from the repository for a note: each `quoted`, and at most `max` of them named. */
const pathList = (paths: string[], max = 10) => {
  const named = paths.slice(0, max).map((path) => quoted(path));
  const more = paths.length - named.length;
  return `${named.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
};

/**
 * An operation git stopped mid-way in `cwd`, as what to tell the agent to do about it; undefined
 * when there is none. Each detaches HEAD or holds state a sync would land in the middle of.
 */
async function inProgress(cwd: string): Promise<string | undefined> {
  const rebasing = await rebaseInProgress(cwd);
  if (rebasing !== undefined) {
    return `a rebase${rebasing ? ` of ${rebasing}` : ""} is in progress in this worktree; run \`git rebase --abort\` (or finish it)`;
  }
  const stops: [string, string, string][] = [
    ["rebase-apply/applying", "`git am`", "git am --abort"],
    ["MERGE_HEAD", "a merge", "git merge --abort"],
    ["CHERRY_PICK_HEAD", "a cherry-pick", "git cherry-pick --abort"],
    ["REVERT_HEAD", "a revert", "git revert --abort"],
    // a cherry-pick or revert series between commits: neither *_HEAD is left
    [
      "sequencer",
      "a cherry-pick or revert",
      "git cherry-pick --abort` or `git revert --abort",
    ],
    ["BISECT_LOG", "a bisect", "git bisect reset"],
  ];
  for (const [file, what, undo] of stops) {
    const path = await inTree(
      cwd,
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      file,
    );
    if (existsSync(path)) {
      return `${what} is in progress in this worktree; run \`${undo}\` (or finish it)`;
    }
  }
  return undefined;
}

/** Whether a stopped `op` is in progress in `cwd`, so there is something to abort. */
async function stopped(cwd: string, op: "rebase" | "cherry-pick") {
  if (op === "rebase") return (await rebaseInProgress(cwd)) !== undefined;
  // CHERRY_PICK_HEAD marks the commit it stopped on; `sequencer` the rest of a series
  const sequencer = await inTree(
    cwd,
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "sequencer",
  );
  return (
    existsSync(sequencer) ||
    (await inTree(
      cwd,
      "rev-parse",
      "--verify",
      "--quiet",
      "CHERRY_PICK_HEAD",
    ).then(
      () => true,
      () => false,
    ))
  );
}

/**
 * Aborts the rebase or cherry-pick a failed command left stopped in `cwd`. "" when nothing was
 * left or the abort worked, else the end of a note saying the worktree is left mid-way.
 */
async function abortStopped(
  cwd: string,
  op: "rebase" | "cherry-pick",
): Promise<string> {
  if (!(await stopped(cwd, op))) return "";
  const state =
    op === "rebase"
      ? "mid-rebase with HEAD detached, and commits made now land on no branch"
      : "mid-cherry-pick, with some of them applied";
  return inTree(cwd, op, "--abort").then(
    () => "",
    (abort: unknown) =>
      `, and \`git ${op} --abort\` failed too (${gitSaid(abort)}), so the worktree is left ${state}; run \`git ${op} --abort\` before anything else.`,
  );
}

/** Whether the worktree has changes to tracked files; untracked files block nothing by themselves. */
const isDirty = async (cwd: string) =>
  (await inTree(cwd, "status", "--porcelain", "--untracked-files=no")) !== "";

/**
 * Rebases an existing worktree's branch onto `origin/<name>` when it is behind, unless the branch
 * is published (rewriting it would break the pull request built from it), may be (`published`
 * undefined: GitHub couldn't be asked), or has uncommitted changes; a rebase that fails is aborted
 * and the worktree left as it was, or, when the abort fails too, left mid-rebase. Says what it did.
 */
async function rebaseOntoDefault(
  cwd: string,
  name: string,
  published: boolean | undefined,
): Promise<string[]> {
  const target = `refs/remotes/origin/${name}`;
  const behind = Number(
    await inTree(cwd, "rev-list", "--count", `HEAD..${target}`),
  );
  if (behind === 0) return [];
  const behindBy = `Your worktree is ${commits(behind)} behind \`origin/${name}\``;
  if (published !== false) {
    const why = published
      ? "its branch is already published to GitHub"
      : "the runner couldn't tell whether its branch is published to GitHub";
    return [
      `${behindBy}; it wasn't rebased because ${why}, and rewriting published commits would rewrite its pull request.`,
    ];
  }
  if (await isDirty(cwd)) {
    return [
      `${behindBy}; uncommitted changes blocked rebasing it onto that, so it was left as it was.`,
    ];
  }
  try {
    await inTree(
      cwd,
      ...(await movingCommitsConfig(cwd)),
      "rebase",
      "--quiet",
      target,
    );
  } catch (error) {
    const conflicted = await unmerged(cwd);
    const stuck = await abortStopped(cwd, "rebase");
    return [
      conflicted.length > 0
        ? `${behindBy}; rebasing onto it conflicted (in ${pathList(conflicted)})${stuck || ", so the rebase was aborted and the worktree left as it was."}`
        : `${behindBy}; rebasing onto it failed (${gitSaid(error)})${stuck || ", so the worktree was left as it was."}`,
    ];
  }
  const tip = await inTree(cwd, "rev-parse", target);
  return [
    `Your worktree was rebased onto \`origin/${name}\`, which GitHub had moved ${commits(behind)} ahead to ${short(tip)}; your commits now have new shas.`,
  ];
}

type ApiCommit = {
  tree: { sha: string };
  parents: { sha: string }[];
  message: string;
};

const isAncestor = (cwd: string, sha: string, of: string) =>
  inTree(cwd, "merge-base", "--is-ancestor", sha, of).then(
    () => true,
    () => false,
  );

/**
 * Where GitHub's `tip` of the agent's branch sits against the worktree's HEAD: walks the tip's first
 * parents to the first commit that matches the worktree, by sha (HEAD, or an ancestor of it) or by
 * tree (HEAD's, or one on its first-parent line since the default branch), since `publish` recreates
 * commits on GitHub under new shas. `outside` is what the walk passed, newest first, with its
 * commit bodies; `match` is GitHub's commit they sit on and `local` the commit it matches here,
 * absent when the walk found none.
 */
async function locateOnGitHub(options: {
  cwd: string;
  call: Call;
  tip: string;
  defaultBranch: string;
}): Promise<{
  head: string;
  outside: { sha: string; commit: ApiCommit }[];
  match: { sha: string; local: string } | undefined;
}> {
  const { cwd, call, tip } = options;
  const head = await inTree(cwd, "rev-parse", "HEAD");
  if (tip === head)
    return { head, outside: [], match: { sha: tip, local: tip } };

  const headTree = await inTree(cwd, "rev-parse", "HEAD^{tree}");
  const base = await inTree(
    cwd,
    "merge-base",
    `refs/remotes/origin/${options.defaultBranch}`,
    "HEAD",
  ).catch(() => "");
  const trees = new Map<string, string>();
  const line = await inTree(
    cwd,
    "log",
    "--first-parent",
    "--format=%H %T",
    "HEAD",
    ...(base ? [`^${base}`] : []),
  );
  for (const entry of line.split("\n").filter(Boolean)) {
    const [sha = "", tree = ""] = entry.split(" ");
    if (!trees.has(tree)) trees.set(tree, sha);
  }
  trees.set(headTree, head);

  const outside: { sha: string; commit: ApiCommit }[] = [];
  let match: { sha: string; local: string } | undefined;
  let at: string | undefined = tip;
  while (at && outside.length <= DEFAULT_MAX_COMMITS) {
    if (at === head || (await isAncestor(cwd, at, "HEAD"))) {
      match = { sha: at, local: at };
      break;
    }
    const commit: ApiCommit = await call<ApiCommit>(
      "GET",
      `/git/commits/${at}`,
    );
    const local = trees.get(commit.tree.sha);
    if (local) {
      match = { sha: at, local };
      break;
    }
    outside.push({ sha: at, commit });
    at = commit.parents[0]?.sha;
  }
  return { head, outside, match };
}

/**
 * Brings commits pushed to the agent's GitHub `branch` from outside the sandbox into its existing
 * worktree, when that can't lose anything: the worktree is clean, everything in it is published,
 * and the outside commits sit on top, merges among them only where they fast-forward. GitHub's
 * history is classified before any body is fetched: walking the tip's first parents to the first commit that matches the worktree, by sha
 * (HEAD, or an ancestor of it) or by tree (HEAD's, or one on its first-parent line since the
 * default branch), since `publish` recreates commits on GitHub under new shas. Anything else is
 * left as it is, with a note. `published` is whether GitHub has the branch at all.
 */
export async function syncAgentBranch(options: {
  repoDir: string;
  cwd: string;
  call: Call;
  branch: string;
  defaultBranch: string;
}): Promise<{ published: boolean; notes: string[] }> {
  const { cwd, call, branch } = options;
  const tip = await remoteTip(call, branch).catch((error: unknown) => {
    if (error instanceof BranchNotFoundError) return null;
    throw error;
  });
  if (tip === null) return { published: false, notes: [] };
  const { head, outside, match } = await locateOnGitHub({ ...options, tip });
  if (match && outside.length === 0) return { published: true, notes: [] };

  const pushed = `${commits(outside.length)} pushed from outside this sandbox`;
  const untouched = (detail: string) => ({
    published: true,
    notes: [
      `\`${branch}\` on GitHub is at ${short(tip)}, ${detail}; your worktree (at ${short(head)}) was not touched. \`publish\` will refuse to overwrite commits the branch never had.`,
    ],
  });
  if (!match) {
    return untouched(
      `and none of the ${commits(outside.length)} seen walking back from it matches this worktree`,
    );
  }
  if (match.local !== head) {
    return untouched(
      `with ${pushed}, and your branch has commits that aren't on GitHub, so the histories diverged`,
    );
  }
  if (await isDirty(cwd)) {
    return untouched(
      `with ${pushed}, but your worktree has uncommitted changes`,
    );
  }
  // on HEAD's own sha they fast-forward, merges and all
  if (
    match.sha !== head &&
    outside.some(({ commit }) => commit.parents.length > 1)
  ) {
    return untouched(
      `with ${pushed}, including a merge: GitHub's copies of your commits have other shas than yours, so they can only be brought in by cherry-pick, which can't replay a merge`,
    );
  }

  await fetchBranch({
    repoDir: options.repoDir,
    call,
    branch,
    tip,
    stopAt: [match.sha],
    connected: [head],
  });
  const oldest = outside.map(({ sha }) => sha).reverse();
  try {
    if (match.sha === head) {
      await inTree(
        cwd,
        ...(await movingCommitsConfig(cwd)),
        "merge",
        "--ff-only",
        "--quiet",
        tip,
      );
    } else {
      // HEAD's tree is the one they were made on, so they apply as they are; each keeps its author
      await inTree(
        cwd,
        ...(await movingCommitsConfig(cwd)),
        "cherry-pick",
        "--allow-empty",
        ...oldest,
      );
    }
  } catch (error) {
    const failed = `with ${pushed}, but bringing them in failed (${gitSaid(error)})`;
    const stuck =
      match.sha === head ? "" : await abortStopped(cwd, "cherry-pick");
    if (stuck) {
      return {
        published: true,
        notes: [
          `\`${branch}\` on GitHub is at ${short(tip)}, ${failed}${stuck}`,
        ],
      };
    }
    return untouched(failed);
  }
  const list = outside
    .map(
      ({ sha, commit }) =>
        `${short(sha)} ${quoted(commit.message.split("\n")[0] ?? "")}`,
    )
    .reverse()
    .join("; ");
  return {
    published: true,
    notes: [
      `${pushed.replace(" pushed", ` pushed to \`${branch}\``)} ${outside.length === 1 ? "was" : "were"} brought into your worktree: ${list}.`,
    ],
  };
}

/**
 * `runner.mjs sync`'s half for the agent's own GitHub `branch`: brings the worktree, on
 * `localBranch`, onto GitHub's head of it, with GitHub's shas, when that can't lose anything.
 * Commits pushed from outside are fast-forwarded in when the worktree has no unpublished commits,
 * and the unpublished ones are rebased onto them when it has some. When there are commits from
 * outside and `localBranch` continues no GitHub branch yet, it is recorded as continuing `branch`,
 * so `publish` only fast-forwards it from then on. It is refused, with the worktree and
 * local branch left as they were, for a worktree with uncommitted changes, unpublished commits
 * that include a merge, a rebase that conflicts or a branch too far ahead to fetch. Unlike
 * `syncAgentBranch`, which leaves the worktree's own shas and cherry-picks, the published commits
 * here are replaced by GitHub's, so `git log` and GitHub agree. `lines` is what to tell the agent;
 * `ok` is false when the worktree was left as it was for a reason it should act on, and `moved`
 * true when the worktree was moved. A branch GitHub doesn't have is left alone.
 */
export async function syncOwnBranch(options: {
  repoDir: string;
  cwd: string;
  call: Call;
  branch: string;
  localBranch: string;
  defaultBranch: string;
}): Promise<{ ok: boolean; lines: string[]; moved?: boolean }> {
  const { cwd, branch } = options;
  const call = cachingCommits(options.call);
  const tip = await remoteTip(call, branch).catch((error: unknown) => {
    if (error instanceof BranchNotFoundError) return null;
    throw error;
  });
  if (tip === null) {
    return {
      ok: true,
      lines: [
        `${branch} isn't on GitHub yet, so there is nothing to bring in; your worktree was not touched.`,
      ],
    };
  }
  const { head, outside, match } = await locateOnGitHub({
    cwd,
    call,
    tip,
    defaultBranch: options.defaultBranch,
  });
  const at = `${branch} on GitHub is at ${short(tip)}`;
  const refuse = (why: string) => ({
    ok: false,
    lines: [
      `${at}; ${why}. Your worktree (at ${short(head)}) was not changed.`,
    ],
  });
  if (!match) {
    return refuse(
      `none of the ${commits(outside.length)} seen walking back from it matches this worktree, so it can't be told what is new`,
    );
  }
  // GitHub's head is HEAD or under it, and nothing is on top of it from outside
  if (outside.length === 0 && match.sha === match.local) {
    const ahead = Number(
      await inTree(cwd, "rev-list", "--count", `${tip}..HEAD`),
    );
    return {
      ok: true,
      lines: [
        `${at}, and your worktree already has it${ahead > 0 ? ` with ${commits(ahead)} on top that aren't published` : ""}; nothing to bring in.`,
      ],
    };
  }
  if (await isDirty(cwd)) {
    return refuse(
      "your worktree has uncommitted changes, so nothing was brought in; commit or stash them and sync again",
    );
  }
  const subjectOf = (sha: string) =>
    inTree(cwd, "log", "-1", "--format=%s", sha);
  // a rebase drops a merge and replays what it merged one by one, as the branch's own commits. Any
  // merge among the unpublished commits has one on their first-parent line that brought it in
  const merges =
    match.local === head
      ? ""
      : await inTree(
          cwd,
          "rev-list",
          "--first-parent",
          "--merges",
          "--reverse",
          `${match.local}..HEAD`,
        );
  const [merge] = merges.split("\n").filter(Boolean);
  if (merge) {
    const after = Number(
      await inTree(cwd, "rev-list", "--count", `${merge}..HEAD`),
    );
    const redo =
      after > 0
        ? `, which drops the ${commits(after)} after it too; sync, merge again, and put ${after === 1 ? "it" : "them"} back with \`git cherry-pick ${short(merge)}..${short(head)}\``
        : "; sync, then merge again";
    return refuse(
      `your unpublished commits include a merge, ${short(merge)} ${quoted(await subjectOf(merge))}, and rebasing them onto GitHub's commits would flatten it into the commits it merged, so nothing was brought in. Undo the merge with \`git reset --keep ${short(merge)}^\`${redo}`,
    );
  }
  try {
    await fetchBranch({
      repoDir: options.repoDir,
      call,
      branch,
      tip,
      connected: [head],
    });
  } catch (error) {
    if (error instanceof TooFarError) return refuse(messageOf(error));
    throw error;
  }
  if (outside.length > 0) {
    // the branch now holds commits someone else pushed: like a branch the agent continues, `publish`
    // only fast-forwards it, so it never rebases them onto the base and force-updates them away. Set
    // before the worktree moves, so a failure here leaves the worktree as it was
    const key = `branch.${options.localBranch}.${REMOTE_BRANCH_KEY}`;
    if (!(await inTree(cwd, "config", "--get", key).catch(() => ""))) {
      await inTree(cwd, "config", key, branch);
    }
  }

  // the commits here after the one that matches GitHub's: never published
  const unpublished =
    match.local === head
      ? []
      : (await inTree(cwd, "rev-list", "--reverse", `${match.local}..HEAD`))
          .split("\n")
          .filter(Boolean);
  if (unpublished.length === 0) {
    try {
      const hooksOff = await movingCommitsConfig(cwd);
      if (await isAncestor(cwd, head, tip)) {
        await inTree(cwd, ...hooksOff, "merge", "--ff-only", "--quiet", tip);
      } else {
        // same tree as GitHub's commit it matches, so only the commits' shas change
        await inTree(cwd, ...hooksOff, "reset", "--keep", "--quiet", tip);
      }
    } catch (error) {
      return refuse(`bringing it in failed (${gitSaid(error)})`);
    }
  } else {
    try {
      await inTree(
        cwd,
        ...(await movingCommitsConfig(cwd)),
        "rebase",
        "--quiet",
        "--onto",
        tip,
        match.local,
      );
    } catch (error) {
      const conflicted = await unmerged(cwd);
      const stuck = await abortStopped(cwd, "rebase");
      const why =
        conflicted.length > 0
          ? `rebasing your ${commits(unpublished.length)} onto it conflicted (in ${pathList(conflicted)})`
          : `rebasing your ${commits(unpublished.length)} onto it failed (${gitSaid(error)})`;
      return {
        ok: false,
        lines: [
          `${at}; ${why}${stuck || `, so the rebase was aborted and your worktree (at ${short(head)}) was left as it was.`}`,
        ],
      };
    }
  }

  const lines = [`${at}.`];
  if (outside.length > 0) {
    const list = outside
      .map(
        ({ sha, commit }) =>
          `${short(sha)} ${quoted(commit.message.split("\n")[0] ?? "")}`,
      )
      .reverse()
      .join("; ");
    lines.push(`Brought in ${commits(outside.length)}: ${list}.`);
  }
  if (match.sha !== match.local) {
    lines.push(
      "Your published commits now carry GitHub's shas, so `git log` and GitHub agree.",
    );
  }
  if (unpublished.length > 0) {
    const moved = (await inTree(cwd, "rev-list", "--reverse", `${tip}..HEAD`))
      .split("\n")
      .filter(Boolean);
    // git drops a commit whose change GitHub already has, so the two lists may differ in length
    const list = await Promise.all(
      moved.map(async (sha, i) => {
        const from = moved.length === unpublished.length ? unpublished[i] : "";
        return `${from ? `${short(from)} → ` : ""}${short(sha)} ${quoted(await subjectOf(sha))}`;
      }),
    );
    const dropped = unpublished.length - moved.length;
    lines.push(
      `Rebased ${commits(unpublished.length)} onto it${list.length > 0 ? `: ${list.join("; ")}` : ""}${dropped > 0 ? `; ${commits(dropped)} dropped because GitHub already has the change` : ""}.`,
    );
  }
  lines.push(
    `Your worktree is now at ${short(await inTree(cwd, "rev-parse", "HEAD"))}.`,
  );
  return { ok: true, lines, moved: true };
}

/**
 * Fetches GitHub's `startBranch`: the commits it has that the default branch doesn't, each parent
 * on the default branch fetched alone, so a branch that merged the default branch in never walks
 * down the default branch's history. Which commits are the default branch's comes from its commit
 * listing, a page at a time, not from a compare: the gateway refuses `..` in a path. Records the
 * newest of them the branch was cut from or merged, its merge base, under `FETCHED_BASES` so
 * publish finds the base it was cut from. Returns the branch's tip.
 */
async function fetchStartBranch(options: {
  repoDir: string;
  call: Call;
  startBranch: string;
  defaultBranch: string;
}): Promise<string> {
  const { call, startBranch, defaultBranch } = options;
  const g = git(options.repoDir);
  const tip = await remoteTip(call, startBranch).catch((error: unknown) => {
    if (error instanceof BranchNotFoundError) {
      throw new BranchNotFoundError(
        startBranch,
        `the start branch ${error.message}`,
      );
    }
    throw error;
  });
  const onDefault = await resolved(g, `refs/remotes/origin/${defaultBranch}`);
  const cached = cachingCommits(call);
  // newest first. A branch cut further back than the pages read so far walks the default branch's
  // history as its own until it hits the cap; the listing is then read a page deeper and the walk redone
  const onDefaultBranch: string[] = [];
  let walked: Map<string, string[]>;
  for (let page = 1; ; page++) {
    const listed = await call<{ sha: string }[]>(
      "GET",
      `/commits?sha=${encodeURIComponent(defaultBranch)}&per_page=${DEFAULT_MAX_COMMITS}${page > 1 ? `&page=${page}` : ""}`,
    );
    onDefaultBranch.push(...listed.map(({ sha }) => sha));
    try {
      ({ walked } = await fetchBranch({
        repoDir: options.repoDir,
        call: cached,
        branch: startBranch,
        tip,
        stopAt: onDefaultBranch,
        connected: onDefault ? [onDefault] : [],
      }));
      break;
    } catch (error) {
      if (!(error instanceof TooFarError)) throw error;
      if (listed.length < DEFAULT_MAX_COMMITS || page >= MAX_LISTING_PAGES) {
        throw new TooFarError(
          `the start branch ${startBranch} has more than ${DEFAULT_MAX_COMMITS} commits that ${defaultBranch} doesn't; a run fetches at most ${DEFAULT_MAX_COMMITS}`,
        );
      }
    }
  }
  const touching = new Set(
    [tip, ...[...walked.values()].flat()].filter((sha) =>
      onDefaultBranch.includes(sha),
    ),
  );
  const mergeBase =
    onDefaultBranch.find((sha) => touching.has(sha)) ??
    (onDefault ? await g(["merge-base", onDefault, tip]).catch(() => "") : "");
  if (mergeBase) {
    await g(["update-ref", `${FETCHED_BASES}${mergeBase}`, mergeBase]);
  }
  return tip;
}

/** `refs/sky/starts/<agentId>`: the start branch's tip when the agent's worktree was first made from it; never moved. */
export const STARTS = "refs/sky/starts/";

export const BRANCH_CHECK_USAGE = "branch-check <branch>";

/**
 * `runner.mjs branch-check <branch>`: the API's, before it starts an agent on an existing GitHub
 * branch. Looks the branch up through the gateway and fetches nothing. Prints its tip on stdout and
 * returns the exit status the API maps: 0 found, 3 no such branch, 4 the default branch, 2 a usage
 * or config error, 1 anything else.
 */
export async function branchCheckMain(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: { stdout: (s: string) => void; stderr: (s: string) => void },
): Promise<number> {
  const [branch, ...rest] = argv;
  if (!branch || rest.length > 0) {
    io.stderr(`usage: ${BRANCH_CHECK_USAGE}\n`);
    return 2;
  }
  const connectorId = env[CONNECTOR_ENV];
  if (!connectorId) {
    io.stderr(`branch-check: ${CONNECTOR_ENV} is not set\n`);
    return 2;
  }
  try {
    const g = git(env.REPO_DIR || "/workspace/repo");
    const { owner, repo } = parseOrigin(
      await g(["remote", "get-url", "origin"]),
    );
    if (branch === (await defaultBranchOf(g))) {
      io.stderr(
        `branch-check: ${branch} is the default branch of ${owner}/${repo}; an agent can't continue it\n`,
      );
      return 4;
    }
    const call = gateway({
      gatewayUrl: env[GATEWAY_URL_ENV] || DEFAULT_GATEWAY_URL,
      connectorId,
      owner,
      repo,
    });
    const tip = await remoteTip(call, branch).catch((error: unknown) => {
      if (error instanceof BranchNotFoundError) return null;
      throw error;
    });
    if (tip === null) {
      io.stderr(`branch-check: ${branch} doesn't exist on ${owner}/${repo}\n`);
      return 3;
    }
    io.stdout(`${tip}\n`);
    return 0;
  } catch (error) {
    io.stderr(`branch-check: ${messageOf(error)}\n`);
    return 1;
  }
}

export const SYNC_USAGE = "sync [--branch <name>]";

/** Seconds `sync` waits for the repo lock: short, so the agent hears "busy" before its shell times out. */
export const SYNC_LOCK_WAIT_S = 30;

/**
 * The default branch half of `sync`: what `origin/<default>` did, as the line the agent reads.
 * `worktreeMoved` is whether the branch half moved the worktree, which this half never does.
 */
async function describeDefault(
  g: Git,
  synced: DefaultSync,
  worktreeMoved: boolean,
): Promise<string> {
  const name = synced.default;
  if (!synced.moved) {
    return `origin/${name} is already at GitHub's tip ${short(synced.sha)}; nothing moved.`;
  }
  const unchanged = worktreeMoved
    ? `Local ${name} was not changed.`
    : `Your worktree and local ${name} were not changed.`;
  const tip = `GitHub's tip ${short(synced.sha)}`;
  if (!synced.previous) return `origin/${name} moved to ${tip}. ${unchanged}`;
  const from = short(synced.previous);
  // left: only in the old tip (dropped by GitHub); right: only in the new one
  const [dropped = 0, added = 0] = (
    await g([
      "rev-list",
      "--left-right",
      "--count",
      `${synced.previous}...${synced.sha}`,
    ])
  )
    .split(/\s+/)
    .map(Number);
  if (dropped === 0) {
    return `origin/${name} moved from ${from} to ${tip}, ${commits(added)} ahead. ${unchanged}`;
  }
  if (added === 0) {
    return `origin/${name} moved back from ${from} to ${tip}: GitHub's ${name} dropped ${commits(dropped)}. ${unchanged}`;
  }
  return `origin/${name} moved from ${from} to ${tip}: GitHub's ${name} was rewritten, with ${commits(added)} added and ${commits(dropped)} dropped. ${unchanged}`;
}

/** The GitHub branch flag of `sync`, `--branch <name>` or `--branch=<name>`; undefined for a bad argv. */
function syncArgs(argv: string[]): { branch?: string } | undefined {
  if (argv.length === 0) return {};
  const [first = "", second, ...rest] = argv;
  if (first.startsWith("--branch=") && second === undefined) {
    const branch = first.slice("--branch=".length);
    return branch ? { branch } : undefined;
  }
  if (first === "--branch" && second && rest.length === 0) {
    return { branch: second };
  }
  return undefined;
}

/**
 * `runner.mjs sync`, run by the agent from its worktree. Brings `origin/<default>` to GitHub's tip
 * again, for a default branch that moved while the run worked, and then the worktree onto GitHub's
 * head of the branch `publish` targets (`--branch`, the branch the agent continues,
 * `SKY_PUBLISH_BRANCH`, or the worktree's own), for commits pushed to it mid-run (`syncOwnBranch`).
 * The default branch's refresh moves no local branch and touches no worktree. Prints what it did on
 * stdout and returns the exit status: 0 for `--help` or everything refreshed or already current,
 * 2 for a usage or config error, 1 for a refresh that couldn't be done or a worktree left as it was
 * for a reason the agent should act on, with the reason on stderr.
 */
export async function syncMain(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: { cwd: string; stdout: (s: string) => void; stderr: (s: string) => void },
  deps: { lockWaitS?: number } = {},
): Promise<number> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    io.stdout(`usage: ${SYNC_USAGE}\n`);
    return 0;
  }
  const args = syncArgs(argv);
  if (!args) {
    io.stderr(
      `sky sync: takes no arguments but --branch <name>\nusage: ${SYNC_USAGE}\n`,
    );
    return 2;
  }
  const connectorId = env[CONNECTOR_ENV];
  if (!connectorId) {
    io.stderr(
      `sky sync: ${CONNECTOR_ENV} is not set; set a connector secret: sky secret set <env> ${CONNECTOR_ENV} --connector=<connection id>\n`,
    );
    return 2;
  }
  try {
    // a worktree's common dir is the shared clone's `.git`, so the clone is its parent
    const common = await inTree(
      io.cwd,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    );
    const repoDir = dirname(common);
    const g = git(repoDir);
    const { owner, repo } = parseOrigin(
      await g(["remote", "get-url", "origin"]),
    );
    const call = gateway({
      gatewayUrl: env[GATEWAY_URL_ENV] || DEFAULT_GATEWAY_URL,
      connectorId,
      owner,
      repo,
    });
    // both halves write the shared repo, so they hold the lock together
    const { synced, own } = await withRepoLock(
      repoDir,
      async () => {
        const synced = await syncDefaultBranch({ repoDir, call });
        const own = await syncWorktreeBranch({
          repoDir,
          cwd: io.cwd,
          call,
          env,
          defaultBranch: synced.default,
          branch: args.branch,
        });
        return { synced, own };
      },
      deps.lockWaitS ?? SYNC_LOCK_WAIT_S,
    );
    let code = 0;
    if (synced.tooFar) {
      io.stderr(`sky sync: ${tooFarNote(synced)}\n`);
      code = 1;
    } else {
      io.stdout(`${await describeDefault(g, synced, own.moved === true)}\n`);
    }
    for (const line of own.lines) {
      (own.ok ? io.stdout : io.stderr)(
        own.ok ? `${line}\n` : `sky sync: ${line}\n`,
      );
    }
    return own.ok ? code : 1;
  } catch (error) {
    io.stderr(
      error instanceof RepoLockBusyError
        ? "sky sync: the repo is busy: another run is writing the shared repo; try again in a minute\n"
        : `sky sync: ${messageOf(error)}\n`,
    );
    return 1;
  }
}

/**
 * `syncOwnBranch` for the worktree at `cwd`, on the GitHub branch `branch` names or else the one
 * `publish` would send it to. A failure is reported as a refusal, so the default branch's result
 * already gained still reaches the agent.
 */
async function syncWorktreeBranch(options: {
  repoDir: string;
  cwd: string;
  call: Call;
  env: NodeJS.ProcessEnv;
  defaultBranch: string;
  branch: string | undefined;
}): Promise<{ ok: boolean; lines: string[]; moved?: boolean }> {
  const { repoDir, cwd, env } = options;
  try {
    // a rebase or bisect detaches HEAD, so this is checked before the branch is read
    const midway = await inProgress(cwd);
    if (midway) {
      return {
        ok: false,
        lines: [`${midway}, then sync again. Nothing was changed.`],
      };
    }
    const local = await inTree(
      cwd,
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ).catch(() => "");
    if (!local) {
      return {
        ok: false,
        lines: [
          "HEAD is detached in this worktree, so its GitHub branch can't be told; check out your branch and sync again. Nothing was changed.",
        ],
      };
    }
    const branch =
      options.branch ?? (await publishedBranch(git(repoDir), local, env));
    const valid =
      !branch.startsWith("-") &&
      branch !== "HEAD" &&
      !/^(refs|origin)\//.test(branch) &&
      (await inTree(cwd, "check-ref-format", `refs/heads/${branch}`).then(
        () => true,
        () => false,
      ));
    if (!valid) {
      return {
        ok: false,
        lines: [
          `${branch} is not a valid branch name; see \`git check-ref-format\`. Nothing was changed.`,
        ],
      };
    }
    if (branch === options.defaultBranch) {
      return {
        ok: false,
        lines: [
          `${branch} is the default branch, which \`publish\` never sends to; name your own branch with --branch. Nothing was changed.`,
        ],
      };
    }
    return await syncOwnBranch({ ...options, branch, localBranch: local });
  } catch (error) {
    return {
      ok: false,
      lines: [`bringing in the branch's commits failed: ${messageOf(error)}`],
    };
  }
}

/**
 * The GitHub branch `publish` sends `branch` to when no `--branch` is given: the branch a continued
 * agent was started on, then the environment's `SKY_PUBLISH_BRANCH`, then its own name.
 */
const publishedBranch = async (
  g: Git,
  branch: string,
  env: NodeJS.ProcessEnv,
): Promise<string> =>
  (await g(["config", "--get", `branch.${branch}.${REMOTE_BRANCH_KEY}`]).catch(
    () => "",
  )) ||
  env[BRANCH_ENV] ||
  branch;

const tooFarNote = (s: DefaultSync) =>
  `GitHub's ${s.default} is more than ${DEFAULT_MAX_COMMITS} commits ahead of what this sandbox has, too far to fetch, so \`origin/${s.default}\` was left at ${short(s.previous)}; you are working from that commit, not GitHub's ${short(s.sha)}.`;

/**
 * The agent's worktree for this run, brought up to date with GitHub, with notes for the agent on
 * what that did or couldn't do. A public repo's default branch and a start branch come
 * over git, at no REST cost; a private one, or a failed fetch, goes through the connector. Without
 * a connector there is no way to reach GitHub, and the worktree is made or reused as it stands.
 * A `signal` aborted before the repo lock is taken, queued behind another run's setup or earlier,
 * rejects with its reason and leaves the worktree unmade.
 */
export function prepareWorktree(
  config: PrepareConfig,
  deps: {
    env: NodeJS.ProcessEnv;
    warn: (line: string) => void;
    /** Seconds to queue for the repo lock; `REPO_LOCK_WAIT_S` when absent. */
    lockWaitS?: number;
    signal?: AbortSignal;
  },
): Promise<Prepared> {
  // every step writes the repo every sprite run shares: runs starting at once take turns
  return withRepoLock(
    config.repoDir,
    () => prepareLocked(config, deps),
    deps.lockWaitS,
    deps.signal,
  );
}

type PrepareConfig = {
  repoDir: string;
  worktreesDir: string;
  agentId: AgentId;
  startBranch?: string;
};

/** The default branch's tip GitHub reported when the run's refresh succeeded, and when. */
export type Refreshed = { branch: string; sha: string; at: Date };

type Prepared = { cwd: string; notes: string[]; refreshed?: Refreshed };

async function prepareLocked(
  config: PrepareConfig,
  deps: { env: NodeJS.ProcessEnv; warn: (line: string) => void },
): Promise<Prepared> {
  const notes: string[] = [];
  let refreshed: Refreshed | undefined;
  const { startBranch } = config;
  const branch = agentBranch(config.agentId);
  const g = git(config.repoDir);
  const isNew = !existsSync(join(config.worktreesDir, config.agentId));
  // false when the agent switched to another branch and the runner left it there
  let onBranch = true;
  /**
   * The agent may have switched its worktree to another local branch (see `adoptAgentBranch`).
   * `publish` names the GitHub branch after the checked-out one, so a branch already sent under
   * the old name keeps its pull request only when the agent's branch is pointed at it. That is
   * decided now or never: the next run is already on the agent's branch.
   */
  const adopt = async (
    cwd: string,
    lookup?: { call: Call; defaultName: string | undefined },
  ) => {
    if (isNew) return;
    const adopted = await adoptAgentBranch(cwd, branch);
    onBranch = adopted.onBranch;
    if (adopted.note) notes.push(adopted.note);
    const old = adopted.from;
    const key = `branch.${branch}.${REMOTE_BRANCH_KEY}`;
    if (
      !old ||
      startBranch ||
      (await g(["config", "--get", key]).catch(() => ""))
    ) {
      return;
    }
    // publishing there would write to the default branch directly
    if (old === lookup?.defaultName) return;
    // undefined when GitHub couldn't say
    let published: boolean | undefined;
    if (lookup) {
      published = await remoteTip(lookup.call, old).then(
        () => true,
        (error: unknown) => {
          if (error instanceof BranchNotFoundError) return false;
          deps.warn(
            `runner: looking for ${old} on GitHub failed: ${messageOf(error)}`,
          );
          return undefined;
        },
      );
    }
    if (published) {
      try {
        await g(["config", key, old]);
        notes.push(
          `\`${old}\` is already on GitHub, so \`publish\` updates it (and its open pull request) rather than opening \`${branch}\`.`,
        );
        return;
      } catch (error) {
        deps.warn(`runner: recording ${old} failed: ${messageOf(error)}`);
        published = undefined;
      }
    }
    if (published === undefined) {
      notes.push(
        `The runner couldn't tell whether \`${old}\` was published to GitHub. If it was, publish with \`--branch ${old}\` to update its pull request rather than open a new one.`,
      );
    }
  };
  const continueStartBranch = async (cwd: string) => {
    if (!startBranch) return { cwd, notes, refreshed };
    // the repo's config, shared by every worktree, and `git config` fails outright while another
    // run holds its lock, so it is written only when it changes; the key is per branch
    const key = `branch.${branch}.${REMOTE_BRANCH_KEY}`;
    const held = await g(["config", "--get", key]).catch(() => "");
    if (held !== startBranch) await g(["config", key, startBranch]);
    // `publish` reads the checked-out branch's key, which is not this one
    if (!onBranch) return { cwd, notes, refreshed };
    notes.push(
      `This worktree continues the existing GitHub branch \`${startBranch}\`; \`publish\` updates that branch (and its open pull request), not \`${branch}\`.`,
    );
    return { cwd, notes, refreshed };
  };
  const connectorId = deps.env[CONNECTOR_ENV];
  if (!connectorId) {
    if (startBranch && isNew) {
      throw new Error(
        `this agent was started on branch ${startBranch}, but ${CONNECTOR_ENV} is not set, so there is no way to fetch it from GitHub`,
      );
    }
    const cwd = await ensureWorktree(config);
    await adopt(cwd);
    return continueStartBranch(cwd);
  }
  const defaultName = await defaultBranchOf(g).catch(() => undefined);
  if (startBranch && startBranch === defaultName) {
    throw new Error(
      `this agent was started on ${startBranch}, the default branch: publishing would write to it directly; start from a branch of its own`,
    );
  }
  let lastFailure: unknown;
  const syncFailed = (error: unknown) => {
    lastFailure = error;
    deps.warn(`runner: refresh from GitHub failed: ${messageOf(error)}`);
    notes.push(
      `The runner couldn't refresh from GitHub: ${messageOf(error)}; working from the commit the sandbox last had.`,
    );
  };
  let call: Call | undefined;
  // cleared by the first anonymous fetch that fails (a private repo), which is not tried again this run
  let overGit = anonGitEnabled(deps.env);
  const gitFailed = (error: unknown) => {
    overGit = false;
    deps.warn(
      `runner: anonymous git fetch failed (${whyFailed(error)}); falling back to the connector`,
    );
  };
  try {
    if (!defaultName) throw new Error("origin/HEAD names no branch");
    const { owner, repo } = parseOrigin(
      await g(["remote", "get-url", "origin"]),
    );
    call = gateway({
      gatewayUrl: deps.env[GATEWAY_URL_ENV] || DEFAULT_GATEWAY_URL,
      connectorId,
      owner,
      repo,
    });
    let synced: DefaultSync | undefined;
    if (overGit) {
      synced = await syncDefaultOverGit({ repoDir: config.repoDir }).catch(
        (error: unknown) => {
          gitFailed(error);
          return undefined;
        },
      );
    }
    synced ??= await syncDefaultBranch({ repoDir: config.repoDir, call });
    if (synced.tooFar) notes.push(tooFarNote(synced));
    else
      refreshed = { branch: synced.default, sha: synced.sha, at: new Date() };
  } catch (error) {
    syncFailed(error);
  }
  if (isNew && startBranch) {
    // unlike the refresh, the run can't go on without it: there is nothing else to start from
    if (!call || !defaultName) {
      throw new Error(
        `can't fetch branch ${startBranch} from GitHub: ${messageOf(lastFailure)}`,
      );
    }
    let tip: string | undefined;
    if (overGit) {
      try {
        tip = await fetchStartBranchOverGit({
          repoDir: config.repoDir,
          startBranch,
          defaultBranch: defaultName,
        });
      } catch (error) {
        if (error instanceof BranchNotFoundError) throw error;
        gitFailed(error);
      }
    }
    tip ??= await fetchStartBranch({
      repoDir: config.repoDir,
      call,
      startBranch,
      defaultBranch: defaultName,
    });
    // the API's: what the agent's own work is diffed from, however `origin/<start>` moves after
    const startRef = `${STARTS}${config.agentId}`;
    if (!(await resolved(g, startRef))) {
      await g(["update-ref", startRef, tip, ""]);
    }
  }
  const cwd = await ensureWorktree({
    ...config,
    ...(isNew && startBranch && { from: `refs/remotes/origin/${startBranch}` }),
  });
  await adopt(cwd, call && { call, defaultName });
  // the sync and rebase below assume the agent's own branch is checked out
  if (!isNew && onBranch && defaultName) {
    // unknown blocks the rebase as published does: a rebase can't be taken back once the branch
    // turns out to be
    let published: boolean | undefined;
    if (call) {
      try {
        const synced = await syncAgentBranch({
          repoDir: config.repoDir,
          cwd,
          call,
          branch: startBranch ?? (await publishedBranch(g, branch, deps.env)),
          defaultBranch: defaultName,
        });
        published = synced.published;
        notes.push(...synced.notes);
      } catch (error) {
        syncFailed(error);
      }
    }
    // a start branch behind the default branch is someone's branch as they left it, not news
    if (!startBranch) {
      notes.push(...(await rebaseOntoDefault(cwd, defaultName, published)));
    }
  }
  return continueStartBranch(cwd);
}
