import type { AskReason } from "./auto-approve.js";

/** The worktree and the run's scratch directory the fixture's commands name. */
export const FIXTURE_ROOT = "/workspace/worktrees/agt_x";
export const FIXTURE_SCRATCH = "/tmp/sky-runner-6670/scratch-run_x";

export type FixtureCase = {
  command: string;
  /** What the default commands give it, run from `FIXTURE_ROOT` with `FIXTURE_SCRATCH` as the scratch directory. */
  verdict: "approved" | AskReason;
};

const S = FIXTURE_SCRATCH;

/**
 * Commands runs were stopped on, in the shapes they came in: the first 30 run without asking,
 * the other 30 still do, each for the reason pinned.
 */
export const FIXTURE: readonly FixtureCase[] = [
  // run without asking
  {
    command: `cd ${FIXTURE_ROOT} && git status --short | head`,
    verdict: "approved",
  },
  { command: "rg -n 'x' src --glob '!node_modules'", verdict: "approved" },
  { command: "rg -n 'x' src -g '*.ts'", verdict: "approved" },
  { command: "rg -n '~' src/a.ts", verdict: "approved" },
  { command: "pnpm test; echo exit=$?", verdict: "approved" },
  {
    command: 'pnpm test 2>&1 | tail -5; echo "exit $?"',
    verdict: "approved",
  },
  { command: `S=${S}; cat $S/body.md`, verdict: "approved" },
  { command: `S=${S}; cat "$S/a.md"`, verdict: "approved" },
  { command: "date -u", verdict: "approved" },
  { command: "true", verdict: "approved" },
  { command: "sleep 30", verdict: "approved" },
  { command: "timeout 300 pnpm test 2>&1 | tail -5", verdict: "approved" },
  { command: "env -u ANTHROPIC_API_KEY pnpm typecheck", verdict: "approved" },
  {
    command:
      "timeout 300 pnpm --filter @better-giving/app exec vitest --run 'src/routes/$slug.db.spec.ts' 2>&1 | rg 'Test Files|Tests |×|FAIL'",
    verdict: "approved",
  },
  { command: "pnpm exec tsc -b", verdict: "approved" },
  {
    command: "pnpm exec vitest run packages/shared/src/auto-approve.test.ts",
    verdict: "approved",
  },
  {
    command: `S=${S}; cat > $S/body.md <<'EOF'\n## Summary\nUses \`$HOME\` and $(x) as text.\nEOF`,
    verdict: "approved",
  },
  {
    command: "pnpm exec biome check packages/shared/src",
    verdict: "approved",
  },
  {
    command: "pnpm --filter @sky/api exec biome lint src/internal.ts",
    verdict: "approved",
  },
  {
    command:
      "pnpm exec biome format --write apps/site/gallery/pages/checklist.tsx 2>&1 | tail -1 && pnpm lint >/dev/null 2>&1; echo l=$?",
    verdict: "approved",
  },
  {
    command: "pnpm exec biome check --write packages/runner/src",
    verdict: "approved",
  },
  {
    command:
      'git add -A packages/operator && git commit -q -m "Add the operator package"',
    verdict: "approved",
  },
  {
    command: 'git add apps/api/src/internal.ts && git commit -qm "Trim input"',
    verdict: "approved",
  },
  { command: `git commit -F ${S}/msg.txt`, verdict: "approved" },
  { command: "git restore apps/api/src/internal.ts", verdict: "approved" },
  {
    command: "git checkout -- packages/shared/src/event.ts",
    verdict: "approved",
  },
  { command: "git stash", verdict: "approved" },
  { command: "sed -i 's/foo/bar/g' src/a.ts", verdict: "approved" },
  { command: `mkdir -p ${S}/out`, verdict: "approved" },
  {
    command: `cat >> ${S}/notes.md <<'EOF'\nmore\nEOF`,
    verdict: "approved",
  },
  // still ask
  {
    command:
      "/.sprite/languages/node/nvm/versions/node/v24.22.1/bin/node /opt/sky/runner.mjs publish --title x",
    verdict: "program",
  },
  { command: "git push origin main", verdict: "not-allowed" },
  { command: "gh pr create --fill", verdict: "not-allowed" },
  { command: "curl -s https://example.com", verdict: "not-allowed" },
  { command: "wget https://example.com/x", verdict: "not-allowed" },
  { command: "ssh host ls", verdict: "not-allowed" },
  { command: "scp a.txt host:/tmp", verdict: "not-allowed" },
  { command: "nc -l 8080", verdict: "not-allowed" },
  { command: "fly deploy", verdict: "not-allowed" },
  { command: "sudo ls", verdict: "not-allowed" },
  { command: `rm -rf ${FIXTURE_ROOT}`, verdict: "not-allowed" },
  { command: "timeout 5 curl https://example.com", verdict: "not-allowed" },
  { command: "env -u X sudo ls", verdict: "not-allowed" },
  { command: "cat ~/.ssh/id_rsa", verdict: "outside-root" },
  { command: "cat .env", verdict: "sensitive-path" },
  { command: "ls .claude", verdict: "sensitive-path" },
  {
    command: "cat > .env <<'EOF'\nTOKEN=1\nEOF",
    verdict: "sensitive-path",
  },
  {
    command: "cat > /etc/hosts <<'EOF'\nx\nEOF",
    verdict: "outside-root",
  },
  { command: "bash scripts/run.sh", verdict: "not-allowed" },
  { command: "python3 - <<'EOF'\nprint(1)\nEOF", verdict: "syntax" },
  { command: "echo $(whoami)", verdict: "syntax" },
  { command: "git commit --amend -m x", verdict: "unsafe-option" },
  { command: "git config user.email x@y.z", verdict: "not-allowed" },
  {
    command: "git remote add x https://example.com/y.git",
    verdict: "not-allowed",
  },
  { command: "git fetch origin", verdict: "not-allowed" },
  { command: "git pull", verdict: "not-allowed" },
  { command: "sed -i 's/a/b/' .env", verdict: "sensitive-path" },
  { command: "sed -i 's/a/b/' /etc/hosts", verdict: "outside-root" },
  { command: "git add .git/config", verdict: "sensitive-path" },
  { command: "S=/tmp/other; cat $S/a.md", verdict: "outside-root" },
];
