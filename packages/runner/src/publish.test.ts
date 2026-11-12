import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, expect, test } from "vitest";
import { server } from "../../../test/msw.js";
import {
  GatewayError,
  HELD_PATCH_BEGIN,
  HELD_PATCH_END,
  PUBLISH_USAGE,
  publish,
  publishMain,
  stripAttribution,
} from "./publish.js";

const GATEWAY = "https://gateway.test/v1/gateway/github";
const CONNECTOR = "conn_123";
const REPO = `${GATEWAY}/${CONNECTOR}/repos/acme/widgets`;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let root: string;
let work: string;
let baseSha: string;

// the host's own git identity must not override the -c identity below
const withoutHostIdentity = () => {
  const env = { ...process.env };
  for (const key of [
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
  ]) {
    delete env[key];
  }
  return env;
};

const commit = (message: string, date = "2026-10-30T12:00:00+02:00") => {
  git(work, "add", "--all");
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Claude",
      "-c",
      "user.email=noreply@anthropic.com",
      "commit",
      "-qm",
      message,
    ],
    {
      cwd: work,
      env: {
        ...withoutHostIdentity(),
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      },
    },
  );
  return git(work, "rev-parse", "HEAD");
};

// amends HEAD as `commit` makes commits: CI has no git identity of its own
const amend = (message: string) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Claude",
      "-c",
      "user.email=noreply@anthropic.com",
      "commit",
      "-q",
      "--amend",
      "-m",
      message,
    ],
    { cwd: work, env: withoutHostIdentity() },
  );

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "runner-publish-"));
  const origin = join(root, "origin");
  work = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", origin]);
  writeFileSync(join(origin, "README"), "hi\n");
  writeFileSync(join(origin, "old.txt"), "going away\n");
  git(origin, "add", ".");
  git(
    origin,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-qm",
    "init",
  );
  execFileSync("git", ["clone", "-q", origin, work]);
  git(
    work,
    "remote",
    "set-url",
    "origin",
    "https://github.com/acme/widgets.git",
  );
  git(work, "checkout", "-qb", "claude/agt_1");
  baseSha = git(work, "rev-parse", "HEAD");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

type Pull = { number: number; html_url: string; head: string; base: string };

/** GitHub's git data and pulls API behind the gateway, recording every request it answers. */
function fakeGitHub(
  options: {
    ref?: string;
    pulls?: Pull[];
    /** Blob shas GitHub already holds. */
    blobs?: string[];
    /** Trees of commits GitHub holds that this clone doesn't, by commit sha. */
    commitTrees?: Record<string, string>;
    /** Parents of those commits; a commit not listed sits directly on the base. */
    commitParents?: Record<string, string[]>;
    /** Whether a PATCH to a pull is expected; otherwise GitHub refuses it and the test fails. */
    allowPullUpdates?: boolean;
    /** A repo holding objects GitHub has that this clone doesn't, served by the trees and blobs routes. */
    objectsFrom?: string;
    /** The GitHub branch published to; the worktree's own, claude/agt_1, unless given. */
    branch?: string;
  } = {},
) {
  const remoteBranch = options.branch ?? "claude/agt_1";
  const state = {
    ref: options.ref,
    allowPullUpdates: options.allowPullUpdates ?? false,
    pulls: options.pulls ?? [],
    blobs: [] as { content: string; encoding: string }[],
    trees: [] as { base_tree: string; tree: unknown[] }[],
    commits: [] as {
      message: string;
      tree: string;
      parents: string[];
      author: unknown;
      committer: unknown;
    }[],
    refWrites: [] as { method: string; body: unknown }[],
    pullCreates: [] as unknown[],
    pullUpdates: [] as { number: string; body: Record<string, unknown> }[],
    authorization: [] as (string | null)[],
    /** The path of every GET answered, in order. */
    gets: [] as string[],
  };
  const seen = (request: Request) => {
    state.authorization.push(request.headers.get("authorization"));
    if (request.method === "GET") {
      state.gets.push(new URL(request.url).pathname);
    }
  };
  // a repo that isn't there would read as GitHub not holding any blob or tree, and fail far from the cause
  if (options.objectsFrom) git(options.objectsFrom, "rev-parse", "--git-dir");
  server.use(
    http.get(REPO, ({ request }) => {
      seen(request);
      return HttpResponse.json({ full_name: "acme/widgets" });
    }),
    // the base is as the clone has it: nothing to refresh
    http.get(`${REPO}/git/ref/heads/main`, ({ request }) => {
      seen(request);
      return HttpResponse.json({ object: { sha: baseSha } });
    }),
    http.get(`${REPO}/git/blobs/:sha`, ({ request, params }) => {
      seen(request);
      const sha = String(params.sha);
      if (options.objectsFrom) {
        try {
          const content = execFileSync("git", ["cat-file", "blob", sha], {
            cwd: options.objectsFrom,
            stdio: ["ignore", "pipe", "ignore"],
          });
          return HttpResponse.json({
            sha,
            content: content.toString("base64"),
            encoding: "base64",
          });
        } catch {
          // a blob that repo lacks: GitHub's 404 below, as for any blob it doesn't hold
        }
      }
      return options.blobs?.includes(sha)
        ? HttpResponse.json({ sha })
        : HttpResponse.json({ message: "Not Found" }, { status: 404 });
    }),
    http.get(`${REPO}/git/trees/:sha`, ({ request, params }) => {
      seen(request);
      if (!options.objectsFrom) {
        return HttpResponse.json({ message: "Not Found" }, { status: 404 });
      }
      const recursive = new URL(request.url).searchParams.has("recursive");
      const out = execFileSync(
        "git",
        ["ls-tree", "-z", ...(recursive ? ["-r"] : []), String(params.sha)],
        { cwd: options.objectsFrom, encoding: "utf8" },
      );
      const tree = out
        .split("\0")
        .filter(Boolean)
        .map((line) => {
          const [meta = "", path = ""] = line.split("\t");
          const [mode, type, sha] = meta.split(" ");
          return { path, mode, type, sha };
        });
      return HttpResponse.json({ sha: params.sha, tree, truncated: false });
    }),
    http.get(`${REPO}/git/commits/:sha`, ({ request, params }) => {
      seen(request);
      const tree = options.commitTrees?.[String(params.sha)];
      return tree
        ? HttpResponse.json({
            sha: params.sha,
            tree: { sha: tree },
            parents: (
              options.commitParents?.[String(params.sha)] ?? [baseSha]
            ).map((sha) => ({ sha })),
          })
        : HttpResponse.json({ message: "Not Found" }, { status: 404 });
    }),
    http.post(`${REPO}/git/blobs`, async ({ request }) => {
      seen(request);
      state.blobs.push((await request.json()) as never);
      return HttpResponse.json(
        { sha: `blob${state.blobs.length}` },
        { status: 201 },
      );
    }),
    http.post(`${REPO}/git/trees`, async ({ request }) => {
      seen(request);
      state.trees.push((await request.json()) as never);
      return HttpResponse.json(
        { sha: `tree${state.trees.length}` },
        { status: 201 },
      );
    }),
    http.post(`${REPO}/git/commits`, async ({ request }) => {
      seen(request);
      state.commits.push((await request.json()) as never);
      return HttpResponse.json(
        { sha: `commit${state.commits.length}` },
        { status: 201 },
      );
    }),
    http.get(`${REPO}/git/ref/heads/${remoteBranch}`, ({ request }) => {
      seen(request);
      return state.ref
        ? HttpResponse.json({
            ref: `refs/heads/${remoteBranch}`,
            object: { sha: state.ref, type: "commit" },
          })
        : HttpResponse.json({ message: "Not Found" }, { status: 404 });
    }),
    http.post(`${REPO}/git/refs`, async ({ request }) => {
      seen(request);
      const body = (await request.json()) as { sha: string };
      state.refWrites.push({ method: "POST", body });
      state.ref = body.sha;
      return HttpResponse.json({ object: { sha: body.sha } }, { status: 201 });
    }),
    http.patch(
      `${REPO}/git/refs/heads/${remoteBranch}`,
      async ({ request }) => {
        seen(request);
        const body = (await request.json()) as { sha: string };
        state.refWrites.push({ method: "PATCH", body });
        state.ref = body.sha;
        return HttpResponse.json({ object: { sha: body.sha } });
      },
    ),
    http.get(`${REPO}/pulls`, ({ request }) => {
      seen(request);
      const url = new URL(request.url);
      expect(url.searchParams.get("state")).toBe("open");
      const head = url.searchParams.get("head");
      return HttpResponse.json(
        state.pulls.filter((p) => `acme:${p.head}` === head),
      );
    }),
    http.patch(`${REPO}/pulls/:number`, async ({ request, params }) => {
      seen(request);
      state.pullUpdates.push({
        number: String(params.number),
        body: (await request.json()) as Record<string, unknown>,
      });
      return state.allowPullUpdates
        ? HttpResponse.json({ number: Number(params.number) })
        : HttpResponse.json(
            { message: "unexpected PATCH to a pull" },
            { status: 500 },
          );
    }),
    http.post(`${REPO}/pulls`, async ({ request }) => {
      seen(request);
      const body = (await request.json()) as { head: string; base: string };
      state.pullCreates.push(body);
      const pull = {
        number: 7,
        html_url: "https://github.com/acme/widgets/pull/7",
        head: body.head,
        base: body.base,
      };
      state.pulls.push(pull);
      return HttpResponse.json(pull, { status: 201 });
    }),
  );
  return state;
}

const run = (extra: Partial<Parameters<typeof publish>[0]> = {}) =>
  publish({
    cwd: work,
    gatewayUrl: GATEWAY,
    connectorId: CONNECTOR,
    title: "Add widgets",
    ...extra,
  });

const b64 = (s: string) => Buffer.from(s).toString("base64");

test("a new branch: each commit becomes blobs, a tree on the base tree and a commit, then the ref is created and a PR opened", async () => {
  const gh = fakeGitHub();
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a\n\nWith a body.");
  writeFileSync(join(work, "run.sh"), "#!/bin/sh\necho hi\n");
  chmodSync(join(work, "run.sh"), 0o755);
  symlinkSync("a.txt", join(work, "link"));
  commit("Add a script and a link", "2026-10-30T13:00:00+00:00");

  const result = await run({ body: "Details here." });

  expect(gh.blobs).toEqual([
    { content: b64("first\n"), encoding: "base64" },
    { content: b64("a.txt"), encoding: "base64" },
    { content: b64("#!/bin/sh\necho hi\n"), encoding: "base64" },
  ]);
  const baseTree = git(work, "rev-parse", `${baseSha}^{tree}`);
  expect(gh.trees).toEqual([
    {
      base_tree: baseTree,
      tree: [{ path: "a.txt", mode: "100644", type: "blob", sha: "blob1" }],
    },
    {
      base_tree: "tree1",
      tree: expect.arrayContaining([
        { path: "link", mode: "120000", type: "blob", sha: "blob2" },
        { path: "run.sh", mode: "100755", type: "blob", sha: "blob3" },
      ]),
    },
  ]);
  const author = {
    name: "Claude",
    email: "noreply@anthropic.com",
    date: "2026-10-30T10:00:00Z",
  };
  expect(gh.commits).toEqual([
    {
      message: "Add a\n\nWith a body.\n",
      tree: "tree1",
      parents: [baseSha],
      author,
      committer: author,
    },
    {
      message: "Add a script and a link\n",
      tree: "tree2",
      parents: ["commit1"],
      author: { ...author, date: "2026-10-30T13:00:00Z" },
      committer: { ...author, date: "2026-10-30T13:00:00Z" },
    },
  ]);
  expect(gh.refWrites).toEqual([
    {
      method: "POST",
      body: { ref: "refs/heads/claude/agt_1", sha: "commit2" },
    },
  ]);
  expect(gh.pullCreates).toEqual([
    {
      title: "Add widgets",
      body: "Details here.",
      head: "claude/agt_1",
      base: "main",
    },
  ]);
  expect(result).toEqual({
    branch: "claude/agt_1",
    base: "main",
    sha: "commit2",
    created: true,
    updated: false,
    pullRequest: { number: 7, url: "https://github.com/acme/widgets/pull/7" },
  });
});

test("no request carries a credential: the gateway injects it", async () => {
  const gh = fakeGitHub();
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a");
  await run();
  expect(gh.authorization.length).toBeGreaterThan(0);
  expect(new Set(gh.authorization)).toEqual(new Set([null]));
});

test("an existing ref is fast-forwarded with force off, replaying only the commits GitHub lacks", async () => {
  writeFileSync(join(work, "a.txt"), "first\n");
  const first = commit("Add a");
  writeFileSync(join(work, "b.txt"), "second\n");
  commit("Add b");
  const gh = fakeGitHub({ ref: first });

  const result = await run();

  expect(gh.blobs).toEqual([{ content: b64("second\n"), encoding: "base64" }]);
  expect(gh.trees).toEqual([
    {
      base_tree: git(work, "rev-parse", `${first}^{tree}`),
      tree: [{ path: "b.txt", mode: "100644", type: "blob", sha: "blob1" }],
    },
  ]);
  expect(gh.commits.map((c) => c.parents)).toEqual([[first]]);
  expect(gh.refWrites).toEqual([
    { method: "PATCH", body: { sha: "commit1", force: false } },
  ]);
  expect(result.sha).toBe("commit1");
});

test("an open PR for the branch is returned, not duplicated", async () => {
  const gh = fakeGitHub({
    pulls: [
      {
        number: 3,
        html_url: "https://github.com/acme/widgets/pull/3",
        head: "claude/agt_1",
        base: "main",
      },
    ],
  });
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a");

  const result = await run({ title: undefined });

  expect(gh.pullCreates).toEqual([]);
  expect(result).toMatchObject({
    created: false,
    pullRequest: { number: 3, url: "https://github.com/acme/widgets/pull/3" },
  });
});

const OPEN_PR: Pull = {
  number: 3,
  html_url: "https://github.com/acme/widgets/pull/3",
  head: "claude/agt_1",
  base: "main",
};

const publishWithoutTitle = (body?: string) =>
  publish({
    cwd: work,
    gatewayUrl: GATEWAY,
    connectorId: CONNECTOR,
    ...(body !== undefined && { body }),
  });

test("an open PR gets the title and body given, through a PATCH", async () => {
  const gh = fakeGitHub({ pulls: [OPEN_PR], allowPullUpdates: true });
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a");

  const result = await run({ title: "New title", body: "New body" });

  expect(gh.pullUpdates).toEqual([
    { number: "3", body: { title: "New title", body: "New body" } },
  ]);
  expect(result).toMatchObject({ created: false, updated: true });
});

test("an open PR given only a body gets only the body", async () => {
  const gh = fakeGitHub({ pulls: [OPEN_PR], allowPullUpdates: true });
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a");

  await publishWithoutTitle("Only body");

  expect(gh.pullUpdates).toEqual([
    { number: "3", body: { body: "Only body" } },
  ]);
});

test("an open PR given only a title gets only the title", async () => {
  const gh = fakeGitHub({ pulls: [OPEN_PR], allowPullUpdates: true });
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a");

  await run({ title: "Only title" });

  expect(gh.pullUpdates).toEqual([
    { number: "3", body: { title: "Only title" } },
  ]);
});

test("an open PR's body is stripped of Claude Code's attribution before the PATCH", async () => {
  const gh = fakeGitHub({ pulls: [OPEN_PR], allowPullUpdates: true });
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a");

  await run({
    title: "Add widgets",
    body: "## Summary\n\nFixed review notes.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n",
  });

  expect(gh.pullUpdates).toEqual([
    {
      number: "3",
      body: {
        title: "Add widgets",
        body: "## Summary\n\nFixed review notes.\n",
      },
    },
  ]);
});

test("an open PR given neither title nor body is sent no PATCH", async () => {
  const gh = fakeGitHub({ pulls: [OPEN_PR] });
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a");

  const result = await publishWithoutTitle();

  expect(result).toMatchObject({ created: false, updated: false });
  expect(gh.pullUpdates).toEqual([]);
});

test("an open PR's title and body are refreshed even when its branch is already at HEAD on GitHub", async () => {
  writeFileSync(join(work, "a.txt"), "first\n");
  const head = commit("Add a");
  const gh = fakeGitHub({
    ref: head,
    pulls: [OPEN_PR],
    allowPullUpdates: true,
  });

  const result = await run({ title: "Reworded", body: "Fresh body" });

  expect(gh.refWrites).toEqual([]);
  expect(gh.pullUpdates).toEqual([
    { number: "3", body: { title: "Reworded", body: "Fresh body" } },
  ]);
  expect(result).toMatchObject({ sha: head, created: false, updated: true });
});

test("a GitHub error on the PR update surfaces as a GatewayError naming the call", async () => {
  fakeGitHub({ pulls: [OPEN_PR] });
  server.use(
    http.patch(`${REPO}/pulls/3`, () =>
      HttpResponse.json({ message: "Validation Failed" }, { status: 422 }),
    ),
  );
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a");

  const error = await run({ title: "New title" }).catch((e: unknown) => e);

  expect(error).toBeInstanceOf(GatewayError);
  expect((error as GatewayError).status).toBe(422);
  expect((error as Error).message).toBe(
    "GitHub gateway: PATCH /repos/acme/widgets/pulls/3 returned 422: Validation Failed",
  );
});

test("a new PR is created with the title and body given", async () => {
  const gh = fakeGitHub();
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a");

  await run({ body: "Why" });

  expect(gh.pullUpdates).toEqual([]);
  expect(gh.pullCreates).toEqual([
    { title: "Add widgets", body: "Why", head: "claude/agt_1", base: "main" },
  ]);
});

test("Claude Code's footer and Co-Authored-By trailers are stripped from PR bodies and commit messages", async () => {
  const gh = fakeGitHub();
  writeFileSync(join(work, "a.txt"), "first\n");
  commit(
    "Add a\n\nKeeps this line.\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>",
  );

  await run({
    body: "## Summary\n\nWhy.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n",
  });

  expect(gh.commits[0]?.message).toBe("Add a\n\nKeeps this line.\n");
  expect(gh.pullCreates).toMatchObject([{ body: "## Summary\n\nWhy.\n" }]);
});

test("every co-author trailer is stripped from commit messages and PR bodies, whoever the co-author", async () => {
  const gh = fakeGitHub();
  writeFileSync(join(work, "a.txt"), "first\n");
  commit(
    "Add a\n\nSigned-off-by: Ada <ada@example.com>\nco-authored-by: Ada <ada@example.com>\nCo-Authored-By: Claude Shannon <claude@example.com>\n",
  );

  await run({ body: "Why.\n\nCo-authored-by: Grace <grace@example.com>\n" });

  expect(gh.commits[0]?.message).toBe(
    "Add a\n\nSigned-off-by: Ada <ada@example.com>\n",
  );
  expect(gh.pullCreates).toMatchObject([{ body: "Why.\n" }]);
});

test("attribution quoted in a fenced block or mid-text is left in PR bodies and commit messages", async () => {
  const gh = fakeGitHub();
  const fenced =
    "Strip the trailer:\n\n```\nCo-Authored-By: Claude <noreply@anthropic.com>\n```\n";
  const midText =
    "Drops the footer\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\nfrom PR bodies.\n";
  writeFileSync(join(work, "a.txt"), "first\n");
  commit(`Add a\n\n${midText}`);

  await run({ body: fenced });

  expect(gh.commits[0]?.message).toBe(`Add a\n\n${midText}`);
  expect(gh.pullCreates).toMatchObject([{ body: fenced }]);
});

test("stripAttribution drops co-authors and the footer from the trailing block only", () => {
  expect(
    stripAttribution(
      "Fix\n\nSigned-off-by: Ada <ada@example.com>\nco-authored-by: Fable 2 <noreply@anthropic.com>\n",
    ),
  ).toBe("Fix\n\nSigned-off-by: Ada <ada@example.com>\n");
  expect(
    stripAttribution(
      "Fix\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\nCo-Authored-By: Ada <ada@example.com>\n",
    ),
  ).toBe("Fix\n");
  const prose = "Co-authored-by: Ada <a@b.c>\n\nThen prose.";
  expect(stripAttribution(prose)).toBe(prose);
});

test("a deleted file is a tree entry with a null sha", async () => {
  const gh = fakeGitHub();
  unlinkSync(join(work, "old.txt"));
  commit("Remove old");

  await run();

  expect(gh.blobs).toEqual([]);
  expect(gh.trees[0]?.tree).toEqual([
    { path: "old.txt", mode: "100644", type: "blob", sha: null },
  ]);
});

test("a gateway error names the call, the status and GitHub's message", async () => {
  fakeGitHub();
  server.use(
    http.post(`${REPO}/git/blobs`, () =>
      HttpResponse.json(
        { message: "Resource not accessible by integration" },
        { status: 403 },
      ),
    ),
  );
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a");

  const error = await run().catch((e: unknown) => e);
  expect(error).toBeInstanceOf(GatewayError);
  expect((error as Error).message).toBe(
    "GitHub gateway: POST /repos/acme/widgets/git/blobs returned 403: Resource not accessible by integration",
  );
});

test("a branch with no commits past its base, or with uncommitted changes, publishes nothing", async () => {
  await expect(run()).rejects.toThrow(/no commits on claude\/agt_1 past main/);
  writeFileSync(join(work, "a.txt"), "draft\n");
  await expect(run()).rejects.toThrow(/uncommitted changes/);
});

test("a rebase left in progress by a killed run is named with its way out, not as a detached HEAD", async () => {
  const gh = fakeGitHub();
  writeFileSync(join(work, "README"), "mine\n");
  const mine = commit("Edit README");
  git(work, "checkout", "-q", "-b", "elsewhere", baseSha);
  writeFileSync(join(work, "README"), "theirs\n");
  const theirs = commit("Edit README too");
  git(work, "checkout", "-q", "claude/agt_1");
  // stops on the conflict with HEAD detached, as a run killed mid-rebase leaves it
  expect(() =>
    execFileSync("git", ["rebase", "--quiet", theirs], {
      cwd: work,
      stdio: "pipe",
    }),
  ).toThrow();

  const failure = run();

  await expect(failure).rejects.toThrow(
    /a rebase of claude\/agt_1 is in progress here.*git rebase --abort/,
  );
  await expect(failure).rejects.not.toThrow(/detached/);
  expect(gh.authorization).toEqual([]);
  git(work, "rebase", "--abort");
  expect(git(work, "rev-parse", "HEAD")).toBe(mine);
});

test("the publish command prints the PR URL, and without a connector exits 2 naming the secret to set", async () => {
  fakeGitHub();
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a");
  const out: string[] = [];
  const err: string[] = [];
  const io = {
    cwd: work,
    stdout: (s: string) => void out.push(s),
    stderr: (s: string) => void err.push(s),
  };

  expect(await publishMain(["--title", "Add a"], {}, io)).toBe(2);
  expect(err.join("")).toContain(
    "sky secret set <env> GITHUB_CONNECTOR --connector=<connection id>",
  );

  const env = { GITHUB_CONNECTOR: CONNECTOR, GITHUB_GATEWAY_URL: GATEWAY };
  expect(await publishMain(["--title", "Add a"], env, io)).toBe(0);
  expect(out).toEqual(["https://github.com/acme/widgets/pull/7\n"]);
});

test("the publish command says an open PR was updated only when its title or body was sent", async () => {
  const gh = fakeGitHub({
    pulls: [
      {
        number: 3,
        html_url: "https://github.com/acme/widgets/pull/3",
        head: "claude/agt_1",
        base: "main",
      },
    ],
  });
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a");
  const err: string[] = [];
  const io = {
    cwd: work,
    stdout: () => {},
    stderr: (s: string) => void err.push(s),
  };
  const env = { GITHUB_CONNECTOR: CONNECTOR, GITHUB_GATEWAY_URL: GATEWAY };

  expect(await publishMain([], env, io)).toBe(0);
  expect(gh.pullUpdates).toEqual([]);
  expect(err.join("")).toMatch(
    /^sky publish: pull request #3 was already open; /,
  );

  err.length = 0;
  gh.ref = undefined;
  gh.allowPullUpdates = true;
  expect(await publishMain(["--title", "Add a"], env, io)).toBe(0);
  expect(err.join("")).toMatch(
    /^sky publish: pull request #3 was already open and updated; /,
  );
});

test("a re-publish whose earlier commits GitHub holds under other shas resumes from the one with the same tree", async () => {
  writeFileSync(join(work, "a.txt"), "first\n");
  const first = commit("Add a");
  writeFileSync(join(work, "b.txt"), "second\n");
  commit("Add b");
  const firstTree = git(work, "rev-parse", `${first}^{tree}`);
  const gh = fakeGitHub({
    ref: "gh_first",
    commitTrees: { gh_first: firstTree },
  });

  await run();

  expect(gh.trees).toEqual([
    {
      base_tree: firstTree,
      tree: [{ path: "b.txt", mode: "100644", type: "blob", sha: "blob1" }],
    },
  ]);
  expect(gh.commits.map((c) => c.parents)).toEqual([["gh_first"]]);
  expect(gh.refWrites).toEqual([
    { method: "PATCH", body: { sha: "commit1", force: false } },
  ]);
});

test("a head GitHub holds with this branch's tree but on a base that has since moved is replaced, not built upon, so no stale history stays under the new commits", async () => {
  writeFileSync(join(work, "a.txt"), "first\n");
  const first = commit("Add a");
  const firstTree = git(work, "rev-parse", `${first}^{tree}`);
  const gh = fakeGitHub({
    ref: "gh_stale",
    commitTrees: { gh_stale: firstTree, gh_old_base: firstTree },
    commitParents: { gh_stale: ["gh_old_base"], gh_old_base: [] },
  });

  await run();

  expect(gh.commits.map((c) => c.parents)).toEqual([[baseSha]]);
  expect(gh.refWrites).toEqual([
    { method: "PATCH", body: { sha: "commit1", force: true } },
  ]);
});

test("a blob GitHub already holds is not uploaded again", async () => {
  writeFileSync(join(work, "a.txt"), "first\n");
  writeFileSync(join(work, "b.txt"), "second\n");
  commit("Add a and b");
  const aSha = git(work, "rev-parse", "HEAD:a.txt");
  const gh = fakeGitHub({ blobs: [aSha] });

  await run();

  expect(gh.blobs).toEqual([{ content: b64("second\n"), encoding: "base64" }]);
  expect(gh.trees[0]?.tree).toEqual([
    { path: "a.txt", mode: "100644", type: "blob", sha: aSha },
    { path: "b.txt", mode: "100644", type: "blob", sha: "blob1" },
  ]);
});

test("a branch already at HEAD on GitHub moves no ref and returns its open PR", async () => {
  writeFileSync(join(work, "a.txt"), "first\n");
  const head = commit("Add a");
  const gh = fakeGitHub({
    ref: head,
    pulls: [
      {
        number: 3,
        html_url: "https://github.com/acme/widgets/pull/3",
        head: "claude/agt_1",
        base: "main",
      },
    ],
  });

  const result = await run({ title: undefined });

  expect(gh.blobs).toEqual([]);
  expect(gh.commits).toEqual([]);
  expect(gh.refWrites).toEqual([]);
  expect(result).toMatchObject({ sha: head, created: false });
});

test("a ref GitHub refuses to fast-forward says the history was rewritten", async () => {
  writeFileSync(join(work, "a.txt"), "first\n");
  const first = commit("Add a");
  writeFileSync(join(work, "b.txt"), "second\n");
  commit("Add b");
  fakeGitHub({ ref: first });
  server.use(
    http.patch(`${REPO}/git/refs/heads/claude/agt_1`, () =>
      HttpResponse.json(
        { message: "Update is not a fast forward" },
        { status: 422 },
      ),
    ),
  );

  await expect(run()).rejects.toThrow(
    "claude/agt_1 on GitHub isn't an ancestor of this branch and holds a commit this branch never had, as when someone pushed there; it can't be fast-forwarded and isn't overwritten (GitHub gateway: PATCH /repos/acme/widgets/git/refs/heads/claude/agt_1 returned 422: Update is not a fast forward)",
  );
});

test("publishes to the start branch and skips the base rebase", async () => {
  // someone's branch, with their commit, that this agent continues on claude/agt_1
  git(work, "config", "branch.claude/agt_1.sky-remote-branch", "feature/x");
  writeFileSync(join(work, "theirs.txt"), "theirs\n");
  const theirs = commit("Their change");
  writeFileSync(join(work, "mine.txt"), "mine\n");
  commit("Agent change");
  const gh = fakeGitHub({
    pulls: [
      {
        number: 4,
        html_url: "https://github.com/acme/widgets/pull/4",
        head: "feature/x",
        base: "main",
      },
    ],
  });
  let remoteRef = theirs;
  const refWrites: unknown[] = [];
  server.use(
    // the base moved on GitHub; a rebase onto it would fetch the new head and fail on it here
    http.get(`${REPO}/git/ref/heads/main`, () =>
      HttpResponse.json({ object: { sha: "e".repeat(40) } }),
    ),
    http.get(`${REPO}/git/ref/heads/feature/x`, () =>
      HttpResponse.json({ object: { sha: remoteRef } }),
    ),
    http.patch(`${REPO}/git/refs/heads/feature/x`, async ({ request }) => {
      const body = (await request.json()) as { sha: string };
      refWrites.push(body);
      remoteRef = body.sha;
      return HttpResponse.json({ object: { sha: body.sha } });
    }),
  );

  const result = await run({ title: undefined });

  expect(gh.commits.map((c) => [c.message, c.parents])).toEqual([
    ["Agent change\n", [theirs]],
  ]);
  expect(refWrites).toEqual([{ sha: "commit1", force: false }]);
  expect(gh.refWrites).toEqual([]);
  expect(result).toEqual({
    branch: "feature/x",
    base: "main",
    sha: "commit1",
    created: false,
    updated: false,
    pullRequest: { number: 4, url: "https://github.com/acme/widgets/pull/4" },
  });
  expect(git(work, "rev-parse", "--abbrev-ref", "HEAD")).toBe("claude/agt_1");
});

test("with no open PR and no title, nothing is written", async () => {
  const gh = fakeGitHub();
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a");

  await expect(run({ title: undefined })).rejects.toThrow(
    "a title is needed to open the pull request",
  );
  expect(gh.blobs).toEqual([]);
  expect(gh.refWrites).toEqual([]);
});

test("a failed ref lookup surfaces instead of reading as a new branch", async () => {
  const gh = fakeGitHub();
  server.use(
    http.get(`${REPO}/git/ref/heads/claude/agt_1`, () =>
      HttpResponse.json({ message: "Server Error" }, { status: 500 }),
    ),
  );
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a");

  await expect(run()).rejects.toThrow(
    "GitHub gateway: GET /repos/acme/widgets/git/ref/heads/claude/agt_1 returned 500: Server Error",
  );
  expect(gh.refWrites).toEqual([]);
});

test("a repo the connector can't see names the connector, not the branch", async () => {
  fakeGitHub();
  server.use(
    http.get(REPO, () =>
      HttpResponse.json({ message: "Not Found" }, { status: 404 }),
    ),
  );
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a");

  await expect(run()).rejects.toThrow(
    "the connector in GITHUB_CONNECTOR can't see acme/widgets; check its connection id and the repos it grants (GitHub gateway: GET /repos/acme/widgets returned 404: Not Found)",
  );
});

test("a rate-limit pause GitHub asks for is waited out, then the call goes on", async () => {
  const gh = fakeGitHub();
  let refused = 0;
  server.use(
    http.post(
      `${REPO}/git/blobs`,
      () => {
        refused++;
        return HttpResponse.json(
          { message: "You have exceeded a secondary rate limit" },
          { status: 403, headers: { "retry-after": "0" } },
        );
      },
      { once: true },
    ),
  );
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a");

  await run();

  expect(refused).toBe(1);
  expect(gh.blobs).toEqual([{ content: b64("first\n"), encoding: "base64" }]);
});

test("a spent rate limit that resets within the wait is waited out until x-ratelimit-reset, then the call goes on", async () => {
  const gh = fakeGitHub();
  let refused = 0;
  const reset = Math.floor(Date.now() / 1000) + 1;
  server.use(
    http.post(
      `${REPO}/git/blobs`,
      () => {
        refused++;
        return HttpResponse.json(
          { message: "API rate limit exceeded" },
          {
            status: 403,
            headers: {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": String(reset),
            },
          },
        );
      },
      { once: true },
    ),
  );
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a");

  const before = Date.now();
  await run();

  expect(refused).toBe(1);
  expect(Date.now()).toBeGreaterThanOrEqual(reset * 1000);
  expect(Date.now() - before).toBeLessThan(10_000);
  expect(gh.blobs).toEqual([{ content: b64("first\n"), encoding: "base64" }]);
});

test("a spent rate limit that resets later than the wait allows fails naming the reset time, with no raw 403", async () => {
  fakeGitHub();
  const reset = Math.floor(Date.now() / 1000) + 3000;
  server.use(
    http.post(`${REPO}/git/blobs`, () =>
      HttpResponse.json(
        { message: "API rate limit exceeded" },
        {
          status: 403,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(reset),
          },
        },
      ),
    ),
  );
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a");

  const error = await run().catch((e: Error) => e);

  expect((error as Error).message).toContain(
    `rate limit, which resets at ${new Date(reset * 1000).toISOString()}`,
  );
  expect((error as Error).message).not.toContain("API rate limit exceeded");
});

test("--branch sends the commits to the named GitHub branch and opens the PR from it, while the worktree keeps its own branch", async () => {
  const gh = fakeGitHub({ branch: "feature/widgets" });
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a");

  const result = await run({ branch: "feature/widgets" });

  expect(gh.refWrites).toEqual([
    {
      method: "POST",
      body: { ref: "refs/heads/feature/widgets", sha: "commit1" },
    },
  ]);
  expect(gh.pullCreates).toMatchObject([
    { head: "feature/widgets", base: "main" },
  ]);
  expect(result.branch).toBe("feature/widgets");
  expect(git(work, "symbolic-ref", "--short", "HEAD")).toBe("claude/agt_1");
});

test("--branch finds the open PR for the named branch and updates it instead of opening another", async () => {
  const gh = fakeGitHub({
    branch: "feature/widgets",
    allowPullUpdates: true,
    pulls: [
      {
        number: 3,
        html_url: "https://github.com/acme/widgets/pull/3",
        head: "feature/widgets",
        base: "main",
      },
    ],
  });
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a");

  const result = await run({ branch: "feature/widgets", title: "Renamed" });

  expect(gh.pullCreates).toEqual([]);
  expect(gh.pullUpdates).toMatchObject([
    { number: "3", body: { title: "Renamed" } },
  ]);
  expect(result).toMatchObject({ created: false, updated: true });
});

test("--branch after the local history was amended force-updates the named branch", async () => {
  writeFileSync(join(work, "a.txt"), "first\n");
  const old = commit("Add a");
  const gh = fakeGitHub({
    branch: "feature/widgets",
    ref: old,
    commitTrees: { [old]: git(work, "rev-parse", `${old}^{tree}`) },
  });
  writeFileSync(join(work, "a.txt"), "first, amended\n");
  git(work, "add", "--all");
  git(
    work,
    "-c",
    "user.name=Claude",
    "-c",
    "user.email=noreply@anthropic.com",
    "commit",
    "-q",
    "--amend",
    "--no-edit",
  );

  await run({ branch: "feature/widgets" });

  expect(gh.refWrites.at(-1)).toMatchObject({
    method: "PATCH",
    body: { force: true },
  });
});

test("--branch must be a valid branch name other than the base, refused before anything reaches GitHub", async () => {
  const gh = fakeGitHub();
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a");
  const refused = [
    ["main", "main is the base branch; publish to a branch of its own"],
    ["bad name", "bad name is not a valid branch name"],
    ["a..b", "a..b is not a valid branch name"],
    ["-x", "-x is not a valid branch name"],
    ["ends.lock", "ends.lock is not a valid branch name"],
  ] as const;
  for (const [branch, message] of refused) {
    await expect(run({ branch })).rejects.toThrow(message);
  }
  // the default branch stays off limits when --base names another
  await expect(run({ branch: "main", base: "develop" })).rejects.toThrow(
    "main is the base branch",
  );
  expect(gh.authorization).toEqual([]);
  expect(gh.blobs).toEqual([]);
  expect(gh.commits).toEqual([]);
  expect(gh.refWrites).toEqual([]);
  expect(gh.pullCreates).toEqual([]);
});

test("--branch refuses HEAD and a ref path or remote prefix, before anything reaches GitHub", async () => {
  const gh = fakeGitHub();
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a");
  for (const branch of [
    "HEAD",
    "refs/heads/feature",
    "refs/feature",
    "origin/feature",
  ]) {
    await expect(run({ branch })).rejects.toThrow(
      `${branch} is not a valid branch name`,
    );
  }
  expect(gh.authorization).toEqual([]);
  expect(gh.refWrites).toEqual([]);
  expect(gh.pullCreates).toEqual([]);
});

const publishEnv = { GITHUB_CONNECTOR: CONNECTOR, GITHUB_GATEWAY_URL: GATEWAY };

const publishMainWith = async (args: string[], env: Record<string, string>) => {
  let stderr = "";
  const status = await publishMain(
    args,
    { ...publishEnv, ...env },
    {
      cwd: work,
      stdout: () => {},
      stderr: (s) => {
        stderr += s;
      },
    },
  );
  return { status, stderr };
};

test("--body @path reads the pull request body from that file", async () => {
  const gh = fakeGitHub();
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a");
  const file = join(root, "pr-body.md");
  writeFileSync(file, "## Summary\n\nFrom a file.\n");

  const { status } = await publishMainWith(
    ["--title", "T", "--body", `@${file}`],
    {},
  );

  expect(status).toBe(0);
  expect(gh.pullCreates).toMatchObject([
    { body: "## Summary\n\nFrom a file.\n" },
  ]);
});

test("--body @path that can't be read exits 2 naming the file, and publishes nothing", async () => {
  const gh = fakeGitHub();
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a");
  const file = join(root, "missing.md");

  const { status, stderr } = await publishMainWith(
    ["--title", "T", "--body", `@${file}`],
    {},
  );

  expect(status).toBe(2);
  expect(stderr).toContain(`cannot read the --body file ${file} (ENOENT)`);
  expect(stderr).toContain(`usage: ${PUBLISH_USAGE}`);
  expect(gh.authorization).toEqual([]);
  expect(gh.pullCreates).toEqual([]);
  expect(gh.refWrites).toEqual([]);
});

test("--body @path with a relative path is read from the command's working directory", async () => {
  const gh = fakeGitHub();
  // committed with the rest: an untracked file would trip the clean-worktree check
  writeFileSync(join(work, "pr-body.md"), "## Summary\n\nRelative.\n");
  commit("Add the body file");

  const { status } = await publishMainWith(
    ["--title", "T", "--body", "@pr-body.md"],
    {},
  );

  expect(status).toBe(0);
  expect(gh.pullCreates).toMatchObject([{ body: "## Summary\n\nRelative.\n" }]);
});

test("a --body without @ is published as given", async () => {
  const gh = fakeGitHub();
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a");

  const { status } = await publishMainWith(
    ["--title", "T", "--body", "Why.\n"],
    {},
  );

  expect(status).toBe(0);
  expect(gh.pullCreates).toMatchObject([{ body: "Why.\n" }]);
});

test("SKY_PUBLISH_BRANCH is the command's default branch", async () => {
  const gh = fakeGitHub({ branch: "from/env" });
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a");

  const { status } = await publishMainWith(["--title", "T"], {
    SKY_PUBLISH_BRANCH: "from/env",
  });

  expect(status).toBe(0);
  expect(gh.pullCreates).toMatchObject([{ head: "from/env" }]);
});

test("--branch outranks SKY_PUBLISH_BRANCH", async () => {
  const gh = fakeGitHub({ branch: "cli/branch" });
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a");

  const { status } = await publishMainWith(
    ["--title", "T", "--branch", "cli/branch"],
    { SKY_PUBLISH_BRANCH: "from/env" },
  );

  expect(status).toBe(0);
  expect(gh.refWrites).toMatchObject([
    { body: { ref: "refs/heads/cli/branch" } },
  ]);
  expect(gh.pullCreates).toMatchObject([{ head: "cli/branch" }]);
});

test.each([
  ["the started-on branch outranks SKY_PUBLISH_BRANCH", [], "cfg/branch"],
  [
    "--branch outranks the started-on branch",
    ["--branch", "cli/branch"],
    "cli/branch",
  ],
])("%s", async (_, flags, expected) => {
  const gh = fakeGitHub({ branch: expected });
  git(work, "config", "branch.claude/agt_1.sky-remote-branch", "cfg/branch");
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a");

  const { status } = await publishMainWith(["--title", "T", ...flags], {
    SKY_PUBLISH_BRANCH: "from/env",
  });

  expect(status).toBe(0);
  expect(gh.pullCreates).toMatchObject([{ head: expected }]);
});

test("--branch over a continued branch sends every commit onto the base as a new branch, with no base rebase", async () => {
  git(work, "config", "branch.claude/agt_1.sky-remote-branch", "feature/x");
  writeFileSync(join(work, "theirs.txt"), "theirs\n");
  commit("Their change");
  writeFileSync(join(work, "mine.txt"), "mine\n");
  commit("Agent change");
  const gh = fakeGitHub({ branch: "cli/branch" });
  // the base moved on GitHub; a rebase onto it would fetch this head, which the fake doesn't hold
  server.use(
    http.get(`${REPO}/git/ref/heads/main`, () =>
      HttpResponse.json({ object: { sha: "e".repeat(40) } }),
    ),
  );

  const { status } = await publishMainWith(
    ["--title", "T", "--branch", "cli/branch"],
    {},
  );

  expect(status).toBe(0);
  expect(gh.commits.map((c) => [c.message, c.parents])).toEqual([
    ["Their change\n", [baseSha]],
    ["Agent change\n", ["commit1"]],
  ]);
  expect(gh.refWrites).toMatchObject([
    { method: "POST", body: { ref: "refs/heads/cli/branch", sha: "commit2" } },
  ]);
  expect(gh.pullCreates).toMatchObject([{ head: "cli/branch", base: "main" }]);
});

test("an empty SKY_PUBLISH_BRANCH falls back to the worktree's branch", async () => {
  const gh = fakeGitHub();
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a");

  const { status } = await publishMainWith(["--title", "T"], {
    SKY_PUBLISH_BRANCH: "",
  });

  expect(status).toBe(0);
  expect(gh.pullCreates).toMatchObject([{ head: "claude/agt_1" }]);
});

test("a configured author replaces the identity on every recreated commit, the committer defaulting to it and the dates kept", async () => {
  const gh = fakeGitHub();
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a");
  const io = { cwd: work, stdout: () => {}, stderr: () => {} };

  const status = await publishMain(
    ["--title", "T"],
    {
      GITHUB_CONNECTOR: CONNECTOR,
      GITHUB_GATEWAY_URL: GATEWAY,
      GIT_AUTHOR_NAME: "Dev Person",
      GIT_AUTHOR_EMAIL: "dev@example.com",
    },
    io,
  );

  expect(status).toBe(0);
  const dev = {
    name: "Dev Person",
    email: "dev@example.com",
    date: "2026-10-30T10:00:00Z",
  };
  expect(gh.commits).toMatchObject([{ author: dev, committer: dev }]);
});

test("a configured committer differs from the author when GIT_COMMITTER_* are set", async () => {
  const gh = fakeGitHub();
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a");
  const io = { cwd: work, stdout: () => {}, stderr: () => {} };

  await publishMain(
    ["--title", "T"],
    {
      GITHUB_CONNECTOR: CONNECTOR,
      GITHUB_GATEWAY_URL: GATEWAY,
      GIT_AUTHOR_NAME: "A",
      GIT_AUTHOR_EMAIL: "a@example.com",
      GIT_COMMITTER_NAME: "C",
      GIT_COMMITTER_EMAIL: "c@example.com",
    },
    io,
  );

  expect(gh.commits[0]).toMatchObject({
    author: { name: "A", email: "a@example.com" },
    committer: { name: "C", email: "c@example.com" },
  });
});

const CLAUDE = { name: "Claude", email: "noreply@anthropic.com" };

const identityCases: {
  name: string;
  env: Record<string, string>;
  author: { name: string; email: string };
  committer: { name: string; email: string };
}[] = [
  {
    name: "no identity variables at all",
    env: {},
    author: CLAUDE,
    committer: CLAUDE,
  },
  {
    name: "an author name without an email",
    env: { GIT_AUTHOR_NAME: "Dev Person" },
    author: CLAUDE,
    committer: CLAUDE,
  },
  {
    name: "an author email without a name",
    env: { GIT_AUTHOR_EMAIL: "dev@example.com" },
    author: CLAUDE,
    committer: CLAUDE,
  },
  {
    name: "a committer without any author",
    env: { GIT_COMMITTER_NAME: "C", GIT_COMMITTER_EMAIL: "c@example.com" },
    author: CLAUDE,
    committer: CLAUDE,
  },
  {
    name: "an author and only a committer name",
    env: {
      GIT_AUTHOR_NAME: "A",
      GIT_AUTHOR_EMAIL: "a@example.com",
      GIT_COMMITTER_NAME: "C",
    },
    author: { name: "A", email: "a@example.com" },
    committer: { name: "C", email: "a@example.com" },
  },
  {
    name: "an author and only a committer email",
    env: {
      GIT_AUTHOR_NAME: "A",
      GIT_AUTHOR_EMAIL: "a@example.com",
      GIT_COMMITTER_EMAIL: "c@example.com",
    },
    author: { name: "A", email: "a@example.com" },
    committer: { name: "A", email: "c@example.com" },
  },
];

test.each(identityCases)(
  "identity: $name",
  async ({ env, author, committer }) => {
    const gh = fakeGitHub();
    writeFileSync(join(work, "a.txt"), "first\n");
    commit("Add a");

    const { status } = await publishMainWith(["--title", "T"], env);

    expect(status).toBe(0);
    expect(gh.commits[0]).toMatchObject({
      author: { ...author, date: "2026-10-30T10:00:00Z" },
      committer: { ...committer, date: "2026-10-30T10:00:00Z" },
    });
  },
);

// the base as GitHub holds it, with workflow files already on it
const baseWithWorkflows = () => {
  mkdirSync(join(work, ".github/workflows"), { recursive: true });
  writeFileSync(join(work, ".github/workflows/ci.yml"), "name: ci\non: push\n");
  writeFileSync(join(work, ".github/workflows/old.yml"), "name: old\n");
  baseSha = commit("Base with CI");
  git(work, "update-ref", "refs/remotes/origin/main", baseSha);
};

const treePaths = (gh: ReturnType<typeof fakeGitHub>) =>
  gh.trees.flatMap((t) => (t.tree as { path: string }[]).map((e) => e.path));

const treeGets = (gh: ReturnType<typeof fakeGitHub>) =>
  gh.gets.filter((path) => path.includes("/git/trees/"));

const expectNothingSent = (gh: ReturnType<typeof fakeGitHub>) => {
  expect(gh.blobs).toEqual([]);
  expect(gh.trees).toEqual([]);
  expect(gh.commits).toEqual([]);
  expect(gh.refWrites).toEqual([]);
  expect(gh.pullCreates).toEqual([]);
  expect(gh.pullUpdates).toEqual([]);
};

test("workflow add, edit, delete and rename are held back while other files publish, and the patch applies to the published head", async () => {
  baseWithWorkflows();
  const gh = fakeGitHub();
  writeFileSync(join(work, "a.txt"), "first\n");
  writeFileSync(
    join(work, ".github/workflows/ci.yml"),
    "name: ci\non: [push, pull_request]\n",
  );
  writeFileSync(join(work, ".github/workflows/new.yml"), "name: new\n");
  git(work, "mv", ".github/workflows/old.yml", ".github/workflows/renamed.yml");
  commit("Add a and touch CI");
  rmSync(join(work, ".github/workflows/new.yml"));
  writeFileSync(join(work, "b.txt"), "second\n");
  commit("Add b, drop new.yml");
  writeFileSync(join(work, ".github/workflows/only.yml"), "name: only\n");
  commit("Workflow only");
  const head = git(work, "rev-parse", "HEAD");

  const result = await run();

  expect(treePaths(gh).sort()).toEqual(["a.txt", "b.txt"]);
  expect(gh.commits.map((c) => c.message)).toEqual([
    "Add a and touch CI\n",
    "Add b, drop new.yml\n",
  ]);
  expect(result.held?.files).toEqual([
    "M .github/workflows/ci.yml",
    "A .github/workflows/only.yml",
    "R .github/workflows/old.yml -> .github/workflows/renamed.yml",
  ]);
  expect(result.held?.patchPath).toBe(
    join(
      git(work, "rev-parse", "--absolute-git-dir"),
      "sky",
      "held-workflows.patch",
    ),
  );
  expect(readFileSync(result.held?.patchPath ?? "", "utf8")).toBe(
    result.held?.patch,
  );
  // the local branch is as it was
  expect(git(work, "rev-parse", "HEAD")).toBe(head);

  // the published head has the base's workflows; the patch brings them to the local ones
  const published = join(root, "published");
  execFileSync("git", ["clone", "-q", work, published]);
  git(published, "checkout", "-q", baseSha);
  git(published, "apply", "--check", result.held?.patchPath ?? "");
  git(published, "apply", result.held?.patchPath ?? "");
  for (const f of ["ci.yml", "only.yml", "renamed.yml"]) {
    expect(readFileSync(join(published, ".github/workflows", f), "utf8")).toBe(
      readFileSync(join(work, ".github/workflows", f), "utf8"),
    );
  }
  expect(existsSync(join(published, ".github/workflows/old.yml"))).toBe(false);

  // a later publish holds back the same files again
  const second = fakeGitHub();
  const again = await run();
  expect(again.held?.files).toEqual(result.held?.files);
  expect(treePaths(second).sort()).toEqual(["a.txt", "b.txt"]);
});

test("publishing from a subdirectory holds back, lists and patches workflows as from the root", async () => {
  baseWithWorkflows();
  const gh = fakeGitHub();
  mkdirSync(join(work, "sub"));
  writeFileSync(join(work, "sub/a.txt"), "first\n");
  writeFileSync(join(work, ".github/workflows/ci.yml"), "name: changed\n");
  commit("Add a, change CI");

  const result = await run({ cwd: join(work, "sub") });

  expect(treePaths(gh)).toEqual(["sub/a.txt"]);
  expect(result.held?.files).toEqual(["M .github/workflows/ci.yml"]);
  expect(readFileSync(result.held?.patchPath ?? "", "utf8")).toBe(
    result.held?.patch,
  );
  const published = join(root, "published");
  execFileSync("git", ["clone", "-q", work, published]);
  git(published, "checkout", "-q", baseSha);
  git(published, "apply", result.held?.patchPath ?? "");
  expect(
    readFileSync(join(published, ".github/workflows/ci.yml"), "utf8"),
  ).toBe("name: changed\n");
});

test("a workflow deleted on the branch is held back, and a commit touching only a workflow is skipped", async () => {
  baseWithWorkflows();
  const gh = fakeGitHub();
  rmSync(join(work, ".github/workflows/ci.yml"));
  commit("Drop CI");
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a");

  const result = await run();

  expect(gh.commits).toHaveLength(1);
  expect(gh.commits[0]).toMatchObject({
    message: "Add a\n",
    parents: [baseSha],
  });
  expect(treePaths(gh)).toEqual(["a.txt"]);
  expect(result.held?.files).toEqual(["D .github/workflows/ci.yml"]);
  expect(result.held?.patch).toContain("deleted file mode");
});

test("a branch whose only change is a workflow sends nothing and fails naming the patch", async () => {
  baseWithWorkflows();
  const gh = fakeGitHub();
  writeFileSync(join(work, ".github/workflows/new.yml"), "name: new\n");
  commit("Add a workflow");

  const error = await run().catch((e: unknown) => e);

  expect(error).toBeInstanceOf(Error);
  const named = /are held in (.+held-workflows\.patch): apply them/.exec(
    (error as Error).message,
  )?.[1];
  expect(named).toBe(
    join(
      git(work, "rev-parse", "--absolute-git-dir"),
      "sky",
      "held-workflows.patch",
    ),
  );
  expect(readFileSync(named ?? "", "utf8")).toContain("+name: new");
  expect(gh.commits).toEqual([]);
  expect(gh.refWrites).toEqual([]);
  expect(gh.pullCreates).toEqual([]);
});

test("the publish command names each held-back file on stderr and prints the patch after the PR URL", async () => {
  baseWithWorkflows();
  fakeGitHub();
  writeFileSync(join(work, "a.txt"), "first\n");
  writeFileSync(join(work, ".github/workflows/ci.yml"), "name: changed\n");
  commit("Add a, change CI");
  const out: string[] = [];
  const err: string[] = [];

  const status = await publishMain(
    ["--title", "T"],
    { GITHUB_CONNECTOR: CONNECTOR, GITHUB_GATEWAY_URL: GATEWAY },
    {
      cwd: work,
      stdout: (s) => void out.push(s),
      stderr: (s) => void err.push(s),
    },
  );

  expect(status).toBe(0);
  expect(err.join("")).toMatch(/M \.github\/workflows\/ci\.yml/);
  expect(err.join("")).toMatch(/held-workflows\.patch/);
  expect(err.join("")).toMatch(/outside the sandbox/);
  expect(out[0]).toBe("https://github.com/acme/widgets/pull/7\n");
  expect(out[1]?.startsWith(`${HELD_PATCH_BEGIN}\n`)).toBe(true);
  expect(out[1]).toContain("+name: changed");
  expect(out[1]?.endsWith(`\n${HELD_PATCH_END}\n`)).toBe(true);
});

test("workflow changes the branch reverts hold nothing back and remove the earlier patch", async () => {
  baseWithWorkflows();
  fakeGitHub();
  writeFileSync(join(work, "a.txt"), "first\n");
  writeFileSync(join(work, ".github/workflows/ci.yml"), "name: changed\n");
  commit("Add a, change CI");
  const first = await run();
  expect(existsSync(first.held?.patchPath ?? "")).toBe(true);
  writeFileSync(join(work, ".github/workflows/ci.yml"), "name: ci\non: push\n");
  commit("Revert CI");

  const second = fakeGitHub();
  const result = await run();

  expect(result.held).toBeUndefined();
  expect(existsSync(first.held?.patchPath ?? "")).toBe(false);
  expect(treePaths(second)).toEqual(["a.txt"]);
});

test("without workflow changes, no held result is returned and a stale patch is removed", async () => {
  baseWithWorkflows();
  const gh = fakeGitHub();
  const dir = join(git(work, "rev-parse", "--absolute-git-dir"), "sky");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "held-workflows.patch"), "stale\n");
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a");

  const result = await run();

  expect(result.held).toBeUndefined();
  expect(existsSync(join(dir, "held-workflows.patch"))).toBe(false);
  expect(treePaths(gh)).toEqual(["a.txt"]);
});

const heldPatchPath = () =>
  join(
    git(work, "rev-parse", "--absolute-git-dir"),
    "sky",
    "held-workflows.patch",
  );

test("a re-publish to a branch GitHub already holds, with its PR open and workflows still held, sends nothing and still returns the held changes", async () => {
  baseWithWorkflows();
  // what GitHub holds after the first publish: a.txt added, workflows as the base has them
  git(work, "checkout", "-qb", "expected");
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a");
  const publishedTree = git(work, "rev-parse", "HEAD^{tree}");
  git(work, "checkout", "-q", "claude/agt_1");
  writeFileSync(join(work, "a.txt"), "first\n");
  writeFileSync(join(work, ".github/workflows/ci.yml"), "name: changed\n");
  commit("Add a, change CI");
  const gh = fakeGitHub({
    ref: "gh_head",
    commitTrees: { gh_head: publishedTree },
    pulls: [OPEN_PR],
  });

  const result = await run({ title: undefined });

  expect(gh.blobs).toEqual([]);
  expect(gh.trees).toEqual([]);
  expect(gh.commits).toEqual([]);
  expect(gh.refWrites).toEqual([]);
  expect(result).toMatchObject({
    sha: "gh_head",
    created: false,
    updated: false,
    pullRequest: { number: 3, url: "https://github.com/acme/widgets/pull/3" },
  });
  expect(result.held?.files).toEqual(["M .github/workflows/ci.yml"]);
  expect(result.held?.patchPath).toBe(heldPatchPath());
  expect(existsSync(heldPatchPath())).toBe(true);
});

test("the tree sent sits on the base's own tree, so the workflows GitHub holds are the base's", async () => {
  baseWithWorkflows();
  const gh = fakeGitHub();
  writeFileSync(join(work, "a.txt"), "first\n");
  writeFileSync(join(work, ".github/workflows/ci.yml"), "name: changed\n");
  commit("Add a, change CI");

  await run();

  expect(gh.trees).toEqual([
    {
      base_tree: git(work, "rev-parse", `${baseSha}^{tree}`),
      tree: [{ path: "a.txt", mode: "100644", type: "blob", sha: "blob1" }],
    },
  ]);
});

test("on a base with no .github/workflows, a workflow the branch adds is held back and the patch applies to the base", async () => {
  const gh = fakeGitHub();
  mkdirSync(join(work, ".github/workflows"), { recursive: true });
  writeFileSync(join(work, ".github/workflows/ci.yml"), "name: ci\n");
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a and CI");

  const result = await run();

  expect(treePaths(gh)).toEqual(["a.txt"]);
  expect(gh.trees[0]?.base_tree).toBe(
    git(work, "rev-parse", `${baseSha}^{tree}`),
  );
  expect(result.held?.files).toEqual(["A .github/workflows/ci.yml"]);
  const published = join(root, "published");
  execFileSync("git", ["clone", "-q", work, published]);
  git(published, "checkout", "-q", baseSha);
  git(published, "apply", result.held?.patchPath ?? "");
  expect(
    readFileSync(join(published, ".github/workflows/ci.yml"), "utf8"),
  ).toBe("name: ci\n");
});

test("a holding publish leaves the worktree clean, with the workflow files on disk as the branch has them", async () => {
  baseWithWorkflows();
  fakeGitHub();
  writeFileSync(join(work, "a.txt"), "first\n");
  writeFileSync(join(work, ".github/workflows/ci.yml"), "name: changed\n");
  writeFileSync(join(work, ".github/workflows/new.yml"), "name: new\n");
  commit("Add a, change CI, add new");

  const result = await run();

  expect(result.held).toBeDefined();
  expect(git(work, "status", "--porcelain")).toBe("");
  expect(readFileSync(join(work, ".github/workflows/ci.yml"), "utf8")).toBe(
    "name: changed\n",
  );
  expect(readFileSync(join(work, ".github/workflows/new.yml"), "utf8")).toBe(
    "name: new\n",
  );
});

test("the publish command, with two workflows held, names both and the patch on stderr and prints the URL, then exactly the patch between its markers on stdout", async () => {
  baseWithWorkflows();
  fakeGitHub();
  writeFileSync(join(work, "a.txt"), "first\n");
  writeFileSync(join(work, ".github/workflows/ci.yml"), "name: changed\n");
  writeFileSync(join(work, ".github/workflows/new.yml"), "name: new\n");
  commit("Add a, change CI, add new");
  const out: string[] = [];
  const err: string[] = [];

  const status = await publishMain(
    ["--title", "T"],
    { GITHUB_CONNECTOR: CONNECTOR, GITHUB_GATEWAY_URL: GATEWAY },
    {
      cwd: work,
      stdout: (s) => void out.push(s),
      stderr: (s) => void err.push(s),
    },
  );

  expect(status).toBe(0);
  const stderr = err.join("");
  expect(stderr).toContain("held back 2 changes");
  expect(stderr).toContain("M .github/workflows/ci.yml");
  expect(stderr).toContain("A .github/workflows/new.yml");
  expect(stderr).toContain(`the patch is at ${heldPatchPath()}`);
  expect(stderr).toContain(
    "the PM must push these files from outside the sandbox",
  );
  const patch = readFileSync(heldPatchPath(), "utf8");
  expect(patch).toContain("+name: changed");
  expect(patch).toContain("+name: new");
  expect(out.join("")).toBe(
    `https://github.com/acme/widgets/pull/7\n${HELD_PATCH_BEGIN}\n${patch}${HELD_PATCH_END}\n`,
  );
});

test("a file moved into .github/workflows is deleted where it was and held back as an addition", async () => {
  writeFileSync(join(work, "deploy.yml"), "name: deploy\n");
  baseWithWorkflows();
  const gh = fakeGitHub();
  git(work, "mv", "deploy.yml", ".github/workflows/deploy.yml");
  commit("Move deploy into workflows");

  const result = await run();

  expect(gh.blobs).toEqual([]);
  expect(gh.trees[0]?.tree).toEqual([
    { path: "deploy.yml", mode: "100644", type: "blob", sha: null },
  ]);
  expect(treePaths(gh)).toEqual(["deploy.yml"]);
  expect(result.held?.files).toEqual(["A .github/workflows/deploy.yml"]);
});

test("a file moved out of .github/workflows is sent where it landed and held back as a deletion", async () => {
  baseWithWorkflows();
  const gh = fakeGitHub();
  git(work, "mv", ".github/workflows/old.yml", "old.yml");
  commit("Move old out of workflows");

  const result = await run();

  expect(gh.blobs).toEqual([
    { content: b64("name: old\n"), encoding: "base64" },
  ]);
  expect(gh.trees[0]?.tree).toEqual([
    { path: "old.yml", mode: "100644", type: "blob", sha: "blob1" },
  ]);
  expect(result.held?.files).toEqual(["D .github/workflows/old.yml"]);
});

/** What the PM pushes from outside the sandbox: `files` of the branch's own work, then the held patch applied. */
const pmPush = (patchPath: string, files: Record<string, string>) => {
  const pm = join(root, "pm");
  execFileSync("git", ["clone", "-q", work, pm]);
  git(pm, "checkout", "-q", baseSha);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(pm, path)), { recursive: true });
    writeFileSync(join(pm, path), content);
  }
  if (patchPath) git(pm, "apply", patchPath);
  git(pm, "add", "--all");
  git(
    pm,
    "-c",
    "user.name=PM",
    "-c",
    "user.email=pm@example.com",
    "commit",
    "-qm",
    "Push held workflows",
  );
  return { dir: pm, tree: git(pm, "rev-parse", "HEAD^{tree}") };
};

test("publish, the PM pushes the held patch, a new commit: the next publish fast-forwards, keeps the PM's workflows and holds nothing", async () => {
  baseWithWorkflows();
  fakeGitHub();
  writeFileSync(join(work, "a.txt"), "first\n");
  writeFileSync(join(work, ".github/workflows/ci.yml"), "name: changed\n");
  writeFileSync(join(work, ".github/workflows/new.yml"), "name: new\n");
  const first = commit("Add a, change CI");
  const firstResult = await run();
  const pm = pmPush(firstResult.held?.patchPath ?? "", { "a.txt": "first\n" });
  // the patch brings the published head to exactly the branch's own tree
  expect(pm.tree).toBe(git(work, "rev-parse", `${first}^{tree}`));

  writeFileSync(join(work, "b.txt"), "second\n");
  commit("Review fix");
  const gh = fakeGitHub({
    ref: "pm_head",
    commitTrees: { pm_head: pm.tree },
    pulls: [OPEN_PR],
    allowPullUpdates: true,
  });

  const result = await run();

  expect(result.held).toBeUndefined();
  expect(existsSync(heldPatchPath())).toBe(false);
  expect(gh.trees).toHaveLength(1);
  expect(gh.trees[0]).toMatchObject({ base_tree: pm.tree });
  expect(treePaths(gh)).toEqual(["b.txt"]);
  expect(gh.commits).toHaveLength(1);
  expect(gh.commits[0]?.parents).toEqual(["pm_head"]);
  expect(gh.refWrites).toEqual([
    { method: "PATCH", body: { sha: "commit1", force: false } },
  ]);
  // GitHub's head's trees are all here, so none is asked for
  expect(treeGets(gh)).toEqual([]);
});

test("after the PM pushes the whole held patch, a re-publish with no new commit holds nothing, removes the patch and writes nothing", async () => {
  baseWithWorkflows();
  fakeGitHub();
  writeFileSync(join(work, "a.txt"), "first\n");
  writeFileSync(join(work, ".github/workflows/ci.yml"), "name: changed\n");
  writeFileSync(join(work, ".github/workflows/new.yml"), "name: new\n");
  commit("Add a, change CI");
  const firstResult = await run();
  const pm = pmPush(firstResult.held?.patchPath ?? "", { "a.txt": "first\n" });
  expect(existsSync(heldPatchPath())).toBe(true);
  const gh = fakeGitHub({
    ref: "pm_head",
    commitTrees: { pm_head: pm.tree },
    pulls: [OPEN_PR],
  });

  const result = await run({ title: undefined });

  expect(result.held).toBeUndefined();
  expect(existsSync(heldPatchPath())).toBe(false);
  expectNothingSent(gh);
});

test("the PM pushes only part of the patch: the next publish holds only the rest, from GitHub's own workflows", async () => {
  baseWithWorkflows();
  fakeGitHub();
  writeFileSync(join(work, "a.txt"), "first\n");
  writeFileSync(join(work, ".github/workflows/ci.yml"), "name: changed\n");
  writeFileSync(join(work, ".github/workflows/new.yml"), "name: new\n");
  commit("Add a, change CI");
  await run();
  // only the new workflow reaches GitHub; its objects are not in this clone
  const pm = pmPush("", {
    "a.txt": "first\n",
    ".github/workflows/new.yml": "name: new\n",
  });
  expect(() =>
    execFileSync("git", ["cat-file", "-e", `${pm.tree}^{tree}`], {
      cwd: work,
      stdio: "ignore",
    }),
  ).toThrow();

  writeFileSync(join(work, "b.txt"), "second\n");
  const tip = commit("Review fix");
  const gh = fakeGitHub({
    ref: "pm_head",
    commitTrees: { pm_head: pm.tree },
    objectsFrom: pm.dir,
    pulls: [OPEN_PR],
    allowPullUpdates: true,
  });

  const result = await run();

  // GitHub's head's trees are not here, so they are asked for
  expect(treeGets(gh).some((path) => path.endsWith(`/${pm.tree}`))).toBe(true);
  expect(git(work, "rev-parse", "HEAD")).toBe(tip);
  expect(git(work, "status", "--porcelain")).toBe("");
  expect(result.held?.files).toEqual(["M .github/workflows/ci.yml"]);
  // the rest of the patch brings GitHub's head to the branch's workflows
  git(pm.dir, "apply", result.held?.patchPath ?? "");
  expect(readFileSync(join(pm.dir, ".github/workflows/ci.yml"), "utf8")).toBe(
    "name: changed\n",
  );
  expect(readFileSync(join(pm.dir, ".github/workflows/new.yml"), "utf8")).toBe(
    "name: new\n",
  );
  expect(gh.trees[0]).toMatchObject({ base_tree: pm.tree });
  expect(treePaths(gh)).toEqual(["b.txt"]);
  expect(gh.commits.map((c) => c.parents)).toEqual([["pm_head"]]);
  expect(gh.refWrites).toEqual([
    { method: "PATCH", body: { sha: "commit1", force: false } },
  ]);
});

test("someone pushes a change to a workflow the branch never touched: the next publish keeps it in what is sent and holds only the branch's own workflow change", async () => {
  baseWithWorkflows();
  fakeGitHub();
  writeFileSync(join(work, "a.txt"), "first\n");
  writeFileSync(join(work, ".github/workflows/ci.yml"), "name: changed\n");
  commit("Add a, change CI");
  await run();
  // a CI fix pushed to the PR's branch from outside, to a file the branch leaves as the base has it
  const theirs = pmPush("", {
    "a.txt": "first\n",
    ".github/workflows/old.yml": "name: old, fixed\n",
  });

  writeFileSync(join(work, "b.txt"), "second\n");
  commit("Review fix");
  const gh = fakeGitHub({
    ref: "their_head",
    commitTrees: { their_head: theirs.tree },
    objectsFrom: theirs.dir,
    pulls: [OPEN_PR],
    allowPullUpdates: true,
  });

  const result = await run();

  expect(result.held?.files).toEqual(["M .github/workflows/ci.yml"]);
  expect(result.held?.patch).not.toContain("old.yml");
  git(theirs.dir, "apply", result.held?.patchPath ?? "");
  expect(
    readFileSync(join(theirs.dir, ".github/workflows/old.yml"), "utf8"),
  ).toBe("name: old, fixed\n");
  expect(
    readFileSync(join(theirs.dir, ".github/workflows/ci.yml"), "utf8"),
  ).toBe("name: changed\n");
  // on GitHub's head's tree, with nothing sent under .github/workflows
  expect(gh.trees[0]).toMatchObject({ base_tree: theirs.tree });
  expect(treePaths(gh)).toEqual(["b.txt"]);
  expect(gh.commits.map((c) => c.parents)).toEqual([["their_head"]]);
  expect(gh.refWrites).toEqual([
    { method: "PATCH", body: { sha: "commit1", force: false } },
  ]);
});

test("the PM pushes an edited version of a held workflow: the next publish still holds it, from GitHub's version to the branch's, and only it", async () => {
  baseWithWorkflows();
  fakeGitHub();
  writeFileSync(join(work, "a.txt"), "first\n");
  writeFileSync(join(work, ".github/workflows/ci.yml"), "name: changed\n");
  writeFileSync(join(work, ".github/workflows/new.yml"), "name: new\n");
  commit("Add a, change CI");
  await run();
  // new.yml as the branch has it, ci.yml as the PM edited it
  const pm = pmPush("", {
    "a.txt": "first\n",
    ".github/workflows/ci.yml": "name: changed by the PM\n",
    ".github/workflows/new.yml": "name: new\n",
  });

  writeFileSync(join(work, "b.txt"), "second\n");
  commit("Review fix");
  const gh = fakeGitHub({
    ref: "pm_head",
    commitTrees: { pm_head: pm.tree },
    objectsFrom: pm.dir,
    pulls: [OPEN_PR],
    allowPullUpdates: true,
  });

  const result = await run();

  expect(result.held?.files).toEqual(["M .github/workflows/ci.yml"]);
  expect(result.held?.patch).toContain("-name: changed by the PM");
  expect(result.held?.patch).not.toContain("new.yml");
  expect(treePaths(gh)).toEqual(["b.txt"]);
  expect(gh.commits.map((c) => c.parents)).toEqual([["pm_head"]]);
});

test("continuing a branch whose GitHub commits already change workflows sends the new work on GitHub's tree and holds nothing", async () => {
  baseWithWorkflows();
  git(work, "config", "branch.claude/agt_1.sky-remote-branch", "feature/x");
  writeFileSync(join(work, "theirs.txt"), "theirs\n");
  writeFileSync(join(work, ".github/workflows/ci.yml"), "name: theirs\n");
  const theirs = commit("Their change, with CI");
  writeFileSync(join(work, "mine.txt"), "mine\n");
  commit("Agent change");
  const gh = fakeGitHub({
    ref: theirs,
    branch: "feature/x",
    pulls: [{ ...OPEN_PR, head: "feature/x" }],
    allowPullUpdates: true,
  });

  const result = await run();

  expect(result.held).toBeUndefined();
  expect(treePaths(gh)).toEqual(["mine.txt"]);
  expect(gh.trees[0]).toMatchObject({
    base_tree: git(work, "rev-parse", `${theirs}^{tree}`),
  });
  expect(gh.commits.map((c) => c.parents)).toEqual([[theirs]]);
  expect(gh.refWrites).toEqual([
    { method: "PATCH", body: { sha: "commit1", force: false } },
  ]);
});

test("a rewrite that would drop workflow changes already on GitHub is refused before anything is sent", async () => {
  baseWithWorkflows();
  writeFileSync(join(work, "a.txt"), "first\n");
  const old = commit("Add a");
  // GitHub holds the head this branch had before an amend, plus a workflow the PM pushed, on a history that
  // doesn't pass through the base
  const pm = pmPush("", {
    "a.txt": "first\n",
    ".github/workflows/new.yml": "name: new\n",
  });
  amend("Add a, amended");
  const gh = fakeGitHub({
    ref: old,
    commitTrees: { [old]: pm.tree, elsewhere: pm.tree },
    commitParents: { [old]: ["elsewhere"], elsewhere: [] },
    objectsFrom: pm.dir,
  });

  await expect(run()).rejects.toThrow(/would drop/);
  expectNothingSent(gh);
});

test("a head this branch held before an amend, carrying workflow changes of its own that the amended history lacks, is refused before anything is sent", async () => {
  baseWithWorkflows();
  writeFileSync(join(work, "a.txt"), "first\n");
  const old = commit("Add a");
  // GitHub holds that head with a workflow added, on the base; the amend then changes a.txt, so no
  // current commit matches it outside .github/workflows and only the reflog still knows it
  const pm = pmPush("", {
    "a.txt": "first\n",
    ".github/workflows/new.yml": "name: new\n",
  });
  writeFileSync(join(work, "a.txt"), "first, amended\n");
  git(work, "add", "--all");
  amend("Add a, amended");
  const gh = fakeGitHub({
    ref: old,
    commitTrees: { [old]: pm.tree },
    objectsFrom: pm.dir,
  });

  await expect(run()).rejects.toThrow(/would drop/);
  expectNothingSent(gh);
});

/** The fields GitHub's commit API gives for a commit here: dates in UTC, the message less its final newline. */
const apiCommit = (sha: string) => {
  const person = (who: "a" | "c") => {
    const [name = "", email = "", at = "0"] = git(
      work,
      "show",
      "-s",
      `--format=%${who}n%x00%${who}e%x00%${who}d`,
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
    tree: { sha: git(work, "rev-parse", `${sha}^{tree}`) },
    parents: git(work, "rev-list", "--parents", "-n1", sha)
      .split(" ")
      .slice(1)
      .map((p) => ({ sha: p })),
    author: person("a"),
    committer: person("c"),
    message: git(work, "show", "-s", "--format=%B", sha).replace(/\n+$/, ""),
    verification: { verified: false, signature: null, payload: null },
  };
};

/** A commit on top of the base with `files` written, made here off the branch, which stays checked out. */
const nextBase = (files: Record<string, string>) => {
  git(work, "checkout", "-q", "--detach", baseSha);
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(work, path), content);
  }
  const next = commit("Base moves");
  git(work, "checkout", "-q", "claude/agt_1");
  return next;
};

/**
 * The base moves on GitHub to `sha`, served with its tree as the commit and trees APIs give them, so
 * publish rebases onto it. After `fakeGitHub`, whose routes would otherwise answer first.
 */
const baseMovesTo = (sha: string) => {
  baseSha = sha;
  const tree = git(work, "rev-parse", `${sha}^{tree}`);
  server.use(
    http.get(`${REPO}/git/commits/${sha}`, () =>
      HttpResponse.json(apiCommit(sha)),
    ),
    http.get(`${REPO}/git/trees/${tree}`, () => {
      const listing = git(work, "ls-tree", "-r", "-z", tree)
        .split("\0")
        .filter(Boolean)
        .map((line) => {
          const [meta = "", path = ""] = line.split("\t");
          const [mode, type, entrySha] = meta.split(" ");
          return { path, mode, type, sha: entrySha };
        });
      return HttpResponse.json({ sha: tree, tree: listing, truncated: false });
    }),
  );
};

test("the base changes a workflow between two publishes of a branch that changes none: the rewrite force-updates onto the new base's workflows and holds nothing", async () => {
  baseWithWorkflows();
  const oldBase = baseSha;
  fakeGitHub();
  writeFileSync(join(work, "a.txt"), "first\n");
  const first = commit("Add a");
  await run();
  const newBase = nextBase({ ".github/workflows/ci.yml": "name: ci v2\n" });
  const gh = fakeGitHub({
    ref: "commit1",
    commitTrees: {
      commit1: git(work, "rev-parse", `${first}^{tree}`),
      // the walk from GitHub's head stops at the old base
      [oldBase]: git(work, "rev-parse", `${oldBase}^{tree}`),
    },
    commitParents: { commit1: [oldBase], [oldBase]: [] },
    pulls: [OPEN_PR],
    allowPullUpdates: true,
  });
  baseMovesTo(newBase);

  const result = await run();

  expect(result.held).toBeUndefined();
  expect(existsSync(heldPatchPath())).toBe(false);
  // on the new base's own tree, with nothing sent under .github/workflows
  expect(gh.trees).toEqual([
    {
      base_tree: git(work, "rev-parse", `${newBase}^{tree}`),
      tree: [{ path: "a.txt", mode: "100644", type: "blob", sha: "blob1" }],
    },
  ]);
  expect(gh.commits.map((c) => c.parents)).toEqual([[newBase]]);
  expect(gh.refWrites).toEqual([
    { method: "PATCH", body: { sha: "commit1", force: true } },
  ]);
});

test("a branch whose workflow change is held, re-published after the base moves, force-updates its rewritten history and still holds the change", async () => {
  baseWithWorkflows();
  const oldBase = baseSha;
  fakeGitHub();
  writeFileSync(join(work, "a.txt"), "first\n");
  writeFileSync(join(work, ".github/workflows/ci.yml"), "name: changed\n");
  commit("Add a, change CI");
  await run();
  // the tree the first publish sent: the base's, with a.txt
  const sent = pmPush("", { "a.txt": "first\n" });
  const newBase = nextBase({ README: "hi again\n" });
  const gh = fakeGitHub({
    ref: "commit1",
    commitTrees: { commit1: sent.tree },
    commitParents: { commit1: [oldBase] },
    objectsFrom: sent.dir,
    pulls: [OPEN_PR],
    allowPullUpdates: true,
  });
  baseMovesTo(newBase);

  const result = await run();

  expect(gh.refWrites).toEqual([
    { method: "PATCH", body: { sha: "commit1", force: true } },
  ]);
  expect(gh.trees[0]).toMatchObject({
    base_tree: git(work, "rev-parse", `${newBase}^{tree}`),
  });
  expect(treePaths(gh)).toEqual(["a.txt"]);
  expect(gh.commits.map((c) => c.parents)).toEqual([[newBase]]);
  expect(result.held?.files).toEqual(["M .github/workflows/ci.yml"]);
  expect(readFileSync(heldPatchPath(), "utf8")).toBe(result.held?.patch);
});

test("after the PM pushes the held workflows, a re-publish once the base moves is refused before anything is sent", async () => {
  baseWithWorkflows();
  const oldBase = baseSha;
  fakeGitHub();
  writeFileSync(join(work, "a.txt"), "first\n");
  writeFileSync(join(work, ".github/workflows/ci.yml"), "name: changed\n");
  commit("Add a, change CI");
  const first = await run();
  const pm = pmPush(first.held?.patchPath ?? "", { "a.txt": "first\n" });
  const newBase = nextBase({ README: "hi again\n" });
  const gh = fakeGitHub({
    ref: "pm_head",
    commitTrees: { pm_head: pm.tree },
    commitParents: { pm_head: [oldBase] },
    pulls: [OPEN_PR],
    allowPullUpdates: true,
  });
  baseMovesTo(newBase);

  await expect(run()).rejects.toThrow(
    /merge the pull request as it is.*from outside the sandbox.*publish again/,
  );
  expect(gh.blobs).toEqual([]);
  expect(gh.trees).toEqual([]);
  expect(gh.commits).toEqual([]);
  expect(gh.refWrites).toEqual([]);
});

test("a GitHub head that is someone else's, neither this branch's history nor the base's, is refused before anything is held or sent", async () => {
  baseWithWorkflows();
  writeFileSync(join(work, "a.txt"), "first\n");
  writeFileSync(join(work, ".github/workflows/ci.yml"), "name: changed\n");
  commit("Add a, change CI");
  // a branch of the same name someone else pushed, with a tree this branch never had
  const theirs = pmPush("", { "theirs.txt": "theirs\n" });
  // what an earlier publish held, which this one must leave as it is
  mkdirSync(dirname(heldPatchPath()), { recursive: true });
  writeFileSync(heldPatchPath(), "an earlier publish's patch\n");
  const gh = fakeGitHub({
    ref: "their_head",
    commitTrees: { their_head: theirs.tree },
    objectsFrom: theirs.dir,
  });

  await expect(run()).rejects.toThrow(
    "claude/agt_1 on GitHub isn't an ancestor of this branch and holds a commit this branch never had, as when someone pushed there; it can't be fast-forwarded and isn't overwritten, so nothing was sent",
  );
  expect(gh.blobs).toEqual([]);
  expect(gh.trees).toEqual([]);
  expect(gh.commits).toEqual([]);
  expect(gh.refWrites).toEqual([]);
  expect(readFileSync(heldPatchPath(), "utf8")).toBe(
    "an earlier publish's patch\n",
  );
});

/** Merges `shas` into the branch, as `commit` makes commits. */
const merge = (...shas: string[]) => {
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Claude",
      "-c",
      "user.email=noreply@anthropic.com",
      "merge",
      "-q",
      "--no-edit",
      ...shas,
    ],
    {
      cwd: work,
      env: {
        ...withoutHostIdentity(),
        GIT_AUTHOR_DATE: "2026-10-30T14:00:00+00:00",
        GIT_COMMITTER_DATE: "2026-10-30T14:00:00+00:00",
      },
    },
  );
  return git(work, "rev-parse", "HEAD");
};

/** The base moves to a new commit, here as fetched (`origin/main`) and on GitHub. */
const baseMoves = (files: Record<string, string>) => {
  const next = nextBase(files);
  git(work, "update-ref", "refs/remotes/origin/main", next);
  baseMovesTo(next);
  return next;
};

test("a merge of the base GitHub holds is sent with the base tip as its second parent, so the base is an ancestor of the published head", async () => {
  writeFileSync(join(work, "a.txt"), "first\n");
  const first = commit("Add a");
  const gh = fakeGitHub({ ref: first });
  const base = baseMoves({ "b.txt": "from main\n" });
  merge(base);

  const result = await run();

  expect(gh.commits.map((c) => c.parents)).toEqual([[first, base]]);
  expect(gh.refWrites).toEqual([
    { method: "PATCH", body: { sha: "commit1", force: false } },
  ]);
  expect(result.sha).toBe("commit1");
});

test("an octopus merge of commits GitHub holds keeps every parent, in order", async () => {
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a");
  const gh = fakeGitHub();
  // another branch's head on GitHub
  const other = nextBase({ "x.txt": "from another branch\n" });
  const lookedUp: string[] = [];
  server.use(
    http.get(`${REPO}/git/commits/${other}`, () => {
      lookedUp.push(other);
      return HttpResponse.json(apiCommit(other));
    }),
  );
  const base = baseMoves({ "b.txt": "from main\n" });
  merge(base, other);

  await run();

  // the parent is looked up on GitHub by its own sha, not assumed held
  expect(lookedUp).toEqual([other]);
  expect(gh.commits.map((c) => c.parents)).toEqual([
    [base],
    ["commit1", base, other],
  ]);
  expect(gh.refWrites).toEqual([
    {
      method: "POST",
      body: { ref: "refs/heads/claude/agt_1", sha: "commit2" },
    },
  ]);
});

test("a merge of a branch only this clone has is refused, naming the merge, before anything is sent", async () => {
  // a branch made here and never pushed
  const side = nextBase({ "s.txt": "local only\n" });
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a");
  const gh = fakeGitHub();
  const merged = merge(side);

  const error = await run().catch((e: unknown) => e);

  expect(String(error)).toContain(
    `commit ${merged} on claude/agt_1 merges ${side}, which GitHub doesn't have`,
  );
  expect(String(error)).toMatch(
    /merge only branches GitHub has, or replace the merge with its commits: `git rebase [0-9a-f]{40}`/,
  );
  expectNothingSent(gh);
});

test("a GitHub error other than not-found on a merge's parent lookup is raised as it is, not read as the parent missing", async () => {
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a");
  const gh = fakeGitHub();
  const other = nextBase({ "x.txt": "from another branch\n" });
  server.use(
    http.get(`${REPO}/git/commits/${other}`, () =>
      HttpResponse.json({ message: "Server Error" }, { status: 500 }),
    ),
  );
  merge(other);

  const error = await run().catch((e: unknown) => e);

  expect(String(error)).toContain(
    `GET /repos/acme/widgets/git/commits/${other} returned 500: Server Error`,
  );
  expect(String(error)).not.toContain("doesn't have");
  expectNothingSent(gh);
});

test("an octopus merge with one parent GitHub holds and one it doesn't is refused, naming the missing one, before anything is sent", async () => {
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a");
  const gh = fakeGitHub();
  const held = nextBase({ "x.txt": "on GitHub\n" });
  const missing = nextBase({ "y.txt": "only here\n" });
  server.use(
    http.get(`${REPO}/git/commits/${held}`, () =>
      HttpResponse.json(apiCommit(held)),
    ),
  );
  const merged = merge(held, missing);

  const error = await run().catch((e: unknown) => e);

  expect(String(error)).toContain(
    `commit ${merged} on claude/agt_1 merges ${missing}, which GitHub doesn't have`,
  );
  expect(String(error)).not.toContain(`merges ${held}`);
  expectNothingSent(gh);
});

test("history without a merge sends one parent per commit and looks up no commit on GitHub", async () => {
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a");
  writeFileSync(join(work, "b.txt"), "second\n");
  commit("Add b");
  const gh = fakeGitHub();

  await run();

  expect(gh.commits.map((c) => c.parents)).toEqual([[baseSha], ["commit1"]]);
  expect(gh.gets.filter((path) => path.includes("/git/commits/"))).toEqual([]);
});

test("a merge of the base after a held workflow change keeps both parents and still holds the change", async () => {
  baseWithWorkflows();
  const gh = fakeGitHub();
  writeFileSync(join(work, "a.txt"), "first\n");
  writeFileSync(join(work, ".github/workflows/ci.yml"), "name: changed\n");
  commit("Add a, change CI");
  const base = baseMoves({ "b.txt": "from main\n" });
  merge(base);

  const result = await run();

  expect(gh.commits.map((c) => c.parents)).toEqual([[base], ["commit1", base]]);
  expect(treePaths(gh)).not.toContain(".github/workflows/ci.yml");
  expect(result.held?.files).toEqual(["M .github/workflows/ci.yml"]);
});

test("a merge whose only change past its first parent is under .github/workflows is still sent, not skipped as held", async () => {
  baseWithWorkflows();
  const gh = fakeGitHub();
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a");
  const base = baseMoves({ ".github/workflows/ci.yml": "name: ci v2\n" });
  merge(base);

  const result = await run();

  expect(gh.commits.map((c) => c.parents)).toEqual([[base], ["commit1", base]]);
  // the base's newer workflow is GitHub's already and the connector can't write it, so it isn't sent
  expect(treePaths(gh)).not.toContain(".github/workflows/ci.yml");
  // the merged tree's ci.yml differs from the baseline's, so it is reported as held
  expect(result.held?.files).toEqual(["M .github/workflows/ci.yml"]);
});

test("a branch already on GitHub that merges a base which since changed a workflow is refused before anything is sent", async () => {
  baseWithWorkflows();
  writeFileSync(join(work, "a.txt"), "first\n");
  const first = commit("Add a");
  // GitHub's head is the branch as it is here, with the base's workflows before they changed
  const gh = fakeGitHub({ ref: first });
  const base = baseMoves({ ".github/workflows/ci.yml": "name: ci v2\n" });
  const merged = merge(base);

  const error = await run().catch((e: unknown) => e);

  expect(String(error)).toContain(
    `commit ${merged} on claude/agt_1 merges ${base}, and the merge's .github/workflows/ differs from the one publish can send`,
  );
  expect(String(error)).toContain(
    "have someone merge main into claude/agt_1 from outside the sandbox, then publish again, or rebase instead of merging",
  );
  expectNothingSent(gh);
});

test("a branch already on GitHub that merges a base whose workflows haven't changed is sent with both parents", async () => {
  baseWithWorkflows();
  writeFileSync(join(work, "a.txt"), "first\n");
  const first = commit("Add a");
  const gh = fakeGitHub({ ref: first });
  const base = baseMoves({ "b.txt": "from main\n" });
  merge(base);

  await run();

  expect(gh.commits.map((c) => c.parents)).toEqual([[first, base]]);
  expect(treePaths(gh)).toEqual(["b.txt"]);
  expect(gh.refWrites).toEqual([
    { method: "PATCH", body: { sha: "commit1", force: false } },
  ]);
});

test("a continued branch with its own workflow changes merges an unchanged base and is sent with both parents", async () => {
  baseWithWorkflows();
  git(work, "config", "branch.claude/agt_1.sky-remote-branch", "feature/x");
  writeFileSync(join(work, "theirs.txt"), "theirs\n");
  writeFileSync(join(work, ".github/workflows/ci.yml"), "name: theirs\n");
  const theirs = commit("Their change, with CI");
  const gh = fakeGitHub({
    ref: theirs,
    branch: "feature/x",
    pulls: [{ ...OPEN_PR, head: "feature/x" }],
    allowPullUpdates: true,
  });
  // the base's workflows are still the ones their branch changed
  const base = baseMoves({ "b.txt": "from main\n" });
  merge(base);

  const result = await run();

  expect(result.held).toBeUndefined();
  expect(gh.commits.map((c) => c.parents)).toEqual([[theirs, base]]);
  expect(treePaths(gh)).toEqual(["b.txt"]);
  expect(gh.refWrites).toEqual([
    { method: "PATCH", body: { sha: "commit1", force: false } },
  ]);
});
