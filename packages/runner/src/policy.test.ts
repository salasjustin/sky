import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AutoApprove, AutoApproveScope } from "@sky/shared";
import { afterEach, describe, expect, test } from "vitest";
import { matchesPolicy, policyOutcome } from "./policy.js";

test.each([
  // pattern, tool, input, held
  ["Bash", "Bash", { command: "ls" }, true],
  ["Bash", "Read", { file_path: "a.ts" }, false],
  ["Bash", "BashOutput", {}, false],
  ["Bash(git push:*)", "Bash", { command: "git push origin main" }, true],
  ["Bash(git push:*)", "Bash", { command: "git push" }, true],
  ["Bash(git push:*)", "Bash", { command: "git status" }, false],
  ["Bash(git push:*)", "Bash", { command: "cd repo && git push" }, true],
  ["Bash(git push:*)", "Bash", { command: "make; git push -f" }, true],
  ["Bash(git push:*)", "Bash", { command: "echo 'git push'" }, false],
  ["Bash(npm test)", "Bash", { command: "npm test" }, true],
  ["Bash(npm test)", "Bash", { command: "npm test -- --watch" }, false],
  ["Bash(git push:*)", "Write", { file_path: "git push" }, false],
  ["Write(infra/:*)", "Write", { file_path: "infra/main.tf" }, true],
  ["Write(infra/:*)", "Write", { file_path: "src/infra/main.tf" }, false],
  ["Edit(.env)", "Edit", { file_path: ".env" }, true],
  [
    "NotebookEdit(nb/:*)",
    "NotebookEdit",
    { notebook_path: "nb/a.ipynb" },
    true,
  ],
  ["Bash(git push:*)", "Bash", {}, false],
] as const)("%s on %s %j → %s", (pattern, tool, input, held) => {
  expect(matchesPolicy([pattern], tool, input)).toBe(held);
});

test("an empty policy holds nothing", () => {
  expect(matchesPolicy([], "Bash", { command: "rm -rf /" })).toBe(false);
});

test("any one matching pattern holds the call", () => {
  expect(
    matchesPolicy(["Read", "Bash(git push:*)"], "Bash", {
      command: "git push",
    }),
  ).toBe(true);
});

describe("read-only Bash commands skip a bare Bash hold", () => {
  const root = "/workspace/worktrees/agt_1";
  const on: AutoApprove = { defaults: true, commands: [] };
  const outcome = (
    policy: string[],
    command: string,
    autoApprove = on,
    scope: AutoApproveScope = { root },
    tool = "Bash",
  ) => policyOutcome(policy, autoApprove, scope, tool, { command });

  test.each([
    ["git status", "auto-approved"],
    ["grep -n foo src/a.ts", "auto-approved"],
    ["pnpm -r test", "auto-approved"],
    ["cat ../x", "hold"],
    ["grep x; rm -rf /", "hold"],
    ["cat ~/.claude/.credentials.json", "hold"],
    ["ls $(rm x)", "hold"],
    ["git push origin main", "hold"],
    ["rm -rf /", "hold"],
  ])("Bash policy, %s → %s", (command, expected) => {
    expect(outcome(["Bash"], command)).toBe(expected);
  });

  test.each([
    // chained read-only commands as agents write them
    ["git status -sb | head -3", "auto-approved"],
    ["cd packages/x && grep -n foo bar.ts", "auto-approved"],
    ["ls a; cat b", "auto-approved"],
    ["wc -l {a,b}.ts", "auto-approved"],
    ["git log --oneline 2>&1 | grep fix | sort | uniq -c", "auto-approved"],
    ["git diff --stat || git status", "auto-approved"],
    // any step that isn't read-only holds the whole command
    ["git status && git push", "hold"],
    ["git push; git status", "hold"],
    ["cat a | sh", "hold"],
    ["cat a | xargs rm", "hold"],
    ["cat a | tee b", "hold"],
    ["git status > out.txt", "hold"],
    ["git status 2> err.txt", "hold"],
    ["cd .. && ls", "hold"],
    ["cd packages/x && cat .env", "hold"],
    ["ls & rm x", "hold"],
  ])("Bash policy, compound %s → %s", (command, expected) => {
    expect(outcome(["Bash"], command)).toBe(expected);
  });

  test("relative paths resolve against the shell's cwd, contained by the worktree root", () => {
    expect(
      outcome(["Bash"], "cat ../README", on, { root, cwd: `${root}/src` }),
    ).toBe("auto-approved");
    expect(
      outcome(["Bash"], "cat .bash_history", on, {
        root,
        cwd: "/home/sprite",
      }),
    ).toBe("hold");
    expect(
      outcome(["Bash"], "cat apps/api/.dev.vars", on, {
        root,
        cwd: "/workspace/repo",
      }),
    ).toBe("hold");
  });

  test("a cwd that isn't absolute holds, since it can't be placed against the root", () => {
    expect(outcome(["Bash"], "git status", on, { root, cwd: "" })).toBe("hold");
    expect(outcome(["Bash"], "git status", on, { root, cwd: "src" })).toBe(
      "hold",
    );
  });

  test("an auto-approve check that throws holds the call", () => {
    const broken = { defaults: true, commands: 1 } as unknown as AutoApprove;
    expect(outcome(["Bash"], "git status", broken)).toBe("hold");
    const realpath = () => {
      throw new Error("EIO");
    };
    expect(outcome(["Bash"], "git status", on, { root, realpath })).toBe(
      "hold",
    );
  });

  test("an explicit command pattern still holds what it names", () => {
    expect(outcome(["Bash(git diff:*)"], "git diff")).toBe("hold");
    expect(outcome(["Bash", "Bash(git diff:*)"], "git diff")).toBe("hold");
    expect(outcome(["Bash", "Bash(git diff:*)"], "git status")).toBe(
      "auto-approved",
    );
  });

  test("a call no pattern holds runs, and isn't counted as auto-approved", () => {
    expect(outcome(["Bash(git push:*)"], "git status")).toBe("run");
    expect(outcome([], "git status")).toBe("run");
  });

  test("turning auto-approval off holds every Bash command again", () => {
    const off: AutoApprove = { defaults: false, commands: [] };
    expect(outcome(["Bash"], "git status", off)).toBe("hold");
  });

  test("added commands skip the hold; replaced defaults do not", () => {
    const added = { defaults: true, commands: ["make check"] };
    expect(outcome(["Bash"], "make check", added)).toBe("auto-approved");
    expect(outcome(["Bash"], "make check")).toBe("hold");
    const replaced = { defaults: false, commands: ["make check"] };
    expect(outcome(["Bash"], "make check", replaced)).toBe("auto-approved");
    expect(outcome(["Bash"], "git status", replaced)).toBe("hold");
  });

  test("other tools are untouched, secret paths included", () => {
    const read = (file_path: string, policy = ["Read"]) =>
      policyOutcome(policy, on, { root }, "Read", { file_path });
    expect(read("/home/sprite/.claude/.credentials.json")).toBe("hold");
    expect(read("src/a.ts")).toBe("hold");
    expect(outcome(["Write"], "ls", on, { root }, "Write")).toBe("hold");
    expect(policyOutcome(["Bash"], on, { root }, "Bash", {})).toBe("hold");
    expect(policyOutcome(["Bash"], on, { root }, "Bash", { command: 1 })).toBe(
      "hold",
    );
  });
});

describe("globs and recursive grep against a real worktree", () => {
  const on: AutoApprove = { defaults: true, commands: [] };
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
  });
  const worktree = (files: string[]) => {
    const root = realpathSync.native(
      mkdtempSync(join(tmpdir(), "sky-policy-")),
    );
    dirs.push(root);
    for (const file of files) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), "x");
    }
    // the hooks the runner wires into a session
    const scope: AutoApproveScope = {
      root,
      realpath: realpathSync.native,
      readDir: (path) =>
        readdirSync(path, { withFileTypes: true }).map((e) => ({
          name: e.name,
          kind: e.isSymbolicLink()
            ? "symlink"
            : e.isDirectory()
              ? "dir"
              : e.isFile()
                ? "file"
                : "other",
        })),
    };
    const outcome = (command: string, over: Partial<AutoApproveScope> = {}) =>
      policyOutcome(["Bash"], on, { ...scope, ...over }, "Bash", { command });
    return { root, outcome };
  };

  test("a glob and grep -r over files the worktree may read skip the hold", () => {
    const { outcome } = worktree(["src/a.ts", "src/b.ts", "docs/a.md"]);
    expect(outcome("wc -l src/*.ts")).toBe("auto-approved");
    expect(outcome("cat docs/*.md | head -n 20")).toBe("auto-approved");
    expect(outcome("grep -rn foo src")).toBe("auto-approved");
  });

  test("one match or file that names a secret holds the call", () => {
    const { outcome } = worktree(["src/a.ts", ".env.local", "src/id_rsa"]);
    expect(outcome("cat .e*")).toBe("hold");
    expect(outcome("cat src/*")).toBe("hold");
    expect(outcome("grep -rn foo src")).toBe("hold");
    expect(outcome("grep -r foo .")).toBe("hold");
  });

  test("a glob in a write holds the call", () => {
    const { outcome } = worktree(["src/a.ts"]);
    expect(outcome("sed -i 's/a/b/' src/*.ts")).toBe("hold");
    expect(outcome("biome format --write src/*.ts")).toBe("hold");
  });

  test("without the directory hook, or when it throws, the call is held", () => {
    const { outcome } = worktree(["src/a.ts"]);
    expect(outcome("wc -l src/*.ts", { readDir: undefined })).toBe("hold");
    expect(outcome("grep -rn foo src", { readDir: undefined })).toBe("hold");
    const broken = () => {
      throw new Error("EIO");
    };
    expect(outcome("wc -l src/*.ts", { readDir: broken })).toBe("hold");
    expect(outcome("grep -rn foo src", { readDir: broken })).toBe("hold");
  });
});
