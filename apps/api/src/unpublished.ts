import { agents, type Db, runs } from "@sky/db";
import type {
  AgentId,
  EnvironmentId,
  RebuildCheckSource,
  UnpublishedAgent,
} from "@sky/shared";
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { WORKTREES_DIR } from "./provision.js";
import { redact } from "./redact.js";
import { execCapped, type SpriteOps } from "./sprites.js";

// $1 the worktrees' directory, the rest agent ids. One tab-separated line per agent:
//   <id> none                                         no worktree on the sprite
//   <id> ok <dirty files> <commits> <never> <branch>  the worktree's state
// <commits> are those past what GitHub has: the last publish's head, else the tip the agent started
// on, else the default branch; <never> is 1 when neither exists and the branch has commits; <branch>
// is the GitHub branch the last publish went to, empty when there was none. Read-only git throughout
// (`--no-optional-locks` keeps `status` from refreshing the index). The record is the runner's
// `published.ts`, whose file name escapes `%` and `/` as this does.
export const WORK_CHECK = String.raw`dir=$1; shift
enc() { printf %s "$1" | sed 's/%/%25/g; s#/#%2F#g'; }
for id in "$@"; do
  wt="$dir/$id"
  if [ ! -d "$wt" ]; then printf '%s\tnone\n' "$id"; continue; fi
  g() { git --no-optional-locks -C "$wt" "$@"; }
  dirty=$(g status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  head=$(g rev-parse -q --verify HEAD 2>/dev/null) || head=
  local=$(g symbolic-ref -q --short HEAD 2>/dev/null) || local=
  base=$(g merge-base origin/HEAD HEAD 2>/dev/null) || base=
  common=$(g rev-parse --git-common-dir 2>/dev/null)
  case $common in /*) ;; *) common="$wt/$common";; esac
  pub=; branch=
  if [ -n "$local" ] && [ -f "$common/sky-published/$(enc "$local")" ]; then
    pub=$(sed -n 1p "$common/sky-published/$(enc "$local")"); branch=$(sed -n 2p "$common/sky-published/$(enc "$local")")
  fi
  if [ -z "$pub" ]; then pub=$(g rev-parse -q --verify "refs/sky/starts/$id" 2>/dev/null) || pub=; fi
  n=0; never=0; from=
  if [ -n "$head" ]; then
    if [ -n "$pub" ] && g merge-base --is-ancestor "$pub" "$head" 2>/dev/null; then from=$pub
    elif [ -n "$pub" ] && g diff --quiet "$pub" "$head" 2>/dev/null; then n=0; from=$head
    elif [ -n "$pub" ]; then from=$(g merge-base "$pub" "$head" 2>/dev/null) || from=
    fi
    if [ -z "$from" ]; then from=$base; [ -z "$pub" ] && never=1; fi
    [ -n "$from" ] && n=$(g rev-list --count "$from..$head" 2>/dev/null || echo 0)
    [ "$n" -eq 0 ] && never=0
  fi
  printf '%s\tok\t%s\t%s\t%s\t%s\n' "$id" "$dirty" "$n" "$never" "$branch"
done`;

type AgentRow = { id: AgentId; branch: string; remoteBranch: string | null };

/** The agent's work on the sprite, read from its worktree; one a sprite answered for. */
export function parseWorkCheck(
  output: string,
  rows: AgentRow[],
): UnpublishedAgent[] {
  const lines = new Map(
    output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [id = "", ...fields] = line.split("\t");
        return [id, fields] as const;
      }),
  );
  const found: UnpublishedAgent[] = [];
  for (const row of rows) {
    const fields = lines.get(row.id);
    if (!fields) throw new Error(`the check said nothing of ${row.id}`);
    const [state, dirty = "", commits = "", never = "", recorded = ""] = fields;
    if (state === "none") continue;
    const uncommitted = Number(dirty);
    const unpublishedCommits = Number(commits);
    if (
      state !== "ok" ||
      !Number.isSafeInteger(uncommitted) ||
      !Number.isSafeInteger(unpublishedCommits)
    ) {
      throw new Error(`the check's answer for ${row.id} is unreadable`);
    }
    if (uncommitted === 0 && unpublishedCommits === 0) continue;
    found.push({
      agentId: row.id,
      branch: recorded || row.remoteBranch || row.branch,
      uncommitted,
      unpublishedCommits,
      neverPublished: never === "1",
    });
  }
  return found;
}

/**
 * What the API recorded of each agent's last run that carried a rollup, read against the commit the
 * sprite last published: the commits newer than it, or every commit when none was. The rollup lists
 * at most 50 commits, so a longer branch counts 50. Uncommitted changes are not in any record, so
 * they come back `null`: unknown.
 */
export function recordedWork(db: Db, rows: AgentRow[]): UnpublishedAgent[] {
  const found: UnpublishedAgent[] = [];
  for (const row of rows) {
    const rollup = db
      .select({ rollup: runs.rollup })
      .from(runs)
      .where(and(eq(runs.agentId, row.id), isNotNull(runs.rollup)))
      .orderBy(desc(runs.createdAt), desc(sql`${runs}.rowid`))
      .get()?.rollup;
    const commits = rollup?.cumulative.commits ?? [];
    const head = commits[0]?.sha;
    if (!rollup || !head) continue;
    const { published } = rollup;
    if (published?.head === head) continue;
    const at = published
      ? commits.findIndex((commit) => commit.sha === published.head)
      : -1;
    found.push({
      agentId: row.id,
      branch: published?.branch || row.remoteBranch || row.branch,
      uncommitted: null,
      unpublishedCommits: at >= 0 ? at : commits.length,
      neverPublished: published === undefined,
    });
  }
  return found;
}

export type UnpublishedWork = {
  /** Where the answer came from. */
  source: RebuildCheckSource;
  agents: UnpublishedAgent[];
  /** With `source: "records"`, why the sprite could not be asked. */
  unreachable?: string;
};

const MAX_OUTPUT_BYTES = 256 * 1024;
const REASON_MAX = 300;

/**
 * The environment's unarchived agents whose work exists only on the sprite: uncommitted changes in
 * the worktree, commits the branch they publish to doesn't have, or a branch never published. The
 * sprite is asked first, with read-only git in each worktree. A sprite that doesn't answer, or an
 * answer that can't be read, falls back to what the runs recorded, and says so in `unreachable`.
 */
export async function findUnpublishedWork(
  db: Db,
  sprites: SpriteOps,
  env: { id: EnvironmentId; spriteName: string },
  log: (line: string) => void,
): Promise<UnpublishedWork> {
  const rows = db
    .select({
      id: agents.id,
      branch: agents.branch,
      remoteBranch: agents.remoteBranch,
    })
    .from(agents)
    .where(and(eq(agents.envId, env.id), isNull(agents.archivedAt)))
    .orderBy(agents.createdAt, sql`rowid`)
    .all();
  if (rows.length === 0) return { source: "sprite", agents: [] };
  try {
    const out = await execCapped(
      sprites,
      env.spriteName,
      ["bash", "-c", WORK_CHECK, "_", WORKTREES_DIR, ...rows.map((r) => r.id)],
      { op: "work-check", maxBytes: MAX_OUTPUT_BYTES },
    );
    if (out.exitCode !== 0 || out.truncated) {
      throw new Error(
        out.truncated
          ? "the check's answer was too long to read"
          : `the check exited ${out.exitCode}`,
      );
    }
    return { source: "sprite", agents: parseWorkCheck(out.stdout, rows) };
  } catch (err) {
    const reason = redact(err instanceof Error ? err.message : String(err), [
      ...sprites.secrets.values(),
    ]).slice(0, REASON_MAX);
    log(
      `checking ${env.id}'s worktrees for unpublished work failed: ${reason}`,
    );
    return {
      source: "records",
      agents: recordedWork(db, rows),
      unreachable: reason,
    };
  }
}
