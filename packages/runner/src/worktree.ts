import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  type AgentId,
  agentBranch,
  type Rollup,
  type RunRollup,
} from "@sky/shared";

const run = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", args, {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

/** The agent's worktree on `claude/<agentId>`, created from `from` (the clone's `origin/HEAD` by default) on first use. */
export async function ensureWorktree(options: {
  repoDir: string;
  worktreesDir: string;
  agentId: AgentId;
  from?: string;
}): Promise<string> {
  const branch = agentBranch(options.agentId);
  const path = join(options.worktreesDir, options.agentId);
  if (existsSync(path)) {
    const head = await git(path, "rev-parse", "--abbrev-ref", "HEAD");
    if (head !== branch) {
      throw new Error(`worktree ${path} is on ${head}, expected ${branch}`);
    }
    return path;
  }
  // forget a worktree whose directory was deleted, so its branch can be checked out again
  await git(options.repoDir, "worktree", "prune");
  const branchExists = await git(options.repoDir, "branch", "--list", branch);
  if (branchExists) {
    await git(options.repoDir, "worktree", "add", path, branch);
  } else {
    await git(
      options.repoDir,
      "worktree",
      "add",
      "-b",
      branch,
      path,
      options.from ?? "origin/HEAD",
    );
  }
  return path;
}

/** Commits everything in the worktree; false when there was nothing to commit. Never pushes. */
export async function commitAll(options: {
  cwd: string;
  agentId: string;
  runId: string;
}): Promise<boolean> {
  await git(options.cwd, "add", "--all");
  if (!(await git(options.cwd, "status", "--porcelain"))) return false;
  await git(
    options.cwd,
    "-c",
    "user.name=sky-agent",
    "-c",
    "user.email=agent@sky.local",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "--no-verify",
    "-m",
    `agent ${options.agentId} run ${options.runId}`,
  );
  return true;
}

export async function headSha(cwd: string): Promise<string> {
  return git(cwd, "rev-parse", "HEAD");
}

const MAX_COMMITS = 50;
const MAX_SUBJECT_CHARS = 200;

/** The branch's commits and diffstat at HEAD: since `since` for the run, and since the merge-base with `origin/HEAD` for the whole branch. */
export async function diffRollup(options: {
  cwd: string;
  since: string;
}): Promise<RunRollup> {
  const { cwd } = options;
  const base = await git(cwd, "merge-base", "origin/HEAD", "HEAD");
  const [run, cumulative] = await Promise.all([
    rollupSince(cwd, options.since),
    rollupSince(cwd, base),
  ]);
  return { base, run, cumulative };
}

async function rollupSince(cwd: string, from: string): Promise<Rollup> {
  const [log, numstat] = await Promise.all([
    git(
      cwd,
      "log",
      `--max-count=${MAX_COMMITS}`,
      "--format=%H%x00%s",
      `${from}..HEAD`,
    ),
    git(cwd, "diff", "--numstat", from, "HEAD"),
  ]);
  const commits = lines(log).map((line) => {
    const [sha = "", subject = ""] = line.split("\0");
    return {
      sha,
      subject:
        subject.length > MAX_SUBJECT_CHARS
          ? `${subject.slice(0, MAX_SUBJECT_CHARS - 1)}…`
          : subject,
    };
  });
  let added = 0;
  let removed = 0;
  const files = lines(numstat);
  for (const line of files) {
    // a binary file reads `-\t-\t<path>`: Number("-") is NaN, counted as 0
    const [a, r] = line.split("\t");
    added += Number(a) || 0;
    removed += Number(r) || 0;
  }
  return { commits, files: files.length, added, removed };
}

const lines = (output: string) => (output ? output.split("\n") : []);
