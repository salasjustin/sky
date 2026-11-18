import { readFileSync } from "node:fs";
import {
  AGENT_LIST_MAX_LIMIT,
  AgentState,
  BranchName,
  PREVIEW_MAX_TTL_SECONDS,
  PREVIEW_MIN_TTL_SECONDS,
  PREVIEW_PROXY_PORT,
  PreviewPort,
  type RunStatus,
} from "@sky/shared";
import { type Api, ApiError, type ApiListedAgent, type ApiRun } from "./api.js";
import type { Io } from "./cli.js";
import { type Output, UsageError } from "./output.js";
import { resolveEnvId } from "./secret.js";

type Values = {
  prompt?: string;
  timeout?: string;
  reason?: string;
  yes?: boolean;
  branch?: string;
  events?: string;
  format?: string;
  secret?: string;
  env?: string;
  role?: string;
  fallback?: string;
  pool?: string;
  status?: string;
  archived?: boolean;
  limit?: string;
  cursor?: string;
  build?: string;
  start?: string;
  "no-wait"?: boolean;
  port?: string;
  ttl?: string;
  stop?: boolean;
};
/** Makes the command's requests; everything argv can get wrong is already rejected. */
type Action = (api: Api, io: Io, out: Output) => Promise<number>;

export interface AgentCommand {
  options: {
    [K in keyof Values]?: {
      type: NonNullable<Values[K]> extends boolean ? "boolean" : "string";
      /** Repeats arrive comma-joined, so `--env=a --env=b` reads as `--env=a,b`. */
      multiple?: true;
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

/** Rejects here what the API's BranchName would reject, so a bad name exits 2 rather than 1. */
function parseBranch(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const branch = raw.trim();
  if (branch === "") throw new UsageError("--branch is empty", true);
  const parsed = BranchName.safeParse(branch);
  if (!parsed.success) {
    const rule = parsed.error.issues[0]?.message;
    throw new UsageError(
      `--branch '${branch}' is not a branch name: ${rule}`,
      true,
    );
  }
  return parsed.data;
}

/** The agent list's query, with what argv can get wrong rejected here so it exits 2 rather than 1. */
function listQuery(values: Values): URLSearchParams {
  const query = new URLSearchParams();
  const names = (raw: string | undefined, flag: string) => {
    if (raw === undefined) return [];
    const parts = raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
    if (parts.length === 0) throw new UsageError(`${flag} names nothing`, true);
    return parts;
  };
  const env = names(values.env, "--env");
  if (env.length > 0) query.set("env", env.join(","));
  const states = names(values.status, "--status");
  const bad = states.find((s) => !AgentState.safeParse(s).success);
  if (bad !== undefined) {
    throw new UsageError(
      `--status '${bad}' is not a state: ${AgentState.options.join(", ")}`,
      true,
    );
  }
  if (states.length > 0) query.set("status", states.join(","));
  // every agent, archived ones too: the agent someone lost may be among them
  if (values.archived) query.set("archived", "all");
  if (values.limit !== undefined) {
    const n = Number(values.limit);
    if (!/^\d+$/.test(values.limit) || n < 1 || n > AGENT_LIST_MAX_LIMIT) {
      throw new UsageError(
        `--limit takes a whole number from 1 to ${AGENT_LIST_MAX_LIMIT}, not '${values.limit}'`,
        true,
      );
    }
    query.set("limit", String(n));
  }
  if (values.cursor !== undefined) {
    // empty would read as no cursor, so a script's `--cursor=$next` would loop on the first page
    if (values.cursor === "") throw new UsageError("--cursor is empty", true);
    query.set("cursor", values.cursor);
  }
  return query;
}

/**
 * `-` stands for a field the agent has no value for yet. The env name goes last because it may
 * contain spaces, so the first six fields always split cleanly and the rest of the line is the name.
 */
function agentLine(a: ApiListedAgent): string {
  const { run } = a;
  return [
    a.id,
    run?.state ?? "-",
    run?.id ?? "-",
    run?.lastEventAt ?? "-",
    run?.openRequests ?? 0,
    a.remoteBranch ?? a.branch,
    a.envName,
  ].join(" ");
}

const listOnly = ["env", "status", "archived", "limit", "cursor"] as const;
const previewOnly = [
  "build",
  "start",
  "port",
  "ttl",
  "stop",
  "no-wait",
] as const;

/** `90s`, `30m`, `2h`, `7d`; a bare number is seconds. Rejected here what the API's range would reject, so it exits 2. */
function parseTtl(raw: string): number {
  const match = /^(\d+)([smhd]?)$/.exec(raw);
  const unit = { "": 1, s: 1, m: 60, h: 3600, d: 86_400 } as const;
  const seconds = match
    ? Number(match[1]) * unit[match[2] as keyof typeof unit]
    : Number.NaN;
  if (
    !Number.isSafeInteger(seconds) ||
    seconds < PREVIEW_MIN_TTL_SECONDS ||
    seconds > PREVIEW_MAX_TTL_SECONDS
  ) {
    throw new UsageError(
      `--ttl takes a duration like 90m, 24h or 7d, from 1m to 7d, not '${raw}'`,
      true,
    );
  }
  return seconds;
}

/** What `agent preview` was asked to do, checked before any request. */
function previewAction(ref: string | undefined, values: Values): Action {
  if (ref === undefined) {
    throw new UsageError(
      "agent preview takes <agent> [--build=<cmd>] [--start=<cmd>] --port=<n> [--ttl=<duration>] [--no-wait], or <agent> --stop",
      true,
    );
  }
  for (const flag of ["prompt", "branch"] as const) {
    if (values[flag] !== undefined) {
      throw new UsageError(`agent preview takes no --${flag}`, true);
    }
  }
  const { build, start, port, ttl } = values;
  const starting =
    build !== undefined ||
    start !== undefined ||
    port !== undefined ||
    ttl !== undefined;
  if (values.stop) {
    if (starting || values["no-wait"]) {
      throw new UsageError(
        "agent preview --stop takes no --build, --start, --port, --ttl or --no-wait",
        true,
      );
    }
    return async (api, _io, out) => {
      const { raw, stopped } = await api.stopPreview(ref);
      // exit 0 either way, so a retried stop or a cleanup trap doesn't fail
      out.result(
        raw,
        stopped
          ? `stopped the preview of ${ref}`
          : `${ref} had no running preview`,
      );
      return 0;
    };
  }
  if (!starting) {
    if (values["no-wait"]) {
      throw new UsageError("--no-wait only goes with starting a preview", true);
    }
    return async (api, _io, out) => {
      const { raw, preview } = await api.getPreview(ref);
      if (preview === null) {
        out.result(raw, "");
        out.progress(`${ref} has no running preview`);
        return 0;
      }
      const services = preview.services
        ? `${preview.services.app} ${preview.services.proxy}`
        : "- -";
      out.result(
        raw,
        `${preview.state} ${preview.port} ${preview.expiresAt} ${services}`,
      );
      return 0;
    };
  }
  if (port === undefined) {
    throw new UsageError("agent preview needs --port=<n>", true);
  }
  for (const [flag, value] of [
    ["--build", build],
    ["--start", start],
  ] as const) {
    if (value !== undefined && value.trim() === "") {
      throw new UsageError(`${flag} is empty`, true);
    }
  }
  const parsedPort = /^\d+$/.test(port)
    ? PreviewPort.safeParse(Number(port))
    : undefined;
  if (!parsedPort?.success) {
    throw new UsageError(
      `--port takes a whole number from 1024 to 65535, other than ${PREVIEW_PROXY_PORT} (the preview's own), not '${port}'`,
      true,
    );
  }
  const ttlSeconds = ttl === undefined ? undefined : parseTtl(ttl);
  return async (api, io, out) => {
    const started = await api.startPreview(ref, {
      port: parsedPort.data,
      ...(build === undefined ? {} : { build: build.trim() }),
      ...(start === undefined ? {} : { start: start.trim() }),
      ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
    });
    const { preview } = started;
    if (preview.replaced) {
      out.progress(`replaced the running preview of ${preview.replaced}`);
    }
    if (values["no-wait"]) {
      out.result(started.raw, preview.link);
      out.progress(
        `${ref} ${preview.state}; the link works until ${preview.expiresAt}. Run sky agent preview ${ref} to see when it is ready`,
      );
      return 0;
    }
    return await waitUntilReady(api, io, out, ref, started);
  };
}

/** What a preview that is up serves, and how to move it on. */
const STALE_NOTE = (ref: string) =>
  `it serves this build of the worktree: a new commit needs a new preview, so run sky agent preview ${ref} --port=… again, which rebuilds and replaces this one`;

/**
 * Polls the preview until it is ready or failed, printing each state as it changes, then prints the link. A
 * failed one reaches `failApi` as the API's own `preview_failed`, with the tail of what failed. An
 * unreachable API or a 5xx that isn't that is retried with backoff, as `sky wait` does.
 */
async function waitUntilReady(
  api: Api,
  io: Io,
  out: Output,
  ref: string,
  started: Awaited<ReturnType<Api["startPreview"]>>,
): Promise<number> {
  // armed before the first request: a Ctrl-C at any point leaves the preview building
  const disarm = io.onInterrupt(
    `interrupted; the preview of ${ref} keeps building on the server. Run sky agent preview ${ref} to see when it is ready`,
  );
  try {
    // the link is shown only now: printed before the wait, so an interrupted wait doesn't lose it. Under
    // --json the one object is printed at the end
    if (!out.json) out.result(started.raw, started.preview.link);
    let shown: string | undefined;
    let latest: Record<string, unknown> = started.preview;
    let failures = 0;
    for (let state = started.preview.state; ; ) {
      if (state !== shown) {
        out.progress(`${ref} ${state}`);
        shown = state;
      }
      if (state === "ready") break;
      await io.sleep(Math.min(pollIntervalMs * 2 ** failures, maxBackoffMs));
      try {
        const { preview } = await api.getPreview(ref);
        if (preview === null) {
          return out.fail(
            "preview_gone",
            `the preview of ${ref} was stopped or replaced before it was ready`,
          );
        }
        failures = 0;
        latest = { ...latest, ...preview };
        state = preview.state;
      } catch (err) {
        const transient =
          err instanceof ApiError &&
          err.code !== "preview_failed" &&
          isTransient(err);
        if (!transient) throw err;
        if (failures === 0) {
          out.progress(`lost contact with the API (${err.message}); retrying`);
        }
        failures++;
      }
    }
    if (out.json) {
      out.result(
        {
          preview: {
            ...(started.raw as { preview: object }).preview,
            ...latest,
          },
        },
        "",
      );
    }
    out.progress(`the link works until ${latest.expiresAt}`);
    out.progress(STALE_NOTE(ref));
    return 0;
  } finally {
    disarm();
  }
}

const agentSub: AgentCommand = {
  options: {
    prompt: { type: "string" },
    branch: { type: "string" },
    env: { type: "string", multiple: true },
    status: { type: "string", multiple: true },
    archived: { type: "boolean" },
    limit: { type: "string" },
    cursor: { type: "string" },
    build: { type: "string" },
    start: { type: "string" },
    "no-wait": { type: "boolean" },
    port: { type: "string" },
    ttl: { type: "string" },
    stop: { type: "boolean" },
  },
  prepare(positionals, values) {
    const [sub, ref, ...extra] = positionals;
    if (sub === "list") {
      if (ref !== undefined) {
        throw new UsageError("agent list takes no arguments", true);
      }
      for (const flag of ["prompt", "branch"] as const) {
        if (values[flag] !== undefined) {
          throw new UsageError(`agent list takes no --${flag}`, true);
        }
      }
      const previewFlag = previewOnly.find(
        (flag) => values[flag] !== undefined && values[flag] !== false,
      );
      if (previewFlag !== undefined) {
        throw new UsageError(
          `--${previewFlag} only goes with agent preview`,
          true,
        );
      }
      const query = listQuery(values);
      return async (api, _io, out) => {
        const page = await api.listAgents(query);
        if (out.json || page.data.length > 0) {
          out.result(page.raw, page.data.map(agentLine).join("\n"));
        } else {
          // the API answers an env it can't resolve, or one the key may not use, with an empty page
          out.progress(
            values.env === undefined
              ? "no agents match"
              : "no agents match (an env that doesn't exist or this key can't use matches nothing)",
          );
        }
        if (page.nextCursor !== undefined) {
          out.progress(
            `more agents match; for the next page pass --cursor=${page.nextCursor} with the same filters`,
          );
        }
        return 0;
      };
    }
    const stray = listOnly.find((flag) => values[flag] !== undefined);
    if (stray !== undefined && values[stray] !== false) {
      throw new UsageError(`--${stray} only goes with agent list`, true);
    }
    if (sub === "preview") {
      if (extra.length > 0) {
        throw new UsageError("agent preview takes one agent", true);
      }
      return previewAction(ref, values);
    }
    const previewStray = previewOnly.find(
      (flag) => values[flag] !== undefined && values[flag] !== false,
    );
    if (previewStray !== undefined) {
      throw new UsageError(
        `--${previewStray} only goes with agent preview`,
        true,
      );
    }
    if (sub === "start" || sub === "follow-up") {
      const what = sub === "start" ? "<env> [--branch=<name>]" : "<agent>";
      if (ref === undefined || extra.length > 0) {
        throw new UsageError(
          `agent ${sub} takes ${what} --prompt=<text|@file>`,
          true,
        );
      }
      if (values.branch !== undefined && sub === "follow-up") {
        throw new UsageError(
          "agent follow-up takes no --branch: a branch can only be chosen when an agent starts",
          true,
        );
      }
      const branch = parseBranch(values.branch);
      const prompt = readPrompt(values.prompt, `agent ${sub}`);
      return sub === "start"
        ? async (api, _io, out) => {
            const envId = await resolveEnvId(api, ref, out);
            if (envId === undefined) return 1;
            const r = await api.createAgent({
              envId,
              prompt,
              ...(branch === undefined ? {} : { branch }),
            });
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
        ? "agent needs a subcommand: start, follow-up, list, preview or archive"
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
      if (run.claudeCredential) {
        lines.push(`claude credential: ${run.claudeCredential}`);
      }
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
