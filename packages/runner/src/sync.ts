import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { type AgentId, agentBranch } from "@sky/shared";
import {
  CONNECTOR_ENV,
  DEFAULT_GATEWAY_URL,
  FETCHED_BASES,
  GATEWAY_URL_ENV,
  GatewayError,
  gateway,
  movingCommitsConfig,
  parseOrigin,
  REMOTE_BRANCH_KEY,
} from "./publish.js";
import { fetchCommit } from "./repo.js";
import { git, messageOf } from "./store.js";
import { ensureWorktree } from "./worktree.js";

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

const DEFAULT_MAX_COMMITS = 100;

const segments = (branch: string) =>
  branch.split("/").map(encodeURIComponent).join("/");

/** GitHub's tip of `branch`; a branch GitHub doesn't have throws `BranchNotFoundError`. */
export async function remoteTip(call: Call, branch: string): Promise<string> {
  const ref = await call<{ object: { sha: string } }>(
    "GET",
    `/git/ref/heads/${segments(branch)}`,
  ).catch((error: unknown) => {
    if (error instanceof GatewayError && error.status === 404) {
      throw new BranchNotFoundError(
        branch,
        `${branch} doesn't exist on GitHub (${error.message})`,
      );
    }
    throw error;
  });
  return ref.object.sha;
}

const present = (g: Git, sha: string) =>
  g(["cat-file", "-e", `${sha}^{commit}`]).then(
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
 * when it is written and the history stays connected rather than shallow. A sha in `stopAt` is
 * fetched but its parents are not walked; `tipOnly` fetches the tip alone, shallow. More than
 * `maxCommits` to fetch throws `TooFarError` before anything is written. Every write converges, so
 * another agent's run fetching the same branch at once does no harm.
 */
export async function fetchBranch(options: {
  repoDir: string;
  call: Call;
  branch: string;
  /** GitHub's tip, when the caller has already looked it up. */
  tip?: string;
  stopAt?: string[];
  maxCommits?: number;
  tipOnly?: boolean;
}): Promise<{ branch: string; sha: string; previous: string | null }> {
  const { repoDir, branch } = options;
  const g = git(repoDir);
  const call = cachingCommits(options.call);
  const sha = options.tip ?? (await remoteTip(call, branch));
  const maxCommits = options.maxCommits ?? DEFAULT_MAX_COMMITS;
  const stopAt = new Set(options.stopAt ?? []);

  const parentsOf = new Map<string, string[]>();
  if (!(await present(g, sha))) {
    const queue = [sha];
    while (queue.length > 0) {
      const next = queue.shift() as string;
      if (parentsOf.has(next) || (await present(g, next))) continue;
      if (parentsOf.size >= maxCommits) {
        throw new TooFarError(
          `${branch} on GitHub is more than ${maxCommits} commits past anything this clone has`,
        );
      }
      if (options.tipOnly || stopAt.has(next)) {
        parentsOf.set(next, []);
        continue;
      }
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
    await fetchCommit(g, call, commit);
  }

  const ref = `refs/remotes/origin/${branch}`;
  const previous = (await resolved(g, ref)) || null;
  await moveRef(g, ref, sha, previous);
  return { branch, sha, previous };
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
    await fetchBranch({ ...options, branch: name, tip: sha });
  } catch (error) {
    if (error instanceof TooFarError) return { ...result, tooFar: true };
    throw error;
  }
  await g(["update-ref", `${FETCHED_BASES}${sha}`, sha]);
  return { ...result, moved: true };
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

/** A failed git command's own words, not execFile's "Command failed: …" wrapper. */
const gitSaid = (error: unknown) =>
  (error as { stderr?: string }).stderr?.trim() || messageOf(error);

const short = (sha: string | null) => (sha ?? "").slice(0, 7);
const commits = (n: number) => `${n} commit${n === 1 ? "" : "s"}`;

/** Paths a stopped rebase or cherry-pick left unmerged. */
async function unmerged(cwd: string): Promise<string[]> {
  // one line per stage of each unmerged path: "<mode> <sha> <stage>\t<path>"
  const out = await inTree(cwd, "ls-files", "--unmerged").catch(() => "");
  return [
    ...new Set(
      out
        .split("\n")
        .filter(Boolean)
        .map((line) => line.slice(line.indexOf("\t") + 1)),
    ),
  ];
}

/** Whether the worktree has changes to tracked files; untracked files block nothing by themselves. */
const isDirty = async (cwd: string) =>
  (await inTree(cwd, "status", "--porcelain", "--untracked-files=no")) !== "";

/**
 * Rebases an existing worktree's branch onto `origin/<name>` when it is behind, unless the branch
 * is published (rewriting it would break the pull request built from it) or has uncommitted
 * changes; a rebase that fails is aborted and the worktree left as it was. Says what it did.
 */
async function rebaseOntoDefault(
  cwd: string,
  name: string,
  published: boolean,
): Promise<string[]> {
  const target = `refs/remotes/origin/${name}`;
  const behind = Number(
    await inTree(cwd, "rev-list", "--count", `HEAD..${target}`),
  );
  if (behind === 0) return [];
  const behindBy = `Your worktree is ${commits(behind)} behind \`origin/${name}\``;
  if (published) {
    return [
      `${behindBy}; it wasn't rebased because its branch is already published to GitHub, and rewriting published commits would rewrite its pull request.`,
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
    await inTree(cwd, "rebase", "--abort").catch(() => {});
    return [
      conflicted.length > 0
        ? `${behindBy}; rebasing onto it conflicted (in ${conflicted.join(", ")}), so the rebase was aborted and the worktree left as it was.`
        : `${behindBy}; rebasing onto it failed (${gitSaid(error)}), so the worktree was left as it was.`,
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
 * Brings commits pushed to the agent's GitHub `branch` from outside the sandbox into its existing
 * worktree, when that can't lose anything: the worktree is clean, everything in it is published,
 * and the outside commits are a plain line on top. GitHub's history is classified before any body
 * is fetched: walking the tip's first parents to the first commit that matches the worktree, by sha
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
  const head = await inTree(cwd, "rev-parse", "HEAD");
  if (tip === head) return { published: true, notes: [] };

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

  // newest first; `match` is GitHub's commit the outside ones sit on, `local` the commit it matches here
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
  if (outside.some(({ commit }) => commit.parents.length > 1)) {
    return untouched(`with ${pushed}, including a merge`);
  }

  await fetchBranch({
    repoDir: options.repoDir,
    call,
    branch,
    tip,
    stopAt: [match.sha],
  });
  const oldest = outside.map(({ sha }) => sha).reverse();
  try {
    if (match.sha === head) {
      await inTree(cwd, "merge", "--ff-only", "--quiet", tip);
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
    if (match.sha !== head) {
      await inTree(cwd, "cherry-pick", "--abort").catch(() => {});
    }
    return untouched(
      `with ${pushed}, but bringing them in failed (${gitSaid(error)})`,
    );
  }
  const list = outside
    .map(({ sha, commit }) => `${short(sha)} ${commit.message.split("\n")[0]}`)
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
 * Fetches GitHub's `startBranch` back to where it left the default branch, and records that merge
 * base under `FETCHED_BASES` so publish finds the base it was cut from.
 */
async function fetchStartBranch(options: {
  repoDir: string;
  call: Call;
  startBranch: string;
  defaultBranch: string;
}): Promise<void> {
  const { call, startBranch } = options;
  const tip = await remoteTip(call, startBranch).catch((error: unknown) => {
    if (error instanceof BranchNotFoundError) {
      throw new BranchNotFoundError(
        startBranch,
        `the start branch ${error.message}`,
      );
    }
    throw error;
  });
  const { merge_base_commit: mergeBase } = await call<{
    merge_base_commit: { sha: string };
  }>(
    "GET",
    `/compare/${segments(options.defaultBranch)}...${segments(startBranch)}?per_page=1`,
  );
  await fetchBranch({
    repoDir: options.repoDir,
    call,
    branch: startBranch,
    tip,
    stopAt: [mergeBase.sha],
  });
  await git(options.repoDir)([
    "update-ref",
    `${FETCHED_BASES}${mergeBase.sha}`,
    mergeBase.sha,
  ]);
}

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

const tooFarNote = (s: DefaultSync) =>
  `GitHub's ${s.default} is more than ${DEFAULT_MAX_COMMITS} commits ahead of what this sandbox has, too far to fetch, so \`origin/${s.default}\` was left at ${short(s.previous)}; you are working from that commit, not GitHub's ${short(s.sha)}.`;

/**
 * The agent's worktree for this run, brought up to date with GitHub through the connector, with
 * notes for the agent on what that did or couldn't do. Without a connector there is no way to
 * reach GitHub, and the worktree is made or reused as it stands.
 */
export async function prepareWorktree(
  config: {
    repoDir: string;
    worktreesDir: string;
    agentId: AgentId;
    startBranch?: string;
  },
  deps: { env: NodeJS.ProcessEnv; warn: (line: string) => void },
): Promise<{ cwd: string; notes: string[] }> {
  const notes: string[] = [];
  const { startBranch } = config;
  const branch = agentBranch(config.agentId);
  const g = git(config.repoDir);
  const isNew = !existsSync(join(config.worktreesDir, config.agentId));
  const continueStartBranch = async (cwd: string) => {
    if (!startBranch) return { cwd, notes };
    // the repo's config, shared by every worktree; the key is per branch
    await g(["config", `branch.${branch}.${REMOTE_BRANCH_KEY}`, startBranch]);
    notes.push(
      `This worktree continues the existing GitHub branch \`${startBranch}\`; \`publish\` updates that branch (and its open pull request), not \`${branch}\`.`,
    );
    return { cwd, notes };
  };
  const connectorId = deps.env[CONNECTOR_ENV];
  if (!connectorId) {
    if (startBranch && isNew) {
      throw new Error(
        `START_BRANCH is ${startBranch}, but ${CONNECTOR_ENV} is not set, so there is no way to fetch it from GitHub`,
      );
    }
    return continueStartBranch(await ensureWorktree(config));
  }
  const defaultName = await defaultBranchOf(g).catch(() => undefined);
  if (startBranch && startBranch === defaultName) {
    throw new Error(
      `START_BRANCH is ${startBranch}, the default branch: publishing would write to it directly; start from a branch of its own`,
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
    const synced = await syncDefaultBranch({ repoDir: config.repoDir, call });
    if (synced.tooFar) notes.push(tooFarNote(synced));
  } catch (error) {
    syncFailed(error);
  }
  if (isNew && startBranch) {
    // unlike the refresh, the run can't go on without it: there is nothing else to start from
    if (!call || !defaultName) {
      throw new Error(
        `can't fetch START_BRANCH ${startBranch} from GitHub: ${messageOf(lastFailure)}`,
      );
    }
    await fetchStartBranch({
      repoDir: config.repoDir,
      call,
      startBranch,
      defaultBranch: defaultName,
    });
  }
  const cwd = await ensureWorktree({
    ...config,
    ...(isNew && startBranch && { from: `refs/remotes/origin/${startBranch}` }),
  });
  if (!isNew && defaultName) {
    // unknown is taken as published: a rebase can't be taken back once the branch turns out to be
    let published = true;
    if (call) {
      try {
        const synced = await syncAgentBranch({
          repoDir: config.repoDir,
          cwd,
          call,
          branch: startBranch ?? branch,
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
