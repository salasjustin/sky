import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** `refs/sky/starts/<agentId>`: the start branch's tip when the agent's worktree was first made from it; never moved. */
export const STARTS = "refs/sky/starts/";

// under the clone's git dir, which every worktree shares and a rebuild replaces with the clone
export const PUBLISHED_DIR = "sky-published";

/** What a worktree's last `publish` sent: its head then, and the GitHub branch it went to. */
export type Published = { head: string; branch: string };

const git = async (cwd: string, ...args: string[]) =>
  (await run("git", args, { cwd })).stdout.trim();

/** The file name a local branch's record has: `%` and `/` escaped, so the shell that reads it can too. */
export const publishedFileName = (localBranch: string) =>
  localBranch.replaceAll("%", "%25").replaceAll("/", "%2F");

async function recordFile(cwd: string, localBranch: string) {
  const common = await git(cwd, "rev-parse", "--git-common-dir");
  return join(
    isAbsolute(common) ? common : resolve(cwd, common),
    PUBLISHED_DIR,
    publishedFileName(localBranch),
  );
}

/**
 * Notes that `publish` sent `head` of `localBranch` to GitHub's `branch`, for the API to compare the
 * branch's commits against when the sprite is rebuilt. Two lines, the head then the branch.
 */
export async function recordPublished(
  cwd: string,
  localBranch: string,
  { head, branch }: Published,
): Promise<void> {
  const file = await recordFile(cwd, localBranch);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, `${head}\n${branch}\n`);
}

/** The record `recordPublished` left for `localBranch`; undefined when there is none or it isn't one. */
export async function readPublished(
  cwd: string,
  localBranch: string,
): Promise<Published | undefined> {
  try {
    const text = await readFile(await recordFile(cwd, localBranch), "utf8");
    const [head, branch] = text.split("\n");
    return head && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(head) && branch
      ? { head, branch }
      : undefined;
  } catch {
    return undefined;
  }
}
