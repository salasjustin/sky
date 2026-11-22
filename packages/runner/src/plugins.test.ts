import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginRefresh } from "@sky/shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  claudeBinary,
  killRefreshCommands,
  loadedPlugins,
  PLUGIN_LIST_TIMEOUT_MS,
  PLUGIN_REFRESH_TIMEOUT_MS,
  PLUGIN_STEP_TIMEOUT_MS,
  refreshPlugins,
  runInGroup,
} from "./plugins.js";

const listing = JSON.stringify([
  { id: "kru@kru", scope: "user" },
  { id: "kru@kru", scope: "project" },
  { id: "other@kru", scope: "user" },
]);

// each test gets its own lock file, so none takes the sprite-wide one in the temp dir
let lockDir: string;
beforeEach(() => {
  lockDir = mkdtempSync(join(tmpdir(), "sky-lock-"));
});
afterEach(() => rmSync(lockDir, { recursive: true, force: true }));
const refresh = (options: Parameters<typeof refreshPlugins>[0]) =>
  refreshPlugins({ lockFile: join(lockDir, "lock"), ...options });

describe("refreshPlugins", () => {
  test("refreshes the marketplaces, updates each user-scope plugin once, and logs the duration", async () => {
    const calls: string[][] = [];
    const warn = vi.fn();
    let t = 0;
    await refresh({
      env: { A: "b" },
      warn,
      claude: "claude-bin",
      now: () => (t += 1500),
      run: async (file, args, { env }) => {
        expect(file).toBe("claude-bin");
        expect(env).toEqual({ A: "b" });
        calls.push(args);
        return { stdout: args[1] === "list" ? listing : "" };
      },
    });
    expect(calls).toEqual([
      ["plugin", "list", "--json"],
      ["plugin", "marketplace", "update", "kru"],
      ["plugin", "update", "kru@kru", "--scope", "user"],
      ["plugin", "update", "other@kru", "--scope", "user"],
      // read back, for the record of what the refresh left installed
      ["plugin", "list", "--json"],
    ]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toBe(
      "runner: plugins refreshed in 1.5s (kru@kru, other@kru)",
    );
  });

  test("a failing command is one warning and does not throw", async () => {
    const warn = vi.fn();
    await refresh({
      env: {},
      warn,
      claude: "c",
      run: async (_f, args) => {
        if (args[1] === "list") throw new Error("not json\nmore");
        return { stdout: listing };
      },
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatch(
      /plugin refresh failed \(not json\); continuing/,
    );
  });

  test("a hung command is cut at the timeout and the session continues", async () => {
    const warn = vi.fn();
    await refresh({
      env: {},
      warn,
      claude: "c",
      timeoutMs: 50,
      run: (_f, _a, { signal }) =>
        new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason)),
        ),
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatch(/timed out after .*continuing/);
  });

  test("a failing plugin update leaves the rest updating and is named in the warning", async () => {
    const calls: string[][] = [];
    const warn = vi.fn();
    await refresh({
      env: {},
      warn,
      claude: "c",
      run: async (_f, args) => {
        calls.push(args);
        if (args[2] === "kru@kru") throw new Error("delisted\nmore");
        return { stdout: args[1] === "list" ? listing : "" };
      },
    });
    expect(calls).toContainEqual([
      "plugin",
      "update",
      "other@kru",
      "--scope",
      "user",
    ]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatch(
      /plugins refreshed in .*\(other@kru\); update failed for kru@kru \(delisted\)/,
    );
  });

  test("a timeout during one plugin update ends the whole refresh", async () => {
    const calls: string[][] = [];
    const warn = vi.fn();
    await refresh({
      env: {},
      warn,
      claude: "c",
      timeoutMs: 50,
      run: (_f, args, { signal }) => {
        calls.push(args);
        if (args[1] !== "update")
          return Promise.resolve({ stdout: args[1] === "list" ? listing : "" });
        return new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason)),
        );
      },
    });
    expect(calls.filter((a) => a[1] === "update")).toHaveLength(1);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatch(/timed out after .*continuing/);
  });

  test("a stop mid-refresh ends it promptly and says it was stopped", async () => {
    const warn = vi.fn();
    const stop = new AbortController();
    const done = refresh({
      env: {},
      warn,
      claude: "c",
      signal: stop.signal,
      run: (_f, _a, { signal }) =>
        new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason)),
        ),
    });
    stop.abort("SIGTERM");
    await done;
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatch(/plugin refresh stopped after/);
    expect(warn.mock.calls[0]?.[0]).not.toMatch(/timed out/);
  });

  test("an already-stopped run spawns no claude", async () => {
    const warn = vi.fn();
    const run = vi.fn();
    await refresh({
      env: {},
      warn,
      claude: "c",
      signal: AbortSignal.abort("SIGTERM"),
      run,
    });
    expect(run).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatch(
      /plugin refresh skipped \(stopped\)/,
    );
  });
});

describe("refreshPlugins on odd listings", () => {
  test("a plugin listed twice at user scope is updated once", async () => {
    const calls: string[][] = [];
    await refresh({
      env: {},
      warn: vi.fn(),
      claude: "c",
      run: async (_f, args) => {
        calls.push(args);
        return {
          stdout:
            args[1] === "list"
              ? JSON.stringify([
                  { id: "kru@kru", scope: "user" },
                  { id: "kru@kru", scope: "user" },
                ])
              : "",
        };
      },
    });
    expect(calls.filter((a) => a[1] === "update")).toEqual([
      ["plugin", "update", "kru@kru", "--scope", "user"],
    ]);
  });

  test.each([
    ["invalid JSON", "not json"],
    ["JSON that is not an array", '{"id":"kru@kru","scope":"user"}'],
    ["empty output", ""],
  ])(
    "%s is one warning, runs nothing further, and does not throw",
    async (_name, stdout) => {
      const calls: string[][] = [];
      const warn = vi.fn();
      await refresh({
        env: {},
        warn,
        claude: "c",
        run: async (_f, args) => {
          calls.push(args);
          return { stdout };
        },
      });
      expect(calls).toEqual([["plugin", "list", "--json"]]);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]?.[0]).toMatch(
        /plugin refresh failed \(.+\); continuing with the installed versions/,
      );
    },
  );

  test("with no user-scope plugins nothing is updated and the warning says none installed", async () => {
    const calls: string[][] = [];
    const warn = vi.fn();
    await refresh({
      env: {},
      warn,
      claude: "c",
      run: async (_f, args) => {
        calls.push(args);
        return {
          stdout: JSON.stringify([{ id: "kru@kru", scope: "project" }]),
        };
      },
    });
    expect(calls).toEqual([["plugin", "list", "--json"]]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatch(/\(none installed\)/);
  });
});

/**
 * A `claude` over a table of installed versions: `plugin list` reports it, and `plugin update`
 * moves a plugin to `latest` unless `stuck` names it (the update says it worked, the version stays).
 */
function fakeClaude(
  installed: Record<string, string>,
  latest: string,
  stuck: string[] = [],
) {
  const versions = { ...installed };
  const run = async (_f: string, args: string[]) => {
    if (args[1] === "list")
      return {
        stdout: JSON.stringify([
          ...Object.entries(versions).map(([id, version]) => ({
            id,
            version,
            scope: "user",
          })),
          { id: "kru@kru", version: "0.1.0", scope: "project" },
        ]),
      };
    if (args[1] === "update" && !stuck.includes(args[2] as string))
      versions[args[2] as string] = latest;
    return { stdout: "" };
  };
  return { run, versions };
}

describe("refreshPlugins record", () => {
  const record = (options: Partial<Parameters<typeof refreshPlugins>[0]>) =>
    refreshPlugins({
      env: {},
      warn: vi.fn(),
      claude: "c",
      lockFile: join(lockDir, "lock"),
      ...options,
    });

  test("a refresh that moved the plugins records each one's version before and after, with its marketplace", async () => {
    const { run } = fakeClaude(
      { "kru@kru": "0.214.0", "tool@acme": "1.0.0" },
      "0.216.0",
    );
    let t = 0;
    let s = 0;
    const result = await record({
      run,
      now: () => (t += 2000),
      stepNow: () => (s += 150),
    });
    expect(result).toEqual({
      steps: [
        { name: "list before", ms: 150 },
        { name: "update marketplace kru", ms: 150 },
        { name: "update marketplace acme", ms: 150 },
        { name: "update kru@kru", ms: 150 },
        { name: "update tool@acme", ms: 150 },
        { name: "list after", ms: 150 },
      ],
      outcome: "refreshed",
      durationMs: 4000, // the fake clock steps 2s per read: start, the log line, the record
      before: [
        { name: "kru", marketplace: "kru", version: "0.214.0" },
        { name: "tool", marketplace: "acme", version: "1.0.0" },
      ],
      after: [
        { name: "kru", marketplace: "kru", version: "0.216.0" },
        { name: "tool", marketplace: "acme", version: "0.216.0" },
      ],
    });
  });

  test("an update that says it worked but leaves the version is recorded as unchanged", async () => {
    const { run } = fakeClaude({ "kru@kru": "0.214.0" }, "0.216.0", [
      "kru@kru",
    ]);
    const result = await record({ run });
    expect(result.outcome).toBe("refreshed");
    expect(result.before).toEqual(result.after);
    expect(result.after).toEqual([
      { name: "kru", marketplace: "kru", version: "0.214.0" },
    ]);
  });

  test("a failing plugin update is a failed outcome naming the plugin and why, with the versions as they stand", async () => {
    const fake = fakeClaude(
      { "kru@kru": "0.214.0", "tool@acme": "1.0.0" },
      "2.0.0",
    );
    const result = await record({
      run: async (f, args) => {
        if (args[1] === "update" && args[2] === "kru@kru")
          throw new Error("delisted\nmore");
        return fake.run(f, args);
      },
    });
    expect(result).toMatchObject({
      outcome: "failed",
      reason: "update failed for kru@kru (delisted)",
    });
    expect(result.before?.map((p) => p.version)).toEqual(["0.214.0", "1.0.0"]);
    expect(result.after?.map((p) => p.version)).toEqual(["0.214.0", "2.0.0"]);
  });

  test("a marketplace that fails fast is recorded as failed, named, and the updates after it still run from the cache", async () => {
    const fake = fakeClaude({ "kru@kru": "0.214.0" }, "0.216.0");
    const result = await record({
      run: async (f, args) => {
        if (args[1] === "marketplace")
          throw Object.assign(new Error("Command failed: c plugin"), {
            stderr: "could not resolve host\nmore",
          });
        return fake.run(f, args);
      },
    });
    expect(result).toMatchObject({
      outcome: "failed",
      reason: "update failed for marketplace kru (could not resolve host)",
    });
    expect(result.before?.map((p) => p.version)).toEqual(["0.214.0"]);
    expect(result.after?.map((p) => p.version)).toEqual(["0.216.0"]);
  });

  test("a refresh cut at the timeout is timed_out, and an update that landed before the cut shows in after", async () => {
    const fake = fakeClaude(
      { "kru@kru": "0.214.0", "tool@acme": "1.0.0" },
      "0.216.0",
    );
    const result = await record({
      timeoutMs: 50,
      listTimeoutMs: 1000,
      run: (f, args, { signal }) => {
        if (args[1] === "update" && args[2] === "tool@acme")
          return new Promise((_, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason)),
          );
        return fake.run(f, args);
      },
    });
    expect(result.outcome).toBe("timed_out");
    expect(result.before?.map((p) => p.version)).toEqual(["0.214.0", "1.0.0"]);
    expect(result.after?.map((p) => p.version)).toEqual(["0.216.0", "1.0.0"]);
  });

  test("a stalled marketplace update is cut at the step budget and the updates after it still run", async () => {
    const fake = fakeClaude({ "kru@kru": "0.214.0" }, "0.216.0");
    const result = await record({
      timeoutMs: 5000,
      stepTimeoutMs: 30,
      run: (f, args, { signal }) => {
        if (args[1] === "marketplace")
          return new Promise((_, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason)),
          );
        return fake.run(f, args);
      },
    });
    expect(result).toMatchObject({
      outcome: "failed",
      reason: "update failed for marketplace kru (timed out after 0.0s)",
    });
    expect(result.after?.map((p) => p.version)).toEqual(["0.216.0"]);
    expect(result.steps?.map((s) => s.name)).toEqual([
      "list before",
      "update marketplace kru",
      "update kru@kru",
      "list after",
    ]);
  });

  /** Never answers: only the command's signal ends it. */
  const hangs = (signal: AbortSignal) =>
    new Promise<{ stdout: string }>((_, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason)),
    );

  test("a stalled user-scope plugin update is cut at the step budget, named in the failure, and the updates after it still run", async () => {
    const fake = fakeClaude(
      { "kru@kru": "0.214.0", "tool@acme": "1.0.0" },
      "0.216.0",
    );
    const result = await record({
      timeoutMs: 5000,
      stepTimeoutMs: 30,
      run: (f, args, { signal }) => {
        if (args[1] === "update" && args[2] === "kru@kru") return hangs(signal);
        return fake.run(f, args);
      },
    });
    expect(result.outcome).toBe("failed");
    expect(result.reason).toMatch(
      /^update failed for kru@kru \(timed out after /,
    );
    expect(result.after?.map((p) => p.version)).toEqual(["0.214.0", "0.216.0"]);
    expect(result.steps?.map((s) => s.name)).toEqual([
      "list before",
      "update marketplace kru",
      "update marketplace acme",
      "update kru@kru",
      "update tool@acme",
      "list after",
    ]);
  });

  test("each command gets its own step budget, so commands that together outlast one budget all finish", async () => {
    const fake = fakeClaude(
      { "kru@kru": "0.214.0", "tool@acme": "1.0.0" },
      "0.216.0",
    );
    const result = await record({
      timeoutMs: 5000,
      // three commands of ~150ms each: 450ms in all, past one 300ms budget, each well inside its own
      stepTimeoutMs: 300,
      run: async (f, args, { signal }) => {
        if (args[1] !== "list")
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 150);
            signal.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(signal.reason);
            });
          });
        return fake.run(f, args);
      },
    });
    expect(result.outcome).toBe("refreshed");
    expect(result.reason).toBeUndefined();
    expect(result.after?.map((p) => p.version)).toEqual(["0.216.0", "0.216.0"]);
  });

  test("the seconds in a step-budget failure are the budget, not how long the command ran", async () => {
    const fake = fakeClaude({ "kru@kru": "0.214.0" }, "0.216.0");
    let t = 0;
    let s = 0;
    const result = await record({
      timeoutMs: 5000,
      stepTimeoutMs: 60,
      // clocks that read far from 60ms, so a reason built from either shows
      now: () => (t += 4000),
      stepNow: () => (s += 3000),
      run: (f, args, { signal }) => {
        if (args[1] === "update") return hangs(signal);
        return fake.run(f, args);
      },
    });
    expect(result.reason).toBe(
      "update failed for kru@kru (timed out after 0.1s)",
    );
  });

  test("a command that outlasts the refresh's budget is the last step, counted up to the cut", async () => {
    const fake = fakeClaude({ "kru@kru": "0.214.0" }, "0.216.0");
    let s = 0;
    const result = await record({
      timeoutMs: 50,
      listTimeoutMs: 1000,
      stepNow: () => (s += 100),
      run: (f, args, { signal }) => {
        if (args[1] === "update")
          return new Promise((_, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason)),
          );
        return fake.run(f, args);
      },
    });
    expect(result.outcome).toBe("timed_out");
    expect(result.steps).toEqual([
      { name: "list before", ms: 100 },
      { name: "update marketplace kru", ms: 100 },
      { name: "update kru@kru", ms: 100 },
      { name: "list after (cut short)", ms: 100 },
    ]);
  });

  test("the steps stay within 50 entries however many plugins there are", async () => {
    const ids = Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [`p${i}@m`, "1.0.0"]),
    );
    const fake = fakeClaude(ids, "2.0.0");
    const result = await record({ run: fake.run });
    expect(result.outcome).toBe("refreshed");
    expect(result.steps).toHaveLength(50);
    expect(result.steps?.[0]?.name).toBe("list before");
    expect(PluginRefresh.safeParse({ ...result, loaded: [] }).success).toBe(
      true,
    );
  });

  test("a run that ran no command has no steps", async () => {
    const result = await record({
      run: vi.fn(),
      signal: AbortSignal.abort("SIGTERM"),
    });
    expect(result).not.toHaveProperty("steps");
  });

  test("a hung first listing is timed_out with both lists never read", async () => {
    const result = await record({
      timeoutMs: 50,
      run: (_f, _a, { signal }) =>
        new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason)),
        ),
    });
    expect(result).toMatchObject({
      outcome: "timed_out",
      before: null,
      after: null,
    });
  });

  test("an already-stopped run is skipped: stopped, and spawns nothing", async () => {
    const run = vi.fn();
    const result = await record({ run, signal: AbortSignal.abort("SIGTERM") });
    expect(run).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: "skipped",
      reason: "stopped",
      before: null,
      after: null,
    });
  });

  test("a run that waited out another run's refresh is skipped with that reason, and runs no claude", async () => {
    const lockFile = join(lockDir, "held");
    writeFileSync(lockFile, String(process.pid));
    setTimeout(() => rmSync(lockFile), 50);
    const run = vi.fn();
    const result = await record({ run, lockFile });
    expect(run).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: "skipped",
      reason: "another run refreshed the plugins",
      before: null,
      after: null,
    });
    // it ran no command, so it has no steps to record
    expect(result).not.toHaveProperty("steps");
  });

  test("no user-scope plugins is a refreshed outcome with both lists read and empty", async () => {
    const result = await record({
      run: async () => ({
        stdout: JSON.stringify([
          { id: "kru@kru", version: "1", scope: "project" },
        ]),
      }),
    });
    expect(result).toMatchObject({
      outcome: "refreshed",
      before: [],
      after: [],
    });
  });

  test("several failed updates are recorded with each one's stderr cause, within the run.started bounds", async () => {
    const ids = [1, 2, 3, 4, 5].map((n) => `plugin-number-${n}@marketplace`);
    const fake = fakeClaude(
      Object.fromEntries(ids.map((id) => [id, "1.0.0"])),
      "2.0.0",
    );
    const result = await record({
      run: async (f, args) => {
        if (args[1] === "update") {
          const [name, marketplace] = String(args[2]).split("@");
          // the shape a failed execFile rejects with
          const error = new Error(
            `Command failed: /long/path/claude plugin update ${args[2]} --scope user`,
          );
          throw Object.assign(error, {
            stderr: `\nerror: plugin ${name} not found in marketplace ${marketplace}\nmore\n`,
          });
        }
        return fake.run(f, args);
      },
    });
    expect(() => PluginRefresh.parse({ ...result, loaded: [] })).not.toThrow();
    expect(result.outcome).toBe("failed");
    expect(result.reason).toMatch(
      /^update failed for plugin-number-1@marketplace \(error: plugin plugin-number-1 not found in marketplace marketplace\), /,
    );
    expect(result.reason).not.toMatch(/Command failed/);
    expect(result.reason?.endsWith("…")).toBe(true);
  });

  test("an error with no stderr is recorded by its message", async () => {
    const result = await record({
      run: async () => {
        throw Object.assign(new Error("spawn c ENOENT\nmore"), { stderr: "" });
      },
    });
    expect(result).toMatchObject({
      outcome: "failed",
      reason: "spawn c ENOENT",
    });
  });

  test("a listing of more user-scope plugins than run.started carries updates them all and is recorded within its bounds", async () => {
    const installed = Object.fromEntries(
      Array.from({ length: 150 }, (_, n) => [`p${n}@m`, "1.0.0"]),
    );
    const { run, versions } = fakeClaude(installed, "2.0.0");
    const result = await record({ run });
    const updated = Object.values(versions).filter((v) => v === "2.0.0");
    expect(updated).toHaveLength(150);
    expect(() => PluginRefresh.parse({ ...result, loaded: [] })).not.toThrow();
    expect(result.before).toHaveLength(100);
    expect(result.after).toHaveLength(100);
  });

  test("a refresh cut at the timeout whose read-back fails records after as never read, not as before", async () => {
    const fake = fakeClaude({ "kru@kru": "0.214.0" }, "0.216.0");
    let lists = 0;
    const result = await record({
      timeoutMs: 50,
      listTimeoutMs: 1000,
      run: (f, args, { signal }) => {
        if (args[1] === "list" && ++lists > 1)
          return Promise.reject(new Error("list failed"));
        if (args[1] === "update")
          return new Promise((_, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason)),
          );
        return fake.run(f, args);
      },
    });
    expect(result.outcome).toBe("timed_out");
    expect(result.before).toHaveLength(1);
    expect(result.after).toBeNull();
  });

  test("a stop during the read-back after a timeout ends it promptly as stopped", async () => {
    const fake = fakeClaude({ "kru@kru": "0.214.0" }, "0.216.0");
    const stop = new AbortController();
    let lists = 0;
    let readBackAborted = false;
    const result = await record({
      timeoutMs: 50,
      // longer than the test's own timeout: only the stop can end the read-back in time
      listTimeoutMs: 60_000,
      signal: stop.signal,
      run: (f, args, { signal }) => {
        if (args[1] === "update" || (args[1] === "list" && ++lists > 1)) {
          const pending = new Promise<{ stdout: string }>((_, reject) =>
            signal.addEventListener("abort", () => {
              if (args[1] === "list") readBackAborted = true;
              reject(signal.reason);
            }),
          );
          if (args[1] === "list") setTimeout(() => stop.abort("SIGTERM"), 20);
          return pending;
        }
        return fake.run(f, args);
      },
    });
    expect(readBackAborted).toBe(true);
    expect(result).toMatchObject({ outcome: "skipped", reason: "stopped" });
  });

  test("a listing that can't be read is a failed outcome, and a long reason is cut", async () => {
    const result = await record({
      run: async () => {
        throw new Error(`x${"y".repeat(500)}`);
      },
    });
    expect(result.outcome).toBe("failed");
    expect(result.reason?.startsWith("xyyy")).toBe(true);
    expect(result.reason?.length).toBeLessThanOrEqual(200);
  });

  test("a reason past the record's bound is cut so the run.started post still parses", async () => {
    const result = await record({
      run: async (_f, args) => {
        if (args[1] === "list")
          return {
            stdout: JSON.stringify(
              Array.from({ length: 20 }, (_, n) => ({
                id: `plugin-${n}@m`,
                scope: "user",
              })),
            ),
          };
        if (args[1] === "update") throw new Error("a".repeat(150));
        return { stdout: "" };
      },
    });
    expect(result.reason?.length).toBe(300);
    expect(() => PluginRefresh.parse({ ...result, loaded: [] })).not.toThrow();
  });
});

describe("refreshPlugins with a worktree", () => {
  const worktree = "/work/agent";
  /** A `claude` whose user-scope plugin is `userVersion` and whose worktree record is pinned at `projectVersion`. */
  function pinned(userVersion: string, projectVersion: string, latest: string) {
    const versions = { user: userVersion, project: projectVersion };
    const calls: { args: string[]; cwd?: string }[] = [];
    const run = async (
      _f: string,
      args: string[],
      options: { cwd?: string },
    ) => {
      calls.push({ args, cwd: options.cwd });
      if (args[1] === "list")
        return {
          stdout: JSON.stringify([
            { id: "kru@kru", scope: "user", version: versions.user },
            {
              id: "kru@kru",
              scope: "project",
              version: versions.project,
              projectPath: worktree,
            },
            // another agent's worktree: not this run's to touch
            {
              id: "kru@kru",
              scope: "project",
              version: "0.1.0",
              projectPath: "/work/other",
            },
          ]),
        };
      if (args[1] === "update") {
        const scope = args.at(-1) as "user" | "project";
        // `--scope project` acts on the project of the directory it is run from
        if (scope === "project" && options.cwd !== worktree)
          throw new Error("not installed at project scope here");
        versions[scope] = latest;
      }
      return { stdout: "" };
    };
    return { run, versions, calls };
  }

  const refreshHere = (
    options: Partial<Parameters<typeof refreshPlugins>[0]>,
  ) =>
    refreshPlugins({
      env: {},
      warn: vi.fn(),
      claude: "c",
      lockFile: join(lockDir, "lock"),
      projectDir: worktree,
      ...options,
    });

  test("a stale project-scope record is updated from the worktree, so the session ends on the refreshed version", async () => {
    const { run, versions, calls } = pinned("0.239.0", "0.161.0", "0.239.0");
    // user scope already current: only the project record is behind
    const result = await refreshHere({ run });
    expect(result.outcome).toBe("refreshed");
    expect(versions).toEqual({ user: "0.239.0", project: "0.239.0" });
    const projectUpdates = calls.filter((c) => c.args.includes("project"));
    expect(projectUpdates).toEqual([
      {
        args: ["plugin", "update", "kru@kru", "--scope", "project"],
        cwd: worktree,
      },
    ]);
    // the user-scope commands still run where the runner is
    expect(calls.find((c) => c.args.at(-1) === "user")?.cwd).toBeUndefined();
  });

  test("another worktree's record, and a worktree without one, are left alone", async () => {
    const { run, calls } = pinned("1.0.0", "1.0.0", "2.0.0");
    await refreshHere({ run, projectDir: "/work/fresh" });
    expect(calls.some((c) => c.args.includes("project"))).toBe(false);
  });

  test("a failing project-scope update is a failed outcome naming it, and the run carries on", async () => {
    const { run } = pinned("1.0.0", "0.1.0", "2.0.0");
    const result = await refreshHere({
      run: async (f, args, options) => {
        if (args.at(-1) === "project") throw new Error("marketplace gone");
        return run(f, args, options);
      },
    });
    expect(result).toMatchObject({
      outcome: "failed",
      reason: "update failed for kru@kru project scope (marketplace gone)",
    });
  });

  test("without a worktree no project-scope update runs", async () => {
    const { run, calls } = pinned("1.0.0", "0.1.0", "2.0.0");
    await refreshHere({ run, projectDir: undefined });
    expect(calls.some((c) => c.args.includes("project"))).toBe(false);
  });

  /** A lock another live run holds for 50ms, as when a second agent of the project starts beside it. */
  const heldBriefly = () => {
    const lockFile = join(lockDir, "held");
    writeFileSync(lockFile, String(process.pid));
    setTimeout(() => rmSync(lockFile), 50);
    return lockFile;
  };

  test("a run that waited out another run's refresh still updates its own worktree's record, and nothing else", async () => {
    const lockFile = heldBriefly();
    // the holder moved the user scope; this worktree's record is where setup left it
    const { run, versions, calls } = pinned("0.239.0", "0.161.0", "0.239.0");
    const warn = vi.fn();
    const result = await refreshHere({ run, lockFile, warn });
    expect(calls).toEqual([
      { args: ["plugin", "list", "--json"] },
      {
        args: ["plugin", "update", "kru@kru", "--scope", "project"],
        cwd: worktree,
      },
      { args: ["plugin", "list", "--json"] },
    ]);
    expect(versions).toEqual({ user: "0.239.0", project: "0.239.0" });
    expect(result).toMatchObject({
      outcome: "refreshed",
      before: [{ name: "kru", marketplace: "kru", version: "0.239.0" }],
      after: [{ name: "kru", marketplace: "kru", version: "0.239.0" }],
    });
    // a waiting run's record names only the commands it ran, with no marketplace update
    expect(result.steps?.map((s) => s.name)).toEqual([
      "list before",
      "update kru@kru (project)",
      "list after",
    ]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatch(
      /^runner: another run refreshed the plugins; this worktree's records updated in \d+\.\ds \(kru@kru \(project\)\)$/,
    );
    expect(existsSync(lockFile)).toBe(false);
  });

  test("a waiting run whose worktree has no record lists once and is skipped with that reason", async () => {
    const lockFile = heldBriefly();
    const { run, calls } = pinned("1.0.0", "1.0.0", "2.0.0");
    const result = await refreshHere({
      run,
      lockFile,
      projectDir: "/work/fresh",
    });
    expect(calls).toEqual([{ args: ["plugin", "list", "--json"] }]);
    expect(result).toMatchObject({
      outcome: "skipped",
      reason: "another run refreshed the plugins",
      before: [{ name: "kru", marketplace: "kru", version: "1.0.0" }],
      after: [{ name: "kru", marketplace: "kru", version: "1.0.0" }],
    });
    expect(result.steps?.map((s) => s.name)).toEqual(["list before"]);
  });

  test("a waiting run's failing worktree update is a failed outcome naming it", async () => {
    const lockFile = heldBriefly();
    const { run } = pinned("1.0.0", "0.1.0", "2.0.0");
    const result = await refreshHere({
      lockFile,
      run: async (f, args, options) => {
        if (args.at(-1) === "project") throw new Error("marketplace gone");
        return run(f, args, options);
      },
    });
    expect(result).toMatchObject({
      outcome: "failed",
      reason: "update failed for kru@kru project scope (marketplace gone)",
    });
  });

  /** `pinned`'s `claude`, except a project-scope update that never answers: only its signal ends it. */
  const hangingProjectUpdate = (
    base: ReturnType<typeof pinned>["run"],
    onHang: () => void = () => {},
  ) => {
    const hung: string[][] = [];
    const run = (
      f: string,
      args: string[],
      options: { cwd?: string; signal: AbortSignal },
    ) => {
      if (args.at(-1) !== "project") return base(f, args, options);
      hung.push(args);
      onHang();
      return new Promise<{ stdout: string }>((_, reject) =>
        options.signal.addEventListener("abort", () =>
          reject(options.signal.reason),
        ),
      );
    };
    return { run, hung };
  };

  test("a project-scope update that outlasts the timeout is timed_out, not failed", async () => {
    const { run, hung } = hangingProjectUpdate(
      pinned("1.0.0", "0.1.0", "2.0.0").run,
    );
    const result = await refreshHere({
      run,
      timeoutMs: 50,
      listTimeoutMs: 1000,
    });
    expect(hung).toHaveLength(1);
    expect(result.outcome).toBe("timed_out");
    expect(result.reason).toBeUndefined();
  });

  test("a stalled project-scope update is cut at the step budget and recorded as failed, not the whole refresh timed_out", async () => {
    const { run, hung } = hangingProjectUpdate(
      pinned("1.0.0", "0.1.0", "2.0.0").run,
    );
    const result = await refreshHere({
      run,
      timeoutMs: 5000,
      stepTimeoutMs: 30,
    });
    expect(hung).toHaveLength(1);
    expect(result.outcome).toBe("failed");
    expect(result.reason).toMatch(
      /^update failed for kru@kru project scope \(timed out after /,
    );
    expect(result.steps?.at(-1)?.name).toBe("list after");
  });

  test("a stop during a project-scope update ends the refresh as stopped, not failed", async () => {
    const stop = new AbortController();
    const warn = vi.fn();
    const { run, hung } = hangingProjectUpdate(
      pinned("1.0.0", "0.1.0", "2.0.0").run,
      () => {
        setTimeout(() => stop.abort("SIGTERM"), 10);
      },
    );
    const result = await refreshHere({ run, warn, signal: stop.signal });
    expect(hung).toHaveLength(1);
    expect(result).toMatchObject({ outcome: "skipped", reason: "stopped" });
    expect(warn.mock.calls.at(-1)?.[0]).toMatch(/plugin refresh stopped after/);
  });

  describe("a worktree reached through a link or a trailing slash", () => {
    const viaSymlink = (real: string, dir: string) => {
      const link = join(dir, "link");
      symlinkSync(real, link);
      return link;
    };
    const withTrailingSlash = (real: string) => `${real}/`;
    test.each([
      ["a symlink to it", viaSymlink],
      ["a trailing slash", withTrailingSlash],
    ])(
      "a project record whose path is %s is the worktree's own, and is updated from it",
      async (_, recordedAs) => {
        const real = join(lockDir, "worktree");
        mkdirSync(real);
        const recorded = recordedAs(real, lockDir);
        const calls: { args: string[]; cwd?: string }[] = [];
        await refreshHere({
          projectDir: real,
          run: async (_f, args, options) => {
            calls.push({ args, cwd: options.cwd });
            return {
              stdout:
                args[1] === "list"
                  ? JSON.stringify([
                      { id: "kru@kru", scope: "user", version: "1.0.0" },
                      {
                        id: "kru@kru",
                        scope: "project",
                        version: "0.1.0",
                        projectPath: recorded,
                      },
                    ])
                  : "",
            };
          },
        });
        expect(calls.filter((c) => c.args.at(-1) === "project")).toEqual([
          {
            args: ["plugin", "update", "kru@kru", "--scope", "project"],
            cwd: real,
          },
        ]);
      },
    );
  });
});

describe("PluginRefresh", () => {
  const base = { durationMs: 1200, before: [], after: [], loaded: [] };

  test.each([
    ["failed: could not resolve host", "failed", "could not resolve host"],
    ["skipped: stopped", "skipped", "stopped"],
    [
      "skipped: another run refreshed the plugins",
      "skipped",
      "another run refreshed the plugins",
    ],
    ["timed_out", "timed_out", undefined],
    ["refreshed", "refreshed", undefined],
  ])(
    "a record written with the outcome %j reads as a code and a reason",
    (outcome, code, reason) => {
      const parsed = PluginRefresh.parse({ ...base, outcome });
      expect(parsed.outcome).toBe(code);
      expect(parsed.reason).toBe(reason);
      expect(parsed.before).toEqual([]);
    },
  );

  test("an outcome that is neither a code nor an old one is rejected", () => {
    expect(
      PluginRefresh.safeParse({ ...base, outcome: "exploded" }).success,
    ).toBe(false);
  });

  test("steps are optional, so a record from before them still reads", () => {
    const parsed = PluginRefresh.parse({ ...base, outcome: "refreshed" });
    expect(parsed).not.toHaveProperty("steps");
    const withSteps = PluginRefresh.parse({
      ...base,
      outcome: "refreshed",
      steps: [{ name: "list before", ms: 12 }],
    });
    expect(withSteps.steps).toEqual([{ name: "list before", ms: 12 }]);
  });

  test("more than 50 steps, or one with a long name or a negative time, is rejected", () => {
    const step = { name: "list before", ms: 1 };
    const parse = (steps: unknown) =>
      PluginRefresh.safeParse({ ...base, outcome: "refreshed", steps }).success;
    expect(parse(Array.from({ length: 50 }, () => step))).toBe(true);
    expect(parse(Array.from({ length: 51 }, () => step))).toBe(false);
    expect(parse([{ ...step, name: "x".repeat(101) }])).toBe(false);
    expect(parse([{ ...step, ms: -1 }])).toBe(false);
  });

  test("a list that was never read is null, apart from a list with no plugins", () => {
    const parsed = PluginRefresh.parse({
      ...base,
      outcome: "skipped",
      reason: "stopped",
      before: null,
    });
    expect(parsed.before).toBeNull();
    expect(parsed.after).toEqual([]);
  });
});

describe("loadedPlugins", () => {
  test("takes the marketplace and resolved version from the cache path", () => {
    expect(
      loadedPlugins([
        {
          name: "kru",
          path: "/home/sprite/.claude/plugins/cache/kru/kru/0.214.0",
          version: "0.214.0",
        },
      ]),
    ).toEqual([{ name: "kru", marketplace: "kru", version: "0.214.0" }]);
  });

  test("a commit-named version folder wins over the manifest's version", () => {
    expect(
      loadedPlugins([
        {
          name: "p",
          path: "/x/plugins/cache/mk/p/abc123def456/",
          version: "1.0.0",
        },
      ]),
    ).toEqual([{ name: "p", marketplace: "mk", version: "abc123def456" }]);
  });

  test("a plugin from outside the cache keeps the manifest's version and no marketplace", () => {
    expect(
      loadedPlugins([{ name: "local", path: "/work/local", version: "2.0.0" }]),
    ).toEqual([{ name: "local", marketplace: null, version: "2.0.0" }]);
    expect(loadedPlugins([{ name: "local", path: "/work/local" }])).toEqual([
      { name: "local", marketplace: null, version: "unknown" },
    ]);
    expect(loadedPlugins(undefined)).toEqual([]);
  });
});

describe("claudeBinary", () => {
  let dir: string;
  let runnerPath: string;
  let sdkRoot: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claude-binary-"));
    runnerPath = join(dir, "runner.mjs");
    sdkRoot = join(dir, "node_modules/@anthropic-ai");
    mkdirSync(sdkRoot, { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("SKY_CLAUDE wins over an SDK binary beside the runner", () => {
    mkdirSync(join(sdkRoot, "claude-agent-sdk-linux-x64"));
    writeFileSync(join(sdkRoot, "claude-agent-sdk-linux-x64/claude"), "");
    expect(claudeBinary({ SKY_CLAUDE: "/x/claude" }, runnerPath)).toBe(
      "/x/claude",
    );
  });

  test("uses the claude file in a claude-agent-sdk-* dir beside the runner", () => {
    mkdirSync(join(sdkRoot, "claude-agent-sdk-linux-x64"));
    writeFileSync(join(sdkRoot, "claude-agent-sdk-linux-x64/claude"), "");
    expect(claudeBinary({}, runnerPath)).toBe(
      join(sdkRoot, "claude-agent-sdk-linux-x64/claude"),
    );
  });

  test("skips a matching dir without the binary and takes the one that has it", () => {
    mkdirSync(join(sdkRoot, "claude-agent-sdk-darwin-arm64"));
    mkdirSync(join(sdkRoot, "claude-agent-sdk-linux-x64"));
    writeFileSync(join(sdkRoot, "claude-agent-sdk-linux-x64/claude"), "");
    expect(claudeBinary({}, runnerPath)).toBe(
      join(sdkRoot, "claude-agent-sdk-linux-x64/claude"),
    );
  });

  test("ignores a claude file in a dir that is not claude-agent-sdk-*", () => {
    mkdirSync(join(sdkRoot, "other"));
    writeFileSync(join(sdkRoot, "other/claude"), "");
    expect(claudeBinary({}, runnerPath)).toBe("claude");
  });

  test("an empty SKY_CLAUDE is unset: falls through to the SDK, then the PATH", () => {
    expect(claudeBinary({ SKY_CLAUDE: "" }, runnerPath)).toBe("claude");
    mkdirSync(join(sdkRoot, "claude-agent-sdk-linux-x64"));
    writeFileSync(join(sdkRoot, "claude-agent-sdk-linux-x64/claude"), "");
    expect(claudeBinary({ SKY_CLAUDE: "" }, runnerPath)).toBe(
      join(sdkRoot, "claude-agent-sdk-linux-x64/claude"),
    );
  });

  test("no SDK beside the runner falls back to claude on the PATH", () => {
    expect(claudeBinary({}, "/nonexistent/runner.mjs")).toBe("claude");
  });
});

describe("refresh lock", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sky-lock-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("three runs starting together: one refreshes, the two that waited skip theirs", async () => {
    const lockFile = join(dir, "lock");
    let active = 0;
    let peak = 0;
    const calls: string[][] = [];
    const run = async (_f: string, args: string[]) => {
      active++;
      peak = Math.max(peak, active);
      calls.push(args);
      await new Promise((r) => setTimeout(r, 30));
      active--;
      return { stdout: args[1] === "list" ? listing : "" };
    };
    const warn = vi.fn();
    await Promise.all(
      [1, 2, 3].map(() =>
        refreshPlugins({ env: {}, warn, claude: "c", lockFile, run }),
      ),
    );
    expect(peak).toBe(1);
    // the one refresh lists before and after its updates; the two that waited list nothing
    expect(calls.filter((a) => a[1] === "list")).toHaveLength(2);
    const lines = warn.mock.calls.map((c) => String(c[0]));
    const refreshed = lines.filter((l) => /plugins refreshed in/.test(l));
    const skipped = lines.filter((l) => /another run refreshed/.test(l));
    expect(refreshed).toHaveLength(1);
    expect(skipped).toHaveLength(2);
    expect(existsSync(lockFile)).toBe(false);
  });

  test("a run that waited on a live holder skips its refresh once the holder releases", async () => {
    const lockFile = join(dir, "lock");
    writeFileSync(lockFile, String(process.pid));
    setTimeout(() => rmSync(lockFile), 50);
    const warn = vi.fn();
    const run = vi.fn();
    await refreshPlugins({ env: {}, warn, claude: "c", lockFile, run });
    expect(run).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatch(
      /^runner: plugin refresh skipped, another run refreshed the plugins \(waited \d+\.\ds\)$/,
    );
    expect(existsSync(lockFile)).toBe(false);
  });

  test("a run that waited on a holder that then died takes the lock over and refreshes", async () => {
    const lockFile = join(dir, "lock");
    writeFileSync(lockFile, String(process.pid));
    setTimeout(() => writeFileSync(lockFile, "2147483646"), 50);
    const warn = vi.fn();
    const calls: string[][] = [];
    await refreshPlugins({
      env: {},
      warn,
      claude: "c",
      lockFile,
      run: async (_f, args) => {
        calls.push(args);
        return { stdout: "[]" };
      },
    });
    expect(calls).toEqual([["plugin", "list", "--json"]]);
    expect(warn.mock.calls[0]?.[0]).toMatch(/plugins refreshed in/);
    expect(existsSync(lockFile)).toBe(false);
  });

  test("a refresh whose claude fails still releases the lock for the next one", async () => {
    const lockFile = join(dir, "lock");
    const warn = vi.fn();
    await refreshPlugins({
      env: {},
      warn,
      claude: "c",
      lockFile,
      run: async () => {
        throw new Error("spawn c ENOENT");
      },
    });
    expect(warn.mock.calls[0]?.[0]).toMatch(
      /plugin refresh failed \(spawn c ENOENT\)/,
    );
    expect(existsSync(lockFile)).toBe(false);
    const next = vi.fn(async () => ({ stdout: "[]" }));
    await refreshPlugins({ env: {}, warn, claude: "c", lockFile, run: next });
    expect(next).toHaveBeenCalledOnce();
    expect(warn.mock.calls[1]?.[0]).toMatch(/plugins refreshed in/);
  });

  test("a lock left by a dead process is taken over", async () => {
    const lockFile = join(dir, "lock");
    writeFileSync(lockFile, "2147483646");
    const warn = vi.fn();
    await refreshPlugins({
      env: {},
      warn,
      claude: "c",
      lockFile,
      run: async () => ({ stdout: "[]" }),
    });
    expect(warn.mock.calls[0]?.[0]).toMatch(/plugins refreshed/);
  });

  test("a lock held past the budget skips the refresh and lets the session start", async () => {
    const lockFile = join(dir, "lock");
    writeFileSync(lockFile, String(process.pid));
    const warn = vi.fn();
    const run = vi.fn();
    await refreshPlugins({
      env: {},
      warn,
      claude: "c",
      lockFile,
      run,
      timeoutMs: 50,
    });
    expect(run).not.toHaveBeenCalled();
    expect(warn.mock.calls[0]?.[0]).toMatch(/plugin refresh failed/);
    expect(readFileSync(lockFile, "utf8")).toBe(String(process.pid));
  });

  test("a stop while another run holds the lock ends the wait as stopped, not failed, and leaves the holder's lock", async () => {
    const lockFile = join(dir, "lock");
    writeFileSync(lockFile, String(process.pid));
    const stop = new AbortController();
    setTimeout(() => stop.abort("SIGTERM"), 50);
    const warn = vi.fn();
    const run = vi.fn();
    await refreshPlugins({
      env: {},
      warn,
      claude: "c",
      lockFile,
      run,
      signal: stop.signal,
    });
    expect(run).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatch(/plugin refresh stopped after/);
    expect(warn.mock.calls[0]?.[0]).not.toMatch(/failed/);
    expect(readFileSync(lockFile, "utf8")).toBe(String(process.pid));
  });
});

/** Never answers: only the command's signal ends it. */
const stalls = (signal: AbortSignal) =>
  new Promise<{ stdout: string }>((_, reject) =>
    signal.addEventListener("abort", () => reject(signal.reason)),
  );

describe("refreshPlugins caps", () => {
  const capped = (options: Partial<Parameters<typeof refreshPlugins>[0]>) =>
    refreshPlugins({
      env: {},
      warn: vi.fn(),
      claude: "c",
      lockFile: join(lockDir, "lock"),
      timeoutMs: 5000,
      ...options,
    });

  test("the defaults are a 30s refresh, a 10s cap per update and a 5s cap per listing", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      const fake = fakeClaude({ "kru@kru": "1.0.0" }, "2.0.0");
      await capped({ run: fake.run, timeoutMs: undefined });
      const caps = timeout.mock.calls.map(([ms]) => ms);
      expect(caps).toContain(PLUGIN_REFRESH_TIMEOUT_MS);
      // the first listing, the marketplace and plugin updates, the last listing
      expect(caps.filter((ms) => ms === 5_000)).toHaveLength(2);
      expect(caps.filter((ms) => ms === 10_000)).toHaveLength(2);
      expect(PLUGIN_REFRESH_TIMEOUT_MS).toBe(30_000);
      expect(PLUGIN_STEP_TIMEOUT_MS).toBe(10_000);
      expect(PLUGIN_LIST_TIMEOUT_MS).toBe(5_000);
    } finally {
      timeout.mockRestore();
    }
  });

  test("a first listing cut at its own cap is tried once more, and the refresh goes on", async () => {
    const fake = fakeClaude({ "kru@kru": "1.0.0" }, "2.0.0");
    let lists = 0;
    const result = await capped({
      listTimeoutMs: 30,
      run: (f, args, options) => {
        if (args[1] === "list" && ++lists === 1) return stalls(options.signal);
        return fake.run(f, args);
      },
    });
    expect(result.outcome).toBe("refreshed");
    expect(result.before?.map((p) => p.version)).toEqual(["1.0.0"]);
    expect(result.after?.map((p) => p.version)).toEqual(["2.0.0"]);
    expect(result.steps?.map((s) => s.name)).toEqual([
      "list before",
      "list before (retry)",
      "update marketplace kru",
      "update kru@kru",
      "list after",
    ]);
  });

  test("a first listing cut twice is a failed outcome that says so, with no update attempted", async () => {
    const calls: string[][] = [];
    const warn = vi.fn();
    const result = await capped({
      warn,
      listTimeoutMs: 30,
      run: (_f, args, { signal }) => {
        calls.push(args);
        return stalls(signal);
      },
    });
    expect(calls).toEqual([
      ["plugin", "list", "--json"],
      ["plugin", "list", "--json"],
    ]);
    expect(result).toMatchObject({
      outcome: "failed",
      reason: "list before timed out after 0.0s twice; no plugin was updated",
      before: null,
      after: null,
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatch(
      /plugin refresh failed \(list before timed out/,
    );
  });

  test("a cut first listing costs its own cap, not the refresh's budget, so the updates still run", async () => {
    const fake = fakeClaude({ "kru@kru": "1.0.0" }, "2.0.0");
    let lists = 0;
    const result = await capped({
      timeoutMs: 400,
      listTimeoutMs: 100,
      run: (f, args, options) => {
        if (args[1] === "list" && ++lists === 1) return stalls(options.signal);
        return fake.run(f, args);
      },
    });
    // the overall budget was not what ended the stalled listing
    expect(result.outcome).toBe("refreshed");
  });

  test("a last listing cut twice leaves after unread and says so, with the updates done", async () => {
    const fake = fakeClaude({ "kru@kru": "1.0.0" }, "2.0.0");
    let lists = 0;
    const result = await capped({
      listTimeoutMs: 30,
      run: (f, args, options) => {
        if (args[1] === "list" && ++lists > 1) return stalls(options.signal);
        return fake.run(f, args);
      },
    });
    expect(result).toMatchObject({
      outcome: "failed",
      reason: "list after timed out after 0.0s twice",
      after: null,
    });
    expect(result.before?.map((p) => p.version)).toEqual(["1.0.0"]);
    expect(fake.versions).toEqual({ "kru@kru": "2.0.0" });
  });

  test("each marketplace is updated by name, once, and a stalled one is named while the next still runs", async () => {
    const fake = fakeClaude(
      { "a@one": "1.0.0", "b@two": "1.0.0", "c@one": "1.0.0", local: "1.0.0" },
      "2.0.0",
    );
    const marketplaces: string[] = [];
    const result = await capped({
      stepTimeoutMs: 30,
      run: (f, args, options) => {
        if (args[1] === "marketplace") {
          marketplaces.push(String(args[3]));
          if (args[3] === "one") return stalls(options.signal);
        }
        return fake.run(f, args);
      },
    });
    // the plugin with no marketplace has none to update
    expect(marketplaces).toEqual(["one", "two"]);
    expect(result).toMatchObject({
      outcome: "failed",
      reason: "update failed for marketplace one (timed out after 0.0s)",
    });
    expect(result.steps?.map((s) => s.name).slice(0, 3)).toEqual([
      "list before",
      "update marketplace one",
      "update marketplace two",
    ]);
  });

  test("the overall budget stays: a marketplace update that outlasts it ends the refresh as timed_out", async () => {
    const fake = fakeClaude({ "kru@kru": "1.0.0" }, "2.0.0");
    const result = await capped({
      timeoutMs: 50,
      stepTimeoutMs: 5000,
      listTimeoutMs: 1000,
      run: (f, args, options) =>
        args[1] === "marketplace" ? stalls(options.signal) : fake.run(f, args),
    });
    expect(result.outcome).toBe("timed_out");
  });

  test("a cut is told from a failure by which timer fired, whatever the error says", async () => {
    const fake = fakeClaude({ "a@one": "1.0.0", "b@two": "1.0.0" }, "2.0.0");
    const result = await capped({
      stepTimeoutMs: 30,
      run: (f, args, options) => {
        // fails fast, with a message that reads like a cut
        if (args[3] === "one") throw new Error("timed out connecting to host");
        // cut at its cap, but rejecting with an unrelated error
        if (args[3] === "two")
          return new Promise((_, reject) =>
            options.signal.addEventListener("abort", () =>
              reject(new Error("ECONNRESET")),
            ),
          );
        return fake.run(f, args);
      },
    });
    expect(result.reason).toBe(
      "update failed for marketplace one (timed out connecting to host), marketplace two (timed out after 0.0s)",
    );
    expect(result.steps?.map((s) => s.name)).toContain("update a@one");
  });

  test("a step name past 100 characters is cut in the record, and the command still gets the whole name", async () => {
    const marketplace = "m".repeat(150);
    const fake = fakeClaude({ [`p@${marketplace}`]: "1.0.0" }, "2.0.0");
    const names: string[] = [];
    const result = await capped({
      run: (f, args) => {
        if (args[1] === "marketplace") names.push(String(args[3]));
        return fake.run(f, args);
      },
    });
    const long = result.steps?.find((s) => s.name.startsWith("update market"));
    expect(long?.name).toHaveLength(100);
    expect(names).toEqual([marketplace.slice(0, 100)]);
    expect(PluginRefresh.safeParse({ ...result, loaded: [] }).success).toBe(
      true,
    );
  });
});

/** Whether a process is gone: not there, or an exited one nobody has reaped yet. */
const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  try {
    return /^\d+ \(.*\) Z/s.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
};

const until = async (ready: () => boolean, ms = 5000) => {
  for (const start = Date.now(); !ready(); ) {
    if (Date.now() - start > ms) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/**
 * A `claude` made of a real script. `plugin list` prints one plugin; a marketplace update starts a
 * grandchild, writes its pid to PIDFILE, and hangs; any plugin update then records whether that
 * grandchild is still there. STUBBORN makes both ignore SIGTERM.
 */
const FAKE_CLAUDE = `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const { PIDFILE, ALIVEFILE, STUBBORN } = process.env;
const sub = process.argv[3];
const ignore = STUBBORN ? "process.on('SIGTERM', () => {});" : "";
const alive = (pid) => {
  try { process.kill(pid, 0); } catch { return false; }
  try { return !/^\\d+ \\(.*\\) Z/s.test(readFileSync("/proc/" + pid + "/stat", "utf8")); } catch { return true; }
};
if (sub === "list") {
  console.log(JSON.stringify([{ id: "kru@kru", scope: "user", version: "1.0.0" }]));
} else if (sub === "marketplace") {
  const child = spawn(process.execPath, ["-e", ignore + "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  writeFileSync(PIDFILE, String(child.pid));
  if (STUBBORN) process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else if (sub === "update") {
  appendFileSync(ALIVEFILE, alive(Number(readFileSync(PIDFILE, "utf8"))) ? "alive" : "gone");
}
`;

describe("a cut command's whole process group", () => {
  let dir: string;
  let claude: string;
  let pidFile: string;
  let aliveFile: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sky-group-"));
    claude = join(dir, "claude.mjs");
    pidFile = join(dir, "pid");
    aliveFile = join(dir, "alive");
    writeFileSync(claude, FAKE_CLAUDE, { mode: 0o755 });
  });
  afterEach(() => {
    if (existsSync(pidFile)) {
      try {
        process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
      } catch {}
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const env = (extra: Record<string, string> = {}) => ({
    ...process.env,
    PIDFILE: pidFile,
    ALIVEFILE: aliveFile,
    ...extra,
  });
  const grandchild = () => Number(readFileSync(pidFile, "utf8"));

  test("a marketplace update cut at its cap takes its grandchild with it before the next command runs", async () => {
    const result = await refreshPlugins({
      env: env(),
      warn: vi.fn(),
      claude,
      lockFile: join(dir, "lock"),
      stepTimeoutMs: 1500,
    });
    expect(existsSync(pidFile)).toBe(true);
    expect(gone(grandchild())).toBe(true);
    // the plugin update after it ran, and saw the grandchild already gone
    expect(readFileSync(aliveFile, "utf8")).toBe("gone");
    expect(result).toMatchObject({
      outcome: "failed",
      reason: "update failed for marketplace kru (timed out after 1.5s)",
    });
    expect(existsSync(join(dir, "lock"))).toBe(false);
  });

  test("a stop mid-update takes the grandchild with it before the refresh returns", async () => {
    const stop = new AbortController();
    const refreshing = refreshPlugins({
      env: env(),
      warn: vi.fn(),
      claude,
      lockFile: join(dir, "lock"),
      signal: stop.signal,
    });
    await until(() => existsSync(pidFile));
    stop.abort("SIGTERM");
    const result = await refreshing;
    expect(result).toMatchObject({ outcome: "skipped", reason: "stopped" });
    expect(gone(grandchild())).toBe(true);
    expect(existsSync(join(dir, "lock"))).toBe(false);
  });

  test("a command that ignores SIGTERM, with a grandchild that does too, is sent SIGKILL after the grace and waited on", async () => {
    const stop = new AbortController();
    const running = runInGroup(
      claude,
      ["plugin", "marketplace", "update"],
      { env: env({ STUBBORN: "1" }), signal: stop.signal },
      150,
    );
    const outcome = running.then(
      () => "closed",
      () => "rejected",
    );
    await until(() => existsSync(pidFile));
    // let both install their SIGTERM handlers
    await new Promise((resolve) => setTimeout(resolve, 300));
    const cutAt = Date.now();
    stop.abort(new Error("cut"));
    await expect(running).rejects.toThrow("cut");
    expect(await outcome).toBe("rejected");
    expect(Date.now() - cutAt).toBeGreaterThanOrEqual(140);
    expect(gone(grandchild())).toBe(true);
  });

  test("the runner's end kills a running command's group, which would otherwise outlive it", async () => {
    const stop = new AbortController();
    const running = runInGroup(claude, ["plugin", "marketplace", "update"], {
      env: env(),
      signal: stop.signal,
    });
    await until(() => existsSync(pidFile));
    killRefreshCommands();
    await expect(running).rejects.toThrow(/Command failed/);
    expect(gone(grandchild())).toBe(true);
  });

  test("a command's stdout comes back, and a failure carries its stderr and exit code", async () => {
    const signal = new AbortController().signal;
    await expect(
      runInGroup(process.execPath, ["-e", "console.log('hi')"], {
        env: process.env,
        signal,
      }),
    ).resolves.toEqual({ stdout: "hi\n" });
    await expect(
      runInGroup(
        process.execPath,
        ["-e", "console.error('nope'); process.exit(3)"],
        { env: process.env, signal },
      ),
    ).rejects.toMatchObject({ code: 3, stderr: "nope\n" });
    await expect(
      runInGroup("/no/such/claude", [], { env: process.env, signal }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("an already-aborted signal spawns nothing", async () => {
    await expect(
      runInGroup(claude, ["plugin", "list"], {
        env: env(),
        signal: AbortSignal.abort("stopped"),
      }),
    ).rejects.toBe("stopped");
    expect(existsSync(aliveFile)).toBe(false);
  });
});
