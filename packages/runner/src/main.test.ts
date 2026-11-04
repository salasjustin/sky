import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

const pkg = join(import.meta.dirname, "..");
const bundle = join(pkg, "dist/bundle/runner.mjs");

beforeAll(() => {
  execFileSync("pnpm", ["run", "--silent", "build"], { cwd: pkg });
}, 30_000);

// the runner writes Claude Code's credential file; keep it out of the real home
const CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "runner-claude-"));
afterAll(() => rmSync(CLAUDE_CONFIG_DIR, { recursive: true, force: true }));
// no sprite API here, whatever host the tests run on: the runner would otherwise hold a real sprite
// when run inside one, and retry a missing socket for 30 seconds when run outside
const NO_SPRITE_SOCKET = join(CLAUDE_CONFIG_DIR, "absent.sock");

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
});

/** Runs the bundle as the launcher does: the run's id as its argument. `args` replaces that. */
async function runBundle(env: Record<string, string>, args?: string[]) {
  const child = spawn(
    process.execPath,
    [bundle, ...(args ?? [env.RUN_ID ?? ""])],
    {
      env: {
        PATH: process.env.PATH ?? "",
        CLAUDE_CONFIG_DIR,
        SKY_SPRITE_API_SOCKET: NO_SPRITE_SOCKET,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const [code] = await once(child, "exit");
  return { code, stdout, stderr };
}

test("branch-check is its own command, not a run: with no branch it exits 2 with its usage", async () => {
  const child = spawn(process.execPath, [bundle, "branch-check"], {
    env: { PATH: process.env.PATH ?? "", CLAUDE_CONFIG_DIR },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const [code] = await once(child, "exit");
  expect({ code, stdout, stderr }).toEqual({
    code: 2,
    stdout: "",
    stderr: "usage: branch-check <branch>\n",
  });
});

test.each(["constructor", "toString", "__proto__"])(
  "%s is not a command: the runner starts a run, which wants its env",
  async (name) => {
    const child = spawn(process.execPath, [bundle, name], {
      env: { PATH: process.env.PATH ?? "", CLAUDE_CONFIG_DIR },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const [code] = await once(child, "exit");
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/AGENT_ID/);
  },
);

test("missing env is a usage error: exit 2, one line on stderr, nothing on stdout", async () => {
  const { code, stdout, stderr } = await runBundle({
    AGENT_TOKEN: "agent-secret",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret",
  });
  expect(code).toBe(2);
  expect(stdout).toBe("");
  expect(stderr.trim().split("\n")).toHaveLength(1);
  expect(stderr).toMatch(/AGENT_ID/);
  expect(stderr).not.toMatch(/secret/);
});

const runEnv = (api: string, promptFile: string) => ({
  AGENT_ID: "agt_1",
  RUN_ID: "run_1",
  PROMPT: "do it",
  PROMPT_FILE: promptFile,
  API_BASE_URL: api,
  AGENT_TOKEN: "agent-secret",
  CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret",
  REPO_DIR: "/nonexistent/repo",
  WORKTREES_DIR: "/nonexistent/worktrees",
});

describe("a stray runner.mjs started in a run's shell, which inherits PROMPT_FILE", () => {
  let runs: string;
  let promptFile: string;
  let logFile: string;
  beforeEach(() => {
    runs = mkdtempSync(join(tmpdir(), "runner-main-runs-"));
    promptFile = join(runs, "run_1.prompt");
    logFile = join(runs, "run_1.log");
    writeFileSync(logFile, "the live runner's line\n");
  });
  afterEach(() => rmSync(runs, { recursive: true, force: true }));
  const untouched = () => {
    expect(readFileSync(logFile, "utf8")).toBe("the live runner's line\n");
    expect(readdirSync(runs).sort()).toEqual(["run_1.log"]);
  };

  test("without the run's env it refuses with a clear line on stderr, and leaves the run's log alone", async () => {
    const { code, stdout, stderr } = await runBundle(
      { PROMPT_FILE: promptFile },
      [],
    );
    expect({ code, stdout }).toEqual({ code: 2, stdout: "" });
    expect(stderr.trim().split("\n")).toHaveLength(1);
    expect(stderr).toMatch(/missing or invalid env: .*AGENT_TOKEN/);
    expect(stderr).toMatch(/only the Sky API starts a run/);
    untouched();
  });

  test.each([
    ["no argument", [], /no command/],
    ["an unknown command", ["publsh"], /unknown command "publsh"/],
    ["another run's id", ["run_2"], /unknown command "run_2"/],
  ])(
    "with the run's env but %s it refuses, and leaves the run's log alone",
    async (_, args, message) => {
      const { code, stdout, stderr } = await runBundle(
        runEnv("http://127.0.0.1:1", promptFile),
        args,
      );
      expect({ code, stdout }).toEqual({ code: 2, stdout: "" });
      expect(stderr).toMatch(message);
      untouched();
    },
  );

  test("with the run's env and its id, but a live runner already holding the run, it refuses and leaves the log alone", async () => {
    writeFileSync(join(runs, "run_1.lock"), String(process.pid));
    const { code, stderr } = await runBundle(
      runEnv("http://127.0.0.1:1", promptFile),
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(
      new RegExp(
        `another runner \\(pid ${process.pid}\\) already runs this run`,
      ),
    );
    expect(readFileSync(logFile, "utf8")).toBe("the live runner's line\n");
    // the live runner's lock is still its own
    expect(readFileSync(join(runs, "run_1.lock"), "utf8")).toBe(
      String(process.pid),
    );
  });

  test("the run's own runner appends to the log, holds the lock while it runs and frees it on exit", async () => {
    const api = createServer((req, res) => {
      req.resume();
      req.on("end", () => res.writeHead(204).end());
    });
    api.listen(0, "127.0.0.1");
    await once(api, "listening");
    const { port } = api.address() as AddressInfo;
    try {
      const { code } = await runBundle(
        runEnv(`http://127.0.0.1:${port}`, promptFile),
      );
      expect(code).toBe(1);
    } finally {
      api.closeAllConnections();
      api.close();
    }
    const log = readFileSync(logFile, "utf8");
    expect(log.startsWith("the live runner's line\n")).toBe(true);
    expect(log).toMatch(/runner: sprite hold started/);
    expect(existsSync(join(runs, "run_1.lock"))).toBe(false);
  }, 20_000);
});

test("a failed run posts run.failed to the API with the agent token, exits 1, and leaves nothing running", async () => {
  const received: { auth?: string; body: unknown }[] = [];
  const api = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      received.push({
        auth: req.headers.authorization,
        body: JSON.parse(body),
      });
      res.writeHead(204).end();
    });
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  const { port } = api.address() as AddressInfo;
  try {
    const { code, stdout } = await runBundle({
      AGENT_ID: "agt_1",
      RUN_ID: "run_1",
      PROMPT: "do it",
      API_BASE_URL: `http://127.0.0.1:${port}`,
      AGENT_TOKEN: "agent-secret",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret",
      REPO_DIR: "/nonexistent/repo",
      WORKTREES_DIR: "/nonexistent/worktrees",
    });
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(received).toEqual([
      {
        auth: "Bearer agent-secret",
        body: {
          runId: "run_1",
          type: "run.failed",
          payload: { error: expect.stringMatching(/worktree setup failed/) },
        },
      },
    ]);
  } finally {
    api.closeAllConnections();
    api.close();
  }
  // an idle keep-alive socket or a live child would hold the process open: runBundle then never
  // resolves and the timeout fails the test, with no wall-clock threshold to tune
}, 20_000);

test("the runner holds the sprite through the Tasks API at SKY_SPRITE_API_SOCKET", async () => {
  const sockets = mkdtempSync(join(tmpdir(), "runner-main-sprite-"));
  const tasks: string[] = [];
  const sprite = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      tasks.push(`${req.method} ${req.headers.host} ${req.url}`);
      res.writeHead(200).end();
    });
  });
  servers.push(sprite);
  const socketPath = join(sockets, "api.sock");
  sprite.listen(socketPath);
  await once(sprite, "listening");
  const api = createServer((req, res) => {
    req.resume();
    req.on("end", () => res.writeHead(204).end());
  });
  servers.push(api);
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  const { port } = api.address() as AddressInfo;
  try {
    const { code } = await runBundle({
      ...runEnv(`http://127.0.0.1:${port}`, join(sockets, "run_1.prompt")),
      SKY_SPRITE_API_SOCKET: socketPath,
    });
    expect(code).toBe(1);
  } finally {
    rmSync(sockets, { recursive: true, force: true });
  }
  const task = "/v1/tasks/sky-run-37ddff8ee13f1e57937fd048";
  expect(tasks).toEqual([`PUT sprite ${task}`, `DELETE sprite ${task}`]);
}, 20_000);

test("SIGHUP is a stop like SIGTERM: the run still reports, then the runner dies by the signal and frees its lock", async () => {
  const runs = mkdtempSync(join(tmpdir(), "runner-main-runs-"));
  const lock = join(runs, "run_1.lock");
  let respond: (() => void) | undefined;
  const posted = new Promise<void>((resolve) => {
    const api = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        respond = () => res.writeHead(204).end();
        resolve();
      });
    });
    api.listen(0, "127.0.0.1");
    servers.push(api);
  });
  const api = servers.at(-1);
  if (!api) throw new Error("no server");
  await once(api, "listening");
  const { port } = api.address() as AddressInfo;
  const child = spawn(process.execPath, [bundle, "run_1"], {
    env: {
      PATH: process.env.PATH ?? "",
      CLAUDE_CONFIG_DIR,
      SKY_SPRITE_API_SOCKET: NO_SPRITE_SOCKET,
      AGENT_ID: "agt_1",
      RUN_ID: "run_1",
      PROMPT: "do it",
      API_BASE_URL: `http://127.0.0.1:${port}`,
      AGENT_TOKEN: "agent-secret",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret",
      REPO_DIR: "/nonexistent/repo",
      WORKTREES_DIR: "/nonexistent/worktrees",
      PROMPT_FILE: join(runs, "run_1.prompt"),
    },
    stdio: "ignore",
  });
  try {
    const exited = once(child, "exit");
    // the runner is mid-post of run.failed, the API holding its answer
    await posted;
    expect(readFileSync(lock, "utf8")).toBe(String(child.pid));
    child.kill("SIGHUP");
    await new Promise((r) => setTimeout(r, 300));
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    respond?.();
    const [code, signal] = await exited;
    expect({ code, signal }).toEqual({ code: null, signal: "SIGHUP" });
    // death by a signal fires no 'exit' event, so the runner frees the lock itself before it
    expect(existsSync(lock)).toBe(false);
  } finally {
    rmSync(runs, { recursive: true, force: true });
  }
});

/** One server answering as both the Sky API and the GitHub gateway, logging what it saw in order. */
async function apiAndGateway() {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      seen.push(req.url?.startsWith("/gateway/") ? "store" : "api");
      // the gateway is down, so every store sync fails
      res.writeHead(req.url?.startsWith("/gateway/") ? 502 : 204).end();
    });
  });
  server.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return { seen, base: `http://127.0.0.1:${port}` };
}

const storeRunEnv = (base: string, storeHome: string) => ({
  AGENT_ID: "agt_1",
  RUN_ID: "run_1",
  PROMPT: "do it",
  API_BASE_URL: base,
  AGENT_TOKEN: "agent-secret",
  CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret",
  // the run fails at worktree setup, so no session starts
  REPO_DIR: "/nonexistent/repo",
  WORKTREES_DIR: "/nonexistent/worktrees",
  HOME: storeHome,
  SKY_STORE_HOME: ".store",
  SKY_STORE_REPO: "acme/store",
  GITHUB_CONNECTOR: "conn_1",
  GITHUB_GATEWAY_URL: `${base}/gateway`,
});

test("the store is pulled before the run and pushed after it, a failed run included, and failing syncs leave the run's exit code alone", async () => {
  const { seen, base } = await apiAndGateway();
  const home = mkdtempSync(join(tmpdir(), "runner-main-store-"));
  try {
    const { code, stderr } = await runBundle(storeRunEnv(base, home));
    expect(seen).toEqual(["store", "api", "store"]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/runner: .*pull/);
    expect(stderr).toMatch(/runner: .*push/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);

test.each(["SKY_NO_STORE_SYNC", "KRU_NO_STORE_SYNC"])(
  "%s turns the pull and the push off",
  async (name) => {
    const { seen, base } = await apiAndGateway();
    const home = mkdtempSync(join(tmpdir(), "runner-main-store-"));
    try {
      const { code, stderr } = await runBundle({
        ...storeRunEnv(base, home),
        [name]: "1",
      });
      expect(seen).toEqual(["api"]);
      expect(code).toBe(1);
      expect(stderr).not.toMatch(/pull|push/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
  30_000,
);
