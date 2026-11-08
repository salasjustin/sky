import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { claudeBinary, refreshPlugins } from "./plugins.js";

const listing = JSON.stringify([
  { id: "kru@kru", scope: "user" },
  { id: "kru@kru", scope: "project" },
  { id: "other@kru", scope: "user" },
]);

describe("refreshPlugins", () => {
  test("refreshes the marketplaces, updates each user-scope plugin once, and logs the duration", async () => {
    const calls: string[][] = [];
    const warn = vi.fn();
    let t = 0;
    await refreshPlugins({
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
    ]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toBe(
      "runner: plugins refreshed in 1.5s (kru@kru, other@kru)",
    );
  });

  test("a failing command is one warning and does not throw", async () => {
    const warn = vi.fn();
    await refreshPlugins({
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
    await refreshPlugins({
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
    await refreshPlugins({
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
    await refreshPlugins({
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
    const done = refreshPlugins({
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
    await refreshPlugins({
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
    await refreshPlugins({
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
      await refreshPlugins({
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
    await refreshPlugins({
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

  test("two refreshes on one sprite run one after the other, never together", async () => {
    const lockFile = join(dir, "lock");
    let active = 0;
    let peak = 0;
    const run = async (_f: string, args: string[]) => {
      active++;
      peak = Math.max(peak, active);
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
    expect(warn).toHaveBeenCalledTimes(3);
    expect(existsSync(lockFile)).toBe(false);
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
  });
});
