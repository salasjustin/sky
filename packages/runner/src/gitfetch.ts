import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { git, messageOf, type Progress } from "./store.js";

/** Set to `0` to skip the anonymous git attempt and pull through the connector, as for a private repo. */
export const ANON_GIT_ENV = "SKY_ANON_GIT";

export const anonGitEnabled = (env: NodeJS.ProcessEnv): boolean =>
  env[ANON_GIT_ENV] !== "0";

// a public repo answers at once; a stalled network falls back to the connector rather than holding the run
const LS_REMOTE_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 300_000;

const originUrl = (repo: string) => `https://github.com/${repo}.git`;

/** Why an anonymous git step failed, on one line. */
export const whyFailed = (error: unknown): string =>
  messageOf(error).replace(/\s+/g, " ").trim();

/**
 * git in `dir` with no way to ask for a credential: no terminal prompt, no askpass program, and an
 * empty credential helper that clears the machine's own list. A repo that needs a login fails
 * at once instead of waiting for one.
 */
function anonymousGit(dir: string) {
  const base = git(dir);
  const held = Number(process.env.GIT_CONFIG_COUNT) || 0;
  const env = {
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "true",
    SSH_ASKPASS: "true",
    GCM_INTERACTIVE: "never",
    GIT_CONFIG_COUNT: String(held + 1),
    [`GIT_CONFIG_KEY_${held}`]: "credential.helper",
    [`GIT_CONFIG_VALUE_${held}`]: "",
  };
  return (args: string[], timeoutMs: number): Promise<string> =>
    base(args, { env, timeoutMs });
}

/** Fetches `branch` into `refs/remotes/origin/<branch>` of the clone in `repoDir`, history included. */
export async function fetchOverGit(options: {
  repoDir: string;
  branch: string;
}): Promise<string> {
  const g = anonymousGit(options.repoDir);
  const ref = `refs/remotes/origin/${options.branch}`;
  await g(
    [
      "fetch",
      "--quiet",
      "--no-tags",
      "origin",
      `+refs/heads/${options.branch}:${ref}`,
    ],
    FETCH_TIMEOUT_MS,
  );
  return g(["rev-parse", "--verify", `${ref}^{commit}`], FETCH_TIMEOUT_MS);
}

/**
 * Clones `repo` into `dir` over git without a credential: its default branch with full history,
 * checked out, with `origin/HEAD` naming it. Only a public repo succeeds. A failure removes what
 * this run created.
 */
export async function cloneOverGit(options: {
  repo: string;
  dir: string;
  progress?: Progress;
}): Promise<{ branch: string; sha: string }> {
  const dir = resolve(options.dir);
  const created = await mkdir(dir, { recursive: true });
  const g = anonymousGit(dir);
  const plain = git(dir);
  try {
    await plain(["init", "-q"]);
    await plain(["config", "remote.origin.url", originUrl(options.repo)]);
    await plain([
      "config",
      "--replace-all",
      "remote.origin.fetch",
      "+refs/heads/*:refs/remotes/origin/*",
    ]);
    const head = await g(
      ["ls-remote", "--symref", "origin", "HEAD"],
      LS_REMOTE_TIMEOUT_MS,
    );
    const branch = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(head)?.[1];
    if (!branch) {
      throw new Error(
        `${options.repo} is empty: its default branch has no commit to check out; push one first`,
      );
    }
    options.progress?.(`repo pull: fetching ${options.repo} over git`);
    const sha = await fetchOverGit({ repoDir: dir, branch });
    await plain([
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      `refs/remotes/origin/${branch}`,
    ]);
    await plain(["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
    await plain(["update-ref", `refs/heads/${branch}`, sha]);
    await plain(["config", `branch.${branch}.remote`, "origin"]);
    await plain(["config", `branch.${branch}.merge`, `refs/heads/${branch}`]);
    await plain(["reset", "--quiet", "--hard", sha]);
    return { branch, sha };
  } catch (error) {
    if (created) await rm(created, { recursive: true, force: true });
    else await rm(`${dir}/.git`, { recursive: true, force: true });
    throw error;
  }
}
