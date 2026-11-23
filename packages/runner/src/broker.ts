import { execFile } from "node:child_process";
import { chmodSync, rmSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseCommandEntry } from "@sky/shared";
import { z } from "zod";
import {
  BRANCH_ENV,
  filesBetween,
  PublishError,
  type PublishPlan,
  publishWith,
  REMOTE_BRANCH_KEY,
  subjectsOf,
} from "./publish.js";
import { STORED_OBJECTS_ENV } from "./store.js";
import { syncMain } from "./sync.js";

const run = promisify(execFile);

/** The env var the agent's commands find the broker's socket in. */
export const BROKER_SOCKET_ENV = "SKY_BROKER_SOCKET";
const SOCKET_NAME = "broker.sock";

/** Where the broker listens: a socket in the run's scratch directory. */
export const brokerSocketIn = (dir: string) => join(dir, SOCKET_NAME);

// a request carries a pull request's title and body and nothing else
const REQUEST_MAX = 4 * 1024 * 1024;

const BrokerRequest = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("publish"),
    title: z.string().optional(),
    body: z.string().optional(),
    base: z.string().optional(),
    branch: z.string().optional(),
  }),
  z.object({ op: z.literal("sync"), branch: z.string().optional() }),
]);
export type BrokerRequest = z.infer<typeof BrokerRequest>;

/** One line the broker sends back: output for the client's stdout or stderr, then the exit status. */
export type BrokerReply =
  | { t: "out"; s: string }
  | { t: "err"; s: string }
  | { t: "exit"; code: number };

/**
 * Whether `command` is exactly the agent's own `publish` or `sync` call: the runner's script run by
 * the runner's node as one plain command, nothing chained, substituted, redirected or wrapped. Those
 * ask nothing as Bash calls, because the broker opens the approval for them; any other form of the
 * same words is judged by the approval policy like any command.
 */
export function isBrokerCall(
  command: string,
  runner: { execPath: string; script: string | undefined },
): boolean {
  if (runner.script === undefined) return false;
  let words: string[] | undefined;
  try {
    words = parseCommandEntry(command);
  } catch {
    return false;
  }
  if (!words) return false;
  const [program, script, op] = words;
  return (
    program === runner.execPath &&
    script === runner.script &&
    (op === "publish" || op === "sync")
  );
}

/** What the person is asked: shown as the approval request's tool name, summary and input. */
export type ApprovalAsk = {
  toolName: "Publish" | "Sync";
  toolSummary: string;
  toolInput: string;
};

/** The person's answer; a withdrawn or unanswered wait is a refusal with its own words. */
export type ApprovalAnswer =
  | { approved: true }
  | { approved: false; reason: string };

// the API keeps the first 2,000 characters of an approval's summary; a little under, for the last line
const SUMMARY_MAX = 1_900;
const COMMITS_MAX = 100;
const FILES_MAX = 200;
const SUBJECT_MAX = 200;
const PATH_MAX = 200;
const BODY_MAX = 4_000;

const cut = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;
const short = (sha: string) => sha.slice(0, 7);
// a title, subject, path or branch from config can hold a line break, which would add a line of its
// own to the summary; the C1 controls and U+2028/U+2029 are line breaks to some renderers too
const oneLine = (text: string) =>
  text.replace(/[\p{Cc}\u2028\u2029]/gu, " ");
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

type Listed = {
  commits: { sha: string; subject: string }[];
  files: { path: string; added: number; removed: number }[];
};

const stat = ({ commits, files }: Listed) => ({
  commits: commits.length,
  files: files.length,
  added: files.reduce((sum, f) => sum + f.added, 0),
  removed: files.reduce((sum, f) => sum + f.removed, 0),
});

/**
 * The summary the approval is read by: the API keeps its first 2,000 characters, so the lead lines
 * come first and the commit and file lists are cut, with a count of what is left, to fit what is
 * under it. The full lists are in the request's input.
 */
function summaryOf(lead: string[], { commits, files }: Listed): string {
  const head = lead.map(oneLine).join("\n");
  let room = SUMMARY_MAX - head.length;
  const section = (title: string, items: string[], share: number): string[] => {
    const budget = Math.max(0, Math.floor(room * share));
    const out: string[] = [];
    let used = title.length + 1;
    for (const item of items) {
      // keeps a line for "… and N more" when it doesn't all fit
      if (used + item.length + 1 > budget - 20 && out.length < items.length) {
        out.push(`  … and ${items.length - out.length} more`);
        break;
      }
      out.push(item);
      used += item.length + 1;
    }
    room -= used;
    return [title, ...out];
  };
  return [
    head,
    ...section(
      "Commits:",
      commits.map((c) => `  ${short(c.sha)} ${cut(oneLine(c.subject), 80)}`),
      0.4,
    ),
    ...section(
      "Files:",
      files.map(
        (f) => `  +${f.added} -${f.removed} ${cut(oneLine(f.path), 90)}`,
      ),
      1,
    ),
  ].join("\n");
}

/** The approval for a publish: the branch it goes to, and the commits, files and diff stat that go out. */
export function publishAsk(plan: PublishPlan): ApprovalAsk {
  const total = stat(plan);
  const target = plan.pullRequest
    ? `updates pull request #${plan.pullRequest.number}`
    : `opens a pull request into ${plan.base}`;
  const lead = [
    `Publish ${plan.localBranch} to GitHub branch ${plan.branch}, which ${target}.`,
    `${plural(total.commits, "commit")}, ${plural(total.files, "file")}, +${total.added} -${total.removed}; head ${short(plan.head)}.`,
    ...(plan.title ? [`Title: ${cut(plan.title, 200)}`] : []),
  ];
  const input = {
    action: "publish",
    branch: plan.branch,
    localBranch: plan.localBranch,
    base: plan.base,
    head: plan.head,
    stat: total,
    ...(plan.pullRequest && { pullRequest: plan.pullRequest }),
    ...(plan.title && { title: cut(plan.title, 300) }),
    ...(plan.body !== undefined && { body: cut(plan.body, BODY_MAX) }),
    commits: plan.commits
      .slice(0, COMMITS_MAX)
      .map((c) => ({ sha: c.sha, subject: cut(c.subject, SUBJECT_MAX) })),
    files: plan.files
      .slice(0, FILES_MAX)
      .map((f) => ({ ...f, path: cut(f.path, PATH_MAX) })),
    omitted: {
      commits: Math.max(0, plan.commits.length - COMMITS_MAX),
      files: Math.max(0, plan.files.length - FILES_MAX),
    },
  };
  return {
    toolName: "Publish",
    toolSummary: summaryOf(lead, plan),
    toolInput: JSON.stringify(input),
  };
}

/** What a sync is about to act on: the worktree's own commits, which it rebases when GitHub's branch moved. */
export type SyncPlan = Listed & {
  localBranch: string;
  /** The GitHub branch the worktree is brought onto. */
  branch: string;
  head: string;
  /** Where the listed commits start: the worktree's merge base with `origin/HEAD`, "" when none. */
  base: string;
};

/** The approval for a sync: the branch it works on, and the unpublished work it may rebase. */
export function syncAsk(plan: SyncPlan): ApprovalAsk {
  const total = stat(plan);
  const lead = [
    `Sync ${plan.localBranch} with GitHub branch ${plan.branch}: fetch GitHub's default branch and ${plan.branch}, and rebase this worktree's commits onto ${plan.branch} if it moved.`,
    `The worktree holds ${plural(total.commits, "commit")} past the default branch, ${plural(total.files, "file")}, +${total.added} -${total.removed}; head ${short(plan.head)}.`,
  ];
  const input = {
    action: "sync",
    branch: plan.branch,
    localBranch: plan.localBranch,
    head: plan.head,
    base: plan.base,
    stat: total,
    commits: plan.commits
      .slice(0, COMMITS_MAX)
      .map((c) => ({ sha: c.sha, subject: cut(c.subject, SUBJECT_MAX) })),
    files: plan.files
      .slice(0, FILES_MAX)
      .map((f) => ({ ...f, path: cut(f.path, PATH_MAX) })),
    omitted: {
      commits: Math.max(0, plan.commits.length - COMMITS_MAX),
      files: Math.max(0, plan.files.length - FILES_MAX),
    },
  };
  return {
    toolName: "Sync",
    toolSummary: summaryOf(lead, plan),
    toolInput: JSON.stringify(input),
  };
}

const git = async (cwd: string, ...args: string[]) =>
  (
    await run("git", args, {
      cwd,
      env: { ...process.env, ...STORED_OBJECTS_ENV },
      maxBuffer: 64 * 1024 * 1024,
    })
  ).stdout.trim();

/** What a sync of the worktree would act on, read from the worktree and the clone alone: it asks GitHub nothing. */
export async function planSync(
  cwd: string,
  env: NodeJS.ProcessEnv,
  requested: string | undefined,
): Promise<SyncPlan> {
  const localBranch = await git(
    cwd,
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ).catch(() => "");
  if (!localBranch) {
    throw new PublishError(
      "HEAD is detached in this worktree, so sync can't tell which GitHub branch it publishes to; check out your branch and sync again. Nothing was changed.",
    );
  }
  const branch =
    requested ??
    ((await git(
      cwd,
      "config",
      "--get",
      `branch.${localBranch}.${REMOTE_BRANCH_KEY}`,
    ).catch(() => "")) ||
      env[BRANCH_ENV] ||
      localBranch);
  const head = await git(cwd, "rev-parse", "HEAD");
  const base = await git(cwd, "merge-base", "HEAD", "origin/HEAD").catch(
    () => "",
  );
  const shas = base
    ? (
        await git(
          cwd,
          "rev-list",
          "--reverse",
          "--first-parent",
          `${base}..HEAD`,
        )
      )
        .split("\n")
        .filter(Boolean)
    : [];
  return {
    localBranch,
    branch,
    head,
    base,
    commits: await subjectsOf(cwd, shas),
    files: base ? await filesBetween(cwd, base, head) : [],
  };
}

export type BrokerDeps = {
  socketPath: string;
  /** The agent's worktree, from the runner's own state: no request names a path. */
  cwd: string;
  /** What the runner's own code runs with: the session's env and the connector. Never a command's. */
  env: NodeJS.ProcessEnv;
  /** Why the runner can't keep the connector from the repo's commands, or undefined when it can. */
  sealProblem: () => string | undefined;
  /** Opens the run's one approval for the request and waits for the person; `signal` ends the wait. */
  approve: (ask: ApprovalAsk, signal: AbortSignal) => Promise<ApprovalAnswer>;
  /** A problem the run's events should show, as a `runner.warning`. */
  warn: (message: string) => void;
  /** Runs `sync`; `syncMain` unless a test stands in. */
  syncRun?: typeof syncMain;
  /** Runs `publish`; `publishWith` unless a test stands in. */
  publishRun?: typeof publishWith;
};

export type Broker = { close: () => Promise<void> };

/**
 * The runner's socket for the agent's `publish` and `sync`. The commands are thin clients: they
 * send their arguments, and the runner, which alone holds the GitHub connector, does the work,
 * after one approval each that it opens itself. The worktree and branch are the runner's own state,
 * never the request's. A request that arrives while another is being served waits its turn.
 */
export async function startBroker(deps: BrokerDeps): Promise<Broker> {
  rmSync(deps.socketPath, { force: true });
  let turn: Promise<void> = Promise.resolve();
  const sockets = new Set<net.Socket>();

  const serve = async (
    request: BrokerRequest,
    send: (reply: BrokerReply) => void,
    gone: AbortSignal,
  ) => {
    const io = {
      cwd: deps.cwd,
      stdout: (s: string) => send({ t: "out", s }),
      stderr: (s: string) => send({ t: "err", s }),
    };
    const name = request.op === "publish" ? "sky publish" : "sky sync";
    // before anything is read or sent: while the connector could be read from the runner, no request
    // is served
    const exposed = deps.sealProblem();
    if (exposed) {
      const message = `${name} refused: the runner can't confirm it keeps the GitHub connector from the repo's commands (${exposed}); nothing was sent`;
      deps.warn(message);
      io.stderr(`${message}\n`);
      send({ t: "exit", code: 1 });
      return;
    }
    const ask = async (made: ApprovalAsk) => {
      const answer = await deps.approve(made, gone);
      if (!answer.approved) {
        throw new PublishError(`${answer.reason}; nothing was sent`);
      }
    };
    try {
      if (request.op === "publish") {
        const { op: _, ...values } = request;
        const code = await (deps.publishRun ?? publishWith)(
          values,
          deps.env,
          io,
          { review: (plan) => ask(publishAsk(plan)) },
        );
        send({ t: "exit", code });
        return;
      }
      const plan = await planSync(deps.cwd, deps.env, request.branch);
      await ask(syncAsk(plan));
      const now = await git(deps.cwd, "rev-parse", "HEAD");
      if (now !== plan.head) {
        throw new PublishError(
          `${plan.localBranch} moved from ${plan.head} to ${now} while the sync waited for approval; nothing was changed, sync again to ask for the new head`,
        );
      }
      // a switch to another branch at the same commit keeps the head, and would sync that branch
      const checkedOut = await git(
        deps.cwd,
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD",
      ).catch(() => "");
      if (checkedOut !== plan.localBranch) {
        throw new PublishError(
          `the worktree switched from ${plan.localBranch} to ${checkedOut || "a detached HEAD"} while the sync waited for approval; nothing was changed, sync again to ask for the branch it is on`,
        );
      }
      // the GitHub branch the person approved, never one sync would work out again from config the
      // worktree can change while they decided. Past choosing it, sync treats a `--branch` exactly as
      // the branch it would choose itself
      const code = await (deps.syncRun ?? syncMain)(
        ["--branch", plan.branch],
        deps.env,
        io,
      );
      send({ t: "exit", code });
    } catch (error) {
      io.stderr(
        `${name}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      send({ t: "exit", code: 1 });
    }
  };

  const server = net.createServer((socket) => {
    sockets.add(socket);
    const gone = new AbortController();
    socket.setEncoding("utf8");
    socket.on("close", () => {
      sockets.delete(socket);
      gone.abort();
    });
    socket.on("error", () => {});
    const send = (reply: BrokerReply) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(reply)}\n`);
    };
    let received = "";
    let taken = false;
    socket.on("data", (chunk: string) => {
      if (taken) return;
      received += chunk;
      if (received.length > REQUEST_MAX) {
        socket.destroy();
        return;
      }
      const end = received.indexOf("\n");
      if (end < 0) return;
      taken = true;
      let request: BrokerRequest;
      try {
        request = BrokerRequest.parse(JSON.parse(received.slice(0, end)));
      } catch {
        send({ t: "err", s: "sky: the runner could not read the request\n" });
        send({ t: "exit", code: 2 });
        socket.end();
        return;
      }
      turn = turn.then(async () => {
        // a client that left while it waited its turn is never served
        if (!gone.signal.aborted) await serve(request, send, gone.signal);
        socket.end();
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(deps.socketPath, resolve);
  });
  chmodSync(deps.socketPath, 0o600);
  return {
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(deps.socketPath, { force: true });
    },
  };
}
