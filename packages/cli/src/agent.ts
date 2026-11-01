import { readFileSync } from "node:fs";
import type { RunStatus } from "@sky/shared";
import { type Api, ApiError, type ApiRun } from "./api.js";
import type { Io } from "./cli.js";
import { type Output, UsageError } from "./output.js";
import { resolveEnvId } from "./secret.js";

type Values = {
  prompt?: string;
  timeout?: string;
  reason?: string;
  yes?: boolean;
};
/** Makes the command's requests; everything argv can get wrong is already rejected. */
type Action = (api: Api, io: Io, out: Output) => Promise<number>;

export interface AgentCommand {
  options: {
    [K in keyof Values]?: {
      type: NonNullable<Values[K]> extends boolean ? "boolean" : "string";
    };
  };
  prepare(positionals: string[], values: Values): Action;
}

/** inbox, wait and status exit with the newest run's state, so a script branches without parsing. */
const runExitCodes = {
  finished: 0,
  waiting: 3,
  starting: 4,
  running: 4,
  failed: 5,
  stopped: 6,
} as const satisfies Record<RunStatus, number>;

const pollIntervalMs = 3_000;
const maxBackoffMs = 30_000;

/** `@path` reads the prompt from a file; anything else is the prompt itself. */
function readPrompt(prompt: string | undefined, command: string): string {
  if (prompt === undefined) {
    throw new UsageError(`${command} needs --prompt=<text|@file>`, true);
  }
  let text = prompt;
  if (prompt.startsWith("@")) {
    const file = prompt.slice(1);
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      throw new UsageError(`cannot read ${file}${code ? ` (${code})` : ""}`);
    }
  }
  if (text.trim() === "") {
    throw new UsageError(
      prompt.startsWith("@")
        ? `the prompt in ${prompt.slice(1)} is empty`
        : "the prompt is empty",
    );
  }
  return text;
}

const agentSub: AgentCommand = {
  options: { prompt: { type: "string" } },
  prepare(positionals, values) {
    const [sub, ref, ...extra] = positionals;
    if (sub === "start" || sub === "follow-up") {
      const what = sub === "start" ? "<env>" : "<agent>";
      if (ref === undefined || extra.length > 0) {
        throw new UsageError(
          `agent ${sub} takes ${what} --prompt=<text|@file>`,
          true,
        );
      }
      const prompt = readPrompt(values.prompt, `agent ${sub}`);
      return sub === "start"
        ? async (api, _io, out) => {
            const envId = await resolveEnvId(api, ref, out);
            if (envId === undefined) return 1;
            const r = await api.createAgent({ envId, prompt });
            out.result(r.raw, `${r.agentId} ${r.runId}`);
            return 0;
          }
        : async (api, _io, out) => {
            const r = await api.followUp(ref, { prompt });
            out.result(r.raw, `${r.agentId} ${r.runId}`);
            return 0;
          };
    }
    if (sub === "archive") {
      if (ref === undefined || extra.length > 0) {
        throw new UsageError("agent archive takes <agent>", true);
      }
      return async (api, _io, out) => {
        out.result(await api.archiveAgent(ref), `archived ${ref}`);
        return 0;
      };
    }
    throw new UsageError(
      sub === undefined
        ? "agent needs a subcommand: start, follow-up or archive"
        : `unknown agent subcommand '${sub}'`,
      true,
    );
  },
};

type Newest = { raw: unknown; run: ApiRun };

async function newestRun(
  api: Api,
  agentId: string,
  out: Output,
): Promise<Newest | undefined> {
  const [newest] = await api.listRuns(agentId);
  if (newest === undefined) out.fail("no_runs", `${agentId} has no runs`);
  return newest;
}

/** stdout carries what the run is waiting on, so a bot reads the request without parsing JSON. */
function printInbox({ raw, run }: Newest, io: Io, out: Output): number {
  out.progress(`${run.id} ${run.status}`);
  const pending = run.pendingRequest;
  if (out.json) {
    out.result(raw, "");
  } else if (pending?.kind === "question") {
    io.stdout(`question ${pending.requestId}\n${pending.prompt}\n`);
  } else if (pending?.kind === "approval") {
    io.stdout(
      `approval ${pending.requestId} ${pending.toolName}\n${pending.toolSummary}\n`,
    );
  }
  return runExitCodes[run.status];
}

function onlyAgent(command: string, positionals: string[]): string {
  const [agentId, ...extra] = positionals;
  if (agentId === undefined || extra.length > 0) {
    throw new UsageError(`${command} takes one argument, the agent id`, true);
  }
  return agentId;
}

const inbox: AgentCommand = {
  options: {},
  prepare(positionals) {
    const agentId = onlyAgent("inbox", positionals);
    return async (api, io, out) => {
      const newest = await newestRun(api, agentId, out);
      return newest === undefined ? 1 : printInbox(newest, io, out);
    };
  },
};

const status: AgentCommand = {
  options: {},
  prepare(positionals) {
    const agentId = onlyAgent("status", positionals);
    return async (api, _io, out) => {
      const newest = await newestRun(api, agentId, out);
      if (newest === undefined) return 1;
      const { run } = newest;
      const lines = [`${run.id} ${run.status}`];
      if (run.summary) lines.push(`summary: ${run.summary}`);
      if (run.error) lines.push(`error: ${run.error}`);
      if (run.compareUrl) lines.push(`compare: ${run.compareUrl}`);
      out.result(newest.raw, lines.join("\n"));
      return runExitCodes[run.status];
    };
  },
};

const wait: AgentCommand = {
  options: { timeout: { type: "string" } },
  prepare(positionals, values) {
    const agentId = onlyAgent("wait", positionals);
    const timeoutS = parseTimeout(values.timeout);
    return async (api, io, out) => {
      // arm before the first request: a Ctrl-C at any point leaves the agent running
      const disarm = io.onInterrupt(
        `interrupted; ${agentId} keeps running on the server. Run sky wait ${agentId} to keep waiting`,
      );
      try {
        return await pollUntilSettled(api, agentId, timeoutS, io, out);
      } finally {
        disarm();
      }
    };
  },
};

function parseTimeout(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || n <= 0) {
    throw new UsageError(
      `--timeout takes a whole number of seconds, not '${raw}'`,
      true,
    );
  }
  return n;
}

const isActive = (s: RunStatus) => s === "starting" || s === "running";
const isTransient = (err: ApiError) => err.status === 0 || err.status >= 500;

/** Polls until the newest run waits or ends; an unreachable API or a 5xx is retried with backoff. */
async function pollUntilSettled(
  api: Api,
  agentId: string,
  timeoutS: number | undefined,
  io: Io,
  out: Output,
): Promise<number> {
  const deadline =
    timeoutS === undefined
      ? Number.POSITIVE_INFINITY
      : io.now() + timeoutS * 1000;
  let newest: Newest | undefined;
  let failures = 0;
  let delay = 0;
  for (;;) {
    if (delay > 0) {
      const remaining = deadline - io.now();
      if (remaining <= 0)
        return timedOut(newest, failures > 0, timeoutS, io, out);
      await io.sleep(Math.min(delay, remaining));
    }
    try {
      const fetched = await newestRun(api, agentId, out);
      if (fetched === undefined) return 1;
      if (!isActive(fetched.run.status)) return printInbox(fetched, io, out);
      newest = fetched;
      failures = 0;
    } catch (err) {
      if (!(err instanceof ApiError && isTransient(err))) throw err;
      if (failures === 0) {
        out.progress(`lost contact with the API (${err.message}); retrying`);
      }
      failures++;
    }
    delay = Math.min(pollIntervalMs * 2 ** failures, maxBackoffMs);
  }
}

/** Prints the last run fetched, never an older one: `newest` changes only on a successful poll. */
function timedOut(
  newest: Newest | undefined,
  outOfContact: boolean,
  timeoutS: number | undefined,
  io: Io,
  out: Output,
): number {
  if (newest === undefined) {
    io.stderr(`sky: the API did not answer within ${timeoutS}s\n`);
    return runExitCodes.running;
  }
  const asOf = outOfContact ? " as of the last answer from the API" : "";
  io.stderr(`sky: still ${newest.run.status} after ${timeoutS}s${asOf}\n`);
  printInbox(newest, io, out);
  return runExitCodes.running;
}

const decisionVerbs = {
  approve: "approved",
  deny: "denied",
  answer: "answered",
} as const;

/** The API answers an exact repeat with 200 like the first; `already_decided` means a different decision stands. */
function decisionCommand(
  verb: keyof typeof decisionVerbs,
  options: AgentCommand["options"],
  usage: string,
  build: (
    rest: string[],
    values: Values,
  ) => (api: Api, agentId: string, requestId: string) => Promise<unknown>,
): AgentCommand {
  return {
    options,
    prepare(positionals, values) {
      const [agentId, requestId, ...rest] = positionals;
      if (agentId === undefined || requestId === undefined) {
        throw new UsageError(usage, true);
      }
      const send = build(rest, values);
      return async (api, _io, out) => {
        try {
          out.result(
            await send(api, agentId, requestId),
            `${decisionVerbs[verb]} ${requestId}`,
          );
          return 0;
        } catch (err) {
          const recorded =
            err instanceof ApiError && err.code === "already_decided"
              ? err.details.decision
              : undefined;
          if (typeof recorded !== "string") throw err;
          return out.fail(
            "already_decided",
            `${requestId} was already ${recorded}; this ${verb} was not applied`,
          );
        }
      };
    },
  };
}

const noExtra = (rest: string[], usage: string) => {
  if (rest.length > 0) throw new UsageError(usage, true);
};

const approveUsage = "approve takes <agent> <requestId> [--reason=<text>]";
const approve = decisionCommand(
  "approve",
  { reason: { type: "string" } },
  approveUsage,
  (rest, { reason }) => {
    noExtra(rest, approveUsage);
    if (reason?.trim() === "") {
      throw new UsageError("--reason is empty", true);
    }
    return (api, agentId, requestId) =>
      api.decide(agentId, {
        requestId,
        decision: "approve",
        ...(reason === undefined ? {} : { reason }),
      });
  },
);

const denyUsage = "deny takes <agent> <requestId> --reason=<text>";
const deny = decisionCommand(
  "deny",
  { reason: { type: "string" } },
  denyUsage,
  (rest, { reason }) => {
    noExtra(rest, denyUsage);
    if (reason === undefined || reason.trim() === "") {
      throw new UsageError("deny needs --reason=<text>", true);
    }
    return (api, agentId, requestId) =>
      api.decide(agentId, { requestId, decision: "deny", reason });
  },
);

const answerUsage = "answer takes <agent> <requestId> -- <text>";
const answer = decisionCommand("answer", {}, answerUsage, (rest) => {
  const [text, ...extra] = rest;
  if (text === undefined || extra.length > 0) {
    throw new UsageError(`${answerUsage}; quote a text with spaces`, true);
  }
  if (text.trim() === "") throw new UsageError("the answer is empty");
  return (api, agentId, requestId) =>
    api.answer(agentId, { requestId, answer: text });
});

export const agentCommands: Record<string, AgentCommand> = {
  agent: agentSub,
  inbox,
  status,
  wait,
  approve,
  deny,
  answer,
};
