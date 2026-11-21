import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginRefresh } from "@sky/shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { claudeBinary, loadedPlugins, refreshPlugins } from "./plugins.js";

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
      ["plugin", "marketplace", "update"],
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
        if (args[1] === "marketplace") throw new Error("clone failed\nmore");
        return { stdout: listing };
      },
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatch(
      /plugin refresh failed \(clone failed\); continuing/,
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
    const result = await record({ run, now: () => (t += 2000) });
    expect(result).toEqual({
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

  test("a marketplace that can't be reached is a failed outcome with the reason and the versions it left", async () => {
    const fake = fakeClaude({ "kru@kru": "0.214.0" }, "0.216.0");
    const result = await record({
      run: async (f, args) => {
        if (args[1] === "marketplace")
          throw new Error("could not resolve host\nmore");
        return fake.run(f, args);
      },
    });
    expect(result).toMatchObject({
      outcome: "failed",
      reason: "could not resolve host",
    });
    expect(result.before).toEqual(result.after);
    expect(result.before).toHaveLength(1);
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
