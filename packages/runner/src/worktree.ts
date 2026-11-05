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

/** The agent's worktree on `claude/<agentId>`, created from `from` (the clone's `origin/HEAD` by default) on first use; an existing one is returned as it stands, `adoptAgentBranch` dealing with one on another branch. */
export async function ensureWorktree(options: {
  repoDir: string;
  worktreesDir: string;
  agentId: AgentId;
  from?: string;
}): Promise<string> {
  const branch = agentBranch(options.agentId);
  const path = join(options.worktreesDir, options.agentId);
  if (existsSync(path)) return path;
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

export type BranchAdoption = {
  /** Whether the worktree is on the agent's branch afterwards. */
  onBranch: boolean;
  /** The branch the worktree was on, when the agent's branch was moved to it. */
  from?: string;
  /** For the agent's prompt; absent when the worktree was already on its branch. */
  note?: string;
};

/**
 * The agent may have switched its worktree to another local branch. When `branch` is an ancestor
 * of that branch's commit and the tree is clean, `branch` is moved forward to that commit and
 * checked out, so nothing is lost; otherwise the worktree is left as it is and the note says why.
 * Nothing is reset, forced or discarded.
 */
export async function adoptAgentBranch(
  cwd: string,
  branch: string,
): Promise<BranchAdoption> {
  const current = await git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
  if (current === branch) return { onBranch: true };
  const where = current === "HEAD" ? "a detached HEAD" : `\`${current}\``;
  const stays = (reason: string): BranchAdoption => ({
    onBranch: false,
    note: `This worktree is on ${where}, not \`${branch}\`, and the runner left it there: ${reason}. Nothing was changed.`,
  });
  const tip = await git(cwd, "rev-parse", "--verify", "--quiet", branch).catch(
    () => "",
  );
  if (!tip) return stays(`\`${branch}\` doesn't exist`);
  for (const marker of [
    "rebase-merge",
    "rebase-apply",
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
  ]) {
    // a linked worktree keeps these outside its own directory
    const file = await git(
      cwd,
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      marker,
    );
    if (existsSync(file)) {
      return stays("a rebase, merge, cherry-pick or revert is in progress");
    }
  }
  const head = await git(cwd, "rev-parse", "HEAD");
  const isAncestor = (a: string, b: string) =>
    git(cwd, "merge-base", "--is-ancestor", a, b).then(
      () => true,
      () => false,
    );
  const forward = await isAncestor(tip, head);
  // HEAD at or behind the agent's branch (a commit checked out to look at): switching loses nothing
  const behind = !forward && (await isAncestor(head, tip));
  if (!forward && !behind) {
    return stays(
      `\`${branch}\` is not an ancestor of it (the two have diverged), so moving \`${branch}\` there would lose commits`,
    );
  }
  if (await git(cwd, "status", "--porcelain")) {
    return stays("it has uncommitted changes");
  }
  const elsewhere = (await git(cwd, "worktree", "list", "--porcelain"))
    .split("\n")
    .includes(`branch refs/heads/${branch}`);
  if (elsewhere)
    return stays(`\`${branch}\` is checked out in another worktree`);
  // compare-and-swap on the old tip: a fast-forward, never a reset
  if (forward) await git(cwd, "update-ref", `refs/heads/${branch}`, head, tip);
  try {
    await git(cwd, "switch", "--quiet", branch);
  } catch (error) {
    // put the branch back where it was
    if (forward)
      await git(cwd, "update-ref", `refs/heads/${branch}`, tip, head);
    return stays(
      `git would not switch (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (behind) {
    return {
      onBranch: true,
      note: `The runner found this worktree on ${where}, behind \`${branch}\`, and checked \`${branch}\` out; nothing was lost. Stay on \`${branch}\` from here.`,
    };
  }
  return {
    onBranch: true,
    ...(current !== "HEAD" && { from: current }),
    note: `The runner found this worktree on ${where} instead of \`${branch}\`, moved \`${branch}\` forward to its commit ${head.slice(0, 7)} and checked it out; nothing was lost. Stay on \`${branch}\` from here.`,
  };
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
