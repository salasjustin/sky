import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
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

// The runner refuses to start Claude where it can't keep the credential from the repo's commands, which
// depends on the host's privileges (a CI runner can't change its effective user). These bundle runs stand
// in for the host so a test's outcome doesn't: a preload that makes the kernel's answers the capable
// sandbox's, and a `setpriv` that only has to exist. `unprivileged` is the host that can't.
const HOST = join(CLAUDE_CONFIG_DIR, "host");
mkdirSync(join(HOST, "bin"), { recursive: true });
writeFileSync(join(HOST, "bin/setpriv"), "#!/bin/sh\n");
chmodSync(join(HOST, "bin/setpriv"), 0o755);
const PRELOADS = {
  capable: `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const realStatSync = fs.statSync;
process.seteuid = () => {};
fs.statSync = (path, ...rest) => {
  const stat = realStatSync(path, ...rest);
  return String(path).endsWith("/environ") ? { ...stat, uid: stat.uid + 1 } : stat;
};
syncBuiltinESMExports();
`,
  unprivileged: `
// stepping to another user is refused; stepping back to one's own is always allowed
const own = process.geteuid();
process.seteuid = (uid) => {
  if (uid !== own) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
};
`,
};
const preload = (host: keyof typeof PRELOADS) => {
  const path = join(HOST, `${host}.mjs`);
  writeFileSync(path, PRELOADS[host]);
  return path;
};

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
});

/** Runs the bundle as the launcher does: the run's id as its argument. `args` replaces that. */
async function runBundle(
  env: Record<string, string>,
  args?: string[],
  host: keyof typeof PRELOADS = "capable",
) {
  const child = spawn(
    process.execPath,
    ["--import", preload(host), bundle, ...(args ?? [env.RUN_ID ?? ""])],
    {
      env: {
        PATH: `${join(HOST, "bin")}:${process.env.PATH ?? ""}`,
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

test("a host whose runner can't change its effective user fails the run as credential_exposed, before any worktree work", async () => {
  const received: { body: unknown }[] = [];
  const api = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      received.push({ body: JSON.parse(body) });
      res.writeHead(204).end();
    });
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  const { port } = api.address() as AddressInfo;
  try {
    const { code } = await runBundle(
      {
        AGENT_ID: "agt_1",
        RUN_ID: "run_1",
        PROMPT: "do it",
        API_BASE_URL: `http://127.0.0.1:${port}`,
        AGENT_TOKEN: "agent-secret",
        CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret",
        REPO_DIR: "/nonexistent/repo",
        WORKTREES_DIR: "/nonexistent/worktrees",
      },
      undefined,
      "unprivileged",
    );
    expect(code).toBe(1);
    expect(received).toEqual([
      {
        body: {
          runId: "run_1",
          type: "run.failed",
          payload: {
            error: expect.stringMatching(
              /^credential_exposed: .*can't change its effective user \(EPERM\).*the run did not start\.$/,
            ),
          },
        },
      },
    ]);
    expect(JSON.stringify(received)).not.toContain("oauth-secret");
  } finally {
    api.closeAllConnections();
    api.close();
  }
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

/**
 * A node left running by its shell, reparented to init as a daemonised dev server is, carrying `RUN_ID`.
 * It notes each SIGTERM at `<dir>/termed`, ignoring it when `stubborn`; `<dir>/ready` exists once its handler is installed.
 */
async function leftover(runId: string, dir: string, stubborn = false) {
  const onTerm = stubborn
    ? `fs.writeFileSync("${join(dir, "termed")}", "")`
    : "process.exit(0)";
  const script = `const fs = require("node:fs"); process.on("SIGTERM", () => ${onTerm}); fs.writeFileSync("${join(dir, "ready")}", ""); setInterval(() => {}, 1000)`;
  const shell = spawn(
    "sh",
    ["-c", `node -e '${script}' >/dev/null 2>&1 </dev/null & echo $!`],
    {
      env: { PATH: process.env.PATH ?? "", RUN_ID: runId },
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  let out = "";
  for await (const chunk of shell.stdout) out += chunk;
  const pid = Number(out.trim());
  leftovers.push(pid);
  await until(() => existsSync(join(dir, "ready")));
  return pid;
}
const leftovers: number[] = [];
afterEach(() => {
  for (const pid of leftovers.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
});

async function until(condition: () => boolean) {
  for (let i = 0; i < 250 && !condition(); i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  expect(condition()).toBe(true);
}

const alive = (pid: number) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat[stat.lastIndexOf(")") + 2] !== "Z";
  } catch {
    return false;
  }
};

const linux = existsSync("/proc/self/stat");

test.skipIf(!linux)(
  "once the run is over the runner ends what its session left running",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "runner-main-reap-"));
    const { seen, base } = await apiAndGateway();
    try {
      const server = await leftover("run_reap1", dir);
      const { code, stderr } = await runBundle({
        ...runEnv(base, join(dir, "run_reap1.prompt")),
        RUN_ID: "run_reap1",
      });
      expect(seen).toEqual(["api"]);
      expect(code).toBe(1);
      expect(alive(server)).toBe(false);
      expect(stderr).toMatch(
        new RegExp(`runner: ended 1 process\\(es\\) .*\\[${server}\\]`),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  20_000,
);

test.skipIf(!linux)(
  "a second stop signal while the runner waits on a leftover that ignores SIGTERM still kills it, then the runner dies by the signal",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "runner-main-reap-"));
    let respond: (() => void) | undefined;
    const api = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        respond = () => res.writeHead(204).end();
      });
    });
    servers.push(api);
    api.listen(0, "127.0.0.1");
    await once(api, "listening");
    const { port } = api.address() as AddressInfo;
    try {
      const server = await leftover("run_reap2", dir, true);
      const child = spawn(process.execPath, [bundle, "run_reap2"], {
        env: {
          PATH: process.env.PATH ?? "",
          CLAUDE_CONFIG_DIR,
          SKY_SPRITE_API_SOCKET: NO_SPRITE_SOCKET,
          ...runEnv(`http://127.0.0.1:${port}`, join(dir, "run_reap2.prompt")),
          RUN_ID: "run_reap2",
        },
        stdio: "ignore",
      });
      const exited = once(child, "exit");
      // the first stop, while the runner is mid-post of run.failed
      await until(() => respond !== undefined);
      child.kill("SIGTERM");
      respond?.();
      // the runner's reap has sent its SIGTERM and is waiting out the grace
      await until(() => existsSync(join(dir, "termed")));
      child.kill("SIGHUP");
      const [code, signal] = await exited;
      expect({ code, signal }).toEqual({ code: null, signal: "SIGHUP" });
      await until(() => !alive(server));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  20_000,
);
