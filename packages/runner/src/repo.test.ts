import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { server } from "../../../test/msw.js";
import { DEFAULT_GATEWAY_URL, PublishError, publish } from "./publish.js";
import { pullRepo, rebuildCommit, repoPullMain } from "./repo.js";
import { git as runnerGit } from "./store.js";

const GATEWAY = "https://gateway.test/v1/gateway/github";
const CONNECTOR = "conn_123";
const REPO = `${GATEWAY}/${CONNECTOR}/repos/acme/private`;

// a host with commit.gpgsign=true would sign every fixture commit and turn the file red
const NO_SIGN = ["-c", "commit.gpgsign=false"];

const initRepo = (dir: string) =>
  execFileSync("git", [...NO_SIGN, "init", "-q", "-b", "trunk", dir]);

// rebases and merges in the fixtures commit, which needs an identity a CI runner doesn't configure
const IDENTITY = {
  GIT_AUTHOR_NAME: "Ada L",
  GIT_AUTHOR_EMAIL: "ada@example.com",
  GIT_COMMITTER_NAME: "Ada L",
  GIT_COMMITTER_EMAIL: "ada@example.com",
  GIT_EDITOR: "true",
};
const gitEnv = { ...process.env, ...IDENTITY };

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv }).trim();

let root: string;
let remote: string;
let headSha: string;

const commitAs = (cwd: string, message: string, date: string) => {
  git(cwd, "add", "--all");
  execFileSync(
    "git",
    [
      ...NO_SIGN,
      "-c",
      "user.name=Ada L",
      "-c",
      "user.email=ada@example.com",
      "commit",
      "-qm",
      message,
    ],
    {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      },
    },
  );
  return git(cwd, "rev-parse", "HEAD");
};

/** A private repo's history on a bare "GitHub": zones that aren't UTC, a script, a symlink, a subdir. */
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "runner-repo-"));
  remote = join(root, "remote.git");
  const seed = join(root, "seed");
  initRepo(seed);
  writeFileSync(join(seed, "README.md"), "private\n");
  commitAs(seed, "first", "2026-10-01T09:00:00+05:30");
  mkdirSync(join(seed, "src/deep"), { recursive: true });
  writeFileSync(join(seed, "src/deep/a b.ts"), "export {};\n");
  writeFileSync(join(seed, "run.sh"), "#!/bin/sh\n");
  chmodSync(join(seed, "run.sh"), 0o755);
  symlinkSync("README.md", join(seed, "link"));
  headSha = commitAs(
    seed,
    "second\n\nwith a body",
    "2026-10-02T23:15:00-08:00",
  );
  execFileSync("git", ["clone", "-q", "--bare", seed, remote]);
});
afterEach(() => {
  // githubIs() stubs GIT_CONFIG_GLOBAL with a file under `root`, which is removed here
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const bare = (...args: string[]) => git(remote, ...args);

/** The fields GitHub's commit API gives: dates in UTC, the message less its final newline. */
const apiCommit = (sha: string) => {
  const person = (who: "author" | "committer") => {
    const [name = "", email = "", at = "0"] = bare(
      "show",
      "-s",
      `--format=%${who === "author" ? "a" : "c"}n%x00%${who === "author" ? "a" : "c"}e%x00%${who === "author" ? "a" : "c"}d`,
      "--date=unix",
      sha,
    ).split("\0");
    return {
      name,
      email,
      date: new Date(Number(at) * 1000).toISOString().replace(".000Z", "Z"),
    };
  };
  return {
    sha,
    tree: { sha: bare("rev-parse", `${sha}^{tree}`) },
    parents: bare("rev-list", "--parents", "-n1", sha)
      .split(" ")
      .slice(1)
      .map((p) => ({ sha: p })),
    author: person("author"),
    committer: person("committer"),
    message: bare("show", "-s", "--format=%B", sha).replace(/\n+$/, ""),
    verification: { verified: false, signature: null, payload: null },
  };
};

/** GitHub's REST API for the private repo, reachable only through the connector's gateway. */
function fakeGitHub(base = REPO) {
  const seen = {
    commits: [] as { parents: string[]; tree: string; message: string }[],
    refs: [] as { ref: string; sha: string }[],
  };
  server.use(
    http.get(base, () => HttpResponse.json({ default_branch: "trunk" })),
    http.get(`${base}/git/ref/heads/trunk`, () =>
      HttpResponse.json({ object: { sha: bare("rev-parse", "trunk") } }),
    ),
    http.get(`${base}/git/commits/:sha`, ({ params }) =>
      HttpResponse.json(apiCommit(String(params.sha))),
    ),
    http.get(`${base}/git/trees/:sha`, ({ params }) =>
      HttpResponse.json({
        truncated: false,
        tree: bare("ls-tree", "-r", "-z", String(params.sha))
          .split("\0")
          .filter(Boolean)
          .map((line) => {
            const [meta = "", path = ""] = line.split("\t");
            const [mode, type, sha] = meta.split(" ");
            return { mode, type, sha, path };
          }),
      }),
    ),
    http.get(`${base}/git/blobs/:sha`, ({ params }) => {
      // a blob GitHub lacks is a 404, which is how publish learns to upload it
      let content: Buffer;
      try {
        content = execFileSync(
          "git",
          ["cat-file", "blob", String(params.sha)],
          {
            cwd: remote,
            stdio: "pipe",
          },
        );
      } catch {
        return HttpResponse.json({ message: "Not Found" }, { status: 404 });
      }
      return HttpResponse.json({
        encoding: "base64",
        content: content.toString("base64"),
      });
    }),
    http.get(`${base}/git/ref/*`, () =>
      HttpResponse.json({ message: "Not Found" }, { status: 404 }),
    ),
    // publish: its blobs are new to GitHub, its branch doesn't exist, no pull request is open
    http.post(`${base}/git/blobs`, () =>
      HttpResponse.json({ sha: "b".repeat(40) }, { status: 201 }),
    ),
    http.post(`${base}/git/trees`, () =>
      HttpResponse.json({ sha: "c".repeat(40) }, { status: 201 }),
    ),
    http.post(`${base}/git/commits`, async ({ request }) => {
      seen.commits.push((await request.json()) as never);
      return HttpResponse.json({ sha: "d".repeat(40) }, { status: 201 });
    }),
    http.post(`${base}/git/refs`, async ({ request }) => {
      seen.refs.push((await request.json()) as never);
      return HttpResponse.json({}, { status: 201 });
    }),
    http.get(`${base}/pulls`, () => HttpResponse.json([])),
    http.post(`${base}/pulls`, () =>
      HttpResponse.json(
        { number: 7, html_url: "https://github.com/acme/private/pull/7" },
        { status: 201 },
      ),
    ),
  );
  return seen;
}

const pull = (dir: string) =>
  pullRepo({
    repo: "acme/private",
    dir,
    gatewayUrl: GATEWAY,
    connectorId: CONNECTOR,
  });

test("the checkout holds GitHub's own commit, with origin/HEAD and the default branch at it, and every file as committed", async () => {
  fakeGitHub();
  const dir = join(root, "repo");
  expect(await pull(dir)).toEqual({ branch: "trunk", sha: headSha });
  expect(git(dir, "rev-parse", "HEAD")).toBe(headSha);
  expect(git(dir, "rev-parse", "origin/HEAD")).toBe(headSha);
  expect(git(dir, "rev-parse", "refs/remotes/origin/trunk")).toBe(headSha);
  expect(git(dir, "rev-parse", "--abbrev-ref", "origin/HEAD")).toBe(
    "origin/trunk",
  );
  expect(git(dir, "symbolic-ref", "--short", "HEAD")).toBe("trunk");
  expect(git(dir, "remote", "get-url", "origin")).toBe(
    "https://github.com/acme/private.git",
  );
  expect(git(dir, "status", "--porcelain")).toBe("");
  expect(
    spawnSync("git", ["fsck", "--strict", "--no-dangling", "--no-progress"], {
      cwd: dir,
      encoding: "utf8",
    }),
  ).toMatchObject({ status: 0, stdout: "", stderr: "" });
  expect(readFileSync(join(dir, "src/deep/a b.ts"), "utf8")).toBe(
    "export {};\n",
  );
  expect(lstatSync(join(dir, "run.sh")).mode & 0o111).not.toBe(0);
  expect(readlinkSync(join(dir, "link"))).toBe("README.md");
  expect(git(dir, "log", "-1", "--format=%an|%aI|%cI|%B")).toBe(
    git(remote, "log", "-1", "--format=%an|%aI|%cI|%B", "trunk"),
  );
});

test("a worktree branches from origin/HEAD as the runner's does, on GitHub's commit", async () => {
  fakeGitHub();
  const dir = join(root, "repo");
  await pull(dir);
  const tree = join(root, "wt");
  git(dir, "worktree", "add", "-b", "claude/agt_1", tree, "origin/HEAD");
  expect(git(tree, "rev-parse", "HEAD")).toBe(headSha);
  expect(git(tree, "merge-base", "origin/HEAD", "HEAD")).toBe(headSha);
});

test("publishing a branch from the checkout builds its first commit on GitHub's real commit, so the ref is created off the real history", async () => {
  const seen = fakeGitHub();
  const dir = join(root, "repo");
  await pull(dir);
  const tree = join(root, "wt");
  git(dir, "worktree", "add", "-b", "claude/agt_1", tree, "origin/HEAD");
  writeFileSync(join(tree, "new.txt"), "agent work\n");
  commitAs(tree, "agent change", "2026-10-31T10:00:00+00:00");
  const result = await publish({
    cwd: tree,
    gatewayUrl: GATEWAY,
    connectorId: CONNECTOR,
    title: "Agent change",
  });
  expect(result).toMatchObject({ base: "trunk", created: true });
  expect(seen.commits).toHaveLength(1);
  expect(seen.commits[0]?.parents).toEqual([headSha]);
  expect(seen.commits[0]?.tree).toBe("c".repeat(40));
  expect(seen.refs).toEqual([
    { ref: "refs/heads/claude/agt_1", sha: "d".repeat(40) },
  ]);
});

/** A commit on GitHub's default branch that the sandbox's clone doesn't have. */
const advanceRemote = (file: string, content: string) => {
  const seed = join(root, "seed");
  writeFileSync(join(seed, file), content);
  const sha = commitAs(seed, `edit ${file}`, "2026-10-31T08:00:00+00:00");
  git(seed, "push", "-q", remote, "trunk");
  return sha;
};

const agentWorktree = async () => {
  const dir = join(root, "repo");
  await pull(dir);
  const tree = join(root, "wt");
  git(dir, "worktree", "add", "-b", "claude/agt_1", tree, "origin/HEAD");
  return { dir, tree };
};

const publishFrom = (tree: string) =>
  publish({
    cwd: tree,
    gatewayUrl: GATEWAY,
    connectorId: CONNECTOR,
    title: "Agent change",
  });

test("a stale clone publishes on GitHub's current head: it is fetched over REST and the agent's commits are rebased onto it", async () => {
  const seen = fakeGitHub();
  const { dir, tree } = await agentWorktree();
  writeFileSync(join(tree, "new.txt"), "agent work\n");
  const mine = commitAs(tree, "agent change", "2026-10-31T10:00:00+00:00");
  const author = git(tree, "log", "-1", "--format=%an <%ae> %aI|%s", mine);
  const fresh = advanceRemote("other.txt", "someone else\n");

  await publishFrom(tree);

  expect(seen.commits).toHaveLength(1);
  expect(seen.commits[0]?.parents).toEqual([fresh]);
  expect(seen.refs).toEqual([
    { ref: "refs/heads/claude/agt_1", sha: "d".repeat(40) },
  ]);
  // every agent's worktree reads origin/HEAD, so one agent's refresh leaves it alone
  expect(git(dir, "rev-parse", "origin/HEAD")).toBe(headSha);
  expect(git(tree, "rev-parse", "HEAD~1")).toBe(fresh);
  expect(git(tree, "log", "-1", "--format=%an <%ae> %aI|%s")).toBe(author);
  expect(readFileSync(join(tree, "other.txt"), "utf8")).toBe("someone else\n");
  expect(readFileSync(join(tree, "new.txt"), "utf8")).toBe("agent work\n");
  expect(
    spawnSync("git", ["fsck", "--no-dangling", "--no-progress"], {
      cwd: tree,
      encoding: "utf8",
    }).status,
  ).toBe(0);
});

test("a base that moved onto a change the agent also made fails with a clear error, sends nothing, and leaves the branch as it was", async () => {
  const seen = fakeGitHub();
  const { dir, tree } = await agentWorktree();
  writeFileSync(join(tree, "README.md"), "agent's line\n");
  const mine = commitAs(tree, "agent change", "2026-10-31T10:00:00+00:00");
  advanceRemote("README.md", "someone else's line\n");

  await expect(publishFrom(tree)).rejects.toThrow(
    /trunk moved on GitHub to [0-9a-f]{40}, and this branch's commits don't rebase onto it cleanly/,
  );

  expect(seen.commits).toEqual([]);
  expect(seen.refs).toEqual([]);
  expect(git(tree, "rev-parse", "HEAD")).toBe(mine);
  expect(git(tree, "status", "--porcelain")).toBe("");
  expect(
    existsSync(
      join(git(tree, "rev-parse", "--absolute-git-dir"), "rebase-merge"),
    ),
  ).toBe(false);
  expect(git(dir, "rev-parse", "origin/HEAD")).toBe(headSha);
});

test("a first publish with no title after the base moved is refused before the clone fetches or rebases anything", async () => {
  fakeGitHub();
  const { tree } = await agentWorktree();
  writeFileSync(join(tree, "new.txt"), "agent work\n");
  const mine = commitAs(tree, "agent change", "2026-10-31T10:00:00+00:00");
  const fresh = advanceRemote("other.txt", "someone else\n");

  await expect(
    publish({ cwd: tree, gatewayUrl: GATEWAY, connectorId: CONNECTOR }),
  ).rejects.toThrow("a title is needed to open the pull request");

  expect(git(tree, "rev-parse", "HEAD")).toBe(mine);
  expect(
    spawnSync("git", ["cat-file", "-e", fresh], { cwd: tree }).status,
  ).not.toBe(0);
  expect(
    spawnSync("git", ["for-each-ref", "refs/sky"], {
      cwd: tree,
      encoding: "utf8",
    }).stdout,
  ).toBe("");
});

test("a branch whose every change already landed on the base is refused before any branch or PR is created", async () => {
  const seen = fakeGitHub();
  const opened: unknown[] = [];
  server.use(
    http.post(`${REPO}/pulls`, async ({ request }) => {
      opened.push(await request.json());
      return HttpResponse.json({}, { status: 201 });
    }),
  );
  const { tree } = await agentWorktree();
  writeFileSync(join(tree, "other.txt"), "same change\n");
  commitAs(tree, "agent change", "2026-10-31T10:00:00+00:00");
  advanceRemote("other.txt", "same change\n");

  await expect(publishFrom(tree)).rejects.toThrow(
    /the changes on claude\/agt_1 are already on trunk/,
  );
  expect(seen.commits).toEqual([]);
  expect(seen.refs).toEqual([]);
  expect(opened).toEqual([]);
});

test("the rebase runs none of the repo's hooks and signs nothing, so neither can fail it", async () => {
  fakeGitHub();
  const { dir, tree } = await agentWorktree();
  writeFileSync(join(tree, "new.txt"), "agent work\n");
  commitAs(tree, "agent change", "2026-10-31T10:00:00+00:00");
  const fresh = advanceRemote("other.txt", "someone else\n");
  const hooks = join(root, "hooks");
  mkdirSync(hooks);
  for (const hook of ["pre-rebase", "post-checkout", "post-rewrite"]) {
    writeFileSync(join(hooks, hook), "#!/bin/sh\nexit 1\n");
    chmodSync(join(hooks, hook), 0o755);
  }
  git(dir, "config", "core.hooksPath", hooks);
  git(dir, "config", "commit.gpgsign", "true");
  git(dir, "config", "gpg.program", "false");

  await publishFrom(tree);

  expect(git(tree, "rev-parse", "HEAD~1")).toBe(fresh);
});

test("a rebase that fails other than on a conflict says what git said, not that the commits conflict", async () => {
  fakeGitHub();
  const { tree } = await agentWorktree();
  writeFileSync(join(tree, "new.txt"), "agent work\n");
  const mine = commitAs(tree, "agent change", "2026-10-31T10:00:00+00:00");
  advanceRemote("other.txt", "someone else\n");
  // another git process holding the worktree's index
  writeFileSync(
    join(git(tree, "rev-parse", "--absolute-git-dir"), "index.lock"),
    "",
  );

  const failure = publishFrom(tree);

  await expect(failure).rejects.toThrow(/index\.lock/);
  await expect(failure).rejects.not.toThrow(/rebase cleanly|mid-rebase/);
  expect(git(tree, "rev-parse", "HEAD")).toBe(mine);
  expect(rebaseInProgress(tree)).toBe(false);
});

test("a rebase git can't commit for want of a name says so in git's words", async () => {
  fakeGitHub();
  const { dir, tree } = await agentWorktree();
  writeFileSync(join(tree, "new.txt"), "agent work\n");
  const mine = commitAs(tree, "agent change", "2026-10-31T10:00:00+00:00");
  advanceRemote("other.txt", "someone else\n");
  git(dir, "config", "user.email", "agent@example.com");
  git(dir, "config", "user.name", "");
  // the committer git falls back on would otherwise come from the host's env
  for (const key of ["GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) {
    vi.stubEnv(key, undefined);
  }
  try {
    const failure = publishFrom(tree);

    await expect(failure).rejects.toThrow(/empty ident name/);
    await expect(failure).rejects.not.toThrow(/rebase cleanly|Command failed/);
    expect(git(tree, "rev-parse", "HEAD")).toBe(mine);
    expect(rebaseInProgress(tree)).toBe(false);
  } finally {
    vi.unstubAllEnvs();
  }
});

test("a rebase refused by the repo's rebase config says what git objected to", async () => {
  fakeGitHub();
  const { dir, tree } = await agentWorktree();
  writeFileSync(join(tree, "new.txt"), "agent work\n");
  const mine = commitAs(tree, "agent change", "2026-10-31T10:00:00+00:00");
  advanceRemote("other.txt", "someone else\n");
  git(dir, "config", "rebase.autoSquash", "maybe");

  const failure = publishFrom(tree);

  await expect(failure).rejects.toThrow(/rebase\.autosquash/i);
  await expect(failure).rejects.not.toThrow(/rebase cleanly|Command failed/);
  expect(git(tree, "rev-parse", "HEAD")).toBe(mine);
});

test("a conflicting rebase names the files in conflict, not the command that ran", async () => {
  fakeGitHub();
  const { tree } = await agentWorktree();
  writeFileSync(join(tree, "README.md"), "agent's line\n");
  commitAs(tree, "agent change", "2026-10-31T10:00:00+00:00");
  advanceRemote("README.md", "someone else's line\n");

  const failure = publishFrom(tree);

  await expect(failure).rejects.toThrow(
    /and publish again \(conflict in README\.md\)$/,
  );
  await expect(failure).rejects.not.toThrow(/Command failed/);
});

test("a base whose tree GitHub truncates fails the publish naming the commit, as a plain error, and leaves the branch and worktree as they were", async () => {
  fakeGitHub();
  const { tree } = await agentWorktree();
  const log = logRequests();
  writeFileSync(join(tree, "new.txt"), "agent work\n");
  const mine = commitAs(tree, "agent change", "2026-10-31T10:00:00+00:00");
  const fresh = advanceRemote("other.txt", "someone else\n");
  server.use(
    http.get(`${REPO}/git/trees/:sha`, () =>
      HttpResponse.json({ truncated: true, tree: [] }),
    ),
  );

  const failure = publishFrom(tree);

  await expect(failure).rejects.toThrow(
    `the tree of commit ${fresh} is too large to fetch`,
  );
  // not a PublishError: the CLI wrapper gets a bare Error here
  await expect(failure).rejects.not.toBeInstanceOf(PublishError);
  expect(log.filter((r) => r.startsWith("POST"))).toEqual([]);
  expect(skyRefs(tree)).toBe("");
  expect(git(tree, "rev-parse", "HEAD")).toBe(mine);
  expect(rebaseInProgress(tree)).toBe(false);
});

test("a base that advanced one commit arrives with its parent in the clone, so it is not listed as shallow", async () => {
  fakeGitHub();
  const { dir, tree } = await agentWorktree();
  writeFileSync(join(tree, "new.txt"), "agent work\n");
  commitAs(tree, "agent change", "2026-10-31T10:00:00+00:00");
  const fresh = advanceRemote("other.txt", "someone else\n");

  await publishFrom(tree);

  expect(git(tree, "rev-parse", "HEAD~1")).toBe(fresh);
  expect(git(tree, "rev-parse", `${fresh}^`)).toBe(headSha);
  expect(shallowLines(dir)).toEqual([headSha]);
});

test("two agents fetching the same base tip leave one shallow line for it", async () => {
  fakeGitHub();
  githubWrites();
  const dir = join(root, "repo");
  await pull(dir);
  advanceRemote("one.txt", "1\n");
  const fresh = advanceRemote("two.txt", "2\n");
  for (const branch of ["claude/agt_1", "claude/agt_2"]) {
    const tree = join(root, branch.replace("/", "-"));
    git(dir, "worktree", "add", "-b", branch, tree, "origin/HEAD");
    writeFileSync(join(tree, `${branch.slice(-1)}.txt`), "work\n");
    commitAs(tree, `work ${branch}`, "2026-10-31T10:00:00+00:00");
    await publishFrom(tree);
  }

  expect(shallowLines(dir).filter((line) => line === fresh)).toHaveLength(1);
});

test("a re-publish with the base where the last publish rebased onto it fetches nothing and leaves HEAD alone", async () => {
  fakeGitHub();
  githubWrites();
  const { tree } = await agentWorktree();
  writeFileSync(join(tree, "new.txt"), "agent work\n");
  commitAs(tree, "agent change", "2026-10-31T10:00:00+00:00");
  const fresh = advanceRemote("other.txt", "someone else\n");
  await publishFrom(tree);
  const rebased = git(tree, "rev-parse", "HEAD");
  const reflog = git(tree, "reflog", "HEAD", "--format=%gs");
  const log = logRequests();

  await publishFrom(tree);

  expect(rebased).not.toBe(headSha);
  expect(git(tree, "rev-parse", "HEAD~1")).toBe(fresh);
  expect(log).toContain("GET /git/ref/heads/trunk");
  expect(log.filter((r) => /\/git\/(commits|trees)\/\w{40}$/.test(r))).toEqual(
    [],
  );
  expect(git(tree, "rev-parse", "HEAD")).toBe(rebased);
  expect(git(tree, "reflog", "HEAD", "--format=%gs")).toBe(reflog);
});

const gitDirOf = (tree: string) => git(tree, "rev-parse", "--absolute-git-dir");

const rebaseInProgress = (tree: string) =>
  ["rebase-merge", "rebase-apply"].some((dir) =>
    existsSync(join(gitDirOf(tree), dir)),
  );

const skyRefs = (tree: string) => git(tree, "for-each-ref", "refs/sky");

const shallowLines = (dir: string) =>
  readFileSync(join(dir, ".git/shallow"), "utf8").split("\n").filter(Boolean);

/** The requests publish makes, as `METHOD path` under the repo, in order. */
const logRequests = () => {
  const log: string[] = [];
  server.use(
    // answers nothing: each request falls through to the handler that does
    http.all(`${REPO}/*`, ({ request }) => {
      log.push(
        `${request.method} ${new URL(request.url).pathname.split("/repos/acme/private")[1]}`,
      );
    }),
  );
  return log;
};

test("a base that hasn't moved fetches nothing, writes no ref and rebases nothing", async () => {
  const seen = fakeGitHub();
  const { tree } = await agentWorktree();
  const log = logRequests();
  writeFileSync(join(tree, "new.txt"), "agent work\n");
  const mine = commitAs(tree, "agent change", "2026-10-31T10:00:00+00:00");

  await publishFrom(tree);

  expect(log).toContain("GET /git/ref/heads/trunk");
  expect(log.filter((r) => /\/git\/(commits|trees)\//.test(r))).toEqual([]);
  expect(skyRefs(tree)).toBe("");
  expect(git(tree, "rev-parse", "HEAD")).toBe(mine);
  expect(git(tree, "reflog", "HEAD", "--format=%gs")).not.toMatch(/rebase/);
  expect(seen.commits[0]?.parents).toEqual([headSha]);
});

test("a base that moved is fetched by commit and tree, recorded in a ref and rebased onto, as the unmoved case is not", async () => {
  fakeGitHub();
  const { tree } = await agentWorktree();
  const log = logRequests();
  writeFileSync(join(tree, "new.txt"), "agent work\n");
  const mine = commitAs(tree, "agent change", "2026-10-31T10:00:00+00:00");
  const fresh = advanceRemote("other.txt", "someone else\n");

  await publishFrom(tree);

  expect(log).toContain(`GET /git/commits/${fresh}`);
  expect(log.some((r) => r.startsWith("GET /git/trees/"))).toBe(true);
  expect(skyRefs(tree)).toBe(`${fresh} commit\trefs/sky/bases/${fresh}`);
  expect(git(tree, "rev-parse", "HEAD")).not.toBe(mine);
  expect(git(tree, "reflog", "HEAD", "--format=%gs")).toMatch(/rebase/);
});

test("the base ref answering a gateway error that isn't a 404 fails the publish with that error, and leaves the branch and worktree as they were", async () => {
  const seen = fakeGitHub();
  const { tree } = await agentWorktree();
  writeFileSync(join(tree, "new.txt"), "agent work\n");
  const mine = commitAs(tree, "agent change", "2026-10-31T10:00:00+00:00");
  advanceRemote("other.txt", "someone else\n");
  server.use(
    http.get(`${REPO}/git/ref/heads/trunk`, () =>
      HttpResponse.json({ message: "Bad Gateway" }, { status: 502 }),
    ),
  );

  const failure = publishFrom(tree);

  await expect(failure).rejects.toThrow(
    /GET \/repos\/acme\/private\/git\/ref\/heads\/trunk returned 502: Bad Gateway/,
  );
  await expect(failure).rejects.not.toThrow(/doesn't exist on GitHub/);
  expect(seen.commits).toEqual([]);
  expect(seen.refs).toEqual([]);
  expect(git(tree, "rev-parse", "HEAD")).toBe(mine);
  expect(git(tree, "symbolic-ref", "HEAD")).toBe("refs/heads/claude/agt_1");
  expect(git(tree, "status", "--porcelain")).toBe("");
  expect(rebaseInProgress(tree)).toBe(false);
  expect(skyRefs(tree)).toBe("");
});

test.each([
  ["commit", "commits"],
  ["tree", "trees"],
])(
  "a failure fetching the new base's %s fails the publish naming the request, and leaves the branch, worktree and clone as they were",
  async (_, endpoint) => {
    const seen = fakeGitHub();
    const { tree } = await agentWorktree();
    writeFileSync(join(tree, "new.txt"), "agent work\n");
    const mine = commitAs(tree, "agent change", "2026-10-31T10:00:00+00:00");
    const fresh = advanceRemote("other.txt", "someone else\n");
    server.use(
      http.get(`${REPO}/git/${endpoint}/:sha`, () =>
        HttpResponse.json({ message: "Server Error" }, { status: 500 }),
      ),
    );

    await expect(publishFrom(tree)).rejects.toThrow(
      new RegExp(
        `GET /repos/acme/private/git/${endpoint}/[0-9a-f]{40}.* returned 500`,
      ),
    );

    expect(seen.commits).toEqual([]);
    expect(seen.refs).toEqual([]);
    expect(git(tree, "rev-parse", "HEAD")).toBe(mine);
    expect(git(tree, "symbolic-ref", "HEAD")).toBe("refs/heads/claude/agt_1");
    expect(git(tree, "status", "--porcelain")).toBe("");
    expect(rebaseInProgress(tree)).toBe(false);
    expect(skyRefs(tree)).toBe("");
    expect(
      spawnSync("git", ["cat-file", "-e", fresh], { cwd: tree }).status,
    ).not.toBe(0);
  },
);

test("a conflict on the second of two agent commits aborts the whole rebase: the branch stays checked out at its own head with nothing half-applied, and the fetched base is kept for a rebase by hand", async () => {
  const seen = fakeGitHub();
  const { tree } = await agentWorktree();
  writeFileSync(join(tree, "new.txt"), "agent work\n");
  commitAs(tree, "agent first", "2026-10-31T10:00:00+00:00");
  writeFileSync(join(tree, "README.md"), "agent's line\n");
  const mine = commitAs(tree, "agent second", "2026-10-31T10:30:00+00:00");
  const fresh = advanceRemote("README.md", "someone else's line\n");

  await expect(publishFrom(tree)).rejects.toThrow(
    /trunk moved on GitHub to [0-9a-f]{40}, and this branch's commits don't rebase onto it cleanly/,
  );

  expect(seen.commits).toEqual([]);
  expect(seen.refs).toEqual([]);
  expect(git(tree, "symbolic-ref", "HEAD")).toBe("refs/heads/claude/agt_1");
  expect(git(tree, "rev-parse", "HEAD")).toBe(mine);
  expect(git(tree, "rev-parse", "claude/agt_1")).toBe(mine);
  expect(git(tree, "status", "--porcelain")).toBe("");
  expect(git(tree, "ls-files", "--unmerged")).toBe("");
  expect(rebaseInProgress(tree)).toBe(false);
  expect(skyRefs(tree)).toBe(`${fresh} commit\trefs/sky/bases/${fresh}`);
  expect(readFileSync(join(tree, "README.md"), "utf8")).toBe("agent's line\n");
});

test("a conflict whose rebase --abort fails says the worktree is left mid-rebase, and why, besides the conflict", async () => {
  const seen = fakeGitHub();
  const { dir, tree } = await agentWorktree();
  writeFileSync(join(tree, "README.md"), "agent's line\n");
  commitAs(tree, "agent change", "2026-10-31T10:00:00+00:00");
  advanceRemote("README.md", "someone else's line\n");
  // stands in for another git process taking HEAD's lock while the rebase is stopped
  writeFileSync(join(dir, ".git/info/attributes"), "README.md merge=lockit\n");
  git(
    dir,
    "config",
    "merge.lockit.driver",
    'touch "$(git rev-parse --git-dir)/HEAD.lock"; exit 1',
  );

  const failure = publishFrom(tree);

  await expect(failure).rejects.toThrow(/conflict in README\.md/);
  await expect(failure).rejects.toThrow(
    /`git rebase --abort` failed too, so the worktree is left mid-rebase.*HEAD\.lock/s,
  );
  expect(seen.commits).toEqual([]);
  expect(rebaseInProgress(tree)).toBe(true);
});

test("with no git identity configured the rebase commits as sky-agent and keeps each commit's author", async () => {
  fakeGitHub();
  const { tree } = await agentWorktree();
  writeFileSync(join(tree, "new.txt"), "agent work\n");
  const mine = commitAs(tree, "agent change", "2026-10-31T10:00:00+00:00");
  const author = git(tree, "log", "-1", "--format=%an <%ae>", mine);
  advanceRemote("other.txt", "someone else\n");
  const empty = join(root, "no-home");
  mkdirSync(empty);
  vi.stubEnv("HOME", empty);
  vi.stubEnv("XDG_CONFIG_HOME", empty);
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  for (const key of [
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
    "EMAIL",
  ]) {
    vi.stubEnv(key, undefined);
  }
  try {
    // the premise: this environment has no identity, so git itself would refuse a commit
    expect(
      spawnSync("git", ["config", "user.email"], { cwd: tree }).status,
    ).not.toBe(0);

    await publishFrom(tree);

    expect(git(tree, "log", "-1", "--format=%an <%ae>|%cn <%ce>")).toBe(
      `${author}|sky-agent <agent@sky.local>`,
    );
  } finally {
    vi.unstubAllEnvs();
  }
});

test("a merge commit on the agent's branch is flattened by the rebase into its constituent commits, none of them a merge", async () => {
  const seen = fakeGitHub();
  const { tree } = await agentWorktree();
  git(tree, "checkout", "-q", "-b", "side", "origin/HEAD");
  writeFileSync(join(tree, "b.txt"), "side work\n");
  commitAs(tree, "side commit", "2026-10-31T09:00:00+00:00");
  git(tree, "checkout", "-q", "claude/agt_1");
  writeFileSync(join(tree, "a.txt"), "agent work\n");
  commitAs(tree, "agent commit", "2026-10-31T10:00:00+00:00");
  execFileSync(
    "git",
    [
      ...NO_SIGN,
      "-c",
      "user.name=Ada L",
      "-c",
      "user.email=ada@example.com",
      "merge",
      "-q",
      "--no-ff",
      "-m",
      "merge side",
      "side",
    ],
    { cwd: tree },
  );
  expect(git(tree, "rev-list", "--merges", "origin/HEAD..HEAD")).not.toBe("");
  const fresh = advanceRemote("other.txt", "someone else\n");

  await publishFrom(tree);

  expect(git(tree, "rev-list", "--merges", `${fresh}..HEAD`)).toBe("");
  expect(seen.commits.map((c) => c.message.trim()).sort()).toEqual([
    "agent commit",
    "side commit",
  ]);
  expect(seen.commits.map((c) => c.parents)).toEqual([
    [fresh],
    [expect.stringMatching(/^d{40}$/)],
  ]);
  expect(readFileSync(join(tree, "b.txt"), "utf8")).toBe("side work\n");
  expect(readFileSync(join(tree, "a.txt"), "utf8")).toBe("agent work\n");
});

/** A branch on GitHub other than the default, one commit past the default's head; the clone never saw it. */
const releaseBranch = () => {
  const seed = join(root, "seed");
  git(seed, "checkout", "-qb", "release");
  writeFileSync(join(seed, "release.txt"), "release notes\n");
  const sha = commitAs(seed, "cut release", "2026-10-31T07:00:00+00:00");
  git(seed, "push", "-q", remote, "release");
  git(seed, "checkout", "-q", "trunk");
  server.use(
    http.get(`${REPO}/git/ref/heads/release`, () =>
      HttpResponse.json({ object: { sha } }),
    ),
  );
  return sha;
};

test("--base naming a branch the clone has no ref for publishes onto GitHub's head of it", async () => {
  const seen = fakeGitHub();
  const opened: unknown[] = [];
  server.use(
    http.post(`${REPO}/pulls`, async ({ request }) => {
      opened.push(await request.json());
      return HttpResponse.json(
        { number: 7, html_url: "https://github.com/acme/private/pull/7" },
        { status: 201 },
      );
    }),
  );
  const { tree } = await agentWorktree();
  writeFileSync(join(tree, "new.txt"), "agent work\n");
  commitAs(tree, "agent change", "2026-10-31T10:00:00+00:00");
  const release = releaseBranch();

  const result = await publish({
    cwd: tree,
    gatewayUrl: GATEWAY,
    connectorId: CONNECTOR,
    title: "Agent change",
    base: "release",
  });

  expect(result).toMatchObject({ base: "release", created: true });
  expect(seen.commits).toHaveLength(1);
  expect(seen.commits[0]?.parents).toEqual([release]);
  expect(opened).toEqual([
    expect.objectContaining({ head: "claude/agt_1", base: "release" }),
  ]);
  expect(git(tree, "rev-parse", "HEAD~1")).toBe(release);
});

test("--base naming a branch GitHub doesn't have fails saying so, and sends nothing", async () => {
  const seen = fakeGitHub();
  const { tree } = await agentWorktree();
  writeFileSync(join(tree, "new.txt"), "agent work\n");
  const mine = commitAs(tree, "agent change", "2026-10-31T10:00:00+00:00");

  await expect(
    publish({
      cwd: tree,
      gatewayUrl: GATEWAY,
      connectorId: CONNECTOR,
      title: "Agent change",
      base: "nope",
    }),
  ).rejects.toThrow("nope doesn't exist on GitHub");
  expect(seen.commits).toEqual([]);
  expect(seen.refs).toEqual([]);
  expect(git(tree, "rev-parse", "HEAD")).toBe(mine);
});

/**
 * GitHub's writes, landing in the bare remote as GitHub's would: blobs, trees and commits are real
 * objects there, a ref update with force off refuses anything but a fast-forward, and a pull
 * request opened stays open.
 */
function githubWrites() {
  const pulls: { number: number; html_url: string; head: string }[] = [];
  const index = join(root, "github-index");
  const bareIn = (args: string[], input: string | Buffer, env = {}) =>
    execFileSync("git", args, {
      cwd: remote,
      input,
      encoding: "utf8",
      env: { ...process.env, ...env },
    }).trim();
  const refSha = (ref: string) =>
    spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], {
      cwd: remote,
      encoding: "utf8",
    }).stdout.trim();
  server.use(
    http.post(`${REPO}/git/blobs`, async ({ request }) => {
      const { content } = (await request.json()) as { content: string };
      const sha = bareIn(
        ["hash-object", "-w", "--stdin"],
        Buffer.from(content, "base64"),
      );
      return HttpResponse.json({ sha }, { status: 201 });
    }),
    http.post(`${REPO}/git/trees`, async ({ request }) => {
      const body = (await request.json()) as {
        base_tree: string;
        tree: { path: string; mode: string; sha: string | null }[];
      };
      const env = { GIT_INDEX_FILE: index };
      bareIn(["read-tree", body.base_tree], "", env);
      for (const entry of body.tree) {
        bareIn(
          entry.sha === null
            ? ["update-index", "--force-remove", entry.path]
            : [
                "update-index",
                "--add",
                "--cacheinfo",
                `${entry.mode},${entry.sha},${entry.path}`,
              ],
          "",
          env,
        );
      }
      const sha = bareIn(["write-tree"], "", env);
      rmSync(index, { force: true });
      return HttpResponse.json({ sha }, { status: 201 });
    }),
    http.post(`${REPO}/git/commits`, async ({ request }) => {
      type Person = { name: string; email: string; date: string };
      const body = (await request.json()) as {
        message: string;
        tree: string;
        parents: string[];
        author: Person;
        committer: Person;
      };
      const sha = bareIn(
        [
          "commit-tree",
          body.tree,
          ...body.parents.flatMap((p) => ["-p", p]),
          "-F",
          "-",
        ],
        body.message,
        {
          GIT_AUTHOR_NAME: body.author.name,
          GIT_AUTHOR_EMAIL: body.author.email,
          GIT_AUTHOR_DATE: body.author.date,
          GIT_COMMITTER_NAME: body.committer.name,
          GIT_COMMITTER_EMAIL: body.committer.email,
          GIT_COMMITTER_DATE: body.committer.date,
        },
      );
      return HttpResponse.json({ sha }, { status: 201 });
    }),
    http.get(`${REPO}/git/ref/heads/claude/*`, ({ request }) => {
      const ref = new URL(request.url).pathname.split("/git/ref/")[1] ?? "";
      const sha = refSha(`refs/${decodeURIComponent(ref)}`);
      return sha
        ? HttpResponse.json({ object: { sha } })
        : HttpResponse.json({ message: "Not Found" }, { status: 404 });
    }),
    http.post(`${REPO}/git/refs`, async ({ request }) => {
      const { ref, sha } = (await request.json()) as {
        ref: string;
        sha: string;
      };
      if (refSha(ref)) {
        return HttpResponse.json(
          { message: "Reference already exists" },
          { status: 422 },
        );
      }
      bareIn(["update-ref", ref, sha], "");
      return HttpResponse.json({ object: { sha } }, { status: 201 });
    }),
    http.patch(`${REPO}/git/refs/heads/*`, async ({ request }) => {
      const ref = `refs/${decodeURIComponent(new URL(request.url).pathname.split("/git/refs/")[1] ?? "")}`;
      const { sha, force } = (await request.json()) as {
        sha: string;
        force: boolean;
      };
      const fastForward =
        spawnSync("git", ["merge-base", "--is-ancestor", refSha(ref), sha], {
          cwd: remote,
        }).status === 0;
      if (!force && !fastForward) {
        return HttpResponse.json(
          { message: "Update is not a fast forward" },
          { status: 422 },
        );
      }
      bareIn(["update-ref", ref, sha], "");
      return HttpResponse.json({ object: { sha } });
    }),
    http.get(`${REPO}/pulls`, ({ request }) => {
      const head = new URL(request.url).searchParams.get("head");
      return HttpResponse.json(pulls.filter((p) => `acme:${p.head}` === head));
    }),
    http.post(`${REPO}/pulls`, async ({ request }) => {
      const { head } = (await request.json()) as { head: string };
      const number = pulls.length + 7;
      const pull = {
        number,
        html_url: `https://github.com/acme/private/pull/${number}`,
        head,
      };
      pulls.push(pull);
      return HttpResponse.json(pull, { status: 201 });
    }),
    http.patch(`${REPO}/pulls/:number`, ({ params }) =>
      HttpResponse.json({ number: Number(params.number) }),
    ),
  );
  return { pulls };
}

/** The branch on GitHub: its commits past `base`, oldest first, by subject, and its tree. */
const onGitHub = (branch: string, base: string) => ({
  subjects: bare("log", "--reverse", "--format=%s", `${base}..${branch}`),
  tree: bare("rev-parse", `${branch}^{tree}`),
  onBase: spawnSync("git", ["merge-base", "--is-ancestor", base, branch], {
    cwd: remote,
  }).status,
});

test("a re-publish after the base moved two commits updates GitHub's branch to the rebased history, and the PR stays open", async () => {
  fakeGitHub();
  const { pulls } = githubWrites();
  const { dir, tree } = await agentWorktree();
  writeFileSync(join(tree, "new.txt"), "agent work\n");
  commitAs(tree, "agent change", "2026-10-31T10:00:00+00:00");
  const first = await publishFrom(tree);

  writeFileSync(join(tree, "fix.txt"), "review fix\n");
  commitAs(tree, "review fix", "2026-10-31T11:00:00+00:00");
  advanceRemote("one.txt", "1\n");
  const fresh = advanceRemote("two.txt", "2\n");
  const second = await publishFrom(tree);

  expect(second).toMatchObject({
    created: false,
    pullRequest: first.pullRequest,
  });
  expect(pulls).toHaveLength(1);
  expect(onGitHub("claude/agt_1", fresh)).toEqual({
    subjects: "agent change\nreview fix",
    tree: git(tree, "rev-parse", "HEAD^{tree}"),
    onBase: 0,
  });
  // the base's tip arrived without its parent, so the clone holds it as shallow
  expect(readFileSync(join(dir, ".git/shallow"), "utf8")).toContain(fresh);
});

test("a branch already rebased by a publish rebases again from that base when the base moves again", async () => {
  fakeGitHub();
  githubWrites();
  const { tree } = await agentWorktree();
  writeFileSync(join(tree, "new.txt"), "agent work\n");
  commitAs(tree, "agent change", "2026-10-31T10:00:00+00:00");
  advanceRemote("one.txt", "1\n");
  advanceRemote("two.txt", "2\n");
  await publishFrom(tree);

  advanceRemote("three.txt", "3\n");
  const fresh = advanceRemote("four.txt", "4\n");
  await publishFrom(tree);

  expect(git(tree, "rev-parse", "HEAD~1")).toBe(fresh);
  expect(onGitHub("claude/agt_1", fresh)).toEqual({
    subjects: "agent change",
    tree: git(tree, "rev-parse", "HEAD^{tree}"),
    onBase: 0,
  });
});

test("a branch rebased by hand onto a shallow base, as a conflict's message says to, then publishes", async () => {
  fakeGitHub();
  githubWrites();
  const { tree } = await agentWorktree();
  writeFileSync(join(tree, "README.md"), "agent's line\n");
  commitAs(tree, "agent change", "2026-10-31T10:00:00+00:00");
  advanceRemote("one.txt", "1\n");
  const fresh = advanceRemote("README.md", "someone else's line\n");
  const failure = await publishFrom(tree).catch((error: Error) => error);
  const advice = /`git (rebase [^`]+)`/.exec(String(failure))?.[1] ?? "";
  expect(advice).not.toBe("");

  spawnSync("git", advice.split(" "), { cwd: tree, env: gitEnv });
  writeFileSync(join(tree, "README.md"), "both lines\n");
  git(tree, "add", "README.md");
  execFileSync("git", [...NO_SIGN, "rebase", "--continue"], {
    cwd: tree,
    env: gitEnv,
  });
  await publishFrom(tree);

  expect(onGitHub("claude/agt_1", fresh)).toEqual({
    subjects: "agent change",
    tree: git(tree, "rev-parse", "HEAD^{tree}"),
    onBase: 0,
  });
});

test("a branch sharing no commit with any base fails with advice that, followed, publishes it", async () => {
  fakeGitHub();
  githubWrites();
  const { tree } = await agentWorktree();
  git(tree, "switch", "-q", "--orphan", "claude/orphan");
  writeFileSync(join(tree, "new.txt"), "agent work\n");
  commitAs(tree, "agent change", "2026-10-31T10:00:00+00:00");
  const failure = await publishFrom(tree).catch((error: Error) => error);
  const advice = [...String(failure).matchAll(/`git ([^`]+)`/g)].map(
    (match) => match[1] ?? "",
  );
  expect(advice).toHaveLength(2);

  for (const step of advice) {
    execFileSync("git", [...NO_SIGN, ...step.split(" ")], {
      cwd: tree,
      env: gitEnv,
    });
  }
  await publishFrom(tree);

  const branch = git(tree, "symbolic-ref", "--short", "HEAD");
  expect(onGitHub(branch, headSha)).toEqual({
    subjects: "agent change",
    tree: git(tree, "rev-parse", "HEAD^{tree}"),
    onBase: 0,
  });
});

test("a branch reaching two bases that share no commit here fails naming both, with advice that, followed, publishes only its own commits", async () => {
  fakeGitHub();
  githubWrites();
  const { tree } = await agentWorktree();
  writeFileSync(join(tree, "new.txt"), "agent work\n");
  commitAs(tree, "agent change", "2026-10-31T10:00:00+00:00");
  advanceRemote("one.txt", "1\n");
  const fresh = advanceRemote("two.txt", "2\n");
  await publishFrom(tree);
  // the shallow base and the clone's own share no history, so git merges them only when told to
  git(tree, "merge", "-q", "--allow-unrelated-histories", "origin/trunk");
  writeFileSync(join(tree, "more.txt"), "follow-up\n");
  commitAs(tree, "follow-up", "2026-10-31T11:00:00+00:00");

  const failure = await publishFrom(tree).catch((error: Error) => error);
  expect(String(failure)).toContain(headSha);
  expect(String(failure)).toContain(fresh);
  const advice = [...String(failure).matchAll(/`git ([^`]+)`/g)].map(
    (match) => match[1] ?? "",
  );
  expect(advice).toHaveLength(2);
  for (const step of advice) {
    execFileSync("git", [...NO_SIGN, ...step.split(" ")], {
      cwd: tree,
      env: gitEnv,
    });
  }
  await publishFrom(tree);

  const branch = git(tree, "symbolic-ref", "--short", "HEAD");
  expect(onGitHub(branch, fresh)).toMatchObject({
    subjects: "agent change\nfollow-up",
    onBase: 0,
  });
});

test.each([
  ["cut from it", ["switch", "-q", "-c", "claude/followup"]],
  ["renamed", ["branch", "-m", "claude/followup"]],
])(
  "a branch %s after a publish rebased it onto a shallow base still publishes from that base",
  async (_, command) => {
    fakeGitHub();
    githubWrites();
    const { tree } = await agentWorktree();
    writeFileSync(join(tree, "new.txt"), "agent work\n");
    commitAs(tree, "agent change", "2026-10-31T10:00:00+00:00");
    advanceRemote("one.txt", "1\n");
    const fresh = advanceRemote("two.txt", "2\n");
    await publishFrom(tree);

    git(tree, ...command);
    writeFileSync(join(tree, "more.txt"), "follow-up\n");
    commitAs(tree, "follow-up", "2026-10-31T11:00:00+00:00");
    await publishFrom(tree);

    expect(onGitHub("claude/followup", fresh)).toEqual({
      subjects: "agent change\nfollow-up",
      tree: git(tree, "rev-parse", "HEAD^{tree}"),
      onBase: 0,
    });
  },
);

test.each([
  ["claude/agt_1", "claude/agt_2"],
  ["claude/agt_2", "claude/agt_1"],
])(
  "two agents in one sprite publish %s then %s after the base moved two commits, each rebased onto it",
  async (...order) => {
    fakeGitHub();
    githubWrites();
    const dir = join(root, "repo");
    await pull(dir);
    const trees: Record<string, string> = {};
    for (const branch of ["claude/agt_1", "claude/agt_2"]) {
      const tree = join(root, branch.replace("/", "-"));
      git(dir, "worktree", "add", "-b", branch, tree, "origin/HEAD");
      writeFileSync(join(tree, `${branch.slice(7)}.txt`), `${branch}\n`);
      commitAs(tree, `work on ${branch}`, "2026-10-31T10:00:00+00:00");
      trees[branch] = tree;
    }
    advanceRemote("one.txt", "1\n");
    const fresh = advanceRemote("two.txt", "2\n");

    for (const branch of order) {
      const tree = trees[branch] ?? "";
      await publishFrom(tree);
      expect(onGitHub(branch, fresh)).toEqual({
        subjects: `work on ${branch}`,
        tree: git(tree, "rev-parse", "HEAD^{tree}"),
        onBase: 0,
      });
    }
  },
);

/** A commit pushed to the agent's branch on GitHub by someone else, as a review suggestion is. */
const suggestOnGitHub = (branch: string) => {
  const reviewer = join(root, "reviewer");
  execFileSync("git", ["clone", "-q", "-b", branch, remote, reviewer]);
  writeFileSync(join(reviewer, "suggested.txt"), "reviewer\n");
  const sha = commitAs(reviewer, "suggestion", "2026-10-31T12:00:00+00:00");
  git(reviewer, "push", "-q", "origin", branch);
  return sha;
};

test("a commit someone else pushed to the branch on GitHub is never overwritten by a re-publish after the base moved", async () => {
  fakeGitHub();
  githubWrites();
  const { tree } = await agentWorktree();
  writeFileSync(join(tree, "new.txt"), "agent work\n");
  commitAs(tree, "agent change", "2026-10-31T10:00:00+00:00");
  await publishFrom(tree);
  const suggestion = suggestOnGitHub("claude/agt_1");
  advanceRemote("one.txt", "1\n");
  advanceRemote("two.txt", "2\n");

  await expect(publishFrom(tree)).rejects.toThrow(
    "claude/agt_1 on GitHub isn't an ancestor of this branch",
  );
  expect(bare("rev-parse", "claude/agt_1")).toBe(suggestion);
});

test("a write to the branch on GitHub while a forced re-publish runs is not overwritten", async () => {
  fakeGitHub();
  githubWrites();
  const { tree } = await agentWorktree();
  writeFileSync(join(tree, "new.txt"), "agent work\n");
  commitAs(tree, "agent change", "2026-10-31T10:00:00+00:00");
  await publishFrom(tree);
  advanceRemote("one.txt", "1\n");
  advanceRemote("two.txt", "2\n");
  let suggestion = "";
  // the other write lands after the publish read the branch and before it moves it
  server.use(
    http.post(
      `${REPO}/git/commits`,
      () => {
        suggestion = suggestOnGitHub("claude/agt_1");
      },
      { once: true },
    ),
  );

  await expect(publishFrom(tree)).rejects.toThrow(
    /claude\/agt_1 moved on GitHub to [0-9a-f]{40} while this publish ran; nothing was overwritten/,
  );
  expect(bare("rev-parse", "claude/agt_1")).toBe(suggestion);
});

test("nothing outside the repo's REST endpoints is called, and no request carries a credential", async () => {
  fakeGitHub();
  const requests: { url: string; auth: string | null }[] = [];
  server.use(
    http.all("*", ({ request }) => {
      requests.push({
        url: request.url,
        auth: request.headers.get("authorization"),
      });
    }),
  );
  await pull(join(root, "repo"));
  expect(requests.length).toBeGreaterThan(3);
  for (const { url, auth } of requests) {
    expect(url === REPO || url.startsWith(`${REPO}/`), url).toBe(true);
    expect(auth, url).toBeNull();
  }
});

test("a commit with no parent leaves no shallow file; one with parents is shallow, so its missing history is never walked", async () => {
  fakeGitHub();
  const dir = join(root, "repo");
  await pull(dir);
  expect(readFileSync(join(dir, ".git/shallow"), "utf8").trim()).toBe(headSha);
  expect(git(dir, "log", "--format=%H")).toBe(headSha);

  const solo = join(root, "solo");
  initRepo(solo);
  writeFileSync(join(solo, "f"), "x\n");
  const only = commitAs(solo, "only", "2026-10-03T00:00:00+01:00");
  execFileSync("git", ["fetch", "-q", solo, "trunk:refs/heads/trunk", "-f"], {
    cwd: remote,
  });
  expect(bare("rev-parse", "trunk")).toBe(only);
  const dir2 = join(root, "repo2");
  await pull(dir2);
  expect(existsSync(join(dir2, ".git/shallow"))).toBe(false);
});

test("an unsigned tip with a header the API leaves out fails the pull, naming the commit and why, rather than leaving a checkout that publishes off a sha GitHub lacks", async () => {
  fakeGitHub();
  const tip = rawTip(MERGETAG, false);
  const failure = pull(join(root, "repo"));
  await expect(failure).rejects.toThrow(
    `commit ${tip.sha} is unsigned and carries more than GitHub's API returns (a mergetag or encoding header`,
  );
  await expect(failure).rejects.toThrow("Move trunk to a commit");
});

test("a signed tip whose signed text doesn't hash to its sha fails the pull, saying so", async () => {
  fakeGitHub();
  const tip = rawTip([], true);
  server.use(
    http.get(`${REPO}/git/commits/:sha`, ({ params }) =>
      HttpResponse.json({
        ...apiCommit(String(params.sha)),
        verification: {
          verified: true,
          reason: "valid",
          signature: SIGNATURE,
          payload: tip.payload.replace("Ship it", "Ship it!"),
        },
      }),
    ),
  );
  await expect(pull(join(root, "repo"))).rejects.toThrow(
    `commit ${tip.sha} is signed, but the signed commit rebuilt from GitHub's API doesn't hash to GitHub's sha`,
  );
});

const SIGNATURE = [
  "-----BEGIN PGP SIGNATURE-----",
  "",
  "wsFcBAABCAAQBQJnAAAACRBK7hj4Ov3rIwAAdHIQAKw4Zm9vYmFy",
  "=abcd",
  "-----END PGP SIGNATURE-----",
  "",
].join("\n");

/**
 * Moves trunk to a commit written as raw text, as GitHub's web flow signs one: `headers` after the
 * committer, the signature as the last header. Returns its sha and the text that was signed.
 */
const rawTip = (headers: string[], signed: boolean) => {
  const tree = bare("rev-parse", `${headSha}^{tree}`);
  const lines = [
    `tree ${tree}`,
    `parent ${headSha}`,
    "author Ada L <ada@example.com> 1790000000 +0530",
    "committer GitHub <noreply@github.com> 1790000100 -0700",
    ...headers,
  ];
  const message = "Merge pull request #1 from acme/feature\n\nShip it\n";
  const payload = `${lines.join("\n")}\n\n${message}`;
  const gpgsig = `gpgsig ${SIGNATURE.split("\n").join("\n ")}`;
  const text = signed
    ? `${[...lines, gpgsig].join("\n")}\n\n${message}`
    : payload;
  const sha = execFileSync(
    "git",
    ["hash-object", "-t", "commit", "-w", "--stdin"],
    { cwd: remote, input: text, encoding: "utf8" },
  ).trim();
  bare("update-ref", "refs/heads/trunk", sha);
  return { sha, payload };
};

const MERGETAG = [
  "mergetag object 0123456789012345678901234567890123456789",
  " type commit",
  " tag v1.0",
  " tagger Ada L <ada@example.com> 1789999000 +0000",
  " ",
  " v1.0",
];

test("a signed tip, as every web-UI merge is, checks out at GitHub's sha from the signed text the API gives, extra headers and all", async () => {
  fakeGitHub();
  const tip = rawTip([...MERGETAG, "encoding UTF-8"], true);
  server.use(
    http.get(`${REPO}/git/commits/:sha`, ({ params }) =>
      HttpResponse.json({
        ...apiCommit(String(params.sha)),
        verification: {
          verified: true,
          reason: "valid",
          signature: SIGNATURE,
          payload: tip.payload,
        },
      }),
    ),
  );
  const dir = join(root, "repo");
  expect(await pull(dir)).toEqual({ branch: "trunk", sha: tip.sha });
  expect(git(dir, "rev-parse", "HEAD")).toBe(tip.sha);
  expect(git(dir, "status", "--porcelain")).toBe("");
});

/** The API's answer for a signed tip: its signature, and the text that was signed unless `payload` says otherwise. */
const signedByApi = (payload: string | null) =>
  server.use(
    http.get(`${REPO}/git/commits/:sha`, ({ params }) =>
      HttpResponse.json({
        ...apiCommit(String(params.sha)),
        verification: {
          verified: true,
          reason: "valid",
          signature: SIGNATURE,
          payload,
        },
      }),
    ),
  );

test("a signed tip with no headers beyond the usual checks out at GitHub's sha", async () => {
  fakeGitHub();
  const tip = rawTip([], true);
  signedByApi(tip.payload);
  const dir = join(root, "repo");
  expect(await pull(dir)).toEqual({ branch: "trunk", sha: tip.sha });
  expect(git(dir, "rev-parse", "HEAD")).toBe(tip.sha);
  expect(git(dir, "cat-file", "commit", tip.sha)).toContain(
    "\ngpgsig -----BEGIN PGP SIGNATURE-----\n",
  );
});

test("a signed tip whose API gave a signature but no signed text fails the pull, saying so, and creates nothing", async () => {
  fakeGitHub();
  const tip = rawTip([], true);
  signedByApi(null);
  const dir = join(root, "fresh/repo");
  const failure = pull(dir);
  await expect(failure).rejects.toThrow(
    `commit ${tip.sha} is signed, but GitHub's API gave no signed text to rebuild it from`,
  );
  await expect(failure).rejects.toThrow("Move trunk to a commit");
  expect(existsSync(join(root, "fresh"))).toBe(false);
});

test("rebuildCommit puts a GitHub-style signature, trailing newline kept, at the end of signed text that has no blank line", () => {
  const body = [
    `tree ${bare("rev-parse", `${headSha}^{tree}`)}`,
    "author Ada L <ada@example.com> 1790000000 +0530",
    "committer GitHub <noreply@github.com> 1790000100 -0700",
    "",
  ].join("\n");
  const text = [
    body.replace(/\n$/, ""),
    "gpgsig -----BEGIN PGP SIGNATURE-----",
    " ",
    " wsFcBAABCAAQBQJnAAAACRBK7hj4Ov3rIwAAdHIQAKw4Zm9vYmFy",
    " =abcd",
    " -----END PGP SIGNATURE-----",
    " ",
    "",
  ].join("\n");
  const sha = execFileSync(
    "git",
    ["hash-object", "-t", "commit", "--literally", "--stdin"],
    { cwd: remote, input: text, encoding: "utf8" },
  ).trim();
  const commit = {
    ...apiCommit(headSha),
    verification: { signature: SIGNATURE, payload: body },
  };
  expect(rebuildCommit(sha, commit)).toBe(text);
});

test("rebuildCommit keeps a signature without a trailing newline as it is", () => {
  const signature = SIGNATURE.replace(/\n$/, "");
  const body = [
    `tree ${bare("rev-parse", `${headSha}^{tree}`)}`,
    "author Ada L <ada@example.com> 1790000000 +0530",
    "committer GitHub <noreply@github.com> 1790000100 -0700",
    "",
    "Ship it",
    "",
  ].join("\n");
  const text = body.replace(
    "\n\n",
    `\ngpgsig ${signature.split("\n").join("\n ")}\n\n`,
  );
  const sha = execFileSync(
    "git",
    ["hash-object", "-t", "commit", "--literally", "--stdin"],
    { cwd: remote, input: text, encoding: "utf8" },
  ).trim();
  const commit = {
    ...apiCommit(headSha),
    verification: { signature, payload: body },
  };
  expect(rebuildCommit(sha, commit)).toBe(text);
});

test("rebuildCommit finds the zone the API dropped, and gives up on a sha it can't match", () => {
  const commit = apiCommit(headSha);
  expect(rebuildCommit(headSha, commit)).toBe(
    `${bare("cat-file", "commit", headSha)}\n`,
  );
  expect(() => rebuildCommit("0".repeat(40), commit)).toThrow(
    `commit ${"0".repeat(40)} is unsigned`,
  );
});

const sinks = () => {
  const io = { out: "", err: "" };
  return {
    io,
    sink: {
      stdout: (s: string) => {
        io.out += s;
      },
      stderr: (s: string) => {
        io.err += s;
      },
    },
  };
};
// the anonymous git attempt is off, so these reach the connector and never the real github.com
const mainEnv = {
  GITHUB_CONNECTOR: CONNECTOR,
  GITHUB_GATEWAY_URL: GATEWAY,
  SKY_ANON_GIT: "0",
};
const anonEnv = { GITHUB_CONNECTOR: CONNECTOR, GITHUB_GATEWAY_URL: GATEWAY };

test.each([
  ["no dir", ["acme/private"]],
  ["nothing", []],
  ["an extra argument", ["acme/private", "dir", "extra"]],
  ["a repo with a subpath", ["a/b/c", "dir"]],
  ["a repo with no owner", ["private", "dir"]],
  ["a repo with a blank owner", [" /private", "dir"]],
])(
  "repo-pull with %s is a usage error, exit 2, and touches nothing",
  async (_, argv) => {
    const { io, sink } = sinks();
    expect(await repoPullMain(argv, mainEnv, sink)).toBe(2);
    expect(io.err).toBe("usage: repo-pull <owner/repo> <dir>\n");
    expect(io.out).toBe("");
  },
);

test("repo-pull without a connector is a config error, exit 2, naming the variable", async () => {
  const { io, sink } = sinks();
  expect(await repoPullMain(["acme/private", join(root, "x")], {}, sink)).toBe(
    2,
  );
  expect(io.err).toBe("repo pull: GITHUB_CONNECTOR is not set\n");
  expect(existsSync(join(root, "x"))).toBe(false);
});

test("repo-pull reports the commit it checked out, on stdout", async () => {
  fakeGitHub();
  const { io, sink } = sinks();
  const dir = join(root, "x");
  expect(await repoPullMain(["acme/private", dir], mainEnv, sink)).toBe(0);
  expect(io.out).toBe(`repo pull: acme/private trunk at ${headSha}\n`);
  expect(git(dir, "rev-parse", "HEAD")).toBe(headSha);
});

test.each([
  ["unset", {}],
  ["empty", { GITHUB_GATEWAY_URL: "" }],
])(
  "repo-pull with the gateway URL %s goes to the default gateway",
  async (_, extra) => {
    fakeGitHub(`${DEFAULT_GATEWAY_URL}/${CONNECTOR}/repos/acme/private`);
    const { sink } = sinks();
    const dir = join(root, "x");
    const env = { GITHUB_CONNECTOR: CONNECTOR, ...extra };
    expect(await repoPullMain(["acme/private", dir], env, sink)).toBe(0);
    expect(git(dir, "rev-parse", "HEAD")).toBe(headSha);
  },
);

test("repo-pull of a repo the connector can't see is a failed pull, exit 1, with the cause on stderr", async () => {
  fakeGitHub();
  server.use(http.get(REPO, () => new HttpResponse("nope", { status: 404 })));
  const { io, sink } = sinks();
  expect(
    await repoPullMain(["acme/private", join(root, "y")], mainEnv, sink),
  ).toBe(1);
  expect(io.err).toContain(
    "repo pull: failed: the connector in GITHUB_CONNECTOR can't see acme/private; check its connection id and the repos it grants",
  );
  expect(io.out).toBe("");
  expect(existsSync(join(root, "y"))).toBe(false);
});

test("a relative dir is taken from the working directory, as a shell gives it", async () => {
  fakeGitHub();
  const cwd = process.cwd();
  process.chdir(root);
  try {
    await pull("rel/repo");
  } finally {
    process.chdir(cwd);
  }
  const dir = join(root, "rel/repo");
  expect(git(dir, "rev-parse", "HEAD")).toBe(headSha);
  expect(git(dir, "status", "--porcelain")).toBe("");
});

test("a re-run onto the checkout a killed run left behind, origin and all, finishes it", async () => {
  fakeGitHub();
  const dir = join(root, "repo");
  initRepo(dir);
  git(dir, "remote", "add", "origin", "https://github.com/acme/private.git");
  writeFileSync(join(dir, ".git/shallow"), `${"e".repeat(40)}\n`);
  expect(await pull(dir)).toEqual({ branch: "trunk", sha: headSha });
  expect(git(dir, "rev-parse", "origin/HEAD")).toBe(headSha);
  expect(git(dir, "config", "--get-all", "remote.origin.fetch")).toBe(
    "+refs/heads/*:refs/remotes/origin/*",
  );
  expect(readFileSync(join(dir, ".git/shallow"), "utf8")).toBe(`${headSha}\n`);
  expect(git(dir, "status", "--porcelain")).toBe("");
});

test("a re-run overwrites an origin a killed run left pointing elsewhere", async () => {
  fakeGitHub();
  const dir = join(root, "repo");
  initRepo(dir);
  git(dir, "remote", "add", "origin", "https://example.com/other.git");
  await pull(dir);
  expect(git(dir, "remote", "get-url", "origin")).toBe(
    "https://github.com/acme/private.git",
  );
});

test("a re-run finishes a run killed after its refs were set and before its working tree was written", async () => {
  fakeGitHub();
  const dir = join(root, "repo");
  await pull(dir);
  rmSync(join(dir, ".git/index"));
  for (const entry of readdirSync(dir)) {
    if (entry !== ".git") rmSync(join(dir, entry), { recursive: true });
  }
  expect(await pull(dir)).toEqual({ branch: "trunk", sha: headSha });
  expect(git(dir, "status", "--porcelain")).toBe("");
  expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("private\n");
  expect(readlinkSync(join(dir, "link"))).toBe("README.md");
});

test("a re-run finishes a run killed while building its index, and leaves no index file behind", async () => {
  fakeGitHub();
  const dir = join(root, "repo");
  await pull(dir);
  // named for the process that was killed, so no live fetch owns it
  const { pid } = spawnSync("true");
  const stale = join(dir, `.git/sky-pull-index-${pid}-killed`);
  execFileSync(
    "git",
    [
      "update-index",
      "--add",
      "--cacheinfo",
      `100644,${bare("rev-parse", `${headSha}:README.md`)},README.md`,
    ],
    { cwd: dir, env: { ...process.env, GIT_INDEX_FILE: stale } },
  );
  expect(existsSync(stale)).toBe(true);
  expect(await pull(dir)).toEqual({ branch: "trunk", sha: headSha });
  expect(existsSync(stale)).toBe(false);
  expect(git(dir, "status", "--porcelain")).toBe("");
});

test("a re-run removes the index of a dead fetch and keeps that of one still running", async () => {
  fakeGitHub();
  const dir = join(root, "repo");
  await pull(dir);
  const { pid: dead } = spawnSync("true");
  const index = (pid: number | undefined) =>
    join(dir, `.git/sky-pull-index-${pid}-other-run`);
  // this process is alive; pid 1 is alive too, under another user or this one
  const kept = [index(process.pid), index(1)];
  for (const path of [...kept, index(dead)]) writeFileSync(path, "");

  await pull(dir);

  expect(existsSync(index(dead))).toBe(false);
  expect(kept.map((path) => existsSync(path))).toEqual([true, true]);
});

test("a pull that fails onto an existing checkout keeps it, and a later run finishes it", async () => {
  fakeGitHub();
  const dir = join(root, "repo");
  await pull(dir);
  const tip = advanceTrunk((work) =>
    writeFileSync(join(work, "new.txt"), "n\n"),
  );
  server.use(
    http.get(`${REPO}/git/blobs/:sha`, () =>
      HttpResponse.json({ message: "Server Error" }, { status: 500 }),
    ),
  );
  await expect(pull(dir)).rejects.toThrow("returned 500");
  expect(git(dir, "rev-parse", "HEAD")).toBe(headSha);
  expect(git(dir, "status", "--porcelain")).toBe("");

  fakeGitHub();
  expect(await pull(dir)).toEqual({ branch: "trunk", sha: tip });
  expect(git(dir, "rev-parse", "HEAD")).toBe(tip);
  expect(readFileSync(join(dir, "new.txt"), "utf8")).toBe("n\n");
  expect(git(dir, "status", "--porcelain")).toBe("");
});

test("a pull that fails part-way removes the checkout it started, so the next run starts clean", async () => {
  fakeGitHub();
  server.use(
    http.get(`${REPO}/git/blobs/:sha`, () =>
      HttpResponse.json({ message: "Server Error" }, { status: 500 }),
    ),
  );
  const parent = join(root, "fresh");
  const dir = join(parent, "repo");
  await expect(pull(dir)).rejects.toThrow("returned 500");
  expect(existsSync(parent)).toBe(false);

  const kept = join(root, "kept");
  mkdirSync(kept);
  writeFileSync(join(kept, "notes.txt"), "mine\n");
  await expect(pull(kept)).rejects.toThrow("returned 500");
  expect(existsSync(join(kept, ".git"))).toBe(false);
  expect(readFileSync(join(kept, "notes.txt"), "utf8")).toBe("mine\n");
});

test("an empty repo fails the pull saying it's empty, not with the gateway's 409", async () => {
  fakeGitHub();
  server.use(
    http.get(`${REPO}/git/ref/heads/trunk`, () =>
      HttpResponse.json(
        { message: "Git Repository is empty." },
        { status: 409 },
      ),
    ),
  );
  const dir = join(root, "repo");
  await expect(pull(dir)).rejects.toThrow(
    "acme/private is empty: its default branch has no commit to check out; push one first",
  );
  expect(existsSync(dir)).toBe(false);
});

/** Pushes a new commit on trunk after `edit` changes a clone of it; returns the new tip. */
const advanceTrunk = (edit: (work: string) => void) => {
  const work = join(root, "work");
  execFileSync("git", ["clone", "-q", "-b", "trunk", remote, work]);
  edit(work);
  const sha = commitAs(work, "more", "2026-10-05T12:00:00+02:00");
  git(work, "push", "-q", "origin", "trunk");
  return sha;
};

test("a truncated tree fails the pull as too large, and leaves nothing behind", async () => {
  fakeGitHub();
  server.use(
    http.get(`${REPO}/git/trees/:sha`, () =>
      HttpResponse.json({ truncated: true, tree: [] }),
    ),
  );
  const dir = join(root, "fresh/repo");
  await expect(pull(dir)).rejects.toThrow(
    "the tree of acme/private is too large to fetch",
  );
  expect(existsSync(join(root, "fresh"))).toBe(false);
});

test("a blob GitHub 404s mid-fetch fails the pull naming the status, and removes the checkout", async () => {
  fakeGitHub();
  server.use(
    http.get(`${REPO}/git/blobs/:sha`, () =>
      HttpResponse.json({ message: "Not Found" }, { status: 404 }),
    ),
  );
  const dir = join(root, "fresh/repo");
  await expect(pull(dir)).rejects.toThrow("404");
  expect(existsSync(join(root, "fresh"))).toBe(false);
});

test("a tree whose entries rebuild a different tree sha fails the pull, naming both, and removes the checkout", async () => {
  fakeGitHub();
  const readme = bare("rev-parse", `${headSha}:README.md`);
  const script = bare("rev-parse", `${headSha}:run.sh`);
  const real = bare("rev-parse", `${headSha}^{tree}`);
  server.use(
    http.get(`${REPO}/git/trees/:sha`, () =>
      HttpResponse.json({
        truncated: false,
        tree: bare("ls-tree", "-r", "-z", real)
          .split("\0")
          .filter(Boolean)
          .map((line) => {
            const [meta = "", path = ""] = line.split("\t");
            const [mode, type, sha] = meta.split(" ");
            // run.sh arrives with README's content
            return { mode, type, sha: sha === script ? readme : sha, path };
          }),
      }),
    ),
  );
  const dir = join(root, "fresh/repo");
  const failure = await pull(dir).catch((error: Error) => error);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toMatch(
    new RegExp(`^tree ${real} arrived as [0-9a-f]{40}$`),
  );
  expect(existsSync(join(root, "fresh"))).toBe(false);
});

test("a submodule's gitlink entry is kept in the tree as a gitlink, with no fetch of its commit", async () => {
  let linked = "";
  const tip = advanceTrunk((work) => {
    const sub = join(work, "vendor/sub");
    mkdirSync(sub, { recursive: true });
    execFileSync("git", [...NO_SIGN, "init", "-q", sub]);
    writeFileSync(join(sub, "f"), "x\n");
    linked = commitAs(sub, "sub", "2026-10-04T00:00:00+00:00");
  });
  expect(bare("ls-tree", tip, "vendor/sub")).toContain(
    `160000 commit ${linked}`,
  );
  fakeGitHub();
  const dir = join(root, "repo");
  expect(await pull(dir)).toEqual({ branch: "trunk", sha: tip });
  expect(git(dir, "ls-tree", "HEAD", "vendor/sub")).toBe(
    `160000 commit ${linked}\tvendor/sub`,
  );
  expect(git(dir, "rev-parse", "HEAD^{tree}")).toBe(
    bare("rev-parse", `${tip}^{tree}`),
  );
});

test("binary, empty and duplicated blobs arrive byte for byte, one fetch per distinct blob", async () => {
  const binary = Buffer.from([0, 255, 10, 13, 0x80, 0, 1]);
  const tip = advanceTrunk((work) => {
    writeFileSync(join(work, "a.bin"), binary);
    writeFileSync(join(work, "copy.bin"), binary);
    writeFileSync(join(work, "empty.txt"), "");
    writeFileSync(join(work, "dup.txt"), "private\n");
  });
  fakeGitHub();
  const fetched: string[] = [];
  server.use(
    http.get(`${REPO}/git/blobs/:sha`, ({ params }) => {
      fetched.push(String(params.sha));
      const content = execFileSync(
        "git",
        ["cat-file", "blob", String(params.sha)],
        { cwd: remote },
      );
      return HttpResponse.json({
        encoding: "base64",
        content: content.toString("base64"),
      });
    }),
  );
  const dir = join(root, "repo");
  await pull(dir);
  expect(git(dir, "ls-tree", "-r", "HEAD")).toBe(bare("ls-tree", "-r", tip));
  expect(readFileSync(join(dir, "a.bin")).equals(binary)).toBe(true);
  expect(readFileSync(join(dir, "copy.bin")).equals(binary)).toBe(true);
  expect(readFileSync(join(dir, "empty.txt"))).toHaveLength(0);
  expect(readFileSync(join(dir, "dup.txt"), "utf8")).toBe("private\n");
  expect(new Set(fetched).size).toBe(fetched.length);
  expect(git(dir, "status", "--porcelain")).toBe("");
});

test("a default branch with a slash is checked out under that name, with origin/HEAD at it", async () => {
  fakeGitHub();
  const sha = bare("rev-parse", "trunk");
  server.use(
    http.get(REPO, () => HttpResponse.json({ default_branch: "release/1.0" })),
    http.get(`${REPO}/git/ref/heads/release/1.0`, () =>
      HttpResponse.json({ object: { sha } }),
    ),
  );
  const dir = join(root, "repo");
  expect(await pull(dir)).toEqual({ branch: "release/1.0", sha });
  expect(git(dir, "symbolic-ref", "--short", "HEAD")).toBe("release/1.0");
  expect(git(dir, "rev-parse", "--abbrev-ref", "origin/HEAD")).toBe(
    "origin/release/1.0",
  );
  expect(git(dir, "config", "branch.release/1.0.merge")).toBe(
    "refs/heads/release/1.0",
  );
});

// anonymous git: a public repo is pulled over git with no credential; anything else uses the connector
const gatewayCalls = () => {
  const urls: string[] = [];
  const onStart = ({ request }: { request: Request }) => {
    if (request.url.startsWith(GATEWAY)) urls.push(request.url);
  };
  server.events.on("request:start", onStart);
  return {
    urls,
    stop: () => server.events.removeListener("request:start", onStart),
  };
};

/** Makes `https://github.com/acme/private.git` reach `to`, with `extra` git config lines, as GitHub would. */
const githubIs = (to = remote, extra = "") => {
  const file = join(root, "gitconfig");
  writeFileSync(
    file,
    `[url "${to}"]\n\tinsteadOf = https://github.com/acme/private.git\n${extra}`,
  );
  vi.stubEnv("GIT_CONFIG_GLOBAL", file);
};

test("a public repo is cloned over git with no connector calls, full history, and the plain remote URL", async () => {
  githubIs();
  const calls = gatewayCalls();
  const { io, sink } = sinks();
  const dir = join(root, "x");

  expect(await repoPullMain(["acme/private", dir], anonEnv, sink)).toBe(0);
  calls.stop();

  expect(calls.urls).toEqual([]);
  expect(io.out).toBe(
    `repo pull: acme/private trunk at ${headSha} (over git)\n`,
  );
  expect(git(dir, "rev-parse", "HEAD")).toBe(headSha);
  expect(git(dir, "rev-parse", "origin/HEAD")).toBe(headSha);
  expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("trunk");
  // the history publish builds on is all here, not a shallow tip
  expect(git(dir, "rev-list", "--count", "HEAD")).toBe("2");
  expect(existsSync(join(dir, ".git", "shallow"))).toBe(false);
  expect(git(dir, "config", "--get", "branch.trunk.merge")).toBe(
    "refs/heads/trunk",
  );
  expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("private\n");
});

test("SKY_ANON_GIT=0 pulls through the connector even when git could reach a public remote", async () => {
  githubIs();
  fakeGitHub();
  const calls = gatewayCalls();
  const { io, sink } = sinks();
  const dir = join(root, "x");

  expect(await repoPullMain(["acme/private", dir], mainEnv, sink)).toBe(0);
  calls.stop();

  expect(calls.urls.length).toBeGreaterThan(0);
  expect(io.out).toBe(`repo pull: acme/private trunk at ${headSha}\n`);
  expect(io.err).not.toContain("anonymous git");
  // the connector's checkout is a shallow tip; git's would be whole history
  expect(existsSync(join(dir, ".git", "shallow"))).toBe(true);
});

test("an anonymous fetch that fails (private repo, no network) falls back to the connector with one line saying why", async () => {
  githubIs(join(root, "gone.git"));
  fakeGitHub();
  const { io, sink } = sinks();
  const dir = join(root, "x");

  expect(await repoPullMain(["acme/private", dir], anonEnv, sink)).toBe(0);

  const lines = io.err.split("\n").filter((l) => l.includes("anonymous git"));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(
    /^repo pull: anonymous git fetch failed \(.+\); pulling through the connector$/,
  );
  expect(git(dir, "rev-parse", "HEAD")).toBe(headSha);
  // the connector's checkout, whole: nothing of the failed clone is left in the way
  expect(existsSync(join(dir, ".git", "shallow"))).toBe(true);
});

/** A stand-in for GitHub that wants a login: answers 401 and keeps every Authorization header it sees. */
const loginRequired = async () => {
  const seen: (string | undefined)[] = [];
  const web = createServer((request, response) => {
    seen.push(request.headers.authorization);
    response.writeHead(401, { "www-authenticate": 'Basic realm="GitHub"' });
    response.end();
  });
  await new Promise<void>((done) => web.listen(0, "127.0.0.1", done));
  const { port } = web.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/acme/private.git`,
    seen,
    close: () => web.close(),
  };
};

test("a repo that asks for a login fails at once with no prompt and no stored credential offered, then uses the connector", async () => {
  const gh = await loginRequired();
  // the machine's own helper would answer a login request; the anonymous fetch must not consult it
  githubIs(
    gh.url,
    '[credential]\n\thelper = "!f() { echo username=u; echo password=p; }; f"\n',
  );
  fakeGitHub();
  const { io, sink } = sinks();
  const dir = join(root, "x");
  const started = Date.now();
  try {
    expect(await repoPullMain(["acme/private", dir], anonEnv, sink)).toBe(0);
  } finally {
    gh.close();
  }

  expect(Date.now() - started).toBeLessThan(15_000);
  expect(gh.seen.length).toBeGreaterThan(0);
  expect(gh.seen.every((header) => header === undefined)).toBe(true);
  expect(io.err).toContain("anonymous git fetch failed");
  expect(git(dir, "rev-parse", "HEAD")).toBe(headSha);
});

/** A remote that accepts every connection and never answers, as a stalled network looks to git. */
const silentRemote = async () => {
  const web = createServer(() => {});
  let connected!: () => void;
  const reached = new Promise<void>((done) => {
    connected = done;
  });
  web.on("connection", () => connected());
  await new Promise<void>((done) => web.listen(0, "127.0.0.1", done));
  const { port } = web.address() as { port: number };
  const url = `http://127.0.0.1:${port}/acme/private.git`;
  return {
    url,
    reached,
    /** Processes still running whose command line names this remote: git's transport helpers. */
    survivors: () =>
      execFileSync("ps", ["-eo", "args"], { encoding: "utf8" })
        .split("\n")
        .filter((line) => line.includes(`127.0.0.1:${port}`)),
    close: () => {
      web.closeAllConnections();
      web.close();
    },
  };
};

test("a git command given a time limit is killed with its transport helpers and fails promptly when it overruns", async () => {
  const remote = await silentRemote();
  const dir = join(root, "slow");
  mkdirSync(dir);
  git(dir, "init", "-q");
  const started = Date.now();
  try {
    await expect(
      runnerGit(dir)(["ls-remote", remote.url], { timeoutMs: 300 }),
    ).rejects.toThrow("git ls-remote timed out after 0s");
    expect(Date.now() - started).toBeLessThan(1_300);
    expect(remote.survivors()).toEqual([]);
  } finally {
    remote.close();
  }
});

test("a remote that never answers times out the anonymous clone, leaves no git running, and the connector pulls instead", async () => {
  const remote = await silentRemote();
  githubIs(remote.url);
  fakeGitHub();
  const { io, sink } = sinks();
  const dir = join(root, "x");
  // only git's own time limit is faked; the processes and the connector's requests stay real
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const pulled = repoPullMain(["acme/private", dir], anonEnv, sink);
    await remote.reached;
    vi.advanceTimersByTime(30_000);
    vi.useRealTimers();

    expect(await pulled).toBe(0);
    expect(io.err).toContain(
      "anonymous git fetch failed (git ls-remote timed out after 30s); pulling through the connector",
    );
    expect(remote.survivors()).toEqual([]);
    expect(git(dir, "rev-parse", "HEAD")).toBe(headSha);
  } finally {
    vi.useRealTimers();
    remote.close();
  }
});

test("a repo with no commits over git says it is empty, then the connector is tried", async () => {
  const empty = join(root, "empty.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "trunk", empty]);
  githubIs(empty);
  fakeGitHub();
  const { io, sink } = sinks();
  await repoPullMain(["acme/private", join(root, "x")], anonEnv, sink);
  expect(io.err).toContain("acme/private is empty");
});
