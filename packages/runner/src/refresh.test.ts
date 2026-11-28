import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvRefresh } from "@sky/shared";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  ENV_REFRESH_MAX_TIMEOUT_MS,
  ENV_REFRESH_TIMEOUT_MS,
  envRefreshBudgetMs,
  redactOutput,
  refreshEnv,
  refreshWarning,
  runEnvRefresh,
} from "./refresh.js";

let dir: string;
let lockFile: string;
let logFile: string;
const lines: string[] = [];
const warn = (line: string) => lines.push(line);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "runner-refresh-"));
  lockFile = join(dir, "refresh.lock");
  logFile = join(dir, "refresh.log");
  lines.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const baseEnv = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? "",
  HOME: dir,
});

const run = (
  script: string,
  options: Partial<Parameters<typeof runEnvRefresh>[0]> = {},
) =>
  runEnvRefresh({
    script,
    env: baseEnv(),
    warn,
    lockFile,
    logFile,
    graceMs: 200,
    ...options,
  });

const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

describe("the env the script gets", () => {
  const held = {
    PATH: "/usr/bin",
    HOME: "/home/agent",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret-value",
    SKY_CLAUDE_API_KEY: "sky-claude-key-value",
    GITHUB_CONNECTOR: "conn_1",
    GITHUB_GATEWAY_URL: "https://gateway.test",
    AI_GATEWAY_API_KEY: "gateway-key-value",
    SKY_CODEX_GATEWAY_TOKEN: "proxy-token-value",
    SKY_PI_GATEWAY_TOKEN: "pi-proxy-token-value",
    AGENT_TOKEN: "agent-secret",
    SKY_CODEX_HOME: "/x/codex",
    SKY_REFRESH: "echo hi",
    PROJECT_SECRET: "the-projects-own",
  };

  test("holds no more than the agent does: the credential, connector, gateway key and proxy tokens are withdrawn", () => {
    const env = refreshEnv(held, { SESSION_VAR: "from the profile" });
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/agent",
      // what a Bash call of the session sees, the project's own secrets and the profile's variables included
      PROJECT_SECRET: "the-projects-own",
      SESSION_VAR: "from the profile",
    });
  });

  test("a script run with it sees none of them", () => {
    const out = join(dir, "env.out");
    const env = refreshEnv(
      { ...held, PATH: process.env.PATH ?? "", HOME: dir },
      { SESSION_VAR: "set" },
    );
    return runEnvRefresh({
      script: `env > '${out}'`,
      env,
      warn,
      lockFile,
      logFile,
    }).then((record) => {
      expect(record.outcome).toBe("ran");
      const seen = readFileSync(out, "utf8");
      for (const name of [
        "CLAUDE_CODE_OAUTH_TOKEN",
        "SKY_CLAUDE_API_KEY",
        "GITHUB_CONNECTOR",
        "GITHUB_GATEWAY_URL",
        "AI_GATEWAY_API_KEY",
        "SKY_CODEX_GATEWAY_TOKEN",
        "SKY_PI_GATEWAY_TOKEN",
        "AGENT_TOKEN",
      ])
        expect(seen).not.toContain(name);
      for (const value of [
        "oauth-secret-value",
        "gateway-key-value",
        "proxy-token-value",
        "conn_1",
      ])
        expect(seen).not.toContain(value);
      expect(seen).toContain("PROJECT_SECRET=the-projects-own");
      expect(seen).toContain("SESSION_VAR=set");
    });
  });
});

describe("a script that ends", () => {
  test("ran: exit 0, its output in the log file and the tail of the record", async () => {
    const record = await run("echo built; echo done >&2");
    expect(record).toEqual({
      outcome: "ran",
      exitCode: 0,
      durationMs: expect.any(Number),
      tail: "built\ndone",
    });
    expect(readFileSync(logFile, "utf8")).toBe("built\ndone\n");
    expect(EnvRefresh.safeParse(record).success).toBe(true);
    expect(refreshWarning(record)).toBeUndefined();
  });

  test("failed: the exit code, the reason and the last lines, and a warning with the last line", async () => {
    const record = await run(
      "echo first; echo 'git: not a repository' >&2; exit 3",
    );
    expect(record).toMatchObject({
      outcome: "failed",
      exitCode: 3,
      reason: "exited with code 3",
      tail: "first\ngit: not a repository",
    });
    expect(refreshWarning(record)).toBe(
      "env refresh failed (exit 3): git: not a repository",
    );
    expect(lines.join("\n")).toMatch(/env refresh failed \(exit 3\)/);
  });

  test("a script killed by a signal is failed, naming it", async () => {
    const record = await run("kill -9 $$");
    expect(record.outcome).toBe("failed");
    expect(record.reason).toBe("killed by SIGKILL");
  });

  test("cwd is where the script runs", async () => {
    const record = await run("pwd", { cwd: dir });
    expect(record.tail).toBe(readFileSync(logFile, "utf8").trim());
    expect(record.tail?.endsWith(dir.split("/").pop() as string)).toBe(true);
  });
});

describe("the budget", () => {
  test("a script past it is cut with SIGTERM, then SIGKILL, its whole process group, and waited on", async () => {
    const pids = join(dir, "pids");
    // a child that ignores SIGTERM, and one that doesn't, both in the script's group
    const record = await run(
      `(trap '' TERM; sleep 300) & echo $! >> '${pids}'; sleep 300 & echo $! >> '${pids}'; wait`,
      { timeoutMs: 400 },
    );
    expect(record.outcome).toBe("timed_out");
    expect(record.reason).toBe("timed out after 0.4s");
    // the run is only given back once the group is gone
    const children = readFileSync(pids, "utf8").trim().split("\n").map(Number);
    expect(children).toHaveLength(2);
    for (const pid of children) expect(gone(pid)).toBe(true);
    expect(refreshWarning(record)).toMatch(/^env refresh timed out/);
    expect(record.durationMs).toBeLessThan(5_000);
  });

  test("a stop cuts it the same way and records skipped for the stop, with no warning", async () => {
    const stop = new AbortController();
    const started = join(dir, "started");
    const pending = run(`touch '${started}'; sleep 300 & wait`, {
      signal: stop.signal,
    });
    while (!existsSync(started)) await new Promise((r) => setTimeout(r, 20));
    stop.abort("SIGTERM");
    const record = await pending;
    expect(record).toMatchObject({ outcome: "skipped", reason: "stopped" });
    expect(refreshWarning(record)).toBeUndefined();
  });

  test("a stop before it starts runs nothing", async () => {
    const marker = join(dir, "marker");
    const record = await run(`touch '${marker}'`, {
      signal: AbortSignal.abort("SIGTERM"),
    });
    expect(record).toMatchObject({ outcome: "skipped", reason: "stopped" });
    expect(existsSync(marker)).toBe(false);
  });

  test("the default is 120 s, a secret may set it, and it stays under 300 s and a quarter of the launch's deadline", () => {
    const deadline = 15 * 60_000;
    expect(ENV_REFRESH_TIMEOUT_MS).toBe(120_000);
    expect(envRefreshBudgetMs(undefined, deadline)).toBe(120_000);
    expect(envRefreshBudgetMs(30_000, deadline)).toBe(30_000);
    expect(envRefreshBudgetMs(3_600_000, deadline)).toBe(225_000);
    expect(envRefreshBudgetMs(3_600_000, 60 * 60_000)).toBe(
      ENV_REFRESH_MAX_TIMEOUT_MS,
    );
    expect(envRefreshBudgetMs(undefined, 4 * 60_000)).toBe(60_000);
    expect(envRefreshBudgetMs(1, 15 * 60_000)).toBe(1_000);
  });
});

describe("the lock beside other runs'", () => {
  test("a run that waited on another run's refresh skips its own, as skipped", async () => {
    const marker = join(dir, "marker");
    // a live holder: this process
    writeFileSync(lockFile, String(process.pid));
    setTimeout(() => rmSync(lockFile), 400);
    const record = await run(`touch '${marker}'`);
    expect(record).toMatchObject({
      outcome: "skipped",
      reason: "another run refreshed",
    });
    expect(existsSync(marker)).toBe(false);
    expect(refreshWarning(record)).toBeUndefined();
  });

  test("a lock whose holder is gone is taken over and the script runs", async () => {
    // pid 2^22+1 is past the default pid_max: no process
    writeFileSync(lockFile, "4194305");
    const record = await run("true");
    expect(record.outcome).toBe("ran");
    expect(existsSync(lockFile)).toBe(false);
  });

  test("a holder that outlasts the budget ends it as timed_out", async () => {
    writeFileSync(lockFile, String(process.pid));
    const record = await run("true", { timeoutMs: 300 });
    expect(record.outcome).toBe("timed_out");
    expect(record.reason).toMatch(/waiting for another run's refresh/);
    expect(readFileSync(lockFile, "utf8")).toBe(String(process.pid));
  });

  test("the lock is freed after the script, whatever it did", async () => {
    await run("exit 1");
    expect(existsSync(lockFile)).toBe(false);
  });
});

describe("the record's tail", () => {
  test("holds the last few lines, at most 1,000 characters, with secrets and token shapes redacted", async () => {
    const env = { ...baseEnv(), MY_DEPLOY_TOKEN: "hunter2hunter2" };
    const record = await run(
      [
        "for i in $(seq 1 60); do echo \"line $i $(printf 'x%.0s' $(seq 1 40))\"; done",
        'echo "token is $MY_DEPLOY_TOKEN and ghp_0123456789abcdefghijABCDEFGHIJ"',
        "exit 2",
      ].join("\n"),
      { env },
    );
    const tail = record.tail as string;
    expect(tail.length).toBeLessThanOrEqual(1_000);
    expect(tail.split("\n").length).toBeLessThanOrEqual(8);
    expect(tail).toContain("line 60");
    expect(tail).not.toContain("line 1 ");
    expect(tail).toContain("token is [redacted] and [redacted]");
    expect(tail).not.toContain("hunter2");
    expect(tail).not.toContain("ghp_");
    expect(refreshWarning(record)).toBe(
      "env refresh failed (exit 2): token is [redacted] and [redacted]",
    );
    expect(EnvRefresh.safeParse(record).success).toBe(true);
  });

  test("strips escape sequences and control characters", async () => {
    const record = await run("printf '\\033[31mred\\033[0m\\a\\n'");
    expect(record.tail).toBe("red");
  });

  test("a long single line is cut from its front", async () => {
    const record = await run("printf 'a%.0s' $(seq 1 5000); echo END");
    expect(record.tail?.length).toBe(1_000);
    expect(record.tail?.endsWith("END")).toBe(true);
  });

  test("redactOutput leaves short values and ordinary text alone", () => {
    expect(
      redactOutput("a short x and the long-secret-value", {
        A_KEY: "x",
        B_TOKEN: "long-secret-value",
        NOT_ONE: "ordinary-value-here",
      }),
    ).toBe("a short x and the [redacted]");
  });
});

describe("the warning", () => {
  test("names the outcome, the exit code and the last line, or the reason without output", () => {
    expect(
      refreshWarning({
        outcome: "failed",
        exitCode: 1,
        durationMs: 5,
        tail: "a\nb",
      }),
    ).toBe("env refresh failed (exit 1): b");
    expect(
      refreshWarning({
        outcome: "timed_out",
        durationMs: 5,
        reason: "timed out after 120.0s",
      }),
    ).toBe("env refresh timed out: timed out after 120.0s");
    expect(
      refreshWarning({ outcome: "skipped", durationMs: 5, reason: "stopped" }),
    ).toBeUndefined();
  });
});

describe("the shared record", () => {
  test("is bounded: the tail at 1,000 characters, the reason at 300, the outcome one of four", () => {
    const ok = { outcome: "ran", durationMs: 1 };
    expect(EnvRefresh.safeParse(ok).success).toBe(true);
    expect(
      EnvRefresh.safeParse({ ...ok, tail: "x".repeat(1_001) }).success,
    ).toBe(false);
    expect(
      EnvRefresh.safeParse({ ...ok, reason: "x".repeat(301) }).success,
    ).toBe(false);
    expect(EnvRefresh.safeParse({ ...ok, outcome: "refreshed" }).success).toBe(
      false,
    );
    expect(EnvRefresh.safeParse({ ...ok, durationMs: -1 }).success).toBe(false);
  });
});
