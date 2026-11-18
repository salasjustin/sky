import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { type AutoApprove, autoApproveVerdict } from "./auto-approve.js";

const ROOT = "/workspace/worktrees/agt_1";
const SCRATCH = "/tmp/sky-runner-1/scratch-run_x";
const DEFAULTS: AutoApprove = { defaults: true, commands: [] };
const verdict = (command: string, config = DEFAULTS) =>
  autoApproveVerdict(command, config, { root: ROOT, scratch: SCRATCH });

describe("rg globs", () => {
  test.each([
    "rg -n 'x' src --glob '!node_modules'",
    "rg -n 'x' src -g '*.ts'",
    "rg -n x src -g '!*.test.ts' -g '*.tsx'",
    "rg -n x src --glob='**/*.ts'",
    "rg -n x src --iglob '!dist'",
    "rg -n x src -g'!dist'",
    "rg -n x -g '*.ts'",
    "rg -n x -g '**/*.md'",
    "rg -n x -g '!node_modules'",
  ])("%s runs: a glob filters, the paths are still checked", (command) => {
    expect(verdict(command)).toBe("approved");
  });

  test.each([
    ["rg x src -g '*'", "unsafe-option"],
    ["rg x src -g '.env'", "unsafe-option"],
    ["rg x src -g '*.pem'", "unsafe-option"],
    // rg's `*` matches a leading dot, and a matching glob beats the hidden and gitignore filters
    ["rg -n . -g '*.env'", "unsafe-option"],
    ["rg -n . -g '*.local'", "unsafe-option"],
    ["rg -n . --iglob '*.NPMRC'", "unsafe-option"],
    ["rg -n . -g '**/*.vars'", "unsafe-option"],
    ["rg -n . -g '*.TS'", "unsafe-option"],
    ["rg x src -g", "unsafe-option"],
    ["rg x src -ng '*.ts'", "unsafe-option"],
    ["rg x ../ -g '*.ts'", "outside-root"],
    ["rg x .env -g '*.ts'", "sensitive-path"],
  ])("%s still asks (%s)", (command, reason) => {
    expect(verdict(command)).toBe(reason);
  });

  test("a config or data extension asks while a code extension or an exclusion runs", () => {
    expect(verdict("rg -n x src -g '*.json'")).toBe("unsafe-option");
    expect(verdict("rg -n x src -g '*.yaml'")).toBe("unsafe-option");
    expect(verdict("rg -n x src -g '*.ts'")).toBe("approved");
    expect(verdict("rg -n x src --glob '!node_modules'")).toBe("approved");
  });
});

describe("a quoted ~", () => {
  test("is text, so a pattern may be one", () => {
    expect(verdict("rg -n '~' src/a.ts")).toBe("approved");
    expect(verdict('rg -n "~" src')).toBe("approved");
  });

  test("an unquoted one with no home, or one with a path after it, still asks", () => {
    expect(verdict("cat ~")).toBe("outside-root");
    expect(verdict("cat ~/x")).toBe("outside-root");
    expect(verdict("rg x '~/.ssh'")).toBe("outside-root");
  });
});

describe("$?", () => {
  test.each([
    "pnpm test; echo exit=$?",
    'pnpm test 2>&1 | tail -5; echo "exit $?"',
    "pnpm lint && echo $?",
  ])("%s runs: echo only prints it", (command) => {
    expect(verdict(command)).toBe("approved");
  });

  test.each([
    ["cat $?", "syntax"],
    ["ls $?", "syntax"],
    ["echo $$", "syntax"],
    ["echo $1", "syntax"],
    ["echo $" + "{x:-y}", "syntax"],
    ["echo $(echo 1)", "syntax"],
  ])("%s asks (%s)", (command, reason) => {
    expect(verdict(command)).toBe(reason);
  });
});

describe("a variable the command set", () => {
  test.each([
    `S=${SCRATCH}; cat $S/a.md`,
    `S=${SCRATCH}; cat "$S/a.md"`,
    `S=${SCRATCH}; cat \${S}/a.md`,
    `S=${SCRATCH}; ls $S; cat $S/b.md`,
    `S="${SCRATCH}"; cat $S/a.md`,
    `S=src; cat $S/a.ts`,
    `S=src; S=lib; cat $S/a.ts`,
    `S=${SCRATCH} && cat $S/a.md`,
  ])("%s runs", (command) => {
    expect(verdict(command)).toBe("approved");
  });

  test.each([
    // every use is checked as if written out
    ["S=/etc; cat $S/passwd", "outside-root"],
    ["S=/tmp/other; cat $S/a.md", "outside-root"],
    ["S=..; cat $S/x", "outside-root"],
    ["S=.env; cat $S", "sensitive-path"],
    ["S=src; S=.ssh; cat $S/id", "sensitive-path"],
    ["S=rm; $S -rf x", "not-allowed"],
    ["S=curl; $S example.com", "not-allowed"],
    ["S=/bin/ls; $S", "program"],
    // not one the command set, or not surely set
    ["cat $S/a.md", "syntax"],
    ["S=src; cat $T/a.md", "syntax"],
    ["S=src; cat a$S", "syntax"],
    ["S=src; cat $S$S", "syntax"],
    ["false && S=src; cat $S/a.md", "syntax"],
    ["pnpm test && S=src; cat $S/a.md", "syntax"],
    ["false || S=src; cat $S/a.md", "syntax"],
    ["S=src && S=lib; cat $S/a.md", "program"],
    ["ls | S=src; cat $S/a.md", "syntax"],
    ["S=src ls", "program"],
    ['"S=src"; cat $S/a.md', "syntax"],
    // values and names that aren't plain
    ["S=; cat $S/a.md", "syntax"],
    ["S='a b'; cat $S", "syntax"],
    ["S='$x'; cat $S", "syntax"],
    ["S=~/x; cat $S", "syntax"],
    ["S=*; cat $S", "syntax"],
    ["PATH=src; ls", "program"],
    ["HOME=src; cat $HOME/x", "syntax"],
    ["IFS=x; cat a", "program"],
    ["GIT_DIR=x; git status", "program"],
    ["S={a,b}; cat $S", "syntax"],
  ])("%s asks (%s)", (command, reason) => {
    expect(verdict(command)).toBe(reason);
  });

  test.each([
    // bash resets `$_` to the previous command's last argument
    ["_=src; echo /proc/self/environ; cat $_", "syntax"],
    ["_=src/a.ts; echo /home/u/.bashrc; cat >> $_ <<'EOF'\nx\nEOF", "syntax"],
    // bash ignores an assignment to FUNCNAME, so `$FUNCNAME` stays empty
    ["FUNCNAME=src; cat $FUNCNAME/etc/passwd", "syntax"],
    ["RANDOM=src; cat $RANDOM", "syntax"],
    ["SECONDS=src; cat $SECONDS", "syntax"],
    ["funcstack=src; cat $funcstack", "syntax"],
    ["status=src; cat $status", "syntax"],
  ])("%j asks: the shell sets that name itself (%s)", (command, reason) => {
    expect(verdict(command)).toBe(reason);
  });

  test.each([
    // zsh's `:h` takes the dirname, so this reads beside the worktree
    `S=${ROOT}/src; cat $S:h:h/other/x`,
    `S=${ROOT}/src; cat "$S:h:h/other/x"`,
    // zsh's `[1,0]` subscript is empty, so this reads /etc/passwd
    `S=src; cat "$S[1,0]/etc/passwd"`,
    `S=src; cat $S[1]`,
  ])("%s asks: zsh modifies or subscripts an unbraced variable", (command) => {
    expect(verdict(command)).toBe("syntax");
  });

  test("a braced variable followed by : or [ is plain text after it", () => {
    expect(verdict(`S=src; cat \${S}:x`)).toBe("approved");
    expect(verdict(`S=src; cat "\${S}[1]"`)).toBe("approved");
  });
});

describe("date, true and sleep", () => {
  test.each([
    "date",
    "date -u",
    "date +%s",
    "date -u '+%Y-%m-%d %H:%M'",
    "true",
    "sleep 1",
    "sleep 0.5",
    "sleep 60",
    "pnpm test; sleep 5; pnpm test",
  ])("%s runs", (command) => {
    expect(verdict(command)).toBe("approved");
  });

  test.each([
    ["date -s 12:00", "unsafe-option"],
    ["date -f x", "unsafe-option"],
    ["sleep 61", "unsafe-option"],
    ["sleep", "unsafe-option"],
    ["sleep 5 6", "unsafe-option"],
    ["sleep 1e9", "unsafe-option"],
    ["true x", "unsafe-option"],
  ])("%s asks (%s)", (command, reason) => {
    expect(verdict(command)).toBe(reason);
  });

  test("need the default commands", () => {
    const off: AutoApprove = { defaults: false, commands: ["ls"] };
    expect(verdict("sleep 5", off)).toBe("not-allowed");
    expect(verdict("date -u", off)).toBe("not-allowed");
  });
});

describe("timeout and env -u", () => {
  test.each([
    "timeout 300 pnpm test",
    "timeout 5 ls src",
    "timeout 1.5m cat src/a.ts",
    "env -u ANTHROPIC_API_KEY pnpm test",
    "env -u A -u B ls",
    "timeout 60 env -u A pnpm typecheck",
    "timeout 300 pnpm test 2>&1 | tail -5",
    "pnpm test | timeout 5 head",
    "timeout 300 pnpm --filter @sky/api exec vitest --run 'src/a.spec.ts' 2>&1 | rg 'FAIL'",
  ])("%s runs: judged by the command it runs", (command) => {
    expect(verdict(command)).toBe("approved");
  });

  test.each([
    ["timeout 5 curl x", "not-allowed"],
    ["env -u A sudo ls", "not-allowed"],
    ["timeout 5 git push", "not-allowed"],
    ["timeout 5 cat .env", "sensitive-path"],
    ["env -u A cat /etc/passwd", "outside-root"],
    ["timeout 5 ./run.sh", "program"],
    // only these forms
    ["timeout", "not-allowed"],
    ["timeout 5", "not-allowed"],
    ["timeout -k 5 10 ls", "not-allowed"],
    ["timeout x ls", "not-allowed"],
    ["env", "not-allowed"],
    ["env ls", "not-allowed"],
    ["env A=1 ls", "not-allowed"],
    ["env -u", "not-allowed"],
    ["env -u A", "not-allowed"],
    ["env -i ls", "not-allowed"],
    ["env -u 'A B' ls", "not-allowed"],
    ["env -u A=1 ls", "not-allowed"],
  ])("%s asks (%s)", (command, reason) => {
    expect(verdict(command)).toBe(reason);
  });
});

describe("test and lint runners through pnpm exec", () => {
  test.each([
    "pnpm exec vitest",
    "pnpm exec vitest run packages/shared",
    "pnpm exec vitest --run 'src/routes/$slug.db.spec.ts'",
    "pnpm exec vitest run -t 'a b'",
    "pnpm exec tsc -b",
    "pnpm exec tsc --noEmit -p packages/shared",
    "pnpm --filter @sky/api exec vitest run src",
    "pnpm -r exec tsc --noEmit",
    "pnpm exec biome check",
    "pnpm exec biome check packages/shared/src",
    "pnpm exec biome check --write packages/shared/src",
    "pnpm exec biome lint apps/api/src/internal.ts",
    "pnpm --filter @sky/api exec biome lint src",
    "pnpm exec biome format --write apps/site/a.tsx 2>&1 | tail -1",
  ])("%s runs", (command) => {
    expect(verdict(command)).toBe("approved");
  });

  test.each([
    ["pnpm exec rm x", "not-allowed"],
    ["pnpm exec node x.js", "not-allowed"],
    ["pnpm exec biome", "not-allowed"],
    ["pnpm exec biome ci", "not-allowed"],
    ["pnpm exec biome migrate", "not-allowed"],
    ["pnpm exec", "not-allowed"],
    ["pnpm exec -c vitest", "unsafe-option"],
    ["pnpm exec vitest --outputFile=/etc/x", "outside-root"],
    ["pnpm exec tsc --outDir /tmp/x", "outside-root"],
    ["pnpm exec tsc --outDir ../x", "outside-root"],
    ["pnpm exec biome format --write .env", "sensitive-path"],
    ["pnpm exec biome check --write .git", "sensitive-path"],
    ["pnpm exec biome check --write .claude/settings.json", "sensitive-path"],
    ["pnpm exec vitest 'a$(rm x)' && pnpm install", "not-allowed"],
  ])("%s asks (%s)", (command, reason) => {
    expect(verdict(command)).toBe(reason);
  });

  test.each([
    "pnpm exec vitest --inspect=0.0.0.0:9229",
    "pnpm exec vitest --inspect",
    "pnpm exec vitest --inspect-brk",
    "pnpm exec vitest --ui --api.host=0.0.0.0",
    "pnpm exec vitest --ui",
    "pnpm exec vitest --api 51204",
    "pnpm exec vitest --api.port=51204",
    "pnpm exec vitest --browser",
    "pnpm exec vitest --browser.enabled",
    "pnpm exec vitest --open",
    "pnpm --filter @sky/api exec vitest run src --ui",
    // script arguments already ask on any option outside a few inert ones
    "pnpm test --ui",
    "pnpm test --inspect=0.0.0.0:9229",
    "pnpm test -- --api.host=0.0.0.0",
  ])("%s asks: it opens a network listener", (command) => {
    expect(verdict(command)).toBe("unsafe-option");
  });

  test("a single-quoted $ is text to these programs only", () => {
    expect(verdict("pnpm test 'a$b'")).toBe("syntax");
    expect(verdict("pnpm lint 'a$b'")).toBe("syntax");
    expect(verdict("pnpm exec vitest 'a$b'")).toBe("approved");
  });

  test("the plain biome commands run alike", () => {
    expect(verdict("biome format --write src/a.ts")).toBe("approved");
    expect(verdict("biome check --write src")).toBe("approved");
    expect(verdict("biome lint src")).toBe("approved");
    expect(verdict("biome format --write ~x")).toBe("syntax");
    expect(verdict("biome ci")).toBe("not-allowed");
  });
});

describe("git writes in the worktree", () => {
  test.each([
    "git add -A",
    "git add .",
    "git add -A packages/operator",
    "git add src/a.ts src/b.ts",
    "git add -u -- src",
    "git commit -m 'Add x'",
    'git commit -m "Add x: y; z"',
    "git commit -qm 'Add x'",
    "git commit -q -m 'Add x'",
    "git commit -am 'Add x'",
    "git commit -m 'a' -m 'b'",
    "git commit -m '/etc/passwd' -- src/a.ts",
    "git commit -m 'text with `ticks` and $vars'",
    `git commit -F ${SCRATCH}/msg.txt`,
    "git commit -F msg.txt",
    "git add -A && git commit -qm 'x'",
    "git restore src/a.ts",
    "git restore --staged src/a.ts",
    "git restore -S -W .",
    "git checkout -- src/a.ts",
    "git checkout -- .",
    "git stash",
    "git stash push -m 'wip' -- src",
    "git stash -u",
    "git stash push -k -q -m 'wip' src/a.ts",
    "git stash list",
  ])("%s runs", (command) => {
    expect(verdict(command)).toBe("approved");
  });

  test.each([
    // the network and the config stay asked about
    ["git push", "not-allowed"],
    ["git push origin main", "not-allowed"],
    ["git remote add x y", "not-allowed"],
    ["git config user.name x", "not-allowed"],
    ["git fetch", "not-allowed"],
    ["git pull", "not-allowed"],
    ["git clone x", "not-allowed"],
    ["git reset --hard", "not-allowed"],
    ["git rm x", "not-allowed"],
    ["git tag x", "not-allowed"],
    ["git merge x", "not-allowed"],
    ["git rebase main", "not-allowed"],
    ["git cherry-pick x", "not-allowed"],
    ["git worktree add ../x", "not-allowed"],
    // only the forms listed
    ["git commit", "unsafe-option"],
    ["git commit -m", "unsafe-option"],
    ["git commit --amend -m x", "unsafe-option"],
    ["git commit -m x --no-verify", "unsafe-option"],
    ["git commit -m x --author=a", "unsafe-option"],
    ["git commit -F -", "unsafe-option"],
    ["git commit -F", "unsafe-option"],
    ["git commit -m x ':(top)y'", "unsafe-option"],
    ["git add -f .env.example", "unsafe-option"],
    ["git add -p", "unsafe-option"],
    ["git add ':/'", "unsafe-option"],
    ["git add --chmod=+x x", "unsafe-option"],
    ["git restore", "unsafe-option"],
    ["git restore --source=HEAD~2 x", "unsafe-option"],
    ["git checkout main", "unsafe-option"],
    ["git checkout -b x", "unsafe-option"],
    ["git checkout HEAD -- x", "unsafe-option"],
    ["git checkout --", "unsafe-option"],
    ["git stash branch x", "unsafe-option"],
    ["git stash -p", "unsafe-option"],
    ["git stash -a", "unsafe-option"],
    // every worktree of the repository shares one stash list, other agents' entries included
    ["git stash pop", "unsafe-option"],
    ["git stash apply", "unsafe-option"],
    ["git stash apply 'stash@{3}'", "unsafe-option"],
    ["git stash drop", "unsafe-option"],
    ["git stash show -p", "unsafe-option"],
    ["git stash show", "unsafe-option"],
    ["git -c core.hooksPath=x commit -m y", "not-allowed"],
    ["git commit -c core.editor=x -m y", "unsafe-option"],
    // outside the worktree and scratch, or a secret or a hook
    ["git add ../x", "outside-root"],
    ["git add /etc/passwd", "outside-root"],
    ["git add ~/x", "outside-root"],
    ["git commit -F /tmp/other/msg", "outside-root"],
    ["git commit -m x -- ../y", "outside-root"],
    ["git restore /etc/hosts", "outside-root"],
    ["git add .env", "sensitive-path"],
    ["git add -A secrets/token.json", "sensitive-path"],
    ["git add .git/config", "sensitive-path"],
    ["git add .git/hooks/pre-commit", "sensitive-path"],
    ["git restore .git/config", "sensitive-path"],
    ["git checkout -- .claude/settings.json", "sensitive-path"],
    ["git commit -F .env", "sensitive-path"],
  ])("%s asks (%s)", (command, reason) => {
    expect(verdict(command)).toBe(reason);
  });

  test("need the default commands", () => {
    const off: AutoApprove = { defaults: false, commands: ["ls"] };
    expect(verdict("git add -A", off)).toBe("not-allowed");
    expect(verdict("git commit -m x", off)).toBe("not-allowed");
    expect(verdict("sed -i 's/a/b/' a.ts", off)).toBe("not-allowed");
    expect(verdict("mkdir -p a", off)).toBe("not-allowed");
    expect(verdict("pnpm exec tsc", off)).toBe("not-allowed");
  });

  test("an entry may add to them", () => {
    const more: AutoApprove = { defaults: true, commands: ["git tag"] };
    expect(verdict("git tag v1", more)).toBe("approved");
    expect(verdict("git tag v1")).toBe("not-allowed");
  });
});

describe("sed -i", () => {
  test.each([
    "sed -i 's/foo/bar/g' src/a.ts",
    "sed -i 's/foo/bar/' a.ts b.ts",
    "sed -i.bak 's/foo/bar/' a.ts",
    "sed -ni 'p' a.ts",
    "sed --in-place 's|a|b|' a.ts",
    "sed --in-place=.orig 's#a#b#2' a.ts",
    "sed -i '3d' a.ts",
    "sed -i '2,4d' a.ts",
    "sed -i '/old/d' a.ts",
    "sed -i '$d' a.ts",
    "sed -i 's/a/b/;s/c/d/g' a.ts",
    "sed -i '1,3s/a/b/gI' a.ts",
    `sed -i 's/a/b/' ${SCRATCH}/a.md`,
    "sed -i -E 's/a+/b/' a.ts",
    "sed -i 's/\\$x/y/' a.ts",
  ])("%s runs", (command) => {
    expect(verdict(command)).toBe("approved");
  });

  test.each([
    ["sed -i 's/a/b/e' a.ts", "unsafe-option"],
    ["sed -i 's/a/b/w out' a.ts", "unsafe-option"],
    ["sed -i '1w out' a.ts", "unsafe-option"],
    ["sed -i '1r b' a.ts", "unsafe-option"],
    ["sed -i '1e rm' a.ts", "unsafe-option"],
    ["sed -i 'y/a/b/' a.ts", "unsafe-option"],
    ["sed -i '{p}' a.ts", "unsafe-option"],
    ["sed -i -f s.sed a.ts", "unsafe-option"],
    ["sed -i -e 's/a/b/' a.ts", "unsafe-option"],
    ["sed -i 's/a/b/'", "unsafe-option"],
    ["sed -i", "unsafe-option"],
    ["sed -i.b/x 's/a/b/' a.ts", "unsafe-option"],
    ["sed -i* 's/a/b/' a.ts", "syntax"],
    ["sed -i 's/a/b/' -- -x", "unsafe-option"],
    ["sed -i 's/a/b/' ../a.ts", "outside-root"],
    ["sed -i 's/a/b/' /etc/hosts", "outside-root"],
    ["sed -i 's/a/b/' .env", "sensitive-path"],
    ["sed -i 's/a/b/' .git/config", "sensitive-path"],
    ["sed -i 's/a/b/' .git/hooks/pre-commit", "sensitive-path"],
    ["sed -i 's/a/b/' .claude/settings.json", "sensitive-path"],
    ["sed -i 's/a/b/' id_rsa", "sensitive-path"],
  ])("%s asks (%s)", (command, reason) => {
    expect(verdict(command)).toBe(reason);
  });

  test("the read-only forms are unchanged", () => {
    expect(verdict("sed -n 1,5p a.ts")).toBe("approved");
    expect(verdict("sed 's/a/b/' a.ts")).toBe("unsafe-option");
    expect(verdict("cat a | sed -n 3p")).toBe("approved");
  });
});

describe("mkdir -p", () => {
  test.each([
    "mkdir -p out",
    "mkdir -p out/a/b",
    "mkdir -p a b",
    `mkdir -p ${SCRATCH}/out`,
  ])("%s runs", (command) => {
    expect(verdict(command)).toBe("approved");
  });

  test.each([
    ["mkdir out", "not-allowed"],
    ["mkdir --parents a", "not-allowed"],
    ["mkdir -m 777 -p out", "not-allowed"],
    ["mkdir -p", "unsafe-option"],
    ["mkdir -p -m 777 out", "unsafe-option"],
    ["mkdir -p ../out", "outside-root"],
    ["mkdir -p /tmp/x", "outside-root"],
    ["mkdir -p /etc/x", "outside-root"],
    ["mkdir -p .ssh", "sensitive-path"],
    ["mkdir -p .git/hooks", "sensitive-path"],
    ["mkdir -p a/.claude", "sensitive-path"],
  ])("%s asks (%s)", (command, reason) => {
    expect(verdict(command)).toBe(reason);
  });
});

describe("cat > file <<'EOF'", () => {
  const body = "line one\n$HOME `x` $(y) \\n\nEOF";

  test.each([
    `cat > out.md <<'EOF'\n${body}`,
    `cat >> out.md <<'EOF'\n${body}`,
    `cat > ${SCRATCH}/body.md <<'EOF'\n${body}\n`,
    `cat >out.md <<'END'\nx\nEND`,
    // only a line of exactly the delimiter ends the body, and blank lines may follow it
    "cat > a <<'EOF'\nx\nEOF \nEOF",
    "cat > a <<'EOF'\nx\nEOF\n\n",
    `cat > a/b.md <<'EOF'\nEOF`,
    `S=${SCRATCH}; cat > $S/body.md <<'EOF'\n${body}`,
    `S=${SCRATCH}; cat > "$S/body.md" <<'EOF'\n${body}`,
    `cd src && cat > out.md <<'EOF'\nx\nEOF`,
    `mkdir -p ${SCRATCH}/o && cat > ${SCRATCH}/o/a.md <<'EOF'\nx\nEOF`,
  ])("%j runs: the body is plain text", (command) => {
    expect(verdict(command)).toBe("approved");
  });

  test.each([
    // the target
    ["cat > .env <<'EOF'\nx\nEOF", "sensitive-path"],
    ["cat > .git/config <<'EOF'\nx\nEOF", "sensitive-path"],
    ["cat > .git/hooks/pre-commit <<'EOF'\nx\nEOF", "sensitive-path"],
    ["cat > .claude/settings.json <<'EOF'\nx\nEOF", "sensitive-path"],
    ["cat > key.pem <<'EOF'\nx\nEOF", "sensitive-path"],
    ["cat > /etc/hosts <<'EOF'\nx\nEOF", "outside-root"],
    ["cat > ../x <<'EOF'\nx\nEOF", "outside-root"],
    ["cat > /tmp/other/x <<'EOF'\nx\nEOF", "outside-root"],
    ["cat > ~/x <<'EOF'\nx\nEOF", "syntax"],
    ["cat > $S/x <<'EOF'\nx\nEOF", "syntax"],
    ["cat > 'a b' <<'EOF'\nx\nEOF", "syntax"],
    ["cat > a;b <<'EOF'\nx\nEOF", "syntax"],
    ["cat > a* <<'EOF'\nx\nEOF", "syntax"],
    ["cat > $(x) <<'EOF'\nx\nEOF", "syntax"],
    // the delimiter and the body
    ["cat > a <<EOF\nx\nEOF", "syntax"],
    ['cat > a <<"EOF"\nx\nEOF', "syntax"],
    ["cat > a <<-'EOF'\nx\nEOF", "syntax"],
    ["cat > a <<'EOF'\nx", "syntax"],
    ["cat > a <<'EOF'\nx\nEOF\nrm -rf x", "syntax"],
    ["cat > a <<'EOF'\nx\0\nEOF", "syntax"],
    // the rest of the line
    ["cat > a <<'EOF' && rm x\nx\nEOF", "syntax"],
    ["cat > a b <<'EOF'\nx\nEOF", "syntax"],
    ["tee a <<'EOF'\nx\nEOF", "syntax"],
    ["echo > a <<'EOF'\nx\nEOF", "syntax"],
    ["rm x; cat > a <<'EOF'\nx\nEOF", "not-allowed"],
    ["echo 'x; cat > a <<'EOF'\nx\nEOF", "syntax"],
    ["ls\ncat > a <<'EOF'\nx\nEOF", "syntax"],
    ["cat <<'EOF'\nx\nEOF", "syntax"],
    ["python3 - <<'EOF'\nprint(1)\nEOF", "syntax"],
    ["bash <<'EOF'\nrm x\nEOF", "syntax"],
    ["node <<'EOF'\n1\nEOF", "syntax"],
  ])("%j asks (%s)", (command, reason) => {
    expect(verdict(command)).toBe(reason);
  });

  test("needs the default commands: cat is one of them", () => {
    const off: AutoApprove = { defaults: false, commands: ["ls"] };
    expect(verdict("cat > a <<'EOF'\nx\nEOF", off)).toBe("not-allowed");
  });
});

describe("writes keep the symlink guards", () => {
  const dir = mkdtempSync(join(tmpdir(), "auto-approve-rules-"));
  const root = join(dir, "worktree");
  const scratch = join(dir, "scratch");
  const outside = join(dir, "outside");
  for (const d of [root, scratch, outside, join(root, "src")])
    mkdirSync(d, { recursive: true });
  writeFileSync(join(outside, "target"), "");
  writeFileSync(join(root, "src/a.ts"), "");
  writeFileSync(join(outside, ".env"), "");
  symlinkSync(outside, join(root, "out-dir"));
  symlinkSync(join(outside, "target"), join(root, "out-file"));
  symlinkSync(join(outside, "not-yet"), join(root, "dangling"));
  symlinkSync(join(outside, "gone"), join(root, "src/dangling-dir"));
  symlinkSync(join(root, "src/a.ts"), join(root, "src/inside-link"));
  symlinkSync(outside, join(scratch, "to-outside"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const real = (command: string, withLstat = true) =>
    autoApproveVerdict(command, DEFAULTS, {
      root,
      scratch,
      realpath: realpathSync.native,
      ...(withLstat && {
        isSymlink: (p: string) => {
          try {
            return lstatSync(p).isSymbolicLink();
          } catch {
            return false;
          }
        },
      }),
    });

  test.each([
    "sed -i 's/a/b/' src/a.ts",
    "sed -i 's/a/b/' src/inside-link",
    "mkdir -p src/new/deeper",
    "git add src/a.ts",
    "git restore src/a.ts",
    `git commit -F ${scratch}/msg`,
    `mkdir -p ${scratch}/new`,
    `cat > ${scratch}/new.md <<'EOF'\nx\nEOF`,
    "cat > src/new.ts <<'EOF'\nx\nEOF",
  ])("%s runs", (command) => {
    expect(real(command)).toBe("approved");
  });

  test.each([
    "sed -i 's/a/b/' out-file",
    "sed -i 's/a/b/' out-dir/target",
    "git add out-file",
    "git restore out-dir/target",
    "git checkout -- out-file",
    "mkdir -p out-dir/new",
    "cat > out-dir/new.md <<'EOF'\nx\nEOF",
    "cat > out-file <<'EOF'\nx\nEOF",
    "cat > out-dir/../x <<'EOF'\nx\nEOF",
    `cat > ${scratch}/to-outside/new.md <<'EOF'\nx\nEOF`,
    `mkdir -p ${scratch}/to-outside/new`,
    `git commit -F ${scratch}/to-outside/target`,
  ])("%s asks: the link leads out", (command) => {
    expect(real(command)).toBe("outside-root");
  });

  test("a link that leads nowhere yet asks, where it can be seen", () => {
    for (const command of [
      "cat > dangling <<'EOF'\nx\nEOF",
      "mkdir -p dangling/x",
      "cat > src/dangling-dir/x.md <<'EOF'\nx\nEOF",
    ])
      expect(real(command), command).toBe("unresolvable");
    // without the hook the link's target is out of sight: the parent resolves, inside
    expect(real("cat > dangling <<'EOF'\nx\nEOF", false)).toBe("approved");
  });

  test("a read in scratch is checked on where its links lead", () => {
    expect(real(`cat ${scratch}/to-outside/target`)).toBe("outside-root");
    expect(real(`cat ${scratch}/to-outside/.env`)).toBe("sensitive-path");
    expect(real(`cat ${scratch}/to-outside/gone`)).toBe("approved");
    expect(real(`cat ${scratch}/a.md`)).toBe("approved");
  });

  test("scratch is never where the shell enters", () => {
    expect(real(`cd ${scratch}`)).toBe("outside-root");
    expect(real(`cd ${scratch} && git add -A`)).toBe("outside-root");
  });
});

describe("scratch", () => {
  test("reads and writes need the run's own directory, named by the scope", () => {
    const without = (command: string) =>
      autoApproveVerdict(command, DEFAULTS, ROOT);
    expect(verdict(`cat ${SCRATCH}/a.md`)).toBe("approved");
    expect(without(`cat ${SCRATCH}/a.md`)).toBe("outside-root");
    expect(verdict("cat /tmp/sky-runner-1/scratch-run_y/a.md")).toBe(
      "outside-root",
    );
    expect(verdict("cat /tmp/sky-runner-1/a.md")).toBe("outside-root");
    expect(verdict(`cat ${SCRATCH}/../x`)).toBe("outside-root");
    expect(without(`S=${SCRATCH}; cat $S/body.md`)).toBe("outside-root");
  });

  test("a secret name under scratch asks", () => {
    expect(verdict(`cat ${SCRATCH}/.env`)).toBe("sensitive-path");
    expect(verdict(`cat ${SCRATCH}/id_rsa`)).toBe("sensitive-path");
  });
});
