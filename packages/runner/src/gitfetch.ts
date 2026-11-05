import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { git, messageOf, type Progress } from "./store.js";

/**
 * The env var holding a read-only GitHub token (a fine-grained token with Contents: read on the
 * one repo). When it is set the runner pulls the repo over git, which costs no REST calls.
 */
export const READ_TOKEN_ENV = "GITHUB_READ_TOKEN";

export const readToken = (env: NodeJS.ProcessEnv): string | undefined =>
  env[READ_TOKEN_ENV]?.trim() || undefined;

const originUrl = (repo: string) => `https://github.com/${repo}.git`;

const basic = (token: string) =>
  Buffer.from(`x-access-token:${token}`).toString("base64");

/** Text with the token, and the header form git would echo it in, taken out. */
export const scrub = (text: string, token: string): string =>
  text.split(token).join("***").split(basic(token)).join("***");

/** Why a git step failed, on one line and without the token. */
export const whyFailed = (error: unknown, token: string): string =>
  scrub(messageOf(error), token).replace(/\s+/g, " ").trim();

/**
 * git in `dir` with the token as an `http.extraHeader` for github.com alone, set through git's
 * environment config: the token reaches neither argv (`ps`), `.git/config`, nor a remote URL. A
 * failure's message is scrubbed of it.
 */
export function gitWithToken(dir: string, token: string) {
  const base = git(dir);
  // after any config the caller's env already carries, which GIT_CONFIG_COUNT would otherwise replace
  const held = Number(process.env.GIT_CONFIG_COUNT) || 0;
  const env = {
    GIT_CONFIG_COUNT: String(held + 1),
    [`GIT_CONFIG_KEY_${held}`]: "http.https://github.com/.extraheader",
    [`GIT_CONFIG_VALUE_${held}`]: `Authorization: Basic ${basic(token)}`,
  };
  return async (args: string[]): Promise<string> => {
    try {
      return await base(args, { env });
    } catch (error) {
      throw new Error(scrub(messageOf(error), token));
    }
  };
}

/** Fetches `branch` into `refs/remotes/origin/<branch>` of the clone in `repoDir`, history included. */
export async function fetchOverGit(options: {
  repoDir: string;
  token: string;
  branch: string;
}): Promise<string> {
  const g = gitWithToken(options.repoDir, options.token);
  const ref = `refs/remotes/origin/${options.branch}`;
  await g([
    "fetch",
    "--quiet",
    "--no-tags",
    "origin",
    `+refs/heads/${options.branch}:${ref}`,
  ]);
  return g(["rev-parse", "--verify", `${ref}^{commit}`]);
}

/**
 * Clones `repo` into `dir` over git: its default branch with full history, checked out, with
 * `origin/HEAD` naming it. The remote URL is the plain one; a failure removes what this run created.
 */
export async function cloneOverGit(options: {
  repo: string;
  dir: string;
  token: string;
  progress?: Progress;
}): Promise<{ branch: string; sha: string }> {
  const dir = resolve(options.dir);
  const created = await mkdir(dir, { recursive: true });
  const g = gitWithToken(dir, options.token);
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
    const head = await g(["ls-remote", "--symref", "origin", "HEAD"]);
    const branch = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(head)?.[1];
    if (!branch) {
      throw new Error(
        `${options.repo} is empty: its default branch has no commit to check out; push one first`,
      );
    }
    options.progress?.(`repo pull: fetching ${options.repo} over git`);
    const sha = await fetchOverGit({
      repoDir: dir,
      token: options.token,
      branch,
    });
    const remoteRef = `refs/remotes/origin/${branch}`;
    await plain(["symbolic-ref", "refs/remotes/origin/HEAD", remoteRef]);
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
