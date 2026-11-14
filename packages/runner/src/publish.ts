import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { fetchCommit } from "./repo.js";
import { fetchMissing, git as repoGit, type TreeItem } from "./store.js";

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
  /**
   * Set when the commits change `.github/workflows/`, which the connector's token may not write:
   * what was sent keeps GitHub's head's version there once the branch exists (the base's before
   * that, and on a rewrite), and the paths the branch changed that differ from it are held in
   * `patch`, also saved at `patchPath`.
   */
  held?: { files: string[]; patch: string; patchPath: string };
};

/** The directory GitHub refuses a tree change under without the `workflow` scope. */
export const WORKFLOWS_DIR = ".github/workflows";
/** Printed on stdout around the held-back patch, after the pull request's URL. */
export const HELD_PATCH_BEGIN =
  "----- held-back workflow changes (git apply) -----";
export const HELD_PATCH_END = "----- end of held-back workflow changes -----";

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

type TreeItemEntry = { mode: string; type: string; sha: string; path: string };

/** The entries of a tree object that is in this clone. */
async function lsTree(cwd: string, sha: string): Promise<TreeItemEntry[]> {
  const out = await git(cwd, "ls-tree", "-z", sha);
  return out
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      const [mode = "", type = "", entrySha = ""] = line
        .slice(0, tab)
        .split(" ");
      return { mode, type, sha: entrySha, path: line.slice(tab + 1) };
    });
}

/** Writes a tree of `entries`; the trees they name needn't be in this clone. */
const mktree = (cwd: string, entries: TreeItemEntry[]) =>
  repoGit(cwd)(["mktree", "--missing", "-z"], {
    input: entries
      .map((e) => `${e.mode} ${e.type} ${e.sha}\t${e.path}\0`)
      .join(""),
  });

/**
 * `tree` with `.github/workflows/` as the tree `workflows` has it, or left out where that is "":
 * only the root and `.github` trees are rebuilt, so the workflows tree itself need not be here.
 */
async function swapWorkflows(
  cwd: string,
  read: (sha: string) => Promise<TreeItemEntry[]>,
  tree: string,
  workflows: string,
): Promise<string> {
  const root = await read(tree);
  const github = root.find((e) => e.path === ".github" && e.type === "tree");
  const inner = github
    ? (await read(github.sha)).filter((e) => e.path !== "workflows")
    : [];
  if (workflows) {
    inner.push({
      mode: "040000",
      type: "tree",
      sha: workflows,
      path: "workflows",
    });
  }
  const rest = root.filter((e) => e.path !== ".github");
  if (inner.length > 0) {
    rest.push({
      mode: "040000",
      type: "tree",
      sha: await mktree(cwd, inner),
      path: ".github",
    });
  }
  return mktree(cwd, rest);
}

/**
 * Makes GitHub's tree `sha` and every blob under it resolvable here, when it isn't: a tree GitHub's
 * head holds that no local commit has, as after someone pushed to the branch.
 */
async function fetchTree(
  cwd: string,
  call: ReturnType<typeof gateway>,
  sha: string,
): Promise<void> {
  const g = repoGit(cwd);
  const here = await g(["cat-file", "-e", `${sha}^{tree}`]).then(
    () => true,
    () => false,
  );
  if (here) return;
  const listing = await call<{ tree: TreeItem[]; truncated: boolean }>(
    "GET",
    `/git/trees/${sha}?recursive=1`,
  );
  if (listing.truncated) {
    throw new PublishError(`the tree ${sha} on GitHub is too large to fetch`);
  }
  const entries = listing.tree.filter(
    (item) => item.type === "blob" || item.type === "commit",
  );
  await fetchMissing(
    g,
    call,
    entries.filter((item) => item.type === "blob"),
    () => {},
    "publish",
  );
  const dir = await mkdtemp(join(tmpdir(), "sky-publish-"));
  try {
    const env = { GIT_INDEX_FILE: join(dir, "index") };
    await g(["update-index", "-z", "--add", "--index-info"], {
      env,
      input: entries
        .map((item) => `${item.mode} ${item.sha}\t${item.path}\0`)
        .join(""),
    });
    const built = await g(["write-tree"], { env });
    if (built !== sha) throw new Error(`tree ${sha} arrived as ${built}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Each path of `paths` that differs between the trees `base` and `tip`, as `<status> <path>`; a rename names both. */
async function heldFiles(
  cwd: string,
  base: string,
  tip: string,
  paths: string[],
) {
  const out = await git(
    cwd,
    "diff",
    "--name-status",
    "-z",
    "-M",
    base,
    tip,
    "--",
    ...paths,
  );
  const fields = out.split("\0").filter(Boolean);
  const files: string[] = [];
  for (let i = 0; i < fields.length; ) {
    const status = fields[i] ?? "";
    const paths = /^[RC]/.test(status)
      ? [fields[i + 1], fields[i + 2]]
      : [fields[i + 1]];
    files.push(`${status[0]} ${paths.join(" -> ")}`);
    i += 1 + paths.length;
  }
  return files;
}

/**
 * Each path under `.github/workflows/` that differs between two `.github/workflows` trees, "" for
 * none; a rename names both ends. Both trees must be in this clone.
 */
async function workflowPathsBetween(
  cwd: string,
  from: string,
  to: string,
): Promise<string[]> {
  if (from === to) return [];
  const empty = await mktree(cwd, []);
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
const RETRIES = 3;
// the primary rate limit resets on the hour at the latest; a reset this near is waited out, a farther one fails naming its time
const MAX_RESET_WAIT_S = 300;
// a stalled gateway call fails rather than holding the caller
const REQUEST_TIMEOUT_MS = 120_000;

/** GitHub's REST API for one repo, through the gateway, with no credential of its own. */
export function gateway(options: {
  gatewayUrl: string;
  connectorId: string;
  owner: string;
  repo: string;
}) {
  const root = `${options.gatewayUrl.replace(/\/+$/, "")}/${encodeURIComponent(options.connectorId)}`;
  const repoPath = `/repos/${options.owner}/${options.repo}`;
  return async function call<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const where = `${method} ${repoPath}${path}`;
    let response: Response;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await fetch(`${root}${repoPath}${path}`, {
          method,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: {
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            ...(body !== undefined && { "content-type": "application/json" }),
          },
          ...(body !== undefined && { body: JSON.stringify(body) }),
        });
      } catch (error) {
        // fetch's own message is just "fetch failed"; the reason is its cause
        const cause = error instanceof Error ? error.cause : undefined;
        throw new GatewayError(
          `GitHub gateway: ${where} failed: ${messageOf(error)}${cause ? ` (${messageOf(cause)})` : ""}`,
        );
      }
      const retryAfter = Number(response.headers.get("retry-after") ?? NaN);
      // the primary limit: the quota is spent until `x-ratelimit-reset`, epoch seconds
      const resetAt = Number(response.headers.get("x-ratelimit-reset") ?? NaN);
      if (
        (response.status === 403 || response.status === 429) &&
        response.headers.get("x-ratelimit-remaining") === "0" &&
        Number.isFinite(resetAt)
      ) {
        const waitS = Math.max(0, resetAt - Date.now() / 1000);
        if (waitS > MAX_RESET_WAIT_S || attempt >= RETRIES) {
          await response.body?.cancel();
          throw new GatewayError(
            `GitHub gateway: ${where} hit GitHub's rate limit, which resets at ${new Date(resetAt * 1000).toISOString()} (in ${Math.ceil(waitS / 60)} min); try again then`,
            response.status,
            true,
          );
        }
        await response.body?.cancel();
        await new Promise((resolve) => setTimeout(resolve, waitS * 1000 + 250));
        continue;
      }
      if (
        (response.status === 403 || response.status === 429) &&
        retryAfter >= 0 &&
        retryAfter <= MAX_RETRY_AFTER_S &&
        attempt < RETRIES
      ) {
        await response.body?.cancel();
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
        continue;
      }
      break;
    }
    if (response.ok) return (await response.json()) as T;
    const text = await response.text();
    let detail = text.trim() || response.statusText;
    try {
      const parsed = JSON.parse(text) as { message?: unknown };
      if (typeof parsed.message === "string") detail = parsed.message;
    } catch {}
    // a rate limit past what is waited out above: GitHub answers a secondary one with a
    // `retry-after` or a message naming it, and a primary one with no remaining quota
    const rateLimited =
      response.status === 429 ||
      (response.status === 403 &&
        (response.headers.has("retry-after") ||
          response.headers.get("x-ratelimit-remaining") === "0" ||
          /rate limit/i.test(detail)));
    throw new GatewayError(
      `GitHub gateway: ${where} returned ${response.status}: ${detail}`,
      response.status,
      rateLimited,
    );
  };
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
 * The base commit GitHub's commit `sha` forks from: the first on its first-parent line that is here
 * and on `base`'s history, within a bounded walk; undefined where the walk finds none.
 */
async function forkPoint(
  cwd: string,
  call: ReturnType<typeof gateway>,
  sha: string,
  base: string,
): Promise<string | undefined> {
  // false as well for a commit that isn't here
  const onBase = (commit: string) =>
    git(cwd, "merge-base", "--is-ancestor", commit, base).then(
      () => true,
      () => false,
    );
  for (let steps = 0; steps < 500; steps++) {
    if (await onBase(sha)) return sha;
    const { parents } = await call<{ parents: { sha: string }[] }>(
      "GET",
      `/git/commits/${sha}`,
    );
    const next = parents[0]?.sha;
    if (!next) return undefined;
    sha = next;
  }
  return undefined;
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
 * published head; a merge of a commit GitHub doesn't hold, or one whose `.github/workflows/` would
 * be sent without its merged-in changes there, is refused before anything is sent. A branch on
 * GitHub whose head this branch held before a rebase or amend here is force-updated to the
 * rewritten history; one holding a commit neither this branch nor the base has is refused before
 * anything is sent, and the GitHub branch a continued agent works on is only ever
 * fast-forwarded. The connector can't write under `.github/workflows/`, so sent trees keep that
 * directory as the base has it, or as GitHub's head of the branch has it once the branch exists,
 * and the paths there the branch itself changed come back as `held`.
 * GitHub's head is matched against local commits outside that directory, so workflows pushed to the
 * branch from elsewhere are kept, and a rewrite that would drop them is refused.
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
}): Promise<PublishResult> {
  // git takes a pathspec (`-- .github/workflows`, `ls-files`'s implicit one) relative to the
  // directory it runs in, while `<rev>:<path>` is from the top, so every call runs from the top
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
  const baseWorkflows = await workflowsOf(mergeBase);

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

  // replay from the last local commit GitHub already holds: the same sha, or else the same tree
  // outside .github/workflows (a recreated commit's sha differs once its date's offset is dropped,
  // and its workflows are the baseline's, or whatever was pushed there since; its tree can't differ
  // elsewhere)
  const known = [mergeBase, ...commits];
  let start = 0;
  let parent = mergeBase;
  // GitHub's head is one this branch held before it was rebased or amended here, so the rewritten
  // history replaces it; a head this branch never held is someone else's, and is never overwritten
  let rewritten = false;
  // the .github/workflows tree sent trees keep: the base's, until the branch exists on GitHub, then
  // GitHub's head's, so a push of the held workflows there is kept, not undone; the base's again
  // for a rewrite over a head whose workflows are only an older base's
  let baseline = baseWorkflows;
  // the .github/workflows tree on GitHub's side of the ref update: its head's, or the base's for a
  // new branch
  let theirWorkflows = baseWorkflows;
  // GitHub's tree for the commit replay resumes from
  let resumeTree: string | undefined;
  if (remote) {
    let at = known.indexOf(remote);
    if (at !== -1) {
      baseline = await workflowsOf(remote);
      resumeTree = await treeOf(remote);
    } else {
      const remoteTree = (
        await call<{ tree: { sha: string } }>("GET", `/git/commits/${remote}`)
      ).tree.sha;
      const trees = await Promise.all(known.map(treeOf));
      // GitHub's head's tree less .github/workflows, where the full trees match nowhere
      let outside: string | undefined;
      at = trees.lastIndexOf(remoteTree);
      if (at !== -1) {
        baseline = await workflowsOf(known[at] as string);
      } else {
        // GitHub's head has workflow changes no local commit has: compare outside them. Its trees
        // are read locally when they're here, else from GitHub
        const asked = new Map<string, Promise<TreeItemEntry[]>>();
        const readRemote = (sha: string) => {
          let entries = asked.get(sha);
          if (!entries) {
            entries = git(cwd, "cat-file", "-e", `${sha}^{tree}`).then(
              () => lsTree(cwd, sha),
              async () =>
                // a tree's own entries, not a recursive listing's
                (
                  await call<{ tree: TreeItemEntry[] }>(
                    "GET",
                    `/git/trees/${sha}`,
                  )
                ).tree.filter((e) => !e.path.includes("/")),
            );
            asked.set(sha, entries);
          }
          return entries;
        };
        const root = await readRemote(remoteTree);
        const github = root.find(
          (e) => e.path === ".github" && e.type === "tree",
        );
        const inner = github ? await readRemote(github.sha) : [];
        const remoteWorkflows =
          inner.find((e) => e.path === "workflows" && e.type === "tree")?.sha ??
          "";
        outside = await swapWorkflows(cwd, readRemote, remoteTree, "");
        const ours = await Promise.all(
          trees.map((t) =>
            swapWorkflows(cwd, (sha) => lsTree(cwd, sha), t, ""),
          ),
        );
        at = ours.lastIndexOf(outside);
        baseline = remoteWorkflows;
      }
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
        const entries = lines(reflog).map((line) => line.split(" "));
        rewritten = entries.some(
          ([sha, heldTree]) => sha === remote || heldTree === remoteTree,
        );
        // what GitHub got of a held tree carries the baseline's workflows, so it is matched outside
        // them, as `known` is
        const heldTrees = new Set(
          entries.flatMap(([, tree]) => (tree ? [tree] : [])),
        );
        for (const heldTree of heldTrees) {
          if (rewritten) break;
          const heldOutside = await swapWorkflows(
            cwd,
            (sha) => lsTree(cwd, sha),
            heldTree,
            "",
          );
          rewritten = heldOutside === outside;
        }
      }
      if (at !== -1) resumeTree = remoteTree;
    }
    // each lookup above sets the baseline to GitHub's head's workflows
    theirWorkflows = baseline;
    // a continued branch is someone's pull request: its head is theirs even when it sits in this
    // branch's reflog, as the head the worktree was made from always does
    if (at === -1 && continued && remoteBranch === continued) {
      throw new PublishError(
        `${remoteBranch} on GitHub is at ${remote}, which this branch doesn't build on (as after an amend or rebase here, or a push there); a branch this agent continues is only ever fast-forwarded, so nothing was sent. Put your work back on top of it: \`git reset --soft ${remote}\` and \`git commit\` keep your files as they are in a new commit on it (when git doesn't know ${remote}, it was pushed during this run, and the next run brings it in), then publish again`,
      );
    }
    // the replay goes onto the base, so a fast-forward from a head that is neither this branch's
    // history nor on the base's is refused: it fails here, before anything is held or sent
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
    if (at === -1 && baseline !== baseWorkflows) {
      if (rewritten) {
        // GitHub's head's workflows are the branch's own changes where they differ from those of
        // the base it forks from; where they don't, they are an older base's, and the rewrite sends
        // the current base's instead
        const fork = await forkPoint(cwd, call, remote, mergeBase);
        if (fork === undefined || (await workflowsOf(fork)) !== baseline) {
          throw new PublishError(
            `${remoteBranch} on GitHub holds workflow changes under ${WORKFLOWS_DIR}/ that publishing this branch's rewritten history (as after ${base} moved on) would drop, so nothing was sent; merge the pull request as it is, or have someone rebase ${remoteBranch} onto ${base}, or merge ${base} into it, from outside the sandbox, keeping those workflow changes, and then publish again`,
          );
        }
      }
      // a rewrite, or a fast-forward from a head on the base's history, sends the base's workflows
      baseline = baseWorkflows;
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
      // the merge goes out with the baseline's workflows, so one whose own differ, merging a parent
      // whose differ too, would make that parent an ancestor without its workflow changes, which the
      // pull request then shows as undone; a merge whose own are the baseline's is sent as it is
      if (
        (await workflowsOf(other)) !== baseline &&
        (await workflowsOf(sha)) !== baseline
      ) {
        throw new PublishError(
          `commit ${sha} on ${localBranch} merges ${other}, and the merge's ${WORKFLOWS_DIR}/ differs from the one publish can send, which is the one GitHub already has since the connector can't write there: sent, it would make ${other} an ancestor without its workflow changes, so the pull request would show them as undone, and nothing was sent; have someone merge ${base} into ${remoteBranch} from outside the sandbox, then publish again${continued && remoteBranch === continued ? "" : ", or rebase instead of merging"}`,
        );
      }
    }
  }

  // the connector can't write under .github/workflows/, so every commit is sent with the baseline's
  // version of it; with no commit differing there, nothing differs from a plain publish
  const holding = (await Promise.all(known.slice(start).map(workflowsOf))).some(
    (id) => id !== baseline,
  );
  const richTrees = new Map<string, string>();
  const shownTree = async (sha: string) => {
    const raw = await treeOf(sha);
    if (!holding) return raw;
    let tree = richTrees.get(sha);
    if (tree === undefined) {
      tree = await swapWorkflows(cwd, (t) => lsTree(cwd, t), raw, baseline);
      richTrees.set(sha, tree);
    }
    return tree;
  };
  const skyDir = join(
    (await git(cwd, "rev-parse", "--absolute-git-dir")).trim(),
    "sky",
  );
  const patchPath = join(skyDir, "held-workflows.patch");
  let held: PublishResult["held"];
  const tip = commits[commits.length - 1] as string;
  // what the tip's workflows differ from the baseline's by, at the paths the branch changed: a path
  // only GitHub's head changed was pushed there by someone else, and is kept, not reverted
  const branchPaths =
    (await workflowsOf(tip)) === baseline
      ? []
      : (
          await git(
            cwd,
            "diff",
            "--no-renames",
            "--name-only",
            "-z",
            mergeBase,
            tip,
            "--",
            WORKFLOWS_DIR,
          )
        )
          .split("\0")
          .filter(Boolean)
          .map((path) => `:(literal)${path}`);
  // empty where the branch's workflow changes cancel out
  if (branchPaths.length > 0) {
    if (baseline) await fetchTree(cwd, call, baseline);
    const sent = await shownTree(tip);
    const tipTree = await treeOf(tip);
    // empty where GitHub's head already has the branch's versions
    const files = await heldFiles(cwd, sent, tipTree, branchPaths);
    if (files.length > 0) {
      const patch = (
        await gitBytes(
          cwd,
          "diff",
          "--binary",
          "--full-index",
          "-M",
          sent,
          tipTree,
          "--",
          ...branchPaths,
        )
      ).toString("utf8");
      await mkdir(skyDir, { recursive: true });
      await writeFile(patchPath, patch);
      held = { files, patch, patchPath };
    }
  }
  // a patch an earlier publish left must not outlive the changes it held
  if (!held) await rm(patchPath, { force: true });

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

  let from = known[start] ?? mergeBase;
  // a tree GitHub has: the commit replay resumes from, or the base head
  let tree = resumeTree ?? (await treeOf(mergeBase));
  let fromShown = await shownTree(from);
  let fromRaw = await treeOf(from);
  const blobs = new Map<string, string>();
  for (const sha of known.slice(start + 1)) {
    const shown = await shownTree(sha);
    const raw = await treeOf(sha);
    const entries: TreeEntry[] = [];
    for (const change of await changes(cwd, fromShown, shown)) {
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
    const wasHeld = entries.length === 0 && raw !== fromRaw;
    fromShown = shown;
    fromRaw = raw;
    from = sha;
    // a commit that only touched held-back workflows has nothing left to send; a merge still has
    // its other parents
    if (wasHeld && merged.length === 0) continue;
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
  if (parent === mergeBase && remote === null && held) {
    throw new PublishError(
      `every change on ${localBranch} is under ${WORKFLOWS_DIR}/, which the connector can't write, so nothing was sent; the changes are held in ${held.patchPath}: apply them from outside the sandbox (${held.files.join(", ")})`,
    );
  }

  // GitHub refuses a ref update that changes .github/workflows/ when the token lacks the `workflow`
  // scope, with a 404 or 403 that reads, bare, as lost repo access; this publish's object writes
  // have succeeded by now, so the update's workflow change is named as the likely cause. What is
  // sent carries the baseline's workflows, so only a baseline moved off GitHub's side changes any
  const writeRef = (method: string, path: string, body: unknown) =>
    call(method, path, body).catch(async (error: unknown) => {
      if (
        !(error instanceof GatewayError) ||
        error.rateLimited ||
        (error.status !== 404 && error.status !== 403)
      ) {
        throw error;
      }
      // unnamed, GitHub's own error stands
      const files = await workflowPathsBetween(
        cwd,
        theirWorkflows,
        baseline,
      ).catch((): string[] => []);
      if (files.length === 0) throw error;
      throw new PublishError(
        `workflow_files_blocked: GitHub refused to update ${remoteBranch} to commits that change ${files.join(", ")}, and that update needs the \`workflow\` scope, which Sky's GitHub connection may lack. Publish the rest without them (move the workflow change to its own commit and drop it from this branch), and have the PM commit the workflow change (${error.message})`,
      );
    });

  if (remote === null) {
    await writeRef("POST", "/git/refs", {
      ref: `refs/heads/${remoteBranch}`,
      sha: parent,
    });
  } else if (rewritten) {
    // GitHub's ref update takes no expected old value: it is read again just before the forced
    // update, so a write since the lookup above isn't overwritten
    const now = await call<{ object: { sha: string } }>(
      "GET",
      `/git/ref/${refPath}`,
    );
    if (now.object.sha !== remote) {
      throw new PublishError(
        `${remoteBranch} moved on GitHub to ${now.object.sha} while this publish ran; nothing was overwritten, publish again`,
      );
    }
    await writeRef("PATCH", `/git/refs/${refPath}`, {
      sha: parent,
      force: true,
    });
  } else if (remote !== parent) {
    await writeRef("PATCH", `/git/refs/${refPath}`, {
      sha: parent,
      force: false,
    }).catch((error: unknown) => {
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
      ...(held && { held }),
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
  );
  return {
    branch: remoteBranch,
    base,
    sha: parent,
    created: true,
    updated: false,
    pullRequest: { number: pull.number, url: pull.html_url },
    ...(held && { held }),
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
 * stdout, then any held-back workflow patch between `HELD_PATCH_BEGIN` and `HELD_PATCH_END`, and
 * returns the exit status, 2 for a usage or config error.
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
    });
    io.stderr(
      result.created
        ? `sky publish: opened pull request #${result.pullRequest.number}\n`
        : `sky publish: pull request #${result.pullRequest.number} was already open${result.updated ? " and updated" : ""}; ${result.branch} is now ${result.sha}\n`,
    );
    if (result.held) {
      io.stderr(
        `sky publish: held back ${result.held.files.length} change${result.held.files.length === 1 ? "" : "s"} under ${WORKFLOWS_DIR}/, which this sandbox's token can't push: ${result.held.files.join(", ")}\n` +
          `sky publish: the patch is at ${result.held.patchPath}; the PM must push these files from outside the sandbox (\`git apply\` it on the branch)\n`,
      );
    }
    io.stdout(`${result.pullRequest.url}\n`);
    if (result.held) {
      io.stdout(
        `${HELD_PATCH_BEGIN}\n${result.held.patch}${result.held.patch.endsWith("\n") ? "" : "\n"}${HELD_PATCH_END}\n`,
      );
    }
    return 0;
  } catch (error) {
    io.stderr(
      `sky publish: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}
