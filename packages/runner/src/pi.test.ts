import { execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import type { SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import type { Decision, RequestId, RunnerEventPost } from "@sky/shared";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { server } from "../../../test/msw.js";
import { gatewayUnavailable } from "./codex.js";
import { type Config, loadConfig } from "./config.js";
import type { PostEvent } from "./events.js";
import {
  cleanAgentDir,
  commandViews,
  DEFAULT_PI_MODEL,
  FALLBACK_PI_MODEL_SPEC,
  PI_PROVIDER,
  PiRpc,
  piCatalogModel,
  piExtensionSource,
  piHomeOf,
  piInstructions,
  piMcpConfig,
  piOutcome,
  piToolCall,
  piUnavailable,
  realPathOf,
  resolvePiExecutable,
  runPiSession,
  skillPath,
  withdrawGatewayKey,
} from "./pi.js";
import type { AwaitDecision } from "./requests.js";
import type { Seal } from "./seal.js";

// a record the fake pi logged or a tool the extension registered: free-form, read by property
// biome-ignore lint/suspicious/noExplicitAny: free-form test data
type Logged = Record<string, any>;

/** The reference to an environment variable that pi's MCP config takes in place of a value. */
const ref = (name: string) => `\${${name}}`;

const base = {
  AGENT_ID: "agt_1",
  RUN_ID: "run_1",
  PROMPT: "do it",
  API_BASE_URL: "http://api.test",
  AGENT_TOKEN: "tok",
};

describe("SKY_RUNTIME=pi", () => {
  test("needs the AI Gateway key and no Claude credential", () => {
    expect(() => loadConfig({ ...base, SKY_RUNTIME: "pi" })).toThrow(
      /AI_GATEWAY_API_KEY/,
    );
    const config = loadConfig({
      ...base,
      SKY_RUNTIME: "pi",
      AI_GATEWAY_API_KEY: "k",
    });
    expect(config.runtime).toBe("pi");
    expect(config.piModel).toBeUndefined();
    expect(config.piSkills).toBeUndefined();
    expect(config.codexModel).toBeUndefined();
  });

  test("SKY_PI_MODEL names the model, and a Claude Code or Codex run ignores it", () => {
    const pi = { ...base, SKY_RUNTIME: "pi", AI_GATEWAY_API_KEY: "k" };
    expect(
      loadConfig({ ...pi, SKY_PI_MODEL: "openai/gpt-5.4-mini" }).piModel,
    ).toBe("openai/gpt-5.4-mini");
    expect(loadConfig({ ...pi, SKY_PI_MODEL: "" }).piModel).toBeUndefined();
    const codex = { ...base, SKY_RUNTIME: "codex", AI_GATEWAY_API_KEY: "k" };
    expect(
      loadConfig({ ...codex, SKY_PI_MODEL: "x/y" }).piModel,
    ).toBeUndefined();
    expect(
      loadConfig({ ...base, CLAUDE_CODE_OAUTH_TOKEN: "t", SKY_PI_SKILLS: "/s" })
        .piSkills,
    ).toBeUndefined();
  });

  test("SKY_PI_SKILLS lists skill directories, absolute or under the home", () => {
    const pi = { ...base, SKY_RUNTIME: "pi", AI_GATEWAY_API_KEY: "k" };
    expect(
      loadConfig({
        ...pi,
        SKY_PI_SKILLS: " /opt/skills/a, ~/.sky/pi/skills , $HOME/.sky/more,",
      }).piSkills,
    ).toEqual(["/opt/skills/a", "~/.sky/pi/skills", "$HOME/.sky/more"]);
  });

  test("a bad skill entry stops a pi run only: Claude Code and Codex runs never read the value", () => {
    const bad = { SKY_PI_SKILLS: "relative/dir,--flag" };
    expect(() =>
      loadConfig({
        ...base,
        SKY_RUNTIME: "pi",
        AI_GATEWAY_API_KEY: "k",
        ...bad,
      }),
    ).toThrow(/SKY_PI_SKILLS/);
    expect(
      loadConfig({ ...base, CLAUDE_CODE_OAUTH_TOKEN: "t", ...bad }).runtime,
    ).toBeUndefined();
    expect(
      loadConfig({
        ...base,
        SKY_RUNTIME: "codex",
        AI_GATEWAY_API_KEY: "k",
        ...bad,
      }).runtime,
    ).toBe("codex");
  });

  test("skillPath expands ~/ and $HOME/ under the run's home and leaves an absolute path", () => {
    expect(skillPath("~/.s/a", "/h")).toBe("/h/.s/a");
    expect(skillPath("$HOME/.s/a", "/h")).toBe("/h/.s/a");
    expect(skillPath("/opt/s", "/h")).toBe("/opt/s");
    expect(skillPath("$HOMER/x", "/h")).toBe("$HOMER/x");
  });

  test("refuses a skill directory that is relative or could read as a pi flag", () => {
    const pi = { ...base, SKY_RUNTIME: "pi", AI_GATEWAY_API_KEY: "k" };
    for (const bad of ["skills", "--no-approve", "./s", "-e", "/a\n/b"])
      expect(() => loadConfig({ ...pi, SKY_PI_SKILLS: bad })).toThrow(
        /SKY_PI_SKILLS/,
      );
  });
});

describe("withdrawGatewayKey", () => {
  test("is the one Codex uses: takes the gateway key out of the env and returns it", () => {
    const env: NodeJS.ProcessEnv = { AI_GATEWAY_API_KEY: "k", OTHER: "1" };
    expect(withdrawGatewayKey(env)).toEqual({ AI_GATEWAY_API_KEY: "k" });
    expect(env).toEqual({ OTHER: "1" });
    expect(withdrawGatewayKey(env)).toEqual({});
  });
});

describe("resolvePiExecutable", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "runner-pi-bin-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("the npm bin link to cli.js runs that file on node, which the seal copies", () => {
    mkdirSync(join(dir, "pkg/dist/bundle"), { recursive: true });
    mkdirSync(join(dir, "node_modules/.bin"), { recursive: true });
    const cli = join(dir, "pkg/dist/bundle/cli.js");
    writeFileSync(cli, "#!/usr/bin/env node\n");
    const bin = join(dir, "node_modules/.bin/pi");
    symlinkSync(cli, bin);
    expect(resolvePiExecutable(bin, "/usr/bin/node")).toEqual({
      command: "/usr/bin/node",
      args: [realpathSync(cli)],
    });
    expect(resolvePiExecutable(bin).command).toBe(process.execPath);
  });

  test("a file that is not JavaScript is run as it is", () => {
    const bin = join(dir, "pi");
    writeFileSync(bin, "\x7fELF");
    chmodSync(bin, 0o755);
    // a compiled pi finds its themes and package.json beside its binary: pi is told where they are
    expect(resolvePiExecutable(bin, "/usr/bin/node")).toEqual({
      command: realpathSync(bin),
      args: [],
      packageDir: realpathSync(dir),
    });
  });

  test("a launcher that isn't there is an error", () => {
    expect(() => resolvePiExecutable(join(dir, "missing"))).toThrow(/ENOENT/);
  });
});

/** The gateway catalog pi-ai ships, as pi 1.6.1 lays it out, installed under `root/node_modules`. */
function writeGatewayCatalog(root: string, models: Record<string, unknown>) {
  const data = join(
    root,
    "node_modules/@earendil-works/pi-ai/dist/providers/data",
  );
  mkdirSync(data, { recursive: true });
  const chat = Object.fromEntries(
    Object.entries(models).map(([id, entry]) => [`chat:${id}`, entry]),
  );
  writeFileSync(
    join(data, "vercel-ai-gateway.json"),
    JSON.stringify({ "anthropic-messages": {}, "typesafe-system-one": chat }),
  );
}

const flashEntry = {
  id: DEFAULT_PI_MODEL,
  api: "anthropic-messages",
  reasoning: true,
  cost: { input: 0.3, output: 1.2, cacheRead: 0.007, cacheWrite: 0 },
  contextWindow: 1048576,
  maxTokens: 262144,
  type: "chat",
};

describe("piCatalogModel", () => {
  let dir: string;
  let cli: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "runner-pi-catalog-"));
    cli = join(
      dir,
      "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
    );
    mkdirSync(join(cli, ".."), { recursive: true });
    writeFileSync(cli, "");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a model in the gateway catalog pi ships gets the catalog's prices and limits", () => {
    writeGatewayCatalog(dir, { [DEFAULT_PI_MODEL]: flashEntry });
    expect(piCatalogModel(DEFAULT_PI_MODEL, cli)).toEqual({
      spec: {
        cost: { input: 0.3, output: 1.2, cacheRead: 0.007, cacheWrite: 0 },
        contextWindow: 1048576,
        maxTokens: 262144,
      },
    });
  });

  test("a model the catalog doesn't list gets the fallback, and says so", () => {
    writeGatewayCatalog(dir, { [DEFAULT_PI_MODEL]: flashEntry });
    const { spec, fallback } = piCatalogModel("x/unknown", cli);
    expect(spec).toEqual(FALLBACK_PI_MODEL_SPEC);
    expect(fallback).toMatch(/x\/unknown/);
  });

  test("no catalog beside pi gets the fallback, and says so", () => {
    const { spec, fallback } = piCatalogModel(DEFAULT_PI_MODEL, cli);
    expect(spec).toEqual(FALLBACK_PI_MODEL_SPEC);
    expect(fallback).toMatch(/catalog/);
  });
});

describe("piToolCall", () => {
  test("bash is Bash, unwrapped from its shell, keeping what the agent wrote", () => {
    expect(
      piToolCall("bash", { command: "bash -lc 'rm -rf x'" }, "/w"),
    ).toEqual({
      toolName: "Bash",
      input: { command: "rm -rf x" },
      targets: [],
      rawCommand: "bash -lc 'rm -rf x'",
    });
    expect(piToolCall("bash", { command: "ls" }, "/w")?.input).toEqual({
      command: "ls",
    });
  });

  test("write and edit are Write and Edit, their paths made absolute from the worktree", () => {
    expect(
      piToolCall("write", { path: "src/a.ts", content: "x" }, "/w"),
    ).toEqual({
      toolName: "Write",
      input: { file_path: "/w/src/a.ts", content: "x" },
      targets: ["/w/src/a.ts"],
    });
    const edit = piToolCall(
      "edit",
      { path: "/etc/hosts", edits: [{ oldText: "a", newText: "b" }] },
      "/w",
    );
    expect(edit?.toolName).toBe("Edit");
    expect(edit?.targets).toEqual(["/etc/hosts"]);
    expect(edit?.input.edits).toEqual([{ oldText: "a", newText: "b" }]);
  });

  test("a leading @ or ~ in a path means what pi's own tools take it to mean", () => {
    expect(
      piToolCall("write", { path: "@a.txt" }, "/w", "/h")?.targets,
    ).toEqual(["/w/a.txt"]);
    expect(piToolCall("edit", { path: "~/x" }, "/w", "/h")?.targets).toEqual([
      "/h/x",
    ]);
    expect(piToolCall("edit", { path: "@~/x" }, "/w", "/h")?.targets).toEqual([
      "/h/x",
    ]);
  });

  test.each([
    ["file:///home/sprite/.bashrc", "/home/sprite/.bashrc"],
    ["@file:///etc/hosts", "/etc/hosts"],
    ["file:///w/a%20b.txt", "/w/a b.txt"],
    ["a\u00A0b\u2009c.txt", "/w/a b c.txt"],
    // pi doesn't trim a write's path, so neither does the check
    [" /etc/x", "/w/ /etc/x"],
  ])("write %j targets %s, the file pi writes", (path, target) => {
    for (const tool of ["write", "edit"])
      expect(piToolCall(tool, { path }, "/w", "/h")?.targets).toEqual([target]);
  });

  test("a file URL pi can't turn into a path is not an error here", () => {
    expect(() =>
      piToolCall("write", { path: "file://host/x" }, "/w"),
    ).not.toThrow();
  });

  test("reads and the runner's own tools are not asked about", () => {
    for (const tool of [
      "read",
      "grep",
      "find",
      "ls",
      "sky_publish",
      "sky_sync",
    ])
      expect(piToolCall(tool, {}, "/w")).toBeUndefined();
  });

  test("any other tool keeps its name, so a pattern naming it holds it", () => {
    expect(piToolCall("mcp__doop__draw", { a: 1 }, "/w")).toEqual({
      toolName: "mcp__doop__draw",
      input: { a: 1 },
      targets: [],
    });
  });
});

describe("commandViews", () => {
  test.each([
    ["git push", ["git push"]],
    ["cd x && git push", ["cd x && git push", "cd x", "git push"]],
    [
      "sudo -u deploy git push origin",
      ["sudo -u deploy git push origin", "git push origin"],
    ],
    ["sudo git push", ["git push"]],
    ["env FOO=1 BAR=2 git push", ["git push"]],
    ["FOO=1 git push", ["git push"]],
    ["/usr/bin/env -u X git push", ["git push"]],
    ["nohup git push", ["git push"]],
    ["timeout 30 git push", ["git push"]],
    ["nice -n 5 git push", ["git push"]],
    ["sudo -- git push", ["git push"]],
    ["bash -lc 'git push'", ["git push"]],
    ['sh -c "cd x; git push"', ["git push"]],
    ["sudo -u a bash -c 'env A=1 git push'", ["git push"]],
    ["xargs -n 1 git push", ["git push"]],
    ["xargs -a list git push", ["git push"]],
    ["sudo --user deploy git push", ["git push"]],
    ["sudo --user=deploy git push", ["git push"]],
    ["sudo -iu root git push", ["git push"]],
    ["sudo -uroot git push", ["git push"]],
    ["sudo --chdir /x --group staff git push", ["git push"]],
    ["sudo --login --other-user a git push", ["git push"]],
    ["timeout --signal KILL 10 git push", ["git push"]],
    ["bash -o pipefail -c 'git push'", ["git push"]],
    ["bash +o history -c 'git push'", ["git push"]],
    ["bash -eo pipefail -c 'git push'", ["git push"]],
    ["bash -O extglob -c 'git push'", ["git push"]],
    ["bash -c -o pipefail 'git push'", ["git push"]],
    ["bash --norc --rcfile x -c 'git push'", ["git push"]],
    ["env -S 'git push origin'", ["git push origin"]],
    ["env -S'git push'", ["git push"]],
    ["env -i --split-string='FOO=1 git push'", ["git push"]],
    ["env --split-string 'git push' origin", ["git push origin"]],
    ["doas -u deploy git push", ["git push"]],
    ["command git push", ["git push"]],
    ["builtin git push", ["git push"]],
    ["exec -a name git push", ["git push"]],
    ["time -o out git push", ["git push"]],
    ["ionice -c 3 git push", ["git push"]],
    ["setsid -w git push", ["git push"]],
    ["stdbuf -oL git push", ["git push"]],
    ["stdbuf -o L git push", ["git push"]],
    ["zsh -c 'git push'", ["git push"]],
    ["dash -c 'git push'", ["git push"]],
    ["ksh -c 'git push'", ["git push"]],
  ])("%s runs %j", (command, expected) => {
    expect(commandViews(command)).toEqual(expect.arrayContaining(expected));
  });

  test("a command with no wrapper has no extra view, and nesting is bounded", () => {
    expect(commandViews("ls -la")).toEqual(["ls -la"]);
    expect(commandViews("bash script.sh")).toEqual(["bash script.sh"]);
    expect(commandViews("sudo --user deploy git push")).not.toContain(
      "deploy git push",
    );
    const deep = `${"bash -c '".repeat(12)}git push${"'".repeat(12)}`;
    expect(() => commandViews(deep)).not.toThrow();
  });
});

describe("realPathOf", () => {
  let dir: string;
  let inside: string;
  let outsideDir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "runner-pi-real-")));
    inside = join(dir, "work");
    outsideDir = join(dir, "elsewhere");
    mkdirSync(join(inside, "src"), { recursive: true });
    mkdirSync(outsideDir);
    writeFileSync(join(outsideDir, "secret.txt"), "s");
    writeFileSync(join(inside, "src/a.ts"), "a");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const held = (path: string) =>
    outcomeIn(inside, "write", { path, content: "x" });
  const outcomeIn = (cwd: string, tool: string, input: unknown) => {
    const call = piToolCall(tool, input, cwd);
    if (!call) throw new Error("not a gated call");
    const scope = {
      root: cwd,
      cwd,
      realpath: (p: string) => p,
      isSymlink: () => false,
      home: "/home/u",
      storeHome: undefined,
      scratch: "/tmp/s",
    };
    return piOutcome(
      { approvalPolicy: [], autoApprove: { defaults: true, commands: [] } },
      call,
      scope,
      cwd,
    );
  };

  test("a file in the worktree is inside, one that doesn't exist yet too", () => {
    expect(held("src/a.ts")).toBe("run");
    expect(held("src/new/deeper/b.ts")).toBe("run");
    expect(realPathOf(join(inside, "src/new/b.ts"))).toBe(
      join(inside, "src/new/b.ts"),
    );
  });

  test("a link to a file outside holds a write through it", () => {
    symlinkSync(join(outsideDir, "secret.txt"), join(inside, "link.txt"));
    expect(held("link.txt")).toBe("hold");
    expect(realPathOf(join(inside, "link.txt"))).toBe(
      join(outsideDir, "secret.txt"),
    );
  });

  test("a link to a directory outside holds a write under it, existing file or new", () => {
    symlinkSync(outsideDir, join(inside, "out"));
    expect(held("out/secret.txt")).toBe("hold");
    expect(held("out/brand-new.txt")).toBe("hold");
    expect(held("out/new/dir/file.txt")).toBe("hold");
  });

  test("a link to a place inside the worktree is still inside", () => {
    symlinkSync(join(inside, "src"), join(inside, "alias"));
    symlinkSync(join(inside, "src/a.ts"), join(inside, "a-link.ts"));
    expect(held("alias/a.ts")).toBe("run");
    expect(held("alias/new.ts")).toBe("run");
    expect(held("a-link.ts")).toBe("run");
  });

  test("a dangling link is judged by where it points", () => {
    symlinkSync(join(outsideDir, "not-yet.txt"), join(inside, "dangling-out"));
    symlinkSync(join(inside, "src/not-yet.ts"), join(inside, "dangling-in"));
    symlinkSync("loop-b", join(inside, "loop-a"));
    symlinkSync("loop-a", join(inside, "loop-b"));
    expect(held("dangling-out")).toBe("hold");
    expect(held("dangling-in")).toBe("run");
    // a loop resolves to nothing: it stays under its own directory, and the write fails there
    expect(held("loop-a")).toBe("run");
    // and the walk stops: the cap on link hops ends it at a path under the worktree
    const resolved = realPathOf(join(inside, "loop-a"));
    expect(resolved.startsWith(`${inside}/`)).toBe(true);
    expect(resolved).toMatch(/\/loop-[ab]$/);
  });

  test("a worktree that is itself reached through a link is judged by its real path", () => {
    const alias = join(dir, "alias-of-work");
    symlinkSync(inside, alias);
    expect(outcomeIn(alias, "write", { path: "src/a.ts", content: "" })).toBe(
      "run",
    );
    expect(
      outcomeIn(alias, "write", { path: "../elsewhere/x", content: "" }),
    ).toBe("hold");
  });

  test("an edit is held the same way", () => {
    symlinkSync(outsideDir, join(inside, "out"));
    expect(
      outcomeIn(inside, "edit", { path: "out/secret.txt", edits: [] }),
    ).toBe("hold");
  });
});

describe("piOutcome", () => {
  const cwd = "/w";
  const scope = {
    root: cwd,
    cwd,
    realpath: (p: string) => p,
    isSymlink: () => false,
    home: "/home/u",
    storeHome: undefined,
    scratch: "/tmp/s",
  };
  const outcome = (
    policy: string[],
    tool: string,
    input: unknown,
    autoApprove = { defaults: true, commands: [] as string[] },
  ) => {
    const call = piToolCall(tool, input, cwd);
    if (!call) throw new Error("not a gated call");
    return piOutcome({ approvalPolicy: policy, autoApprove }, call, scope, cwd);
  };

  test("a command no pattern holds runs", () => {
    expect(outcome([], "bash", { command: "rm -rf x" })).toBe("run");
    expect(outcome(["Edit"], "bash", { command: "rm -rf x" })).toBe("run");
  });

  test("a bare Bash pattern holds a command, and lets the read-only ones through", () => {
    expect(outcome(["Bash"], "bash", { command: "touch x" })).toBe("hold");
    expect(outcome(["Bash"], "bash", { command: "ls -la" })).toBe(
      "auto-approved",
    );
    expect(outcome(["Bash"], "bash", { command: "git status" })).toBe(
      "auto-approved",
    );
    expect(outcome(["Bash"], "bash", { command: "cat README && ls" })).toBe(
      "auto-approved",
    );
    expect(outcome(["Bash"], "bash", { command: "ls; rm x" })).toBe("hold");
  });

  test("a read-only command inside the shell wrapper still self-approves", () => {
    expect(
      outcome(["Bash"], "bash", { command: "bash -lc 'git status'" }),
    ).toBe("auto-approved");
  });

  test("auto-approve can be turned off, or extended with the environment's commands", () => {
    expect(
      outcome(
        ["Bash"],
        "bash",
        { command: "ls" },
        { defaults: false, commands: [] },
      ),
    ).toBe("hold");
    expect(
      outcome(
        ["Bash"],
        "bash",
        { command: "make check" },
        { defaults: true, commands: ["make check"] },
      ),
    ).toBe("auto-approved");
  });

  test.each([
    "git push origin main",
    "cd x && git push",
    "sudo git push",
    "sudo -u deploy git push",
    "env GIT_TERMINAL_PROMPT=0 git push",
    "GIT_SSH_COMMAND=x git push",
    "bash -lc 'git push'",
    "sh -c 'cd x; git push origin'",
    "sudo -u a bash -c 'env A=1 git push'",
    "timeout 60 git push",
    "nohup git push &",
    "xargs -n 1 git push",
    "sudo --user deploy git push",
    "sudo --user=deploy git push",
    "bash -o pipefail -c 'git push'",
    "env -S 'git push'",
  ])("a pattern that names git push holds %s", (command) => {
    expect(outcome(["Bash(git push:*)"], "bash", { command })).toBe("hold");
  });

  test("a named pattern does not hold what it doesn't name", () => {
    expect(
      outcome(["Bash(git push:*)"], "bash", { command: "git status" }),
    ).toBe("run");
    expect(
      outcome(["Bash(git push:*)"], "bash", { command: "echo git-push" }),
    ).toBe("run");
  });

  test("an Edit or Write pattern holds a change to a file in the worktree", () => {
    expect(outcome(["Edit"], "edit", { path: "a.ts", edits: [] })).toBe("hold");
    expect(outcome(["Write"], "write", { path: "a.ts", content: "" })).toBe(
      "hold",
    );
    expect(outcome(["Write"], "edit", { path: "a.ts", edits: [] })).toBe("run");
    expect(
      outcome(["Edit(/w/secret.txt)"], "edit", { path: "secret.txt" }),
    ).toBe("hold");
    expect(
      outcome(["Edit(/w/secret.txt)"], "edit", { path: "other.txt" }),
    ).toBe("run");
  });

  test("a change outside the worktree is held whatever the policy says", () => {
    expect(outcome([], "write", { path: "/etc/x", content: "" })).toBe("hold");
    expect(outcome([], "edit", { path: "../up.txt", edits: [] })).toBe("hold");
    expect(outcome([], "write", { path: "~/x", content: "" })).toBe("hold");
    expect(
      outcome([], "write", {
        path: "file:///home/sprite/.bashrc",
        content: "",
      }),
    ).toBe("hold");
    expect(outcome([], "edit", { path: "@file:///etc/x", edits: [] })).toBe(
      "hold",
    );
    expect(outcome([], "write", { path: "in.txt", content: "" })).toBe("run");
    expect(
      outcome([], "write", { path: "file:///w/in.txt", content: "" }),
    ).toBe("run");
  });

  test("another tool is held by a pattern that names it", () => {
    expect(outcome(["mcp__doop__draw"], "mcp__doop__draw", {})).toBe("hold");
    expect(outcome(["mcp__doop__draw"], "mcp__doop__list", {})).toBe("run");
  });
});

describe("piMcpConfig", () => {
  const profile = {
    doop: { command: "npx", args: ["doop"], env: { API_KEY: "DOOP_KEY" } },
    docs: {
      url: "https://docs.test/mcp",
      headers: { Authorization: "DOCS_TOKEN" },
    },
    gone: { command: "x", args: [], env: { K: "MISSING" } },
  };

  test("writes each secret as a reference to pi's env, never its value, with every tool declared", () => {
    const { mcpServers, unresolved } = piMcpConfig(profile, {
      DOOP_KEY: "s3cret-one",
      DOCS_TOKEN: "s3cret-two",
    });
    expect(mcpServers).toEqual({
      doop: {
        command: "npx",
        args: ["doop"],
        env: { API_KEY: ref("DOOP_KEY") },
        exposure: "direct",
      },
      docs: {
        url: "https://docs.test/mcp",
        headers: { Authorization: ref("DOCS_TOKEN") },
        exposure: "direct",
      },
    });
    expect(JSON.stringify(mcpServers)).not.toContain("s3cret");
    expect(unresolved).toEqual([{ server: "gone", secrets: ["MISSING"] }]);
  });

  test("an empty profile has no servers", () => {
    expect(piMcpConfig({}, {})).toEqual({ mcpServers: {}, unresolved: [] });
  });
});

describe("piInstructions", () => {
  test("is the instructions Codex gets, and says pi has no subagents", () => {
    const text = piInstructions({
      broker: true,
      checks: ["pnpm test"],
      notes: [],
    });
    expect(text).toContain("sky_publish");
    expect(text).toContain("- pnpm test");
    expect(text).toMatch(/no subagents/);
  });

  test("says a denial's reason comes back as the declined step's result", () => {
    const text = piInstructions({ broker: false, checks: [], notes: [] });
    expect(text).toContain(
      "When the person gives a reason, it comes back as that step's result: do what it says.",
    );
    expect(text).not.toMatch(/follows as a message/);
  });
});

describe("gateway errors", () => {
  test("pi's error text is judged by the detection Codex's runs use", () => {
    expect(
      gatewayUnavailable([{ message: "402 Payment Required: out of credits" }]),
    ).toBe("credit");
    expect(gatewayUnavailable([{ message: "429 Too Many Requests" }])).toBe(
      "rate",
    );
    expect(
      gatewayUnavailable([{ message: "context window exceeded" }]),
    ).toBeUndefined();
    expect(
      gatewayUnavailable([{ message: "the model call failed" }], 402),
    ).toBe("credit");
  });

  test("the run's error names the cause and quotes pi", () => {
    expect(piUnavailable("credit", " 402 nope ")).toBe(
      "pi_unavailable: the AI Gateway is out of credit (pi said: 402 nope)",
    );
    expect(piUnavailable("rate", "x")).toMatch(
      /^pi_unavailable: .*rate-limited/,
    );
  });
});

describe("the run's extension", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "runner-pi-ext-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
  async function load(
    tools = [
      { name: "sky_publish", description: "d", parameters: { type: "object" } },
    ],
  ) {
    const file = join(dir, "ext.mjs");
    writeFileSync(
      file,
      piExtensionSource({
        baseUrl: "http://127.0.0.1:9/v1",
        model: "m/x",
        spec: {
          cost: { input: 0.3, output: 1.2, cacheRead: 0.007, cacheWrite: 0 },
          contextWindow: 1048576,
          maxTokens: 8192,
        },
        tools,
      }),
    );
    const mod = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as {
      default: (pi: unknown) => void;
    };
    const seen = {
      providers: [] as [string, Record<string, unknown>][],
      tools: [] as Logged[],
      handlers: new Map<string, Handler>(),
    };
    mod.default({
      registerProvider: (name: string, config: Record<string, unknown>) =>
        seen.providers.push([name, config]),
      registerTool: (tool: Record<string, unknown>) => seen.tools.push(tool),
      on: (event: string, handler: Handler) =>
        seen.handlers.set(event, handler),
    });
    return seen;
  }
  const ctxAnswering = (answer: unknown) => {
    const titles: string[] = [];
    return {
      titles,
      ctx: {
        signal: undefined,
        ui: {
          input: async (title: string) => {
            titles.push(title);
            return answer === undefined ? undefined : JSON.stringify(answer);
          },
        },
      },
    };
  };

  test("registers the run's proxy as the provider with the token it read and the model's prices and limits, and clears the token from pi's env", async () => {
    vi.stubEnv("SKY_PI_GATEWAY_TOKEN", "run-token");
    const seen = await load();
    expect(process.env.SKY_PI_GATEWAY_TOKEN).toBeUndefined();
    expect(seen.providers).toHaveLength(1);
    const [name, config] = seen.providers[0] ?? ["", {}];
    expect(name).toBe(PI_PROVIDER);
    expect(config).toMatchObject({
      baseUrl: "http://127.0.0.1:9/v1",
      apiKey: "run-token",
      api: "openai-completions",
      models: [
        {
          id: "m/x",
          cost: { input: 0.3, output: 1.2, cacheRead: 0.007, cacheWrite: 0 },
          contextWindow: 1048576,
          maxTokens: 8192,
          compat: { maxTokensField: "max_tokens" },
        },
      ],
    });
    // the token is in pi's memory, not in the file
    expect(readFileSync(join(dir, "ext.mjs"), "utf8")).not.toContain(
      "run-token",
    );
  });

  test("refuses to load without the token", async () => {
    vi.stubEnv("SKY_PI_GATEWAY_TOKEN", "");
    await expect(load()).rejects.toThrow(/gateway token is missing/);
  });

  test("puts every call that isn't a read to the runner, and runs what it allows", async () => {
    vi.stubEnv("SKY_PI_GATEWAY_TOKEN", "t");
    const seen = await load();
    const gate = seen.handlers.get("tool_call");
    const allowed = ctxAnswering({ allow: true });
    expect(
      await gate?.(
        { toolName: "bash", toolCallId: "c1", input: { command: "ls" } },
        allowed.ctx,
      ),
    ).toBeUndefined();
    expect(allowed.titles).toHaveLength(1);
    expect(allowed.titles[0]).toMatch(/^sky:/);
    expect(JSON.parse((allowed.titles[0] ?? "").slice(4))).toEqual({
      kind: "call",
      id: "c1",
      tool: "bash",
      input: { command: "ls" },
    });
  });

  test("blocks a call the runner refuses, with its reason, and one it doesn't answer", async () => {
    vi.stubEnv("SKY_PI_GATEWAY_TOKEN", "t");
    const gate = (await load()).handlers.get("tool_call");
    const call = { toolName: "write", toolCallId: "c", input: {} };
    expect(
      await gate?.(
        call,
        ctxAnswering({ allow: false, reason: "not that file" }).ctx,
      ),
    ).toEqual({ block: true, reason: "not that file" });
    expect(await gate?.(call, ctxAnswering(undefined).ctx)).toEqual({
      block: true,
      reason: "no one answered in time",
    });
    // an answer that isn't JSON, or a dialog that throws, is no answer
    const garbled = { ui: { input: async () => "{not json" } };
    expect(await gate?.(call, garbled)).toMatchObject({ block: true });
    const throwing = {
      ui: {
        input: async () => {
          throw new Error("closed");
        },
      },
    };
    expect(await gate?.(call, throwing)).toMatchObject({ block: true });
  });

  test("never asks about a read or the runner's own tools", async () => {
    vi.stubEnv("SKY_PI_GATEWAY_TOKEN", "t");
    const gate = (await load()).handlers.get("tool_call");
    const nobody = ctxAnswering({ allow: false });
    for (const toolName of [
      "read",
      "grep",
      "find",
      "ls",
      "sky_publish",
      "sky_sync",
    ])
      expect(
        await gate?.({ toolName, toolCallId: "c", input: {} }, nobody.ctx),
      ).toBeUndefined();
    expect(nobody.titles).toEqual([]);
  });

  test("registers the runner's tools, which return what the runner answers and fail when it doesn't", async () => {
    vi.stubEnv("SKY_PI_GATEWAY_TOKEN", "t");
    const seen = await load();
    expect(seen.tools.map((t) => t.name)).toEqual(["sky_publish"]);
    const tool = seen.tools[0];
    const ok = ctxAnswering({
      success: true,
      text: "https://github.test/pr/1",
    });
    expect(
      await tool?.execute("id1", { title: "T" }, undefined, undefined, ok.ctx),
    ).toEqual({
      content: [{ type: "text", text: "https://github.test/pr/1" }],
      details: {},
    });
    expect(JSON.parse((ok.titles[0] ?? "").slice(4))).toEqual({
      kind: "tool",
      id: "id1",
      tool: "sky_publish",
      args: { title: "T" },
    });
    await expect(
      tool?.execute(
        "id2",
        {},
        undefined,
        undefined,
        ctxAnswering({ success: false, text: "refused" }).ctx,
      ),
    ).rejects.toThrow("refused");
    await expect(
      tool?.execute(
        "id3",
        {},
        undefined,
        undefined,
        ctxAnswering(undefined).ctx,
      ),
    ).rejects.toThrow(/nothing was sent/);
  });

  test("registers no tools for a run with no connector", async () => {
    vi.stubEnv("SKY_PI_GATEWAY_TOKEN", "t");
    expect((await load([])).tools).toEqual([]);
  });
});

describe("cleanAgentDir", () => {
  let dir: string;
  let precious: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "runner-pi-agent-"));
    precious = join(dir, "precious");
    mkdirSync(precious);
    writeFileSync(join(precious, "sentinel.txt"), "keep");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("keeps what Sky writes, removes the rest, and makes the directory when it is missing", () => {
    const agent = join(dir, "agent");
    cleanAgentDir(agent);
    expect(existsSync(agent)).toBe(true);
    writeFileSync(join(agent, "settings.json"), "{}");
    writeFileSync(join(agent, "mcp.json"), "{}");
    writeFileSync(join(agent, "auth.json"), "{}");
    mkdirSync(join(agent, "prompts/deep"), { recursive: true });
    symlinkSync(precious, join(agent, "skills"));
    cleanAgentDir(agent);
    expect(readdirSync(agent).sort()).toEqual(["mcp.json", "settings.json"]);
    // a link entry is removed without its target being emptied
    expect(readdirSync(precious)).toEqual(["sentinel.txt"]);
    expect(readFileSync(join(precious, "sentinel.txt"), "utf8")).toBe("keep");
  });

  test("an agent directory that is itself a link is replaced, and its target is left whole", () => {
    const agent = join(dir, "agent");
    symlinkSync(precious, agent);
    cleanAgentDir(agent);
    expect(lstatSync(agent).isSymbolicLink()).toBe(false);
    expect(readdirSync(agent)).toEqual([]);
    expect(readdirSync(precious)).toEqual(["sentinel.txt"]);
    expect(readFileSync(join(precious, "sentinel.txt"), "utf8")).toBe("keep");
  });
});

describe("PiRpc", () => {
  const fakeChild = () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn(),
    });
    const written: Record<string, unknown>[] = [];
    child.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean))
        written.push(JSON.parse(line));
    });
    return { child, written, rpc: new PiRpc(child as never) };
  };
  const tick = () => new Promise((r) => setTimeout(r, 5));

  test("reads lines that end at LF only, across chunks and multibyte characters", async () => {
    const { child, rpc } = fakeChild();
    const seen: unknown[] = [];
    rpc.onEvent = (type, record) => seen.push([type, record]);
    // U+2028 is valid inside a JSON string and is not a record boundary
    const line = `${JSON.stringify({ type: "message_end", text: "a b é 😀" })}\n`;
    const bytes = Buffer.from(
      `${line}${JSON.stringify({ type: "agent_settled" })}\r\n`,
    );
    child.stdout.write(bytes.subarray(0, 40));
    child.stdout.write(bytes.subarray(40, 41));
    child.stdout.write(bytes.subarray(41));
    await tick();
    expect(seen).toEqual([
      ["message_end", { type: "message_end", text: "a b é 😀" }],
      ["agent_settled", { type: "agent_settled" }],
    ]);
  });

  test("a command resolves to its response's data, and rejects with pi's error", async () => {
    const { child, written, rpc } = fakeChild();
    const state = rpc.command("get_state");
    await tick();
    expect(written[0]).toMatchObject({ type: "get_state" });
    child.stdout.write(
      `${JSON.stringify({ id: written[0]?.id, type: "response", command: "get_state", success: true, data: { sessionId: "s1" } })}\n`,
    );
    expect(await state).toEqual({ sessionId: "s1" });
    const bad = rpc.command("prompt", { message: "x" });
    await tick();
    child.stdout.write(
      `${JSON.stringify({ id: written[1]?.id, type: "response", command: "prompt", success: false, error: "no model" })}\n`,
    );
    await expect(bad).rejects.toThrow("no model");
  });

  test("a command times out, and ends when the process does", async () => {
    const { child, rpc } = fakeChild();
    await expect(rpc.command("get_state", {}, 5)).rejects.toThrow(
      /didn't answer get_state within 5 ms/,
    );
    const pending = rpc.command("get_state");
    child.stderr.write("boom: no model\n");
    await tick();
    child.emit("exit", 3, null);
    await expect(pending).rejects.toThrow(/pi exited \(3\): boom: no model/);
    expect((await rpc.exited).error).toMatch(/exited \(3\)/);
  });

  test("a dialog is answered with what onUiRequest returns, and a notification is not", async () => {
    const { child, written, rpc } = fakeChild();
    rpc.onUiRequest = async (request) => ({ value: `got ${request.title}` });
    child.stdout.write(
      `${JSON.stringify({ type: "extension_ui_request", id: "u1", method: "input", title: "sky:{}" })}\n`,
    );
    child.stdout.write(
      `${JSON.stringify({ type: "extension_ui_request", id: "u2", method: "notify", message: "hi" })}\n`,
    );
    await tick();
    expect(written).toEqual([
      { type: "extension_ui_response", id: "u1", value: "got sky:{}" },
    ]);
  });

  test("a dialog whose handler throws is cancelled, not left open", async () => {
    const { child, written, rpc } = fakeChild();
    rpc.onUiRequest = async () => {
      throw new Error("x");
    };
    child.stdout.write(
      `${JSON.stringify({ type: "extension_ui_request", id: "u1", method: "confirm", title: "t" })}\n`,
    );
    await tick();
    expect(written).toEqual([
      { type: "extension_ui_response", id: "u1", cancelled: true },
    ]);
  });

  test("abort tells pi to stop and cancels the dialogs still open, once", async () => {
    const { child, written, rpc } = fakeChild();
    rpc.onUiRequest = () => new Promise(() => {});
    child.stdout.write(
      `${JSON.stringify({ type: "extension_ui_request", id: "u1", method: "input", title: "sky:{}" })}\n`,
    );
    await tick();
    rpc.abort();
    await tick();
    expect(written.map((m) => m.type)).toEqual([
      "abort",
      "extension_ui_response",
    ]);
    expect(written[1]).toEqual({
      type: "extension_ui_response",
      id: "u1",
      cancelled: true,
    });
  });

  test("a write that fails after pi died ends the process's wait, not the runner", async () => {
    const { child, rpc } = fakeChild();
    child.stdin.emit("error", new Error("write EPIPE"));
    expect((await rpc.exited).error).toMatch(
      /stopped reading its stdin \(write EPIPE\)/,
    );
  });
});

// A stand-in for pi's RPC mode: a Node script that speaks pi's protocol, drives one scenario per prompt,
// and logs what the runner sent it and started it with.
const FAKE_PI = String.raw`
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
const log = (m) => appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify(m) + "\n");
const argv = process.argv.slice(2);
const flag = (name) => argv[argv.indexOf(name) + 1];
const extension = flag("--extension");
const agentDir = process.env.PI_CODING_AGENT_DIR;
// a session is a file named for its id in --session-dir: one a follow-up finds is a session it resumes
const sessionFile = flag("--session-dir") + "/" + flag("--session-id") + ".jsonl";
const resumed = existsSync(sessionFile);
if (!resumed) writeFileSync(sessionFile, "{}\n");
log({
  start: true,
  agentFiles: readdirSync(agentDir).sort(),
  resumed,
  argv,
  cwd: process.cwd(),
  env: {
    token: process.env.SKY_PI_GATEWAY_TOKEN,
    key: process.env.AI_GATEWAY_API_KEY,
    agentToken: process.env.AGENT_TOKEN,
    agentDir,
    offline: process.env.PI_OFFLINE,
    secret: process.env.PROJECT_SECRET,
    connector: process.env.GITHUB_CONNECTOR,
    gatewayUrl: process.env.GITHUB_GATEWAY_URL,
  },
  extension: existsSync(extension) ? readFileSync(extension, "utf8") : null,
  instructions: existsSync(flag("--append-system-prompt")) ? readFileSync(flag("--append-system-prompt"), "utf8") : null,
  settings: existsSync(agentDir + "/settings.json") ? JSON.parse(readFileSync(agentDir + "/settings.json", "utf8")) : null,
  mcp: existsSync(agentDir + "/mcp.json") ? JSON.parse(readFileSync(agentDir + "/mcp.json", "utf8")) : null,
});
if (process.env.FAKE_PI_LOST_SESSION) process.stderr.write("Warning: No project session found with id 'x'; creating a new session with that id.\n");
if (process.env.FAKE_PI_SCENARIO === "exit-early") { process.stderr.write("Error: model not found\n"); process.exit(3); }
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const waiting = new Map();
let n = 0;
const ask = (payload) => new Promise((resolve) => {
  const id = "ui" + ++n;
  waiting.set(id, resolve);
  send({ type: "extension_ui_request", id, method: "input", title: "sky:" + JSON.stringify(payload) });
});
const result = (r) => (r.cancelled ? undefined : JSON.parse(r.value));
const text = (t) => ({ content: [{ type: "text", text: t }] });
const assistant = (message) => send({ type: "message_end", message: { role: "assistant", content: [], stopReason: "stop", ...message } });
const usage = (input, output, extra = {}) => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { total: 0 }, ...extra });
// a tool call as pi runs it: the start event, the extension's dialog, then the end
async function tool(id, name, args, run) {
  send({ type: "tool_execution_start", toolCallId: id, toolName: name, args });
  const gated = !["read", "grep", "find", "ls", "sky_publish", "sky_sync"].includes(name);
  if (gated) {
    const answer = result(await ask({ kind: "call", id, tool: name, input: args }));
    log({ answered: id, answer });
    if (!answer?.allow) {
      send({ type: "tool_execution_end", toolCallId: id, toolName: name, result: text(answer?.reason ?? "blocked"), isError: true });
      return answer;
    }
  }
  const out = await run?.();
  send({ type: "tool_execution_end", toolCallId: id, toolName: name, result: text(out ?? "ok"), isError: false, durationMs: 7 });
  return { allow: true };
}
const settle = (aborted = false) => { send({ type: "agent_end", messages: [], willRetry: false }); send({ type: "agent_settled", aborted }); };
// the agent's sky_publish or sky_sync: the runner's own tool, which asks the runner's broker and reports what it said
async function brokered(id, name, args) {
  let out;
  await tool(id, name, args, async () => {
    send({ type: "tool_execution_update", toolCallId: id, toolName: name, args: {}, partialResult: text("") });
    const answer = result(await ask({ kind: "tool", id, tool: name, args }));
    out = answer.text;
    log({ published: answer });
    return answer.text;
  });
  assistant({ content: [{ type: "text", text: out }], usage: usage(1, 1) });
  settle();
}
const scenarios = {
  async bash() {
    // what the command did to the worktree, whatever the command was
    await tool("t1", "bash", { command: process.env.FAKE_PI_COMMAND ?? "touch made.txt" }, async () => {
      writeFileSync("made.txt", "made\n");
      return "listing";
    });
    assistant({ content: [{ type: "text", text: "all done" }], usage: usage(100, 10, { cacheRead: 40, cost: { total: 0.0012 } }) });
    settle();
  },
  async commands() {
    for (const [i, command] of JSON.parse(process.env.FAKE_PI_COMMANDS).entries())
      await tool("t" + i, "bash", { command });
    assistant({ content: [{ type: "text", text: "ok" }], usage: usage(1, 1) });
    settle();
  },
  async edits() {
    await tool("e1", "edit", { path: "README", edits: [{ oldText: "hi", newText: "ho" }] });
    await tool("e2", "write", { path: "/etc/sky-test", content: "x" });
    await tool("e3", "read", { path: "README" });
    assistant({ content: [{ type: "text", text: "edited" }], usage: usage(5, 5) });
    settle();
  },
  async publish() { await brokered("p1", "sky_publish", { title: "T" }); },
  async sync() { await brokered("s1", "sky_sync", {}); },
  // a commit on the agent's branch and an origin GitHub names, which a publish needs before it asks for approval
  async committed() {
    execFileSync("git", ["remote", "set-url", "origin", "https://github.com/acme/widgets.git"]);
    writeFileSync("feature.txt", "x\n");
    execFileSync("git", ["add", "--all"]);
    execFileSync("git", ["commit", "-qm", "add feature"]);
    await brokered("p1", "sky_publish", { title: "T" });
  },
  // dialogs as the extension, or something else in pi, can put to the runner, answered one at a time
  async dialogs() {
    for (const dialog of JSON.parse(process.env.FAKE_PI_DIALOGS))
      await new Promise((resolve) => {
        const id = "ui" + ++n;
        waiting.set(id, resolve);
        send({ type: "extension_ui_request", id, ...dialog });
      });
    assistant({ content: [{ type: "text", text: "asked" }], usage: usage(1, 1) });
    settle();
  },
  async failing() {
    assistant({ content: [], stopReason: "error", errorMessage: process.env.FAKE_PI_ERROR, usage: usage(10, 1) });
    settle();
  },
  async retried() {
    send({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1, errorMessage: process.env.FAKE_PI_RETRY_ERROR });
    send({ type: "auto_retry_end", success: false, finalError: process.env.FAKE_PI_RETRY_ERROR });
    assistant({ content: [], stopReason: "error", errorMessage: "the model call failed", usage: usage(10, 1) });
    settle();
  },
  // a 429 pi got past, by a call that succeeded or a retry that did, then a failure of another kind
  async recovered() {
    send({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1, errorMessage: "429 Too Many Requests" });
    if (process.env.FAKE_PI_RECOVERY === "retry") send({ type: "auto_retry_end", success: true });
    else assistant({ content: [{ type: "text", text: "working" }], usage: usage(1, 1) });
    assistant({ content: [], stopReason: "error", errorMessage: process.env.FAKE_PI_ERROR, usage: usage(10, 1) });
    settle();
  },
  async aborted() { assistant({ content: [], stopReason: "aborted", usage: usage(1, 1) }); settle(true); },
  async hang() { await tool("h1", "bash", { command: "touch hang.txt" }); },
  async quiet() { settle(); },
};
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
    const m = JSON.parse(buffer.slice(0, at));
    buffer = buffer.slice(at + 1);
    log(m);
    if (m.type === "extension_ui_response") { const resolve = waiting.get(m.id); waiting.delete(m.id); resolve?.(m); continue; }
    switch (m.type) {
      case "get_state": send({ id: m.id, type: "response", command: "get_state", success: true, data: { sessionId: flag("--session-id") } }); break;
      case "prompt":
        if (process.env.FAKE_PI_SCENARIO === "handled") { send({ id: m.id, type: "response", command: "prompt", success: true, data: { disposition: "handled" } }); break; }
        send({ id: m.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
        send({ type: "agent_start" });
        setTimeout(() => scenarios[process.env.FAKE_PI_SCENARIO ?? "bash"](), 10);
        break;
      case "abort": send({ id: m.id, type: "response", command: "abort", success: true }); settle(true); break;
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("runPiSession", () => {
  let root: string;
  let config: Config;
  let bin: string;
  let logFile: string;
  let events: RunnerEventPost[];
  // the seal a run gets: starts the process as it is asked to, and records what it was asked
  let spawned: SpawnOptions[];
  let seal: Seal;
  let decide: (request: {
    toolName?: string;
    toolSummary?: string;
  }) => Decision["decision"] | "deny-with-reason" | "expired";

  beforeEach(() => {
    vi.stubEnv("GITHUB_CONNECTOR", undefined);
    root = mkdtempSync(join(tmpdir(), "runner-pi-"));
    mkdirSync(join(root, "os-tmp"));
    vi.stubEnv("TMPDIR", join(root, "os-tmp"));
    mkdirSync(join(root, "home"));
    vi.stubEnv("HOME", join(root, "home"));
    const origin = join(root, "origin");
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
    execFileSync("git", ["clone", "-q", origin, join(root, "repo")]);
    bin = join(root, "fake-pi.mjs");
    writeFileSync(bin, FAKE_PI);
    writeGatewayCatalog(root, { [DEFAULT_PI_MODEL]: flashEntry });
    logFile = join(root, "pi.log");
    events = [];
    spawned = [];
    seal = {
      problem: undefined,
      spawn: (options) => {
        spawned.push(options);
        return spawn(options.command, options.args, {
          cwd: options.cwd,
          env: options.env,
          stdio: ["pipe", "pipe", "pipe"],
        }) as ReturnType<Seal["spawn"]>;
      },
      check: () => undefined,
    };
    decide = () => "approve";
    config = {
      runtime: "pi",
      agentId: "agt_1",
      runId: "run_1",
      prompt: "make a file",
      sessionId: undefined,
      apiBaseUrl: "https://api.test",
      agentToken: "agent-secret",
      claudeAuth: "oauth",
      repoDir: join(root, "repo"),
      worktreesDir: join(root, "worktrees"),
      approvalPolicy: ["Bash", "Edit", "Write"],
      autoApprove: { defaults: true, commands: [] },
      sessionEnv: {
        FAKE_PI_LOG: logFile,
        FAKE_PI_SCENARIO: "bash",
        SKY_PI_HOME: join(root, "pi-home"),
        PROJECT_SECRET: "project-secret",
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
      checks: [],
      mcpServers: {},
      waitTimeoutMs: 60_000,
      launchDeadlineMs: 15 * 60_000,
      storeHome: undefined,
      startBranch: undefined,
    };
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  const post: PostEvent = async (event) => {
    events.push(event);
  };
  const awaitDecision: AwaitDecision = async (id) => {
    const requestId = id as RequestId;
    const waiting = events.find(
      (e) =>
        e.type === "run.waiting" && e.payload.request.requestId === requestId,
    );
    const request =
      waiting?.type === "run.waiting" ? waiting.payload.request : undefined;
    const verdict = decide(request && "toolName" in request ? request : {});
    if (verdict === "expired") return { kind: "expired" };
    if (verdict === "deny-with-reason")
      return {
        kind: "decided",
        decision: { requestId, decision: "deny", reason: "not that file" },
      };
    if (verdict === "deny")
      return { kind: "decided", decision: { requestId, decision: "deny" } };
    return { kind: "decided", decision: { requestId, decision: "approve" } };
  };
  const depsOf = (over: Partial<Parameters<typeof runPiSession>[1]> = {}) => ({
    post,
    awaitDecision,
    signal: new AbortController().signal,
    warn: () => {},
    gatewayEnv: { AI_GATEWAY_API_KEY: "gw-key" },
    seal,
    bin,
    stopGraceMs: 2_000,
    ...over,
  });
  const run = (scenario?: string, over?: Parameters<typeof depsOf>[0]) => {
    if (scenario) config.sessionEnv.FAKE_PI_SCENARIO = scenario;
    return runPiSession(config, depsOf(over));
  };
  const sent = () =>
    readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Logged);
  const started = () => sent().find((m) => m.start) as Logged;
  const ofType = <T extends RunnerEventPost["type"]>(type: T) =>
    events.filter(
      (e): e is Extract<RunnerEventPost, { type: T }> => e.type === type,
    );
  const answers = () => sent().filter((m) => m.answered);

  test("starts pi on the gateway through the seal, with the proxy's token and not the key, and reports the run", async () => {
    // each credential where its withdrawal acts: the runner's env, and the session's
    config.sessionEnv.AI_GATEWAY_API_KEY = "gw-key";
    vi.stubEnv("AGENT_TOKEN", "event-token");
    vi.stubEnv("GITHUB_CONNECTOR", "connector-id");
    config.sessionEnv.GITHUB_GATEWAY_URL = "https://gateway.test/github";
    expect(await run()).toBe(0);
    expect(spawned).toHaveLength(1);
    const options = spawned[0];
    expect(options).toMatchObject({
      command: process.execPath,
      name: "pi",
      cwd: join(root, "worktrees", "agt_1"),
    });
    expect(options?.args.slice(0, 7)).toEqual([
      realpathSync(bin),
      "--mode",
      "rpc",
      "--provider",
      PI_PROVIDER,
      "--model",
      DEFAULT_PI_MODEL,
    ]);
    expect(options?.env.SKY_PI_GATEWAY_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    // pi from npm finds its own files: only a compiled pi is told where its package is
    expect(options?.env.PI_PACKAGE_DIR).toBeUndefined();
    for (const name of [
      "AI_GATEWAY_API_KEY",
      "AGENT_TOKEN",
      "GITHUB_CONNECTOR",
      "GITHUB_GATEWAY_URL",
    ])
      expect(options?.env[name]).toBeUndefined();
    // the project's own secrets are pi's, and its commands', as Claude Code's commands get them
    expect(started().env).toMatchObject({
      token: options?.env.SKY_PI_GATEWAY_TOKEN,
      secret: "project-secret",
      offline: "1",
    });
    // pi never saw the key, the event token or the connector (the log drops what is undefined)
    expect(started().env).not.toHaveProperty("key");
    expect(started().env).not.toHaveProperty("agentToken");
    expect(started().env).not.toHaveProperty("connector");
    expect(started().env).not.toHaveProperty("gatewayUrl");
    expect(started().env.agentDir).toBe(join(root, "pi-home", "agent"));
    expect(ofType("run.started")[0]?.payload.sessionId).toMatch(
      /^[0-9a-f-]{36}$/,
    );
    const finished = ofType("run.finished")[0]?.payload;
    expect(finished?.summary).toBe("all done");
    // every prompt token counts, and the cost is pi's own estimate
    expect(finished?.usage).toMatchObject({
      inputTokens: 140,
      outputTokens: 10,
      costUsd: 0.0012,
      turns: 1,
    });
    expect(ofType("claude.Message").map((e) => e.payload.text)).toEqual([
      "all done",
    ]);
  });

  test("loads only what the runner names, from a session in the run's own directories", async () => {
    expect(await run()).toBe(0);
    const { argv } = started();
    const at = (flag: string) => argv[argv.indexOf(flag) + 1];
    for (const flag of [
      "--no-extensions",
      "--no-approve",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-mcp",
    ])
      expect(argv).toContain(flag);
    expect(argv).not.toContain("--no-session");
    expect(at("--session-dir")).toBe(join(root, "pi-home", "sessions"));
    expect(at("--extension")).toMatch(/sky-pi-extension\.mjs$/);
    expect(argv).not.toContain("builtin:mcp");
    expect(started().settings).toMatchObject({
      packages: [],
      extensions: [],
      skills: [],
      defaultProjectTrust: "never",
    });
    expect(started().extension).toContain("registerProvider");
    expect(started().extension).not.toMatch(/[0-9a-f]{64}/);
    // the file on disk holds neither the key nor the per-run token pi reads from its env
    const proxyToken = spawned[0]?.env.SKY_PI_GATEWAY_TOKEN;
    expect(proxyToken).toMatch(/^[0-9a-f]{64}$/);
    expect(started().extension).not.toContain("gw-key");
    expect(started().extension).not.toContain(proxyToken as string);
    expect(started().instructions).toContain("no subagents");
  });

  test("a model and skill directories the environment names are passed on", async () => {
    mkdirSync(join(root, "skills/one"), { recursive: true });
    mkdirSync(join(root, "home/.sky/pi/skills"), { recursive: true });
    mkdirSync(join(root, "home/.sky/pi/skills2"), { recursive: true });
    config.piModel = "openai/gpt-5.4-mini";
    config.piSkills = [
      join(root, "skills/one"),
      "~/.sky/pi/skills",
      "$HOME/.sky/pi/skills2",
      join(root, "skills/gone"),
    ];
    const warnings: string[] = [];
    expect(await run(undefined, { warn: (l) => warnings.push(l) })).toBe(0);
    const { argv } = started();
    expect(argv[argv.indexOf("--model") + 1]).toBe("openai/gpt-5.4-mini");
    const skills = argv.flatMap((a: string, i: number) =>
      a === "--skill" ? [argv[i + 1]] : [],
    );
    expect(skills).toEqual([
      join(root, "skills/one"),
      join(root, "home/.sky/pi/skills"),
      join(root, "home/.sky/pi/skills2"),
    ]);
    expect(warnings.join("\n")).toMatch(
      /skill directory .*gone is not there; skipped/,
    );
    expect(
      ofType("runner.warning")
        .map((e) => e.payload.message)
        .join("\n"),
    ).toMatch(/gone is not there/);
  });

  /** The model entry the run's extension registers, read back from the source pi was started with. */
  const registeredSpec = () => {
    const line = /^const config = (.*);$/m.exec(started().extension)?.[1];
    return (JSON.parse(line ?? "{}") as Logged).spec;
  };

  test("tells pi the model's prices and limits from the gateway catalog pi ships", async () => {
    expect(await run()).toBe(0);
    expect(registeredSpec()).toEqual({
      cost: { input: 0.3, output: 1.2, cacheRead: 0.007, cacheWrite: 0 },
      contextWindow: 1048576,
      maxTokens: 262144,
    });
    expect(ofType("runner.warning")).toEqual([]);
  });

  test.each([
    [
      "a model the catalog doesn't list",
      () => {
        config.piModel = "x/unlisted";
      },
    ],
    [
      "no catalog beside pi",
      () => rmSync(join(root, "node_modules"), { recursive: true }),
    ],
  ])("%s runs on the fallback limits, with one warning", async (_, arrange) => {
    arrange();
    expect(await run()).toBe(0);
    expect(registeredSpec()).toEqual(FALLBACK_PI_MODEL_SPEC);
    expect(ofType("runner.warning")).toHaveLength(1);
  });

  test("the base profile's MCP servers reach pi through the run's mcp.json, as references", async () => {
    config.mcpServers = {
      doop: { command: "npx", args: ["doop"], env: { API_KEY: "DOOP_KEY" } },
      lost: { command: "x", args: [], env: { K: "NOT_SET" } },
    };
    config.sessionEnv.DOOP_KEY = "doop-secret";
    expect(await run()).toBe(0);
    const { argv, mcp } = started();
    expect(argv).not.toContain("--no-mcp");
    // Sky's extension loads first: it clears the gateway token from pi's env before any MCP server starts
    const extensions = argv.flatMap((a: string, i: number) =>
      a === "--extension" ? [argv[i + 1]] : [],
    );
    expect(extensions).toEqual([
      expect.stringMatching(/sky-pi-extension\.mjs$/),
      "builtin:mcp",
    ]);
    expect(mcp).toEqual({
      mcpServers: {
        doop: {
          command: "npx",
          args: ["doop"],
          env: { API_KEY: ref("DOOP_KEY") },
          exposure: "direct",
        },
      },
    });
    expect(JSON.stringify(mcp)).not.toContain("doop-secret");
    expect(
      ofType("runner.warning")
        .map((e) => e.payload.message)
        .join("\n"),
    ).toMatch(/lost \(NOT_SET\)/);
  });

  test("a run starts from a clean agent directory: what an earlier run left there never reaches pi", async () => {
    const agent = join(root, "pi-home/agent");
    mkdirSync(join(agent, "extensions"), { recursive: true });
    mkdirSync(join(agent, "bin"), { recursive: true });
    for (const name of [
      "auth.json",
      "models.json",
      "AGENTS.md",
      "trust.json",
      "extensions/evil.mjs",
      "bin/git",
    ])
      writeFileSync(join(agent, name), '{"planted":true}');
    writeFileSync(join(agent, "settings.json"), '{"packages":["npm:evil"]}');
    expect(await run()).toBe(0);
    // pi started with exactly what Sky writes, and Sky's own settings, not the planted ones
    expect(started().agentFiles).toEqual(["settings.json"]);
    expect(started().settings).toMatchObject({
      packages: [],
      defaultProjectTrust: "never",
    });
    for (const name of [
      "auth.json",
      "models.json",
      "AGENTS.md",
      "bin",
      "extensions",
    ])
      expect(existsSync(join(agent, name))).toBe(false);
  });

  test("a follow-up still resumes its session: sessions live beside the agent directory", async () => {
    config.sessionId = "sess-keep";
    expect(await run()).toBe(0);
    expect(started().resumed).toBe(false);
    const agent = join(root, "pi-home/agent");
    writeFileSync(join(agent, "auth.json"), "{}");
    writeFileSync(join(agent, "models.json"), "{}");
    rmSync(logFile);
    events = [];
    expect(await run()).toBe(0);
    expect(started().resumed).toBe(true);
    expect(started().agentFiles).toEqual(["settings.json"]);
    expect(ofType("run.started")[0]?.payload.sessionId).toBe("sess-keep");
  });

  test("an agent directory that is a link is replaced, and what it pointed at is left alone", async () => {
    const target = join(root, "precious");
    mkdirSync(target);
    writeFileSync(join(target, "keep.txt"), "k");
    mkdirSync(join(root, "pi-home"), { recursive: true });
    symlinkSync(target, join(root, "pi-home/agent"));
    expect(await run()).toBe(0);
    expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("k");
    expect(started().agentFiles).toEqual(["settings.json"]);
    expect(realpathSync(join(root, "pi-home/agent"))).toBe(
      join(realpathSync(root), "pi-home/agent"),
    );
  });

  test("an mcp.json from an earlier run is gone when this run has no servers", async () => {
    mkdirSync(join(root, "pi-home/agent"), { recursive: true });
    writeFileSync(join(root, "pi-home/agent/mcp.json"), "{}");
    expect(await run()).toBe(0);
    expect(started().mcp).toBeNull();
    expect(existsSync(join(root, "pi-home/agent/mcp.json"))).toBe(false);
  });

  test("a command no policy pattern holds runs without asking", async () => {
    config.approvalPolicy = ["Edit"];
    expect(await run()).toBe(0);
    expect(ofType("run.waiting")).toEqual([]);
    expect(answers()[0]?.answer).toEqual({ allow: true });
    expect(ofType("claude.PreToolUse")[0]?.payload).toMatchObject({
      toolName: "Bash",
      toolUseId: "t1",
    });
  });

  test("a read-only command self-approves with the note, and asks no one", async () => {
    config.sessionEnv.FAKE_PI_COMMAND = "git status";
    expect(await run()).toBe(0);
    expect(ofType("run.waiting")).toEqual([]);
    expect(ofType("claude.PreToolUse")[0]?.payload.autoApproved).toMatchObject({
      verdict: "approved",
    });
  });

  test("a write through a link out of the worktree is held, and the same write in a directory of its own self-approves", async () => {
    const origin = join(root, "origin");
    mkdirSync(join(root, "outside"));
    symlinkSync(join(root, "outside"), join(origin, "out"));
    mkdirSync(join(origin, "inside"));
    writeFileSync(join(origin, "inside/.keep"), "");
    git(origin, "add", ".");
    git(
      origin,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-qm",
      "link",
    );
    git(config.repoDir, "fetch", "-q", "origin");
    config.sessionEnv.FAKE_PI_COMMANDS = JSON.stringify([
      "mkdir -p out/x",
      "mkdir -p inside/x",
    ]);
    expect(await run("commands")).toBe(0);
    const asked = ofType("run.waiting").map((e) => e.payload.request);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      toolName: "Bash",
      toolSummary: "mkdir -p out/x",
    });
    const inside = ofType("claude.PreToolUse").find(
      (e) => e.payload.toolUseId === "t1",
    );
    expect(inside?.payload.autoApproved).toMatchObject({ verdict: "approved" });
  });

  test("a held command opens one approval with the real command, and runs when approved", async () => {
    expect(await run()).toBe(0);
    const waiting = ofType("run.waiting");
    expect(waiting).toHaveLength(1);
    expect(waiting[0]?.payload.request).toMatchObject({
      kind: "approval",
      toolName: "Bash",
      toolSummary: "touch made.txt",
      toolInput: JSON.stringify({ command: "touch made.txt" }),
    });
    expect(answers()[0]?.answer).toEqual({ allow: true });
    expect(ofType("claude.PreToolUse")[0]?.payload).toMatchObject({
      toolName: "Bash",
      toolUseId: "t1",
    });
    expect(ofType("claude.PostToolUse")[0]?.payload).toMatchObject({
      toolName: "Bash",
      output: "listing",
      durationMs: 7,
    });
  });

  test("a denial blocks the call, and its reason goes back to the model", async () => {
    decide = () => "deny-with-reason";
    expect(await run()).toBe(0);
    expect(answers()[0]?.answer).toEqual({
      allow: false,
      reason: "not that file",
    });
    const failure = ofType("claude.PostToolUseFailure")[0]?.payload;
    expect(failure).toMatchObject({ toolName: "Bash", error: "not that file" });
    // the call is reported, as a call that failed, once it ends: as Codex's declined ones are
    expect(ofType("claude.PreToolUse").map((e) => e.payload.toolName)).toEqual([
      "Bash",
    ]);
  });

  test("a denial with no reason says the person declined", async () => {
    decide = () => "deny";
    expect(await run()).toBe(0);
    expect(answers()[0]?.answer).toEqual({
      allow: false,
      reason: "The person declined this call.",
    });
  });

  test.each([
    "sudo -u deploy touch made.txt && git push",
    "bash -lc 'git push'",
    "env A=1 git push",
  ])("a pattern naming git push holds %s", async (command) => {
    config.approvalPolicy = ["Bash(git push:*)"];
    config.sessionEnv.FAKE_PI_COMMAND = command;
    expect(await run()).toBe(0);
    expect(ofType("run.waiting")).toHaveLength(1);
  });

  test("edits and writes are held as the policy holds them; a change outside the worktree is held whatever it says; reads are not asked", async () => {
    config.approvalPolicy = ["Edit"];
    expect(await run("edits")).toBe(0);
    const asked = ofType("run.waiting").map((e) => e.payload.request);
    expect(asked).toHaveLength(2);
    expect(asked[0]).toMatchObject({
      toolName: "Edit",
      toolSummary: join(root, "worktrees", "agt_1", "README"),
    });
    expect(asked[1]).toMatchObject({
      toolName: "Write",
      toolSummary: "/etc/sky-test",
    });
    // the read ran with its event and no question
    expect(
      ofType("claude.PreToolUse").map((e) => e.payload.toolName),
    ).toContain("Read");
    expect(answers().map((m) => m.answered)).toEqual(["e1", "e2"]);
  });

  test("sky_publish without the connector sends nothing and says why, and asks no approval of its own", async () => {
    expect(await run("publish")).toBe(0);
    const published = sent().find((m) => m.published)?.published;
    expect(published.success).toBe(false);
    expect(published.text).toMatch(/GitHub connector/);
    expect(ofType("run.waiting")).toEqual([]);
    // run unasked, with its event, as the runner's own tool
    expect(ofType("claude.PreToolUse")[0]?.payload.toolName).toBe(
      "sky_publish",
    );
    expect(ofType("claude.PostToolUseFailure")).toEqual([]);
  });

  test("the extension carries the runner's tools only when the run has a connector", async () => {
    expect(await run()).toBe(0);
    expect(started().extension).toContain('"tools":[]');
    events = [];
    rmSync(logFile);
    expect(
      await run(undefined, {
        connector: { GITHUB_CONNECTOR: "connector-secret" },
      }),
    ).toBe(0);
    expect(started().extension).toContain('"name":"sky_publish"');
    expect(started().extension).toContain('"name":"sky_sync"');
    expect(started().extension).not.toContain("connector-secret");
  });

  test("a resumed run with a connector still gets sky_publish and sky_sync", async () => {
    config.sessionId = "sess-7";
    expect(
      await run(undefined, {
        connector: { GITHUB_CONNECTOR: "connector-secret" },
      }),
    ).toBe(0);
    const { argv, extension } = started();
    expect(argv[argv.indexOf("--session-id") + 1]).toBe("sess-7");
    expect(extension).toContain('"name":"sky_publish"');
    expect(extension).toContain('"name":"sky_sync"');
  });

  const connector = {
    GITHUB_CONNECTOR: "conn_1",
    GITHUB_GATEWAY_URL: "https://gateway.test/v1/gateway/github",
  };

  test("an approved sky_sync opens one Sync approval and is run by the runner", async () => {
    expect(await run("sync", { connector })).toBe(0);
    const asked = ofType("run.waiting").map((e) => e.payload.request);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ kind: "approval", toolName: "Sync" });
    // the fixture's origin is a local path: sync, past its approval, stops at reading it, before any call to GitHub
    const reply = sent().find((m) => m.published)?.published;
    expect(reply.success).toBe(false);
    expect(reply.text).toMatch(/sky sync: origin is not a GitHub repo/);
  });

  test("an approved sky_publish opens one Publish approval and goes on to GitHub", async () => {
    const baseSha = git(join(root, "repo"), "rev-parse", "origin/main");
    const repo =
      "https://gateway.test/v1/gateway/github/conn_1/repos/acme/widgets";
    server.use(
      http.get(repo, () => HttpResponse.json({ full_name: "acme/widgets" })),
      http.get(`${repo}/pulls`, () => HttpResponse.json([])),
      http.get(`${repo}/git/ref/heads/main`, () =>
        HttpResponse.json({ object: { sha: baseSha } }),
      ),
      // the first call past the approval: refused, which ends the publish
      http.get(`${repo}/git/ref/heads/claude/agt_1`, () =>
        HttpResponse.json({ message: "stop here" }, { status: 422 }),
      ),
    );
    expect(await run("committed", { connector })).toBe(0);
    const asked = ofType("run.waiting").map((e) => e.payload.request);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      kind: "approval",
      toolName: "Publish",
      toolInput: expect.stringContaining("add feature"),
    });
    const reply = sent().find((m) => m.published)?.published;
    expect(reply.success).toBe(false);
    expect(reply.text).toMatch(/git\/ref\/heads\/claude\/agt_1 returned 422/);
  });

  test("a declined sky_sync is not run, and says why", async () => {
    decide = () => "deny-with-reason";
    expect(await run("sync", { connector })).toBe(0);
    expect(ofType("run.waiting")).toHaveLength(1);
    const reply = sent().find((m) => m.published)?.published;
    expect(reply.success).toBe(false);
    expect(reply.text).toMatch(/not that file; nothing was sent/);
    expect(reply.text).not.toMatch(/origin is not a GitHub repo/);
  });

  test("requests the runner can't read, or doesn't serve, block rather than run", async () => {
    const call = {
      kind: "call",
      id: "c1",
      tool: "bash",
      input: { command: "x" },
    };
    const tool = (name: string, args: object) => ({
      kind: "tool",
      id: name,
      tool: name,
      args,
    });
    const dialogs = [
      // not the extension's: pi asking a person at a terminal
      { method: "input", title: "What is your name?" },
      // the extension's request, put as a dialog it doesn't use
      { method: "confirm", title: `sky:${JSON.stringify(call)}` },
      { method: "input", title: "sky:{not json" },
      { method: "input", title: 'sky:{"kind":"nope"}' },
      {
        method: "input",
        title: `sky:${JSON.stringify(tool("sky_deploy", {}))}`,
      },
      {
        method: "input",
        title: `sky:${JSON.stringify(tool("sky_publish", { title: "" }))}`,
      },
      {
        method: "input",
        title: `sky:${JSON.stringify(tool("sky_sync", { branch: "" }))}`,
      },
    ];
    config.sessionEnv.FAKE_PI_DIALOGS = JSON.stringify(dialogs);
    const warnings: string[] = [];
    expect(
      await run("dialogs", { connector, warn: (l) => warnings.push(l) }),
    ).toBe(0);
    const replies = sent().filter((m) => m.type === "extension_ui_response");
    expect(replies.map((r) => r.cancelled === true)).toEqual([
      true,
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
    expect(JSON.parse(replies[4]?.value)).toEqual({
      text: "No tool named sky_deploy here.",
      success: false,
    });
    for (const reply of [replies[5], replies[6]])
      expect(JSON.parse(reply?.value)).toEqual({
        text: expect.stringMatching(/^Invalid arguments: /),
        success: false,
      });
    // nothing was asked of a person, and the two unreadable requests were reported
    expect(ofType("run.waiting")).toEqual([]);
    expect(warnings.filter((l) => /unreadable request/.test(l))).toHaveLength(
      2,
    );
  });

  test("publish and sync check the seal each time they are asked for", async () => {
    let checks = 0;
    // sound at pi's start, readable by the time the agent asks to publish
    seal = { ...seal, check: () => (checks++ === 0 ? undefined : "readable") };
    expect(
      await run("publish", {
        connector: { GITHUB_CONNECTOR: "connector-secret" },
      }),
    ).toBe(0);
    const published = sent().find((m) => m.published)?.published;
    expect(published.success).toBe(false);
    expect(published.text).toMatch(
      /sky publish refused: the runner can't confirm.*readable.*nothing was sent/,
    );
  });

  test("what the environment's refresh script did rides run.started", async () => {
    const refresh = { outcome: "ran", exitCode: 0, durationMs: 12 } as const;
    expect(await run(undefined, { envRefresh: refresh })).toBe(0);
    expect(ofType("run.started")[0]?.payload.refresh).toEqual(refresh);
    events = [];
    expect(await run()).toBe(0);
    expect(ofType("run.started")[0]?.payload).not.toHaveProperty("refresh");
  });

  test("the run's pi home is SKY_PI_HOME, else under HOME", () => {
    expect(piHomeOf({ SKY_PI_HOME: "/p", HOME: "/h" })).toBe("/p");
    expect(piHomeOf({ HOME: "/h" })).toBe("/h/.sky/pi");
  });

  test("resumes the session it is given, and reports it", async () => {
    config.sessionId = "sess-7";
    expect(await run()).toBe(0);
    const { argv } = started();
    expect(argv[argv.indexOf("--session-id") + 1]).toBe("sess-7");
    expect(ofType("run.started")[0]?.payload.sessionId).toBe("sess-7");
    expect(ofType("runner.warning")).toEqual([]);
  });

  test("a session pi doesn't have is a fresh one, and the run says so", async () => {
    config.sessionId = "gone-1";
    config.sessionEnv.FAKE_PI_LOST_SESSION = "1";
    expect(await run()).toBe(0);
    expect(ofType("runner.warning")[0]?.payload.message).toMatch(
      /no session gone-1 to resume/,
    );
  });

  test("a model call that fails fails the run with the model's error", async () => {
    config.sessionEnv.FAKE_PI_ERROR = "context window exceeded";
    expect(await run("failing")).toBe(1);
    expect(ofType("run.failed")[0]?.payload.error).toBe(
      "context window exceeded",
    );
    expect(ofType("run.finished")).toEqual([]);
  });

  test("a call the gateway refuses for credit fails as pi_unavailable, quoting pi", async () => {
    config.sessionEnv.FAKE_PI_ERROR =
      "402 Payment Required: insufficient credits";
    expect(await run("failing")).toBe(1);
    expect(ofType("run.failed")[0]?.payload.error).toBe(
      "pi_unavailable: the AI Gateway is out of credit (pi said: 402 Payment Required: insufficient credits)",
    );
  });

  test("retries that gave up on 429s fail as rate-limited", async () => {
    config.sessionEnv.FAKE_PI_RETRY_ERROR = "429 Too Many Requests";
    expect(await run("retried")).toBe(1);
    expect(ofType("run.failed")[0]?.payload.error).toMatch(
      /^pi_unavailable: the AI Gateway rate-limited this run \(pi said: the model call failed\)$/,
    );
    expect(
      ofType("runner.warning")
        .map((e) => e.payload.message)
        .join("\n"),
    ).toMatch(/pi is retrying \(1\/3\): 429/);
  });

  test.each([
    ["a model call that succeeded", "call"],
    ["a retry that succeeded", "retry"],
  ])(
    "a 429 pi got past by %s doesn't name a later failure of another kind",
    async (_, recovery) => {
      config.sessionEnv.FAKE_PI_RECOVERY = recovery;
      config.sessionEnv.FAKE_PI_ERROR = "context window exceeded";
      expect(await run("recovered")).toBe(1);
      expect(ofType("run.failed")[0]?.payload.error).toBe(
        "context window exceeded",
      );
    },
  );

  test("a 402 after a 429 pi got past is still out of credit", async () => {
    config.sessionEnv.FAKE_PI_ERROR =
      "402 Payment Required: insufficient credits";
    expect(await run("recovered")).toBe(1);
    expect(ofType("run.failed")[0]?.payload.error).toMatch(
      /^pi_unavailable: the AI Gateway is out of credit/,
    );
  });

  test("a bare failure after the proxy saw a 402 is out of credit", async () => {
    config.sessionEnv.FAKE_PI_ERROR = "the model call failed";
    const ran = await run("failing", {
      startProxy: async () => ({
        baseUrl: "http://127.0.0.1:9/v1",
        token: "t".repeat(64),
        close: async () => {},
        limitStatus: () => 402,
      }),
    });
    expect(ran).toBe(1);
    expect(ofType("run.failed")[0]?.payload.error).toMatch(
      /^pi_unavailable: the AI Gateway is out of credit/,
    );
  });

  test("a failure the gateway didn't cause keeps pi's own error, even after a 402", async () => {
    // the proxy's latest answer was a 402, but the run stopped for another reason
    const controller = new AbortController();
    const ran = run("hang", {
      signal: controller.signal,
      startProxy: async () => ({
        baseUrl: "http://127.0.0.1:9/v1",
        token: "t".repeat(64),
        close: async () => {},
        limitStatus: () => 402,
      }),
    });
    await vi.waitFor(() => expect(ofType("run.waiting")).toHaveLength(1));
    controller.abort("SIGTERM");
    expect(await ran).toBe(1);
    expect(ofType("run.failed")[0]?.payload.error).toBe(
      "interrupted by SIGTERM",
    );
  });

  test("an aborted turn nobody stopped fails the run", async () => {
    expect(await run("aborted")).toBe(1);
    expect(ofType("run.failed")[0]?.payload.error).toBe("the turn was aborted");
  });

  test("pi exiting before it is ready fails the run with what it said", async () => {
    expect(await run("exit-early")).toBe(1);
    const error = ofType("run.failed")[0]?.payload.error ?? "";
    expect(error).toMatch(/^pi exited \(3\): Error: model not found$/);
    expect(ofType("run.started")).toEqual([]);
  });

  test("a prompt pi handled without running the agent fails the run", async () => {
    expect(await run("handled")).toBe(1);
    expect(ofType("run.failed")[0]?.payload.error).toMatch(
      /handled the prompt/,
    );
  });

  test("a stop aborts pi and fails the run, and a call waiting on a person ends", async () => {
    const controller = new AbortController();
    // the decision never comes before the stop, which ends the wait as the API's long-poll ends
    const ran = run("hang", {
      signal: controller.signal,
      awaitDecision: (_id, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    });
    await vi.waitFor(() => expect(ofType("run.waiting")).toHaveLength(1));
    controller.abort("SIGTERM");
    expect(await ran).toBe(1);
    expect(sent().some((m) => m.type === "abort")).toBe(true);
    expect(ofType("run.failed")[0]?.payload.error).toBe(
      "interrupted by SIGTERM",
    );
    // the open request was withdrawn, and pi's blocked call was answered so it could end
    expect(ofType("run.withdrawn")).toHaveLength(1);
    expect(sent().some((m) => m.type === "extension_ui_response")).toBe(true);
  });

  test("a decision that never comes fails the run at the wait timeout, not never", async () => {
    decide = () => "expired";
    expect(await run("hang")).toBe(1);
    expect(ofType("run.failed")[0]?.payload.error).toBe("waiting_timeout");
    // pi was told to stop, and its blocked call was answered
    expect(sent().some((m) => m.type === "abort")).toBe(true);
  });

  test("the run's proxy gets the key and the gateway's OpenAI path, and closes when the run ends", async () => {
    let closed = false;
    const given: { upstream?: string; key?: string } = {};
    const ran = await runPiSession(
      config,
      depsOf({
        startProxy: async (options) => {
          given.upstream = options.upstream;
          given.key = options.key;
          return {
            baseUrl: "http://127.0.0.1:9/v1",
            token: "t".repeat(64),
            close: async () => {
              closed = true;
            },
          };
        },
      }),
    );
    expect(ran).toBe(0);
    expect(given).toEqual({
      upstream: "https://ai-gateway.vercel.sh/v1",
      key: "gw-key",
    });
    expect(spawned[0]?.env.SKY_PI_GATEWAY_TOKEN).toBe("t".repeat(64));
    expect(started().extension).toContain('"baseUrl":"http://127.0.0.1:9/v1"');
    expect(closed).toBe(true);
  });

  test("a run with no gateway key fails before pi starts", async () => {
    expect(await run(undefined, { gatewayEnv: {} })).toBe(1);
    expect(ofType("run.failed")[0]?.payload.error).toMatch(
      /AI_GATEWAY_API_KEY is not set/,
    );
    expect(spawned).toEqual([]);
  });

  test("a runner that can't be hidden fails the run before anything starts", async () => {
    seal = { ...seal, problem: "the runner can't change its effective user" };
    expect(await run()).toBe(1);
    expect(ofType("run.failed")[0]?.payload.error).toMatch(
      /^credential_exposed: Sky can't keep its AI Gateway key from this repo's commands \(the runner can't change/,
    );
    expect(spawned).toEqual([]);
    expect(ofType("run.started")).toEqual([]);
  });

  test("a pi process the kernel leaves readable stops the run", async () => {
    seal = {
      ...seal,
      check: () => "the kernel lets the repo's commands read pi's environment",
    };
    expect(await run()).toBe(1);
    expect(ofType("run.failed")[0]?.payload.error).toMatch(
      /^credential_exposed: .*read pi's environment.*the run was stopped/,
    );
    expect(ofType("run.started")).toEqual([]);
  });

  test("the scratch directory, with the extension in it, is gone when the run ends", async () => {
    expect(await run()).toBe(0);
    const extension = started().argv[
      started().argv.indexOf("--extension") + 1
    ] as string;
    expect(existsSync(extension)).toBe(false);
  });

  test("what the run changed in the worktree is committed on the agent's branch when it ends", async () => {
    expect(await run()).toBe(0);
    const worktree = join(root, "worktrees", "agt_1");
    expect(git(worktree, "status", "--porcelain")).toBe("");
    expect(git(worktree, "log", "-1", "--format=%s", "claude/agt_1")).toBe(
      "agent agt_1 run run_1",
    );
    expect(
      git(worktree, "show", "--name-only", "--format=", "claude/agt_1"),
    ).toBe("made.txt");
    const rollup = ofType("run.finished")[0]?.payload.rollup;
    expect(rollup?.run.files).toBe(1);
    expect(rollup?.run.commits.map((c) => c.subject)).toEqual([
      "agent agt_1 run run_1",
    ]);
  });
});
