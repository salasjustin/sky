import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import {
  afterEach,
  beforeEach,
  expect,
  onTestFinished,
  test,
  vi,
} from "vitest";
import { server } from "../../../test/msw.js";
import {
  type ApprovalAnswer,
  type ApprovalAsk,
  type BrokerDeps,
  isBrokerCall,
  publishAsk,
  startBroker,
  syncAsk,
} from "./broker.js";
import { brokerPublishMain, brokerSyncMain } from "./broker-client.js";
import type { syncMain } from "./sync.js";

const GATEWAY = "https://gateway.test/v1/gateway/github";
const CONNECTOR = "conn_123";
const REPO = `${GATEWAY}/${CONNECTOR}/repos/acme/widgets`;
const ENV = { GITHUB_CONNECTOR: CONNECTOR, GITHUB_GATEWAY_URL: GATEWAY };

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let root: string;
let work: string;
let baseSha: string;

const commit = (message: string) => {
  git(work, "add", "--all");
  git(
    work,
    "-c",
    "user.name=Claude",
    "-c",
    "user.email=noreply@anthropic.com",
    "commit",
    "-qm",
    message,
  );
  return git(work, "rev-parse", "HEAD");
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "runner-broker-"));
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("HOME", root);
  const origin = join(root, "origin");
  work = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", origin]);
  writeFileSync(join(origin, "README"), "hi\n");
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
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

/** GitHub behind the gateway, as much of it as a publish of new commits to a new branch uses; records every write. */
function github() {
  const state = {
    gets: 0,
    writes: [] as { method: string; path: string; body: unknown }[],
    commits: [] as { message: string }[],
  };
  const write = (method: string, path: string, body: unknown) =>
    state.writes.push({ method, path, body });
  server.use(
    http.get(REPO, () => {
      state.gets++;
      return HttpResponse.json({ full_name: "acme/widgets" });
    }),
    http.get(`${REPO}/git/ref/heads/main`, () => {
      state.gets++;
      return HttpResponse.json({ object: { sha: baseSha } });
    }),
    http.get(`${REPO}/git/ref/heads/claude/agt_1`, () => {
      state.gets++;
      return HttpResponse.json({ message: "Not Found" }, { status: 404 });
    }),
    http.get(`${REPO}/git/blobs/:sha`, () => {
      state.gets++;
      return HttpResponse.json({ message: "Not Found" }, { status: 404 });
    }),
    http.get(`${REPO}/pulls`, () => {
      state.gets++;
      return HttpResponse.json([]);
    }),
    http.post(`${REPO}/git/blobs`, async ({ request }) => {
      write("POST", "/git/blobs", await request.json());
      return HttpResponse.json({ sha: "blob1" }, { status: 201 });
    }),
    http.post(`${REPO}/git/trees`, async ({ request }) => {
      write("POST", "/git/trees", await request.json());
      return HttpResponse.json({ sha: "tree1" }, { status: 201 });
    }),
    http.post(`${REPO}/git/commits`, async ({ request }) => {
      const body = (await request.json()) as { message: string };
      state.commits.push(body);
      write("POST", "/git/commits", body);
      return HttpResponse.json(
        { sha: `commit${state.commits.length}` },
        { status: 201 },
      );
    }),
    http.post(`${REPO}/git/refs`, async ({ request }) => {
      write("POST", "/git/refs", await request.json());
      return HttpResponse.json({ object: { sha: "x" } }, { status: 201 });
    }),
    http.post(`${REPO}/pulls`, async ({ request }) => {
      write("POST", "/pulls", await request.json());
      return HttpResponse.json(
        { number: 7, html_url: "https://github.com/acme/widgets/pull/7" },
        { status: 201 },
      );
    }),
  );
  return state;
}

async function broker(
  approve: (ask: ApprovalAsk, signal: AbortSignal) => Promise<ApprovalAnswer>,
  extra: Partial<BrokerDeps> = {},
) {
  const socketPath = join(root, "broker.sock");
  const warnings: string[] = [];
  const started = await startBroker({
    socketPath,
    cwd: work,
    env: ENV,
    sealProblem: () => undefined,
    approve,
    warn: (message) => warnings.push(message),
    ...extra,
  });
  onTestFinished(() => started.close());
  return { socketPath, warnings };
}

/** The agent's command, with only what a command of the session has: the socket's path and no connector. */
async function client(
  command: typeof brokerPublishMain,
  args: string[],
  socketPath: string | undefined,
) {
  let stdout = "";
  let stderr = "";
  const status = await command(
    args,
    { ...(socketPath && { SKY_BROKER_SOCKET: socketPath }) },
    {
      cwd: work,
      stdout: (s) => {
        stdout += s;
      },
      stderr: (s) => {
        stderr += s;
      },
    },
  );
  return { status, stdout, stderr };
}

const approved = { approved: true } as const;

test("publish over the socket opens exactly one approval, and sends only the commits it showed", async () => {
  const gh = github();
  writeFileSync(join(work, "a.txt"), "first\nsecond\n");
  const first = commit("Add a");
  writeFileSync(join(work, "b.txt"), "b\n");
  const second = commit("Add b");
  const asks: ApprovalAsk[] = [];
  const { socketPath } = await broker(async (ask) => {
    asks.push(ask);
    // nothing has been written to GitHub while the person is being asked
    expect(gh.writes).toEqual([]);
    return approved;
  });

  const { status, stdout, stderr } = await client(
    brokerPublishMain,
    ["--title", "Add widgets", "--body", "Details."],
    socketPath,
  );

  expect({ status, stdout }).toEqual({
    status: 0,
    stdout: "https://github.com/acme/widgets/pull/7\n",
  });
  expect(stderr).toContain("opened pull request #7");
  expect(asks).toHaveLength(1);
  const [ask] = asks;
  expect(ask?.toolName).toBe("Publish");
  const summary = ask?.toolSummary ?? "";
  expect(summary).toContain("claude/agt_1");
  expect(summary).toContain("opens a pull request into main");
  expect(summary).toContain("2 commits, 2 files, +3 -0");
  expect(summary).toContain(`${first.slice(0, 7)} Add a`);
  expect(summary).toContain(`${second.slice(0, 7)} Add b`);
  expect(summary).toContain("+2 -0 a.txt");
  expect(summary.length).toBeLessThanOrEqual(2000);
  const input = JSON.parse(ask?.toolInput ?? "{}");
  expect(input).toMatchObject({
    action: "publish",
    branch: "claude/agt_1",
    localBranch: "claude/agt_1",
    base: "main",
    head: second,
    stat: { commits: 2, files: 2, added: 3, removed: 0 },
    commits: [
      { sha: first, subject: "Add a" },
      { sha: second, subject: "Add b" },
    ],
    files: [
      { path: "a.txt", added: 2, removed: 0 },
      { path: "b.txt", added: 1, removed: 0 },
    ],
  });
  // exactly the approved commits were recreated on GitHub, no others
  expect(gh.commits.map((c) => c.message)).toEqual(["Add a\n", "Add b\n"]);
  expect(gh.writes.filter((w) => w.path === "/pulls")).toHaveLength(1);
});

test("a head that moved while the person was asked is refused and nothing is sent", async () => {
  const gh = github();
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a");
  const { socketPath } = await broker(async () => {
    writeFileSync(join(work, "late.txt"), "not shown\n");
    commit("Added after the approval was asked for");
    return approved;
  });

  const { status, stderr } = await client(
    brokerPublishMain,
    ["--title", "T"],
    socketPath,
  );

  expect(status).toBe(1);
  expect(stderr).toContain("moved from");
  expect(stderr).toContain("while the publish waited for approval");
  expect(stderr).toContain("nothing was sent");
  expect(gh.writes).toEqual([]);
});

test("a denied approval sends nothing", async () => {
  const gh = github();
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a");
  const { socketPath } = await broker(async () => ({
    approved: false,
    reason: "The user denied this tool call.",
  }));

  const { status, stderr, stdout } = await client(
    brokerPublishMain,
    ["--title", "T"],
    socketPath,
  );

  expect({ status, stdout }).toEqual({ status: 1, stdout: "" });
  expect(stderr).toContain("The user denied this tool call.; nothing was sent");
  expect(gh.writes).toEqual([]);
});

test("a publish that fails its checks before anything is shown asks no one", async () => {
  github();
  const asked = vi.fn(async (): Promise<ApprovalAnswer> => approved);
  const { socketPath } = await broker(asked);

  // a worktree with no commit past the base fails before anything is shown
  const { status, stderr } = await client(
    brokerPublishMain,
    ["--title", "T"],
    socketPath,
  );

  expect(status).toBe(1);
  expect(stderr).toContain("no commits on claude/agt_1 past main");
  expect(asked).not.toHaveBeenCalled();
});

test("a runner whose seal can't be confirmed refuses publish and sync with a warning, and asks no one", async () => {
  const gh = github();
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a");
  const asked = vi.fn(async (): Promise<ApprovalAnswer> => approved);
  const syncRun = vi.fn<typeof syncMain>(async () => 0);
  const { socketPath, warnings } = await broker(asked, {
    sealProblem: () =>
      "the kernel lets the repo's commands read Claude's environment",
    syncRun,
  });

  const published = await client(
    brokerPublishMain,
    ["--title", "T"],
    socketPath,
  );
  const synced = await client(brokerSyncMain, [], socketPath);

  for (const result of [published, synced]) {
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("refused");
    expect(result.stderr).toContain("the kernel lets the repo's commands read");
    expect(result.stderr).toContain("nothing was sent");
  }
  expect(warnings).toHaveLength(2);
  expect(warnings[0]).toContain("sky publish refused");
  expect(warnings[1]).toContain("sky sync refused");
  expect(asked).not.toHaveBeenCalled();
  expect(syncRun).not.toHaveBeenCalled();
  expect(gh.gets).toBe(0);
  expect(gh.writes).toEqual([]);
});

test("sync asks the same way: one approval naming the branch and the work it may rebase, then it runs", async () => {
  writeFileSync(join(work, "a.txt"), "first\n");
  const head = commit("Add a");
  const asks: ApprovalAsk[] = [];
  const syncRun = vi.fn<typeof syncMain>(async (_argv, _env, io) => {
    io.stdout("origin/main is already at GitHub's tip; nothing moved.\n");
    return 0;
  });
  const { socketPath } = await broker(
    async (ask) => {
      asks.push(ask);
      expect(syncRun).not.toHaveBeenCalled();
      return approved;
    },
    { syncRun },
  );

  const { status, stdout } = await client(
    brokerSyncMain,
    ["--branch", "feature/x"],
    socketPath,
  );

  expect({ status, stdout }).toEqual({
    status: 0,
    stdout: "origin/main is already at GitHub's tip; nothing moved.\n",
  });
  expect(asks).toHaveLength(1);
  expect(asks[0]?.toolName).toBe("Sync");
  expect(asks[0]?.toolSummary).toContain("claude/agt_1");
  expect(asks[0]?.toolSummary).toContain("feature/x");
  expect(asks[0]?.toolSummary).toContain("+1 -0 a.txt");
  expect(JSON.parse(asks[0]?.toolInput ?? "{}")).toMatchObject({
    action: "sync",
    branch: "feature/x",
    head,
    commits: [{ sha: head, subject: "Add a" }],
  });
  expect(syncRun).toHaveBeenCalledOnce();
  expect(syncRun.mock.calls[0]?.[0]).toEqual(["--branch", "feature/x"]);
  // the runner's own env, with the connector, and not anything the request said
  expect(syncRun.mock.calls[0]?.[1]).toMatchObject(ENV);
});

test("a denied sync, and a sync whose head moved while it waited, run nothing", async () => {
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a");
  const syncRun = vi.fn<typeof syncMain>(async () => 0);
  let answer: "deny" | "move" = "deny";
  const { socketPath } = await broker(
    async () => {
      if (answer === "deny") return { approved: false, reason: "no, not now" };
      writeFileSync(join(work, "b.txt"), "b\n");
      commit("Add b");
      return approved;
    },
    { syncRun },
  );

  const denied = await client(brokerSyncMain, [], socketPath);
  answer = "move";
  const moved = await client(brokerSyncMain, [], socketPath);

  expect(denied.status).toBe(1);
  expect(denied.stderr).toContain("no, not now; nothing was sent");
  expect(moved.status).toBe(1);
  expect(moved.stderr).toContain("while the sync waited for approval");
  expect(syncRun).not.toHaveBeenCalled();
});

/** A commit holding `evil.txt` alone on `parent`, for `git replace` to put in another's place. */
function impostor(parent: string): string {
  const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: work,
    input: "evil\n",
    encoding: "utf8",
  }).trim();
  const tree = execFileSync("git", ["mktree"], {
    cwd: work,
    input: `100644 blob ${blob}\tevil.txt\n`,
    encoding: "utf8",
  }).trim();
  return git(
    work,
    "-c",
    "user.name=x",
    "-c",
    "user.email=x@x",
    "commit-tree",
    tree,
    "-p",
    parent,
    "-m",
    "evil",
  );
}

const sentBlobs = (gh: ReturnType<typeof github>) =>
  gh.writes
    .filter((w) => w.path === "/git/blobs")
    .map((w) =>
      Buffer.from((w.body as { content: string }).content, "base64").toString(
        "utf8",
      ),
    );

test("a replacement made for the shown commit while the person decided is not what is sent", async () => {
  const gh = github();
  writeFileSync(join(work, "a.txt"), "first\n");
  const head = commit("Add a");
  const { socketPath } = await broker(async () => {
    git(work, "replace", head, impostor(baseSha));
    return approved;
  });

  const { status } = await client(
    brokerPublishMain,
    ["--title", "T"],
    socketPath,
  );

  expect(status).toBe(0);
  expect(gh.commits.map((c) => c.message)).toEqual(["Add a\n"]);
  expect(sentBlobs(gh)).toContain("first\n");
  expect(sentBlobs(gh)).not.toContain("evil\n");
  expect(JSON.stringify(gh.writes)).not.toContain("evil.txt");
});

test("a sync's approval shows the commits as stored, whatever a replacement says", async () => {
  writeFileSync(join(work, "a.txt"), "first\n");
  const head = commit("Add a");
  git(work, "replace", head, impostor(baseSha));
  const asks: ApprovalAsk[] = [];
  const syncRun = vi.fn<typeof syncMain>(async () => 0);
  const { socketPath } = await broker(
    async (ask) => {
      asks.push(ask);
      return approved;
    },
    { syncRun },
  );

  await client(brokerSyncMain, [], socketPath);

  expect(asks).toHaveLength(1);
  const input = JSON.parse(asks[0]?.toolInput ?? "{}");
  expect(input.commits).toEqual([{ sha: head, subject: "Add a" }]);
  expect(input.files).toEqual([{ path: "a.txt", added: 1, removed: 0 }]);
});

test("the worktree and the connector are the runner's own: a request that names a path or a connector changes neither", async () => {
  const gh = github();
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a");
  const { socketPath } = await broker(async () => approved);

  const reply = await new Promise<string>((resolve) => {
    const socket = net.createConnection(socketPath);
    let received = "";
    socket.setEncoding("utf8");
    socket.on("connect", () =>
      socket.write(
        `${JSON.stringify({
          op: "publish",
          title: "T",
          cwd: "/somewhere/else",
          GITHUB_CONNECTOR: "conn_attacker",
          connectorId: "conn_attacker",
        })}\n`,
      ),
    );
    socket.on("data", (chunk: string) => {
      received += chunk;
    });
    socket.on("close", () => resolve(received));
  });

  expect(reply).toContain('"exit","code":0');
  expect(gh.writes.some((w) => w.path === "/pulls")).toBe(true);
});

test("the commands say so plainly when there is no broker to ask", async () => {
  const none = await client(brokerPublishMain, ["--title", "T"], undefined);
  expect(none.status).toBe(2);
  expect(none.stderr).toContain("SKY_BROKER_SOCKET is not set");
  const gone = await client(brokerSyncMain, [], join(root, "nobody.sock"));
  expect(gone.status).toBe(1);
  expect(gone.stderr).toContain("can't reach the run's runner");
});

test("--help says the runner asks first, and that no environment setting skips it", async () => {
  const published = await client(brokerPublishMain, ["--help"], undefined);
  const synced = await client(brokerSyncMain, ["--help"], undefined);
  for (const out of [published.stdout, synced.stdout]) {
    expect(out).toContain("approval");
    expect(out).toContain("Environment settings can't skip the approval.");
  }
  expect(published.stdout).toContain("usage: publish --title <title>");
  expect(synced.stdout).toContain("usage: sync [--branch <name>]");
});

const RUNNER = { execPath: "/usr/bin/node", script: "/opt/sky/runner.mjs" };

test.each([
  ["/usr/bin/node /opt/sky/runner.mjs publish --title 'Add widgets'", true],
  [
    "/usr/bin/node /opt/sky/runner.mjs publish --title T --body @/tmp/b.md",
    true,
  ],
  ["/usr/bin/node /opt/sky/runner.mjs sync", true],
  ["/usr/bin/node /opt/sky/runner.mjs sync --branch feature/x", true],
  // chained, piped, wrapped, substituted, redirected: judged as any command is
  ["/usr/bin/node /opt/sky/runner.mjs publish --title T && echo done", false],
  ["/usr/bin/node /opt/sky/runner.mjs publish --title T | cat", false],
  ["/usr/bin/node /opt/sky/runner.mjs publish --title T > out.txt", false],
  ["env X=1 /usr/bin/node /opt/sky/runner.mjs publish --title T", false],
  ['/usr/bin/node /opt/sky/runner.mjs publish --title "$(date)"', false],
  ["/usr/bin/node /opt/sky/runner.mjs publish --title T; rm -rf x", false],
  ["cd sub && /usr/bin/node /opt/sky/runner.mjs sync", false],
  // another script, another subcommand, another program
  ["/usr/bin/node /tmp/evil.mjs publish --title T", false],
  ["/usr/bin/node /opt/sky/runner.mjs store-sync pull", false],
  ["/usr/bin/node /opt/sky/runner.mjs", false],
  ["/tmp/node /opt/sky/runner.mjs publish --title T", false],
])("%s is the agent's own call: %s", (command, expected) => {
  expect(isBrokerCall(command, RUNNER)).toBe(expected);
});

test("a runner with no script path of its own lets no call through as its own", () => {
  expect(
    isBrokerCall("/usr/bin/node undefined publish", {
      execPath: "/usr/bin/node",
      script: undefined,
    }),
  ).toBe(false);
});

test("an approval's summary stays inside what the API keeps, however long the work is", () => {
  const commits = Array.from({ length: 300 }, (_, i) => ({
    sha: i.toString(16).padStart(40, "0"),
    subject: `commit number ${i} with a subject that goes on and on and on`,
  }));
  const files = Array.from({ length: 500 }, (_, i) => ({
    path: `packages/some/deep/path/file-${i}.ts`,
    added: i,
    removed: 1,
  }));
  const plan = {
    localBranch: "claude/agt_1",
    branch: "feature/big",
    base: "main",
    head: commits[299]?.sha as string,
    mergeBase: baseSha ?? "0".repeat(40),
    commits,
    files,
    title: "Big",
  };
  const publish = publishAsk(plan);
  const sync = syncAsk({ ...plan, base: plan.mergeBase });
  for (const ask of [publish, sync]) {
    expect(ask.toolSummary.length).toBeLessThanOrEqual(2000);
    expect(ask.toolSummary).toMatch(/… and \d+ more/);
    // the full lists are in the input, capped, as valid JSON
    const input = JSON.parse(ask.toolInput);
    expect(input.omitted).toEqual({ commits: 200, files: 300 });
    expect(input.stat).toMatchObject({ commits: 300, files: 500 });
  }
  expect(publish.toolSummary).toContain("300 commits, 500 files");
  expect(publish.toolSummary).toContain("feature/big");
});
