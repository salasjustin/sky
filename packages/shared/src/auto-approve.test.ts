import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  type AskReason,
  type AutoApprove,
  autoApproveVerdict,
  extraRoots,
  isAutoApproved,
  parseCommandEntry,
} from "./auto-approve.js";

const CWD = "/workspace/worktrees/agt_1";
const DEFAULTS: AutoApprove = { defaults: true, commands: [] };
const approved = (command: string, config = DEFAULTS) =>
  isAutoApproved(command, config, CWD);
const verdict = (command: string, config = DEFAULTS) =>
  autoApproveVerdict(command, config, CWD);

test.each([
  "ls",
  "ls -la src",
  "ls -R packages/runner",
  "cat package.json",
  "cat src/a.ts src/b.ts",
  "grep -n foo src/a.ts",
  'grep -n "a|b" src/a.ts',
  "grep -n foo src",
  "rg foo",
  "rg -n --files-with-matches 'foo bar' packages",
  "rg --files",
  "sed -n 1,20p src/a.ts",
  "sed -n 5p src/a.ts",
  "head -n 20 src/a.ts",
  "tail -n 20 src/a.ts",
  "wc -l src/a.ts",
  "find . -name '*.ts'",
  "find src -type f -name '*.test.ts'",
  "pwd",
  "echo hi",
  'echo "a > b; c | d"',
  "which node",
  "git status",
  "git status --short",
  "git log --oneline -n 5",
  'git log --format="%h %s" -n 3',
  "git diff",
  "git diff --stat main",
  "git diff HEAD~1 -- src/a.ts",
  "git show HEAD",
  "git show HEAD:src/a.ts",
  "git branch --list",
  "git branch -a --list 'claude/*'",
  "git branch --show-current",
  "git branch -v",
  "git branch -vv",
  "git branch -r",
  "git branch",
  "git rev-parse HEAD",
  "git rev-parse --show-toplevel",
  "node --version",
  "ls\t-la",
  "  ls  ",
])("auto-approves %s", (command) => {
  expect(approved(command)).toBe(true);
});

// `unresolvable` needs the realpath hook; see "the realpath hook" below
const reasons: Record<Exclude<AskReason, "unresolvable">, string[]> = {
  syntax: [
    // background, newlines and empty steps
    "ls |& head",
    "ls | | head",
    "ls |",
    "| head",
    "ls & rm x",
    "ls &",
    "ls;",
    "; ls",
    "ls ;; cat a",
    "ls && && cat a",
    "ls ||",
    "ls\nrm x",
    "ls\rrm x",
    // redirects and here-docs
    "echo hi > f",
    "echo hi >> f",
    "echo hi >f",
    "cat < f",
    "cat <<EOF",
    "ls 2> err",
    "ls 2>err",
    "ls >| f",
    "ls 1>/dev/null",
    "ls 3>/dev/null",
    "ls x2>/dev/null",
    "ls &>/dev/null",
    "ls >&2",
    "ls >& /dev/null",
    "ls 2>&1x",
    "ls 2>&-",
    "ls 2>& 1",
    "ls >/dev/nullx",
    "ls >/dev/null/x",
    "ls '>/dev/null' >/dev/stdout",
    "ls >'/dev/null'",
    "ls >",
    "ls 2>",
    "cat <(rm x)",
    // substitution and expansion
    "ls $(rm x)",
    "cat `id`",
    'echo "$(id)"',
    "echo `id`",
    "echo $HOME",
    'echo "$' + '{HOME}"',
    "echo $" + "{HOME}",
    "cat ~root/x",
    "ls *",
    "cat src/*.ts",
    "cat .e?v",
    "cat .en[v]",
    "echo hi # comment",
    "echo \\$HOME",
    "echo !!",
    "pnpm test $(id)",
    // zsh expands a word starting with `=` to that program's path
    "cat =ls",
    "ls -la =node",
    "=ls",
    // unparseable or empty
    "",
    "   ",
    'echo "unterminated',
    "echo 'unterminated",
    "ls (",
    "ls )",
    // subshells, grouping, here-strings, process substitution and NUL
    "(rm x)",
    "ls; (cd ..; ls)",
    "{ ls; }",
    "ls | (cat)",
    "cat <<< x",
    "ls >(tee f)",
    "ls\u0000rm x",
    // a quoted or brace-built `2` is a word, not the stderr fd
    "ls '2'>/dev/null",
    "ls {2,3}>/dev/null",
  ],
  program: [
    "FOO=1 ls",
    "PATH=/tmp ls",
    "LD_PRELOAD=x ls",
    "./ls",
    "/bin/ls",
    "/bin/cat x",
    "-v",
  ],
  "not-allowed": [
    "env ls",
    "sudo ls",
    "xargs ls",
    "command ls",
    "bash -c ls",
    "sh -c 'ls'",
    "rm x",
    "curl example.com",
    "git push",
    "git reset --hard",
    "mkdir x",
    "mkdir -m 777 -p x",
    "git fetch",
    "git",
    "git -c core.pager=sh log",
    "git --no-pager log",
    "git -C /tmp log",
    "git --git-dir=/tmp/x log",
    "pnpm install",
    "pnpm add evil",
    "pnpm run test",
    "pnpm exec rm x",
    "pnpm dlx evil",
    "pnpm -r exec rm x",
    "pnpm --filter x exec rm x",
    "pnpm --dir /tmp test",
    "pnpm",
    "node script.js",
    "node -e 'process.exit()'",
    "node",
  ],
  "unsafe-option": [
    "git log -c core.pager=sh",
    "git log --config-env=core.pager=SHELL",
    "git diff --output=f",
    "git diff --output f",
    "git log --output=f",
    "git diff --ext-diff",
    "git show --textconv HEAD:x",
    "git diff --no-index src/a.ts src/b.ts",
    "git log --open-files-in-pager",
    "git diff -Ovim",
    "git log --exec-path=x",
    "git log --work-tree=x",
    "git log --git-dir=x",
    "git branch newbranch",
    "git branch -d main",
    "git branch -D main",
    "git branch -m a b",
    "git branch -c a b",
    "git branch --set-upstream-to=origin/main",
    "git branch --delete main",
    "pnpm test --fix",
    "pnpm lint --write",
    "pnpm test -u",
    "pnpm --filter 'a;b' test",
    "pnpm --filter",
    "node --version --eval x",
    "git checkout main",
    "git checkout -b x",
    "git commit",
    "git commit --amend -m x",
    "git commit -m",
    "git commit -F -",
    "git commit -m x --no-verify",
    "git add -f .",
    "git add -p",
    "git add ':(top)x'",
    "git restore",
    "git restore --source=HEAD~3 x",
    "git stash branch x",
    "git stash -p",
    "git checkout HEAD -- x",
    // write-capable flags on allowlisted programs
    "sed -i 's/a/b/e' f",
    "sed -i 's/a/b/w out' f",
    "sed -i '1w out' f",
    "sed -i '1r f' g",
    "sed -i 's/a/b/' ",
    "sed -i -f script f",
    "sed -i.bak/x s/a/b/ f",
    "sed -i 'y/ab/cd/' f",
    "sed -n 1w out f",
    "sed -n 1e f",
    "sed -n '1p;w out' f",
    "sed s/a/b/ f",
    "sed -n 1p",
    "sed -n 1p -s f",
    "mkdir -p",
    "date -s 12:00",
    "date -f x",
    "sleep 61",
    "sleep 1 2",
    "sleep -1",
    "true x",
    "find . -delete",
    "find . -exec rm '{}' ';'",
    "find . -exec rm '{}' +",
    "find . -execdir rm '{}' ';'",
    "find . -ok rm '{}' ';'",
    "find . -okdir rm '{}' ';'",
    "find . -fprint out",
    "find . -fprint0 out",
    "find . -fprintf out x",
    "find . -fls out",
    // following links walks out of the root; a list file names paths no check sees
    "find -L .",
    "find . -follow",
    "find -files0-from list -name x",
    "wc --files0-from=list",
    "wc --files0-from list",
    "wc --files0 list",
    "tail -f log",
    "tail -F log",
    "tail --follow log",
    "grep -r foo .",
    "grep -rn foo src",
    "grep -R foo .",
    "grep --recursive foo .",
    "grep -d recurse foo .",
    "grep --directories=recurse foo .",
    "rg --pre ./x foo",
    "rg --pre=./x foo",
    "rg -z foo",
    "rg --search-zip foo",
    "rg -u foo",
    "rg -uu foo",
    "rg --unrestricted foo",
    "rg --hidden foo",
    "rg -. foo",
    "rg --no-ignore foo",
    "rg --no-ignore-vcs foo",
    "rg --ignore-file=x foo",
    "rg -L foo",
    "rg --follow foo",
    "rg --hostname-bin x foo",
  ],
  "outside-root": [
    // with no home in the scope a `~` stays unexpanded
    "ls ~",
    "cat ~/.claude/.credentials.json",
    "rg foo ~/.ssh",
    "cat /home/sprite/.claude/.credentials.json",
    'cat "~/.ssh/id_rsa"',
    "cat ../x",
    "cat src/../../x",
    "cat /etc/passwd",
    "cat /proc/self/environ",
    "cat /proc/1/environ",
    "ls /",
    "ls ..",
    "ls /home/sprite/.config",
    "cat --file=/etc/passwd",
    "wc -l /etc/passwd",
    "tail -n 5 ../secret",
    "find / -name x",
    "find .. -name x",
    "rg foo /etc",
    "grep foo ../x",
    "sed -n 1p /etc/passwd",
    `cat ${CWD}/../other/x`,
    "git diff -- ../x",
    "git show HEAD:../x",
    "git log --format=%h:/etc/passwd",
  ],
  "sensitive-path": [
    "cat .env",
    "cat .env.local",
    "cat packages/api/.env",
    "cat .envrc",
    "head .env.production",
    "cat .claude/.credentials.json",
    "cat .config/gh/hosts.yml",
    "ls .ssh",
    "cat .ssh/id_rsa",
    "cat id_ed25519",
    "cat credentials.json",
    "cat aws-credentials",
    "cat token.txt",
    "cat tokens/a",
    "cat github_token",
    "cat secret.yaml",
    "cat secrets/prod.json",
    "cat server.pem",
    "cat server.key",
    "cat .npmrc",
    "cat .netrc",
    "cat .aws/config",
    "cat .git/config",
    "find . -name '.env*'",
    "sed -n 1p .env",
    "git show HEAD:.env",
    "git show HEAD:.git/config",
    "ls .gnupg",
    "cat .kube/config",
    "cat .docker/config.json",
    "cat .pgpass",
    "cat environ",
    "cat id_rsa",
    "cat id_dsa",
    "cat id_ecdsa",
    "cat .dev.vars",
    "cat .yarnrc.yml",
    "cat .pypirc",
    "cat cert.p12",
    "cat cert.pfx",
    "cat .htpasswd",
    "cat terraform.tfstate",
    "cat infra/prod.tfstate.backup",
  ],
};

describe.each(Object.entries(reasons))("asks (%s)", (reason, commands) => {
  test.each(commands)("%j", (command) => {
    expect(verdict(command)).toBe(reason);
    expect(approved(command)).toBe(false);
  });
});

test("grep takes only the long options it lists, so an abbreviation can't recurse", () => {
  for (const command of [
    "grep --line-number foo src/a.ts",
    "grep --ignore-case --count foo src/a.ts",
    "grep --context=2 --fixed-strings foo src/a.ts",
    "grep --regexp foo src/a.ts",
  ])
    expect(verdict(command), command).toBe("approved");
  // GNU getopt takes any unambiguous prefix: `--rec` is `--recursive`
  for (const command of [
    "grep --rec --null KEY .",
    "grep --deref KEY .",
    "grep --dir=rec KEY .",
    "grep --dir=recurse KEY .",
    "grep --line-num foo src/a.ts",
    "grep --include=x foo src/a.ts",
  ])
    expect(verdict(command), command).toBe("unsafe-option");
});

test("rg refuses globs and types, which override its hidden-file and gitignore filters", () => {
  for (const command of [
    "rg -g '.e*' ''",
    "rg -g '.*' KEY",
    "rg --glob='.?nv' ''",
    "rg --glob '.?nv' ''",
    "rg --iglob '.E*' ''",
    "rg -ng '.e*' ''",
    "rg --type-add 'e:.env' -te ''",
    "rg --trace -f patterns a.txt",
    "rg --debug foo",
  ])
    expect(verdict(command), command).toBe("unsafe-option");
  expect(verdict("rg -n -t ts foo src")).toBe("approved");
});

test("a path glued to a short option is checked like a separate one", () => {
  expect(verdict("rg --trace -f/etc/passwd a.txt")).toBe("unsafe-option");
  expect(verdict("rg -f/etc/passwd a.txt")).toBe("outside-root");
  expect(verdict("grep -f/etc/passwd a.txt")).toBe("outside-root");
  expect(verdict("grep -of/proc/1/cmdline a.txt")).toBe("outside-root");
  expect(verdict("grep -f.env -o x a.txt")).toBe("sensitive-path");
  expect(verdict("head -c1 src/a.ts")).toBe("approved");
});

test("tail can't follow through a bundle, a glued count or an abbreviation", () => {
  for (const command of [
    "tail -fn1 src/a.ts",
    "tail -f1 src/a.ts",
    "tail -n1f src/a.ts",
    "tail -5f src/a.ts",
    "tail --fol src/a.ts",
    "tail --f src/a.ts",
    "tail --follow=name src/a.ts",
  ])
    expect(verdict(command), command).toBe("unsafe-option");
  expect(verdict("tail -n1 src/a.ts")).toBe("approved");
  expect(verdict("tail -c 100 src/a.ts")).toBe("approved");
});

test("dot segments are collapsed before the secret-path check", () => {
  expect(verdict("cat .git/./config")).toBe("sensitive-path");
  expect(verdict("cat src/../.git/config")).toBe("sensitive-path");
  expect(verdict("cat .git//config")).toBe("sensitive-path");
  expect(verdict("cat .git/hooks/../config")).toBe("sensitive-path");
  expect(verdict("cat .git/HEAD")).toBe("approved");
});

describe("a shell cwd apart from the root", () => {
  const at = (cwd: string) => (command: string) =>
    autoApproveVerdict(command, DEFAULTS, { root: CWD, cwd });

  test("resolves relative paths against cwd and contains them in root", () => {
    const inSrc = at(`${CWD}/src`);
    expect(inSrc("cat a.ts")).toBe("approved");
    expect(inSrc("cat ../package.json")).toBe("approved");
    expect(inSrc("cat ../.env")).toBe("sensitive-path");
    expect(inSrc("cat ../../x")).toBe("outside-root");
    expect(
      isAutoApproved("cat ../package.json", DEFAULTS, {
        root: CWD,
        cwd: `${CWD}/src`,
      }),
    ).toBe(true);
  });

  test("a cwd outside the root, or at a secret, asks even with no path argument", () => {
    expect(at("/home/sprite")("ls")).toBe("outside-root");
    expect(at(`${CWD}/..`)("git status")).toBe("outside-root");
    expect(at(`${CWD}/.ssh`)("ls")).toBe("sensitive-path");
  });
});

describe("the realpath hook", () => {
  const base = realpathSync.native(
    mkdtempSync(join(tmpdir(), "auto-approve-")),
  );
  const root = join(base, "wt");
  const outside = join(base, "outside");
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, ".git"));
  mkdirSync(join(outside, "dir"), { recursive: true });
  writeFileSync(join(root, "a.txt"), "a");
  writeFileSync(join(root, ".git", "config"), "");
  writeFileSync(join(outside, "plain.txt"), "x");
  symlinkSync(join(outside, "plain.txt"), join(root, "docs", "notes"));
  symlinkSync("../.git/config", join(root, "docs", "cfg"));
  symlinkSync(join(outside, "dir"), join(root, "l"));
  symlinkSync("loop", join(root, "loop"));
  symlinkSync(root, join(base, "wt-link"));
  mkdirSync(join(root, "s", "t", "u", "v", "w"), { recursive: true });
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "packages"));
  symlinkSync("../../../../../src", join(root, "s", "t", "u", "v", "w", "l"));
  symlinkSync("s/t/u", join(root, "deep"));
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  const real = (command: string, where: { root?: string; cwd?: string } = {}) =>
    autoApproveVerdict(command, DEFAULTS, {
      root,
      ...where,
      realpath: realpathSync.native,
    });

  test("approves an ordinary file and a path that doesn't exist yet", () => {
    expect(real("cat a.txt")).toBe("approved");
    expect(real("cat docs/missing.md")).toBe("approved");
    expect(real("grep -n foo a.txt")).toBe("approved");
  });

  test("asks when a symlink leaves the root or lands on a secret", () => {
    expect(real("cat docs/notes")).toBe("outside-root");
    expect(real("cat docs/cfg")).toBe("sensitive-path");
    // the kernel takes `..` after the link's target, not lexically
    expect(real("cat l/../plain.txt")).toBe("outside-root");
    expect(real("ls", { cwd: join(root, "l") })).toBe("outside-root");
  });

  test("a cd through a symlink is checked where the link leads", () => {
    expect(real("cd docs && cat ../a.txt")).toBe("approved");
    expect(real("cd l && ls")).toBe("outside-root");
    expect(real("cd l/.. && cat plain.txt")).toBe("outside-root");
    expect(real("cd docs && cat cfg")).toBe("sensitive-path");
  });

  test("asks when a cd target doesn't resolve, since bash then moves by the physical path", () => {
    // lexically s/t/u/v/w/packages, missing; bash falls back to src/../packages, i.e. packages
    expect(
      real("cd s/t/u/v/w/l/../packages && cat ../../outside/plain.txt"),
    ).toBe("unresolvable");
    expect(real("cd missing && ls")).toBe("unresolvable");
  });

  test("after a cd through a symlink, `..` is taken lexically, as bash does", () => {
    // bash's cwd is the root again, not s/t
    expect(real("cd deep && cd .. && cat ../outside/plain.txt")).toBe(
      "outside-root",
    );
  });

  test("a root reached through a symlink still contains its files", () => {
    expect(real("cat a.txt", { root: join(base, "wt-link") })).toBe("approved");
  });

  test("asks when resolving fails for any reason but a missing path", () => {
    expect(real("cat loop")).toBe("unresolvable");
    const denied = () => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    };
    expect(
      autoApproveVerdict("cat a.txt", DEFAULTS, { root, realpath: denied }),
    ).toBe("unresolvable");
  });
});

describe("the plugin cache, the kru store and the repo's skill files", () => {
  const base = realpathSync.native(
    mkdtempSync(join(tmpdir(), "auto-approve-home-")),
  );
  const home = join(base, "home");
  const root = join(base, "wt");
  const cache = join(home, ".claude/plugins/cache");
  const skill = join(cache, "kru/kru/0.213.0/skills/lead/SKILL.md");
  mkdirSync(join(skill, ".."), { recursive: true });
  mkdirSync(join(home, ".kru/audit"), { recursive: true });
  mkdirSync(join(home, ".kru/management/plan/slug"), { recursive: true });
  mkdirSync(join(home, ".ssh"));
  mkdirSync(join(root, ".claude/skills/release"), { recursive: true });
  mkdirSync(join(root, "packages/ui"), { recursive: true });
  writeFileSync(skill, "x");
  writeFileSync(join(home, ".kru/audit/run.jsonl"), "x");
  writeFileSync(join(home, ".kru/management/plan/slug/brief.md"), "x");
  writeFileSync(join(home, ".claude/.credentials.json"), "x");
  writeFileSync(join(home, ".claude/settings.json"), "x");
  writeFileSync(join(home, ".ssh/id_rsa"), "x");
  writeFileSync(join(root, ".claude/skills/release/SKILL.md"), "x");
  writeFileSync(join(root, ".claude/settings.json"), "x");
  writeFileSync(join(root, ".claude/settings.local.json"), "x");
  writeFileSync(join(root, "packages/ui/image.tsx"), "x");
  symlinkSync(join(home, ".ssh/id_rsa"), join(home, ".kru/to-key"));
  symlinkSync(join(home, ".claude/.credentials.json"), join(cache, "to-login"));
  symlinkSync(join(home, ".kru/audit"), join(cache, "to-store"));
  symlinkSync(join(root, "packages"), join(home, ".kru/to-worktree"));
  symlinkSync(
    join(root, ".claude/settings.json"),
    join(root, ".claude/skills/to-settings"),
  );
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  const withHome = (command: string, realpath?: (path: string) => string) =>
    autoApproveVerdict(command, DEFAULTS, {
      root,
      home,
      realpath,
      storeHome: ".kru",
    });
  const both = (command: string) => {
    const plain = withHome(command);
    expect(withHome(command, realpathSync.native), command).toBe(plain);
    return plain;
  };

  test("approves a read under the plugin cache", () => {
    expect(both(`grep -n 'Step 3' -A 200 ${skill} | head -300`)).toBe(
      "approved",
    );
    expect(
      both("cat ~/.claude/plugins/cache/kru/kru/0.213.0/skills/lead/SKILL.md"),
    ).toBe("approved");
    expect(both("ls ~/.claude/plugins/cache")).toBe("approved");
  });

  test("approves a read under the kru store, by absolute path or `~`", () => {
    expect(both(`cat ${home}/.kru/audit/run.jsonl | head -c 400000`)).toBe(
      "approved",
    );
    expect(
      both(
        "cat ~/.kru/management/plan/slug/brief.md && git diff f4d7ee9 --stat",
      ),
    ).toBe("approved");
    expect(both("ls ~/.kru")).toBe("approved");
  });

  test("a root beside the worktree is named, never entered", () => {
    expect(both("cd ~/.kru/audit && cat run.jsonl")).toBe("outside-root");
    expect(both("cd ~/.kru && pnpm test")).toBe("outside-root");
    expect(both("cd ~/.claude/plugins/cache/p && git status")).toBe(
      "outside-root",
    );
    for (const realpath of [undefined, realpathSync.native]) {
      const inStore = (command: string) =>
        autoApproveVerdict(command, DEFAULTS, {
          root,
          home,
          storeHome: ".kru",
          cwd: join(home, ".kru"),
          realpath,
        });
      expect(inStore("ls")).toBe("outside-root");
      expect(inStore("cat audit/run.jsonl")).toBe("outside-root");
    }
  });

  test("approves the worktree's skills, agents and commands", () => {
    expect(
      both("cat .claude/skills/release/SKILL.md && cat packages/ui/image.tsx"),
    ).toBe("approved");
    expect(both("ls .claude/agents .claude/commands")).toBe("approved");
    expect(both(`cat ${root}/.claude/skills/release/SKILL.md`)).toBe(
      "approved",
    );
  });

  test("expands a bare `~` to the home, which is outside both roots", () => {
    expect(both("ls ~")).toBe("outside-root");
    expect(both("cd ~ && ls")).toBe("outside-root");
  });

  test("a `~` is the home in arguments and in a cd target", () => {
    const inside = join(root, "packages/ui");
    const at = (command: string, realpath?: (path: string) => string) =>
      autoApproveVerdict(command, DEFAULTS, {
        root,
        home: inside,
        realpath,
        storeHome: ".kru",
      });
    for (const realpath of [undefined, realpathSync.native]) {
      expect(at("cat ~/image.tsx", realpath)).toBe("approved");
      expect(at("cat ~", realpath)).toBe("approved");
      expect(at("cd ~ && cat image.tsx", realpath)).toBe("approved");
      // from packages/ui, `../../.env` is the worktree's own `.env`
      expect(at("cd ~ && cat ../../.env", realpath)).toBe("sensitive-path");
    }
  });

  test("a home of `/` makes `~` the filesystem root, as bash does", () => {
    const atRoot = (command: string) =>
      autoApproveVerdict(command, DEFAULTS, {
        root,
        home: "/",
        storeHome: ".kru",
      });
    expect(atRoot("ls ~")).toBe("outside-root");
    expect(atRoot("cd ~ && cat etc/passwd")).toBe("outside-root");
    expect(atRoot("cat ~/etc/x")).toBe("outside-root");
    expect(atRoot("cat ~/.kru/x")).toBe("approved");
  });

  describe("the store root follows the base profile's store home", () => {
    const storeIn = (storeHome: string | undefined, command: string) =>
      [undefined, realpathSync.native].map((realpath) =>
        autoApproveVerdict(command, DEFAULTS, {
          root,
          home,
          realpath,
          storeHome,
        }),
      );

    test.each([".sky-store", ".kru", "a/store"])("%s reads", (storeHome) => {
      expect(storeIn(storeHome, `cat ~/${storeHome}/plans/x.md`)).toEqual([
        "approved",
        "approved",
      ]);
      expect(storeIn(storeHome, `ls ${home}/${storeHome}`)).toEqual([
        "approved",
        "approved",
      ]);
    });

    test("only the named directory is a root", () => {
      expect(storeIn(".sky-store", "cat ~/.kru/audit/run.jsonl")).toEqual([
        "outside-root",
        "outside-root",
      ]);
      expect(storeIn(".kru", "cat ~/.sky-store/x")).toEqual([
        "outside-root",
        "outside-root",
      ]);
    });

    test("without a store home there is no store root, the plugin cache stays", () => {
      expect(storeIn(undefined, "cat ~/.kru/audit/run.jsonl")).toEqual([
        "outside-root",
        "outside-root",
      ]);
      expect(storeIn(undefined, "cat ~/.sky-store/x")).toEqual([
        "outside-root",
        "outside-root",
      ]);
      expect(storeIn(undefined, `cat ${skill}`)).toEqual([
        "approved",
        "approved",
      ]);
    });

    test.each([
      "",
      ".",
      "..",
      "../x",
      "a/../..",
      "/etc",
      ".claude",
      ".claude/store",
      "a b",
    ])("%j is no store root", (storeHome) => {
      expect(extraRoots(home, undefined, storeHome)).toEqual([cache]);
    });

    test("a store home with a trailing slash is the same root, judged from the store down", () => {
      expect(extraRoots(home, undefined, "a/store/")).toEqual([
        cache,
        join(home, "a/store"),
      ]);
      const secretHome = join(base, "secret-home");
      const verdicts = ["store/", "store"].map((storeHome) =>
        autoApproveVerdict("cat ~/store/plans/x.md", DEFAULTS, {
          root,
          home: secretHome,
          storeHome,
        }),
      );
      expect(verdicts).toEqual(["approved", "approved"]);
    });

    test("extraRoots lists the plugin cache and the store below the home", () => {
      expect(extraRoots(home, realpathSync.native, ".kru")).toEqual([
        cache,
        join(home, ".kru"),
      ]);
      expect(extraRoots(undefined, undefined, ".kru")).toEqual([]);
    });
  });

  test("asks for a sibling that only shares a root's prefix", () => {
    expect(both("ls ~/.krux/a")).toBe("outside-root");
    expect(both("cat ~/.claude/plugins/cache2/a")).toBe("outside-root");
  });

  test("asks for the rest of ~/.claude, whatever the spelling", () => {
    expect(both("cat ~/.claude/.credentials.json")).toBe("outside-root");
    expect(both("cat ~/.claude/settings.json")).toBe("outside-root");
    expect(both("cat ~/.claude/plugins/../.credentials.json")).toBe(
      "outside-root",
    );
    expect(
      both(`cat ${home}/.claude/plugins/cache/../../.credentials.json`),
    ).toBe("outside-root");
    expect(both("ls ~/.claude")).toBe("outside-root");
    expect(both("cat ~/.kru/../.ssh/id_rsa")).toBe("outside-root");
    expect(both("cat ~/.ssh/id_rsa")).toBe("outside-root");
  });

  test("asks for the rest of the worktree's .claude", () => {
    expect(both("cat .claude/settings.local.json")).toBe("sensitive-path");
    expect(both("cat .claude/settings.json")).toBe("sensitive-path");
    expect(both("cat .claude/skills/../settings.json")).toBe("sensitive-path");
    expect(both("ls .claude")).toBe("sensitive-path");
  });

  test("only the worktree's top-level .claude lets skills through", () => {
    expect(both("cat packages/x/.claude/skills/a")).toBe("sensitive-path");
    expect(both("cat ~/.kru/.claude/skills/x")).toBe("sensitive-path");
    expect(both("cat ~/.claude/plugins/cache/p/.claude/skills/x")).toBe(
      "sensitive-path",
    );
  });

  test("a secret under a root still asks", () => {
    expect(both("cat ~/.kru/.env")).toBe("sensitive-path");
    expect(both("cat ~/.kru/x/credentials.json")).toBe("sensitive-path");
    expect(both("cat .claude/skills/.env")).toBe("sensitive-path");
    expect(both(`cat ${cache}/x/.ssh/y`)).toBe("sensitive-path");
  });

  test("a symlink under a root that leads out of it or onto a secret asks", () => {
    const real = (command: string) => withHome(command, realpathSync.native);
    expect(real("cat ~/.kru/to-key")).toBe("outside-root");
    expect(real("cat ~/.claude/plugins/cache/to-login")).toBe("outside-root");
    // another root is no better than outside
    expect(real("cat ~/.claude/plugins/cache/to-store/run.jsonl")).toBe(
      "outside-root",
    );
    expect(real("cat ~/.kru/to-worktree/ui/image.tsx")).toBe("outside-root");
    expect(real("cat .claude/skills/to-settings")).toBe("sensitive-path");
    expect(real("cd ~/.kru/to-key && ls")).toBe("outside-root");
  });

  test("a `~` that the shell wouldn't expand to the home still asks", () => {
    expect(both("cat ~root/x")).toBe("syntax");
    expect(both("ls x=~/y")).toBe("outside-root");
    expect(both("ls x:~/.kru")).toBe("outside-root");
    expect(both('cat "~/x"')).toBe("outside-root");
    expect(both("cat '~/.kru/x'")).toBe("outside-root");
    expect(both("cat ~+/x")).toBe("syntax");
    expect(both("cat {~,a}/x")).toBe("syntax");
    expect(both("cat ~/{a,b}")).toBe("syntax");
    expect(both("cat x > ~/.kru/y")).toBe("syntax");
  });

  test("without a home the roots don't exist and a `~` asks", () => {
    const bare = (command: string) =>
      autoApproveVerdict(command, DEFAULTS, { root });
    expect(bare(`cat ${home}/.kru/audit/run.jsonl`)).toBe("outside-root");
    expect(bare("cat ~/.kru/audit/run.jsonl")).toBe("outside-root");
    expect(
      autoApproveVerdict("cat ~/.kru/x", DEFAULTS, {
        root,
        home: "relative",
        storeHome: ".kru",
      }),
    ).toBe("outside-root");
  });

  test("an allowlist entry can't hold a `~`", () => {
    expect(parseCommandEntry("ls ~/.kru")).toBeUndefined();
  });
});

describe("a root that is a link to somewhere broader", () => {
  const base = realpathSync.native(
    mkdtempSync(join(tmpdir(), "auto-approve-links-")),
  );
  afterAll(() => rmSync(base, { recursive: true, force: true }));
  let n = 0;

  /**
   * A fresh home and worktree, with the root `name` replaced by a link to
   * `target(home, elsewhere, claude)`. With `linkClaude`, `~/.claude` is a link
   * to the real config folder `claude`, which sits outside the home.
   */
  const setup = (
    name: ".kru" | ".claude/plugins/cache",
    target: (home: string, elsewhere: string, claude: string) => string,
    linkClaude = false,
  ) => {
    const dir = join(base, `case-${++n}`);
    const home = join(dir, "home");
    const elsewhere = join(dir, "elsewhere");
    const root = join(dir, "wt");
    const claude = linkClaude
      ? join(dir, "persist/claude")
      : join(home, ".claude");
    for (const d of [
      join(claude, "plugins"),
      join(claude, "x"),
      join(home, ".config/gh"),
      elsewhere,
      root,
    ])
      mkdirSync(d, { recursive: true });
    if (linkClaude) symlinkSync(claude, join(home, ".claude"));
    for (const f of [
      join(claude, "settings.json"),
      join(claude, "x/settings.json"),
      join(home, "settings.json"),
      join(home, ".config/gh/hosts.yml"),
      join(elsewhere, "settings.json"),
    ])
      writeFileSync(f, "x");
    const to = target(home, elsewhere, claude);
    symlinkSync(to, join(home, name));
    return { home, root, claude, read: `${join(home, name)}/settings.json` };
  };
  const verdictOf = (s: { home: string; root: string }, command: string) =>
    autoApproveVerdict(command, DEFAULTS, {
      root: s.root,
      home: s.home,
      storeHome: ".kru",
      realpath: realpathSync.native,
    });

  describe.each([".kru", ".claude/plugins/cache"] as const)("%s", (name) => {
    test.each([
      ["/", () => "/"],
      ["the home", (home: string) => home],
      ["~/.claude", (home: string) => join(home, ".claude")],
      ["~/.claude/x", (home: string) => join(home, ".claude/x")],
      ["a folder holding the home", (home: string) => dirname(home)],
    ])("linked to %s, reads there ask", (_label, target) => {
      const s = setup(name, target);
      expect(verdictOf(s, `cat ${s.read}`)).toBe("outside-root");
      expect(verdictOf(s, `cat ~/${name}/settings.json`)).toBe("outside-root");
      expect(verdictOf(s, `ls ~/${name}`)).toBe("outside-root");
    });

    test.each([
      ["the real ~/.claude", (claude: string) => claude],
      ["inside the real ~/.claude", (claude: string) => join(claude, "x")],
      [
        "a folder holding the real ~/.claude",
        (claude: string) => dirname(claude),
      ],
    ])("with ~/.claude a link, linked to %s, reads ask", (_label, at) => {
      const s = setup(name, (_home, _elsewhere, claude) => at(claude), true);
      expect(verdictOf(s, `cat ${s.read}`)).toBe("outside-root");
      expect(verdictOf(s, `cat ~/${name}/settings.json`)).toBe("outside-root");
      expect(verdictOf(s, `ls ~/${name}`)).toBe("outside-root");
    });

    test("linked into another secret folder, reads there ask", () => {
      const s = setup(name, (home) => join(home, ".config/gh"));
      expect(verdictOf(s, `cat ~/${name}/hosts.yml`)).toBe("outside-root");
      expect(verdictOf(s, `ls ~/${name}`)).toBe("outside-root");
    });

    test("linked to a harmless folder elsewhere, reads still pass", () => {
      const s = setup(name, (_home, elsewhere) => elsewhere);
      expect(verdictOf(s, `cat ${s.read}`)).toBe("approved");
      expect(verdictOf(s, `cat ~/${name}/settings.json`)).toBe("approved");
    });

    test("is judged for each command, not once", () => {
      const s = setup(name, (_home, elsewhere) => elsewhere);
      expect(verdictOf(s, `cat ${s.read}`)).toBe("approved");
      const link = join(s.home, name);
      rmSync(link);
      symlinkSync(join(s.home, ".claude"), link);
      expect(verdictOf(s, `cat ${s.read}`)).toBe("outside-root");
    });
  });

  test.each([
    ["a real ~/.claude", false],
    ["~/.claude a link", true],
  ])("with %s, a real plugin cache and .kru still read", (_label, link) => {
    const s = setup(".kru", (_home, elsewhere) => elsewhere, link);
    mkdirSync(join(s.claude, "plugins/cache/p"), { recursive: true });
    writeFileSync(join(s.claude, "plugins/cache/p/plugin.json"), "x");
    expect(verdictOf(s, "cat ~/.kru/settings.json")).toBe("approved");
    expect(verdictOf(s, "cat ~/.claude/plugins/cache/p/plugin.json")).toBe(
      "approved",
    );
  });

  test("a home reached through a link still keeps a real root", () => {
    const s = setup(".kru", (_home, elsewhere) => elsewhere);
    const viaLink = join(base, `home-link-${n}`);
    symlinkSync(s.home, viaLink);
    expect(verdictOf({ ...s, home: viaLink }, "cat ~/.kru/settings.json")).toBe(
      "approved",
    );
  });
});

describe(".claude.json holds account and MCP settings, so it is a secret name", () => {
  const base = realpathSync.native(
    mkdtempSync(join(tmpdir(), "auto-approve-account-")),
  );
  const home = join(base, "home");
  mkdirSync(join(home, "src"), { recursive: true });
  writeFileSync(join(home, ".claude.json"), "{}");
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  test.each([
    "cat .claude.json",
    "cat .CLAUDE.JSON",
    "cat src/../.Claude.json",
    "grep -n mcp .claude.json",
  ])("in the worktree: %s", (command) => {
    expect(verdict(command)).toBe("sensitive-path");
  });

  test("in the home, whether the worktree is the home or not", () => {
    const elsewhere = join(base, "wt");
    mkdirSync(elsewhere);
    for (const realpath of [undefined, realpathSync.native]) {
      const at = (root: string, command: string) =>
        autoApproveVerdict(command, DEFAULTS, { root, home, realpath });
      expect(at(home, "cat .claude.json")).toBe("sensitive-path");
      expect(at(home, "cat ~/.claude.json")).toBe("sensitive-path");
      expect(at(home, "cat ~/.CLAUDE.json")).toBe("sensitive-path");
      expect(at(elsewhere, "cat ~/.claude.json")).toBe("outside-root");
    }
  });
});

test("every argument is path-checked, so a pattern or name holding token, secret or credentials asks", () => {
  // deliberate fail-closed: the parser can't tell a search pattern from a path, and these
  // three match anywhere in a segment, not only as a whole file name
  for (const command of [
    "rg token src",
    "grep secret src/a.ts",
    "grep -n getCredentials src/a.ts",
    "cat src/tokenizer.ts",
    "ls secrets-doc",
    "git log --grep=token",
  ])
    expect(verdict(command), command).toBe("sensitive-path");
  expect(verdict("rg tok src")).toBe("approved");
});

test("an absolute path inside the worktree is fine", () => {
  expect(approved(`cat ${CWD}/src/a.ts`)).toBe(true);
  expect(approved(`ls ${CWD}`)).toBe(true);
});

test("quoting can't smuggle a program or secret past the checks", () => {
  expect(verdict('"ls"')).toBe("approved");
  expect(verdict("l's'")).toBe("approved");
  expect(verdict('"rm" x')).toBe("not-allowed");
  expect(verdict('cat ".env"')).toBe("sensitive-path");
  expect(verdict("cat '.e'nv")).toBe("sensitive-path");
  expect(verdict('cat "~/.ssh/id_rsa"')).toBe("outside-root");
  expect(verdict('"FOO=1" ls')).toBe("program");
  expect(verdict("FOO='1' ls")).toBe("program");
  expect(verdict('echo ";" && rm x')).toBe("not-allowed");
});

test("echo prints and never reads, so a path-like argument is fine", () => {
  expect(approved("echo /etc/passwd")).toBe(true);
  expect(approved("echo .env")).toBe(true);
});

describe("pnpm test, typecheck and lint are in the defaults", () => {
  const scripts = DEFAULTS;

  test.each(["pnpm run test", "pnpm install", "pnpm exec rm x"])(
    "%s still asks",
    (command) => expect(verdict(command)).toBe("not-allowed"),
  );

  test.each([
    "pnpm test",
    "pnpm typecheck",
    "pnpm lint",
    "pnpm test packages/runner/src/policy.test.ts",
    "pnpm test -- --run",
    "pnpm test --run",
    "pnpm test --silent",
    "pnpm -r test --bail",
    "pnpm test --passWithNoTests",
    "pnpm -r test",
    "pnpm -r --filter @sky/runner test",
    "pnpm --filter @sky/runner typecheck",
    "pnpm --filter=@sky/runner lint",
    "pnpm -F ./packages/runner test",
  ])("%s is approved", (command) => {
    expect(verdict(command, scripts)).toBe("approved");
  });

  test.each([
    ["pnpm --filter --workspace-root test", "unsafe-option"],
    ["pnpm -F -w test", "unsafe-option"],
    // not stripped as a filter, so `--filter=-w` is taken for the script name
    ["pnpm --filter=-w test", "not-allowed"],
  ])("%s asks: a filter value that is a flag", (command, reason) => {
    expect(verdict(command, scripts)).toBe(reason);
  });
});

test("a command outside the defaults asks", () => {
  expect(approved("make check")).toBe(false);
  expect(approved("git tag --list")).toBe(false);
});

test("added commands join the defaults", () => {
  const config = { defaults: true, commands: ["git tag --list", "make check"] };
  expect(approved("git tag --list", config)).toBe(true);
  expect(approved("git tag --list 'v*'", config)).toBe(true);
  expect(approved("make check", config)).toBe(true);
  expect(approved("make deploy", config)).toBe(false);
  expect(approved("git tag -d v1", config)).toBe(false);
  expect(approved("git status", config)).toBe(true);
});

test("replacing the defaults drops them", () => {
  const config = { defaults: false, commands: ["make check"] };
  expect(approved("make check", config)).toBe(true);
  expect(approved("ls", config)).toBe(false);
  expect(approved("git status", config)).toBe(false);
});

test("an empty replacement turns auto-approval off", () => {
  const off = { defaults: false, commands: [] };
  for (const command of ["ls", "git status", "pnpm test", "echo hi"])
    expect(approved(command, off)).toBe(false);
});

test("added commands get the same structural and path checks", () => {
  const config = { defaults: true, commands: ["make check", "find", "git"] };
  expect(verdict("make check; rm x", config)).toBe("not-allowed");
  expect(verdict("make check > f", config)).toBe("syntax");
  expect(verdict("make check ../x", config)).toBe("outside-root");
  expect(verdict("make check .env", config)).toBe("sensitive-path");
  expect(verdict("FOO=1 make check", config)).toBe("program");
  // a broad entry doesn't lift the per-program guards
  expect(verdict("find . -delete", config)).toBe("unsafe-option");
  expect(verdict("git diff --output=f", config)).toBe("unsafe-option");
  expect(verdict("git -c core.pager=sh log", config)).toBe("unsafe-option");
  // `--config-env` sets config like `-c`, here before the subcommand
  expect(verdict("git --config-env=diff.external=X diff", config)).toBe(
    "unsafe-option",
  );
  expect(verdict("git --config-env diff.external=X diff", config)).toBe(
    "unsafe-option",
  );
  // the broad entry itself runs plain git
  expect(verdict("git diff --stat", config)).toBe("approved");
});

test("a pipe-only program added as an entry keeps its own guards", () => {
  const config = {
    defaults: true,
    commands: ["sort", "uniq", "jq", "awk"],
  };
  expect(verdict("sort a.txt", config)).toBe("approved");
  expect(verdict("uniq a.txt", config)).toBe("approved");
  expect(verdict("awk '{print}' a.txt", config)).toBe("approved");
  expect(verdict("sort -o out f", config)).toBe("unsafe-option");
  expect(verdict("uniq a.txt out", config)).toBe("unsafe-option");
  expect(verdict("jq -f prog.jq", config)).toBe("unsafe-option");
  expect(verdict("awk '{system(\"rm x\")}'", config)).toBe("unsafe-option");
  expect(verdict("sort .env", config)).toBe("sensitive-path");
});

describe("compound commands", () => {
  test.each([
    "ls a; cat b",
    "git status && git diff",
    "git diff --quiet || git status",
  ])("approves %s: every step is read-only", (command) => {
    expect(verdict(command)).toBe("approved");
  });

  test.each([
    ["grep x; rm -rf /", "not-allowed"],
    ["ls && rm x", "not-allowed"],
    ["ls || rm x", "not-allowed"],
    ["pnpm test && curl x", "not-allowed"],
    ["pnpm test; curl x", "not-allowed"],
    ["rm x; ls", "not-allowed"],
    ["rm x && ls", "not-allowed"],
    ["ls; rm x; cat a", "not-allowed"],
    ["git diff --quiet || git push", "not-allowed"],
    ["ls; sed -i s/a/b/e f", "unsafe-option"],
    ["git status; git branch new", "unsafe-option"],
    ["ls; cat ../x", "outside-root"],
    ["cat a && cat .env", "sensitive-path"],
    ["cat .env; ls", "sensitive-path"],
    ["git log || cat .git/config", "sensitive-path"],
    ["ls; FOO=1 ls", "program"],
  ])("asks on %s: one step isn't read-only (%s)", (command, reason) => {
    expect(verdict(command)).toBe(reason);
  });
});

describe("cd", () => {
  test.each([
    "cd packages/x",
    "cd packages/x && grep -n foo bar.ts",
    "cd src && cat ../package.json",
    "cd src && cd .. && git status",
    "cd src; ls",
    `cd ${CWD}/src && ls`,
    "cd src && git log | head -3",
    "ls && cd src && cat a.ts",
    // `&&` runs only where the previous cd succeeded
    "cd src && cd lib && cat ../../package.json",
    "cd a || cd b && cat ../package.json",
    "cd a || cd b; ls",
  ])("approves %s", (command) => {
    expect(verdict(command)).toBe("approved");
  });

  test.each([
    ["cd ..", "outside-root"],
    ["cd .. && ls", "outside-root"],
    ["cd /tmp && ls", "outside-root"],
    ["cd ../other && cat x", "outside-root"],
    ["cd src && cat ../../x", "outside-root"],
    // the next step may run where the shell was if cd failed
    ["cd src; cat ../package.json", "outside-root"],
    ["cd src || cat ../package.json", "outside-root"],
    ["cd src && ls || cat ../package.json", "outside-root"],
    // a failure after a successful chain leaves the shell in an earlier directory
    ["cd src && cd lib; cat ../../package.json", "outside-root"],
    ["cd src; cd ..", "outside-root"],
    ["cd a || cd b; cat ../x", "outside-root"],
    ["FOO=1 cd src", "program"],
    ["cd .ssh && ls", "sensitive-path"],
    ["cd .git && cat config", "sensitive-path"],
    ["cd src && cat ../.env", "sensitive-path"],
    ["cd ~", "outside-root"],
    ["cd src | ls", "syntax"],
    ["ls | cd src", "syntax"],
    ["cd", "unsafe-option"],
    ["cd -", "unsafe-option"],
    ["cd -P src", "unsafe-option"],
    ["cd -- src", "unsafe-option"],
    ["cd +1", "unsafe-option"],
    // zsh's two-argument cd substitutes one for the other in the cwd
    ["cd a b", "unsafe-option"],
    ["cd src && rm x", "not-allowed"],
    ["rm x; cd src", "not-allowed"],
    ["cd src && git push", "not-allowed"],
  ])("asks on %s (%s)", (command, reason) => {
    expect(verdict(command)).toBe(reason);
  });

  test("resolves against the shell's cwd", () => {
    const inSrc = (command: string) =>
      autoApproveVerdict(command, DEFAULTS, { root: CWD, cwd: `${CWD}/src` });
    expect(inSrc("cd .. && ls")).toBe("approved");
    expect(inSrc("cd ../.. && ls")).toBe("outside-root");
  });

  test("is a built-in, so replacing the defaults drops it", () => {
    const replaced = { defaults: false, commands: ["ls"] };
    expect(verdict("cd src && ls", replaced)).toBe("not-allowed");
  });
});

describe("brace expansion", () => {
  /** One `{w0,w1,…}` group expanding to `count` words. */
  const alternatives = (count: number) =>
    `{${Array.from({ length: count }, (_, i) => `w${i}`).join(",")}}`;

  test.each([
    "ls {a,b}",
    "wc -l {a,b}.ts",
    "cat src/{a,b}.ts",
    "cat a{,.bak}",
    "cat {a,b}/{c,d}.ts",
    "cat '{a,b}'",
    "grep -n foo {src,test}/a.ts | head",
    // the cap is 64 words from one word: six pairs, or one group of 64
    "ls {a,b}{c,d}{e,f}{g,h}{i,j}{k,l}",
    `ls ${alternatives(64)}`,
  ])("approves %s", (command) => {
    expect(verdict(command)).toBe("approved");
  });

  test.each([
    // each expanded word is checked like one written out
    ["cat {a,.env}", "sensitive-path"],
    ["cat src/{a.ts,../../x}", "outside-root"],
    ["cat {a,/etc/passwd}", "outside-root"],
    ["ls {.,..}", "outside-root"],
    ["cd {a,b}", "unsafe-option"],
    ["ls; {rm,x} y", "syntax"],
    // tilde and zsh's `=` expand after braces
    ["cat {~,a}/x", "syntax"],
    ["cat {=ls,a}", "syntax"],
    // forms this parser doesn't expand
    ["{ls,cat} x", "syntax"],
    ["ls {a}", "syntax"],
    ["ls {1..3}", "syntax"],
    ["ls {a,{b,c}}", "syntax"],
    ["ls {a,b", "syntax"],
    ["ls a,b}", "syntax"],
    ["ls {'a',b}", "syntax"],
    ["ls {,}", "syntax"],
    ["ls {a, b}", "syntax"],
    ["ls {a;b}", "syntax"],
    ["ls {a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}", "syntax"],
    [`ls ${alternatives(65)}`, "syntax"],
    ["ls {a,b,c}{d,e}{f,g}{h,i}{j,k}{l,m}", "syntax"],
    // an expanded word is checked against the program's own guards
    ["git log {--output=f,x}", "unsafe-option"],
    ["find . {-delete,-x}", "unsafe-option"],
  ])("asks on %s (%s)", (command, reason) => {
    expect(verdict(command)).toBe(reason);
  });
});

describe("redirects", () => {
  test.each([
    "ls 2>&1",
    "ls 2>/dev/null",
    "ls >/dev/null",
    "ls > /dev/null",
    "ls 2> /dev/null",
    "git status 2>&1 | head -3",
    "grep -n foo a.ts 2>/dev/null; cat b.ts",
    "2>/dev/null ls",
    "git diff --quiet >/dev/null || git status",
  ])("approves %s: stderr merged or output dropped", (command) => {
    expect(verdict(command)).toBe("approved");
  });

  test("the redirect's own words are never taken for paths or programs", () => {
    expect(verdict("ls >/dev/null | tee f")).toBe("not-allowed");
    expect(verdict("rm x 2>/dev/null")).toBe("not-allowed");
    expect(verdict("cat ../x 2>/dev/null")).toBe("outside-root");
  });
});

describe("pipes", () => {
  test.each([
    "cat a.ts | head",
    "git status -sb | head -3",
    "git log --oneline | grep fix | wc -l",
    "cat a.ts | sed -n 1,5p",
    "grep -n foo a.ts | sort",
    "grep -n foo a.ts | sort -u -k 2",
    "cat a.txt | sort | uniq -c | sort -rn",
    "cat a.csv | cut -d, -f1",
    "cat a.txt | tr a-z A-Z",
    "cat a.txt | nl",
    "cat a.txt | column -t",
    "cat package.json | jq .name",
    "cat package.json | jq -r '.scripts | keys[]'",
    "ls -l | awk '{print $1}'",
    "ls -l | awk -F: '/ts/ {n++} END {print n}'",
    // the same programs on a file inside the root: the path checks are live, not blanket
    "ls | awk '{print}' a.txt",
    "ls | jq . a.json",
    "ls | uniq a.txt",
    "ls | cut -f1 a.txt",
    "ls | nl a.txt",
    "ls | column -t a.txt",
  ])("approves %s", (command) => {
    expect(verdict(command)).toBe("approved");
  });

  test.each([
    ["ls | sh", "not-allowed"],
    ["cat a | bash", "not-allowed"],
    ["cat a | xargs rm", "not-allowed"],
    ["cat a | tee f", "not-allowed"],
    ["ls | sort | sh", "not-allowed"],
    // the pipe-only programs never start a pipeline or stand alone
    ["sort a.txt", "not-allowed"],
    ["jq . a.json", "not-allowed"],
    ["awk '{print}' a.txt", "not-allowed"],
    ["sort a.txt | head", "not-allowed"],
    ["ls; sort a.txt", "not-allowed"],
    ["ls && jq . a.json", "not-allowed"],
    // the right side gets the same path checks
    ["ls | grep x ../y", "outside-root"],
    ["ls | sort .env", "sensitive-path"],
    ["ls | sed -i s/a/b/e f", "unsafe-option"],
    // so does every pipe-only program that reads a named file instead of stdin
    ["ls | awk '{print}' .env", "sensitive-path"],
    ["ls | awk -F: '{print}' /etc/passwd", "outside-root"],
    ["ls | awk -v x=1 '{print}' ../x", "outside-root"],
    ["ls | jq . ../x", "outside-root"],
    ["ls | jq . .env", "sensitive-path"],
    ["ls | uniq .env", "sensitive-path"],
    ["ls | uniq ../x", "outside-root"],
    ["ls | cut -f1 /etc/passwd", "outside-root"],
    ["ls | cut -f1 .env", "sensitive-path"],
    ["ls | nl .env", "sensitive-path"],
    ["ls | nl ../x", "outside-root"],
    ["ls | column -t ../x", "outside-root"],
    ["ls | column -t .env", "sensitive-path"],
  ])("asks on %s (%s)", (command, reason) => {
    expect(verdict(command)).toBe(reason);
  });

  test.each([
    // writes, runs a program or reads a file list
    "ls | sort -o out",
    "ls | sort -no out",
    "ls | sort --output=out",
    "ls | sort --out=out",
    "ls | sort --compress-program=sh",
    "ls | sort -T /tmp",
    "ls | sort --temporary-directory=x",
    "ls | sort --files0-from=list",
    "ls | sort --random-source=x",
    // a second file operand is the output
    "ls | uniq - out",
    "ls | uniq a.txt out",
    "ls | uniq -f 1 a.txt out",
    "ls | uniq --skip-fields 1",
    "ls | uniq --bogus",
    // jq reads programs, modules or variables from files, or the environment
    "ls | jq -f prog.jq",
    "ls | jq -rf prog.jq",
    "ls | jq --from-file prog.jq",
    "ls | jq --rawfile x a.txt .",
    "ls | jq --slurpfile x a.json .",
    "ls | jq --argfile x a.json .",
    "ls | jq -L lib .",
    "ls | jq env",
    "ls | jq '$ENV.HOME'",
    "ls | jq 'import \"a\" as a; .'",
    "ls | jq 'include \"a\"; .'",
    "ls | jq -n 'modulemeta'",
    // awk runs commands, writes, reads other files or the environment
    "ls | awk '{system(\"rm x\")}'",
    "ls | awk '{print > \"out\"}'",
    "ls | awk '{print >> \"out\"}'",
    "ls | awk '{print | \"sh\"}'",
    "ls | awk '{getline x < \"/etc/passwd\"}'",
    "ls | awk 'BEGIN {ARGV[1] = \"/etc/passwd\"; ARGC = 2}'",
    "ls | awk 'BEGIN {print ENVIRON[\"HOME\"]}'",
    // gawk's SYMTAB reaches ENVIRON, ARGV and ARGC by a name built from pieces
    'ls | awk \'NR==1{for(k in SYMTAB["ENV" "IRON"])print k"="SYMTAB["ENV" "IRON"][k]}\'',
    'ls | awk \'BEGIN{SYMTAB["AR" "GV"][1]=".e" "nv";SYMTAB["AR" "GC"]=2}1\'',
    "ls | awk 'BEGIN{for(f in FUNCTAB)print f}'",
    "ls | awk '@include \"x\"'",
    "ls | awk -f prog.awk",
    "ls | awk -e '{print}'",
    "ls | awk --dump-variables=out '{print}'",
    "ls | awk -d '{print}'",
    "ls | awk",
  ])("asks on %s: a write, a program or a file it doesn't name", (command) => {
    expect(verdict(command)).toBe("unsafe-option");
  });

  test("single-quoted $, backticks, \\ and ! are literal for text tools only", () => {
    expect(verdict("grep -n 'foo$' a.ts")).toBe("approved");
    expect(verdict("cat a.txt | tr -d '\\r'")).toBe("approved");
    expect(verdict("rg -n '`x`' src")).toBe("approved");
    expect(verdict('grep -n "foo$" a.ts')).toBe("syntax");
    expect(verdict("grep -n foo$ a.ts")).toBe("syntax");
    // these hand arguments on to a shell or an expander of their own
    expect(verdict("pnpm test '$(id)'")).toBe("syntax");
    expect(verdict("git log '--format=$(id)'")).toBe("syntax");
    const make = { defaults: true, commands: ["make check"] };
    expect(verdict("make check 'X=$(shell id)'", make)).toBe("syntax");
    expect(verdict("ls | awk '{print $1}' | make check", make)).toBe(
      "approved",
    );
  });

  test("the pipe-only programs are built-ins, so replacing the defaults drops them", () => {
    const replaced = { defaults: false, commands: ["ls"] };
    expect(verdict("ls | sort", replaced)).toBe("not-allowed");
    expect(
      verdict("ls | sort", { defaults: false, commands: ["ls", "sort"] }),
    ).toBe("approved");
  });
});

test("an entry is plain leading words", () => {
  expect(parseCommandEntry("git tag --list")).toEqual(["git", "tag", "--list"]);
  expect(parseCommandEntry("  make   check ")).toEqual(["make", "check"]);
  for (const bad of [
    "",
    "  ",
    "ls; rm x",
    "ls | sh",
    "ls > f",
    "ls >/dev/null",
    "make check 2>&1",
    "ls && make",
    "ls | head",
    "$(id)",
    "A=1 ls",
  ])
    expect(parseCommandEntry(bad)).toBeUndefined();
});

describe("a backslash in double quotes", () => {
  const sub = `cd ${CWD}/sub && `;

  test.each([
    'grep -n "PanelRoute\\|^import\\|^export" AppShell.jsx',
    "grep -nE \"^\\s*'?(bell|mail)'?:\" glyphs.js | head",
    'grep -n "donateProfile\\|buildProfile\\|profile(" lib/server/pages/view.ts | head',
    'grep -n "^describe\\|^})" AppShell.dom.spec.tsx | tail -12',
  ])(
    "runs for a text tool, inside the worktree and after a cd: %s",
    (command) => {
      expect(verdict(command)).toBe("approved");
      expect(verdict(sub + command)).toBe("approved");
    },
  );

  test.each([
    'grep "a\\$b"',
    'grep "a\\"b"',
    'grep "a\\\\b"',
    'grep "\\`x\\`"',
    'grep "a$b"',
    'grep "a!b"',
    'grep "a\\!b"',
    'grep "a\\',
  ])("still asks on %s", (command) => {
    expect(verdict(command)).toBe("syntax");
  });

  test("other programs, and an unquoted backslash, still ask", () => {
    const make = { defaults: true, commands: ["make"] };
    expect(verdict('pnpm test "a\\|b"')).toBe("syntax");
    expect(verdict('make "x\\y"', make)).toBe("syntax");
    expect(verdict("grep a\\|b file")).toBe("syntax");
  });

  test("zsh escapes `\\!` and bash with history keeps the backslash, so it asks", () => {
    expect(verdict('grep "a\\!b"')).toBe("syntax");
  });

  test("the path checks still run on the text with its backslash", () => {
    expect(verdict('grep p "/etc/pa\\sswd"')).toBe("outside-root");
    expect(verdict('grep p "secrets\\x/a"')).toBe("sensitive-path");
    expect(verdict('grep p ".env\\x"')).toBe("sensitive-path");
    expect(verdict('grep p "src\\x/a"')).toBe("approved");
  });

  test("a literal word asks only its own step, never a later one", () => {
    const make = { defaults: true, commands: ["make check"] };
    expect(verdict('grep "a\\|b" f | pnpm test')).toBe("approved");
    expect(verdict('grep "a\\|b" f && pnpm test')).toBe("approved");
    expect(verdict('grep "a\\|b" f | make check', make)).toBe("approved");
    expect(verdict('ls | make "x\\y"', make)).toBe("syntax");
  });

  test("a backslash word glued to other quoted or plain text is still one literal word", () => {
    expect(verdict('grep "a\\|b"c f')).toBe("approved");
    expect(verdict("grep 'x'\"a\\|b\" f")).toBe("approved");
  });

  test("the per-program checks see the text bash passes, backslash included", () => {
    // `1\,2p` is not the sed script `1,2p`, so it asks
    expect(verdict('sed -n "1,2p" a.ts')).toBe("approved");
    expect(verdict('sed -n "1\\,2p" a.ts')).toBe("unsafe-option");
    // `\-g` is a pattern, not rg's `-g`
    expect(verdict('rg "\\-g" src')).toBe("approved");
    expect(verdict('rg "-g" src')).toBe("unsafe-option");
  });
});
