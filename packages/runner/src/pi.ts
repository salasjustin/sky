/**
 * The pi runtime, behind `SKY_RUNTIME=pi`.
 *
 * Where `runCodexSession` drives `codex app-server`, this drives `pi --mode rpc`: one JSON object per
 * line each way on pi's stdin and stdout. It maps what pi reports onto the same run events and the same
 * approve/deny requests, so the API, CLI, MCP and webhooks see one shape. The model is reached through
 * the Vercel AI Gateway with the environment's `AI_GATEWAY_API_KEY`, so any model the gateway serves
 * works, and no Claude credential is used.
 *
 * Approvals. pi has no approval policy of its own; an extension can gate a tool call. The runner writes
 * one extension into the run's scratch directory and loads it with `--extension` (`piExtensionSource`).
 * Its `tool_call` handler puts every call that isn't read-only to the runner as a blocking dialog,
 * `ctx.ui.input`, which RPC mode turns into an `extension_ui_request` on pi's stdout that stays open
 * until the runner answers on its stdin. That is the mechanism for any request that blocks a tool call
 * until a person answers: no socket, no token, and a call the runner never answers is a call pi never
 * runs. The runner answers from the environment's approval policy, as it does for Claude Code, and opens
 * a request for the person when the policy holds the call; a person's denial, reason included, goes back
 * to the model as the blocked call's result. The run's wait for a decision ends at
 * `WAIT_TIMEOUT_MINUTES` as in the other runtimes: the run stops and pi is told to abort.
 *
 * The agent's `publish` and `sync` are tools the same extension registers (`sky_publish`, `sky_sync`).
 * They put their arguments to the runner through that dialog too, and the runner runs the broker's
 * publish or sync, with its one approval, so the GitHub connector never reaches the agent's commands.
 * The extension registers them on every run, so they exist on a resumed session as on a first one.
 *
 * The gateway key stays in the runner: pi reaches the gateway through a proxy the runner starts on the
 * loopback interface for the run (`codex-proxy.ts`), as a provider the extension registers, keyed by a
 * token made for the run. The extension reads that token from pi's environment when it loads and deletes
 * it there, so no command pi runs inherits it, and pi is sealed as Claude's process is: started from a
 * copy of the binary the kernel keeps unreadable, so its `/proc/<pid>/environ` is closed to the agent's
 * commands, and a run whose runner can't be hidden fails with `credential_exposed` before it starts.
 *
 * pi is a Node program with no platform binary, so the binary sealed is a copy of `node` that runs pi's
 * `cli.js`. It loads only the extensions, skills and trust-gated project files the runner names: the
 * repo's own `.pi` directory is ignored (`--no-approve`), so a repo can't load code into pi.
 *
 * The base profile's MCP servers reach pi through the run's `mcp.json`, written by the runner with each
 * secret as a `${NAME}` reference to pi's own environment, never as a value. Not carried over from the
 * Claude Code session: background tasks, the default git identity, the outside-read gate (pi's `read`,
 * `grep`, `find` and `ls` run unasked, wherever they read), and subagents, which pi doesn't have.
 *
 * Cost: pi prices a call from its model's `cost`, which the gateway's models don't give it, so pi
 * reports tokens and a cost of 0. The run reports the tokens and `costUsd: 0`; the gateway's dashboard
 * has the dollars.
 */
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import {
  type AutoApproved,
  type BaseProfileMcpServer,
  type Decision,
  type EnvRefresh,
  type PendingRequest,
  type RequestId,
  RUNNER_TEXT_MAX,
  type RunnerEventPost,
  type RunRollup,
  TOOL_INPUT_POST_MAX,
  type Usage,
  type WithdrawalReason,
} from "@sky/shared";
import { z } from "zod";
import {
  type ApprovalAnswer,
  type ApprovalAsk,
  BROKER_SOCKET_ENV,
  BROKER_TOKEN_ENV,
  type Broker,
  brokerSocketIn,
  startBroker,
} from "./broker.js";
import { askBroker } from "./broker-client.js";
import {
  DYNAMIC_TOOLS,
  gatewayUnavailable,
  outside,
  PUBLISH_TOOL,
  PublishArgs,
  codexInstructions as runtimeInstructions,
  SYNC_TOOL,
  SyncArgs,
  unwrapShell,
} from "./codex.js";
import {
  type GatewayProxy,
  type GatewayProxyOptions,
  startGatewayProxy,
} from "./codex-proxy.js";
import { CODEX_KEY_ENV, type Config } from "./config.js";
import { CONNECTOR_ENV, withoutConnector } from "./connector.js";
import { type PostEvent, RunEndedError } from "./events.js";
import { createHeartbeat } from "./heartbeat.js";
import { sessionMcpServers, unresolvedServersWarning } from "./mcp.js";
import { matchesPolicy, policyOutcome } from "./policy.js";
import type { AwaitDecision } from "./requests.js";
import type { Seal } from "./seal.js";
import { scratchDirOf, withSessionGitConfig } from "./session.js";
import { prepareWorktree, type Refreshed } from "./sync.js";
import { commitAll, diffRollup, headSha } from "./worktree.js";

export { withdrawGatewayKey } from "./codex.js";

/** The pi version Sky installs on every sprite (`provision.ts`) and was tested against. */
export const PI_VERSION = "1.6.1";
/** The model a pi run uses when `SKY_PI_MODEL` names none, as the AI Gateway names it. */
export const DEFAULT_PI_MODEL = "deepseek/deepseek-v4.1-flash-1017";
/** The model provider the run's extension registers: the run's gateway proxy. */
export const PI_PROVIDER = "sky-gateway";
/** The gateway's OpenAI-compatible endpoint; the run's proxy forwards to it. */
export const GATEWAY_PI_URL = "https://ai-gateway.vercel.sh/v1";
/** Where `provision.ts` installs pi; `SKY_PI_BIN` overrides it. */
export const PI_BIN = "/opt/sky/node_modules/.bin/pi";
/** Where pi's extension finds the run's gateway proxy token, which it deletes from the env when it loads. */
export const PI_GATEWAY_TOKEN_ENV = "SKY_PI_GATEWAY_TOKEN";

/**
 * What to exec for `bin`. pi's npm package ships one JavaScript bundle and no platform binary, so unlike
 * Codex there is no native file to resolve: `bin` is a link to `cli.js`, which runs on the Node that
 * starts it. The seal can only keep unreadable a binary it copies itself, so the command is `node`, whose
 * copy the seal makes, and `cli.js` is its argument. Anything that is not a `.js` file is a compiled pi
 * (its release builds), run as it is; it finds its themes, docs and `package.json` beside its own
 * binary, which the seal's copy has none of, so `packageDir` is where pi is told they are.
 */
export function resolvePiExecutable(
  bin: string,
  node: string = process.execPath,
): { command: string; args: string[]; packageDir?: string } {
  const real = realpathSync(bin);
  return /\.[cm]?js$/.test(real)
    ? { command: node, args: [real] }
    : { command: real, args: [], packageDir: dirname(real) };
}

/** The run's pi home: `SKY_PI_HOME`, else `$HOME/.sky/pi`. Its `agent` directory is pi's config directory. */
export function piHomeOf(env: NodeJS.ProcessEnv): string {
  return env.SKY_PI_HOME || join(env.HOME || homedir(), ".sky", "pi");
}

/** The tool names pi's extension never asks the runner about: reads, and the runner's own tools, which ask through the broker. */
const UNGATED_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  PUBLISH_TOOL,
  SYNC_TOOL,
] as const;

/** The Claude-shaped names Sky's approval policy and events use for pi's built-in tools. */
const TOOL_NAMES: Record<string, string> = {
  bash: "Bash",
  write: "Write",
  edit: "Edit",
  read: "Read",
  grep: "Grep",
  find: "Glob",
  ls: "LS",
};
const eventToolName = (tool: string) => TOOL_NAMES[tool] ?? tool;

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * The file pi's `write` and `edit` change for `path`: pi 1.6.1's `resolveToCwd` (`utils/paths.js`), which
 * maps unicode spaces to spaces, strips a leading `@`, expands `~` and turns a `file://` URL into its
 * path, and doesn't trim. Symlinks are not followed.
 */
const piWritePath = (cwd: string, home: string, path: string) => {
  let bare = path.replace(UNICODE_SPACES, " ");
  if (bare.startsWith("@")) bare = bare.slice(1);
  if (bare === "~") return home;
  if (bare.startsWith("~/")) return join(home, bare.slice(2));
  if (bare.startsWith("file://")) {
    try {
      bare = fileURLToPath(bare);
    } catch {
      // pi's own call throws on this URL and writes nothing
    }
  }
  return resolve(cwd, bare);
};

/** One tool call as the policy reads it: the Claude-shaped name and input, and the files a change writes. */
export type PiCall = {
  toolName: string;
  input: Record<string, unknown>;
  /** Absolute paths a `Write` or `Edit` changes. */
  targets: string[];
  /** The command as the agent wrote it, before `unwrapShell`; a `Bash` call only. */
  rawCommand?: string;
};

/**
 * The Claude-shaped call for one of pi's tool calls, or undefined for a tool that only reads. `bash` is
 * `Bash`, with its shell wrapper unwrapped as Codex's are; `write` is `Write` and `edit` is `Edit`, each
 * with its absolute path as `file_path`; any other tool (an MCP server's, one an extension adds) keeps
 * its name, so a policy pattern naming it holds it.
 */
export function piToolCall(
  tool: string,
  raw: unknown,
  cwd: string,
  home = homedir(),
): PiCall | undefined {
  if ((UNGATED_TOOLS as readonly string[]).includes(tool)) return undefined;
  const input =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  if (tool === "bash") {
    const command = typeof input.command === "string" ? input.command : "";
    return {
      toolName: "Bash",
      input: { command: unwrapShell(command) },
      targets: [],
      rawCommand: command,
    };
  }
  if (tool === "write" || tool === "edit") {
    const path = piWritePath(
      cwd,
      home,
      typeof input.path === "string" ? input.path : "",
    );
    const { path: _path, ...rest } = input;
    return {
      toolName: eventToolName(tool),
      input: { file_path: path, ...rest },
      targets: [path],
    };
  }
  return { toolName: tool, input, targets: [] };
}

const SEGMENTS = /&&|\|\||[;|&\n]/;
// programs that run the command after their own arguments, and the options of each that take one
const WRAPPERS: Record<string, readonly string[]> = {
  sudo: [
    "-u",
    "-g",
    "-h",
    "-p",
    "-C",
    "-D",
    "-R",
    "-T",
    "-r",
    "-t",
    "-U",
    "--user",
    "--group",
    "--host",
    "--prompt",
    "--close-from",
    "--chdir",
    "--chroot",
    "--command-timeout",
    "--role",
    "--type",
    "--other-user",
  ],
  doas: ["-u", "-C"],
  env: ["-u", "-C", "-S", "--unset", "--chdir", "--split-string"],
  command: [],
  builtin: [],
  exec: ["-a"],
  nohup: [],
  time: ["-f", "-o", "--format", "--output"],
  nice: ["-n", "--adjustment"],
  ionice: ["-c", "-n", "-p", "--class", "--classdata", "--pid"],
  setsid: [],
  stdbuf: ["-i", "-o", "-e", "--input", "--output", "--error"],
  timeout: ["-s", "-k", "--signal", "--kill-after"],
  xargs: [
    "-a",
    "-n",
    "-I",
    "-L",
    "-P",
    "-s",
    "-d",
    "-E",
    "--arg-file",
    "--max-args",
    "--max-lines",
    "--max-procs",
    "--max-chars",
    "--delimiter",
  ],
};
// `env -S 'git push'` splits its value into the command it runs
const SPLIT_STRING = ["-S", "--split-string"];
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
// bash's long options that take a value; the rest are flags
const SHELL_WITH_ARGUMENT = ["--rcfile", "--init-file"];

/**
 * The option at `words[i]`: its name, the value it takes when `withArgument` names it (attached, as in
 * `--user=a` and `-ua`, or the next word), and the index of the word after both. A short cluster such
 * as `-iu a` is the first of its letters that takes a value.
 */
function option(
  words: { value: string }[],
  i: number,
  withArgument: readonly string[],
): { name: string; value?: string; next: number } {
  const word = words[i]?.value ?? "";
  if (word.startsWith("--")) {
    const equals = word.indexOf("=");
    if (equals >= 0)
      return {
        name: word.slice(0, equals),
        value: word.slice(equals + 1),
        next: i + 1,
      };
    return withArgument.includes(word)
      ? { name: word, value: words[i + 1]?.value, next: i + 2 }
      : { name: word, next: i + 1 };
  }
  for (let j = 1; j < word.length; j++) {
    const name = `-${word[j]}`;
    if (!withArgument.includes(name)) continue;
    return j + 1 < word.length
      ? { name, value: word.slice(j + 1), next: i + 1 }
      : { name, value: words[i + 1]?.value, next: i + 2 };
  }
  return { name: word, next: i + 1 };
}

/** The words of a shell command line, quotes and backslashes resolved and nothing expanded, each with where it starts. */
function shellWords(text: string): { value: string; start: number }[] {
  const words: { value: string; start: number }[] = [];
  let word: string | undefined;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? "";
    if (/\s/.test(c)) {
      if (word !== undefined) words.push({ value: word, start });
      word = undefined;
      continue;
    }
    if (word === undefined) start = i;
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      word = (word ?? "") + text.slice(i + 1, end < 0 ? undefined : end);
      i = end < 0 ? text.length : end;
    } else if (c === '"') {
      word ??= "";
      for (i++; i < text.length && text[i] !== '"'; i++) {
        if (text[i] === "\\" && '"\\$`'.includes(text[i + 1] ?? "\n")) i++;
        word += text[i] ?? "";
      }
    } else if (c === "\\" && i + 1 < text.length) {
      word = (word ?? "") + (text[++i] ?? "");
    } else word = (word ?? "") + c;
  }
  if (word !== undefined) words.push({ value: word, start });
  return words;
}

/** The command a wrapper at the head of `text` runs, as written, or undefined when it has none. */
function peel(text: string): string | undefined {
  const words = shellWords(text);
  const at = (i: number) => words[i]?.value ?? "";
  let first = 0;
  // `FOO=1 git push` runs `git push`
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(at(first))) first++;
  const program = basename(at(first));
  if (first > 0 && program) return text.slice(words[first]?.start);
  if (SHELLS.has(program)) {
    // `-c` makes the first word that isn't an option the script, wherever it sits among the options
    let script = false;
    let i = first + 1;
    for (; i < words.length; i++) {
      const word = at(i);
      if (word === "--" || word === "-") {
        i++;
        break;
      }
      if (/^[-+][A-Za-z]+$/.test(word)) {
        if (word.startsWith("-") && word.includes("c")) script = true;
        // `-o pipefail`, `+o history`, `-O extglob` and `-eo pipefail` each take the next word
        i += word.match(/[oO]/g)?.length ?? 0;
      } else if (word.startsWith("--")) {
        if (SHELL_WITH_ARGUMENT.includes(word)) i++;
      } else break;
    }
    return script ? words[i]?.value : undefined;
  }
  const withArgument = WRAPPERS[program];
  if (!withArgument) return undefined;
  let i = first + 1;
  // `timeout 10 git push` takes its duration before the command
  let positionals = program === "timeout" ? 1 : 0;
  while (i < words.length) {
    const word = at(i);
    if (word === "--") {
      i++;
      break;
    }
    if (word.startsWith("-") && word.length > 1) {
      const { name, value, next } = option(words, i, withArgument);
      if (program === "env" && SPLIT_STRING.includes(name)) {
        const rest = next < words.length ? text.slice(words[next]?.start) : "";
        return `${value ?? ""} ${rest}`.trim() || undefined;
      }
      i = next;
    } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) i++;
    else if (positionals > 0) {
      positionals--;
      i++;
    } else break;
  }
  return i < words.length ? text.slice(words[i]?.start) : undefined;
}

/**
 * Every command a `Bash` command line runs, with the wrappers peeled off each: `cd x && sudo -u a git
 * push` is the line, its two commands, and `git push`; `bash -lc 'git push'` is itself and the script.
 * A policy pattern that names a command is checked against all of them, so a wrapper can't hide the
 * command a pattern holds.
 */
export function commandViews(command: string, depth = 0): string[] {
  const views = new Set<string>([command]);
  if (depth > 4) return [...views];
  // the whole line first: a quoted script holds separators of its own
  const whole = peel(command.trim());
  if (whole !== undefined)
    for (const view of commandViews(whole, depth + 1)) views.add(view);
  for (const part of command.split(SEGMENTS)) {
    const segment = part.trim();
    if (!segment) continue;
    views.add(segment);
    const inner = peel(segment);
    if (inner !== undefined)
      for (const view of commandViews(inner, depth + 1)) views.add(view);
  }
  return [...views];
}

/** How the environment's policy treats one of pi's tool calls; the same answer Codex's runs get. */
export function piOutcome(
  config: Pick<Config, "approvalPolicy" | "autoApprove">,
  call: PiCall,
  scope: Parameters<typeof policyOutcome>[2],
  cwd: string,
): "run" | "auto-approved" | "hold" {
  if (call.toolName === "Bash") {
    // a pattern that names a command holds it however it is wrapped; a bare `Bash` pattern lets the
    // read-only commands through, judged on the command the shell wrapper runs
    const named = config.approvalPolicy.filter((pattern) => pattern !== "Bash");
    if (
      commandViews(call.rawCommand ?? "").some((view) =>
        matchesPolicy(named, "Bash", { command: view }),
      )
    )
      return "hold";
    return policyOutcome(
      config.approvalPolicy,
      config.autoApprove,
      scope,
      "Bash",
      call.input,
    );
  }
  if (call.targets.length === 0)
    return policyOutcome(
      config.approvalPolicy,
      config.autoApprove,
      scope,
      call.toolName,
      call.input,
    );
  // a change to a file outside the worktree is the person's to approve, whatever the policy says
  if (call.targets.some((path) => outside(cwd, path))) return "hold";
  const outcomes = call.targets.map((path) =>
    policyOutcome(
      config.approvalPolicy,
      config.autoApprove,
      scope,
      call.toolName,
      { file_path: path },
    ),
  );
  return outcomes.includes("hold")
    ? "hold"
    : outcomes.includes("auto-approved")
      ? "auto-approved"
      : "run";
}

const summaryOf = (call: PiCall) =>
  String(call.input.command ?? call.input.file_path ?? call.toolName);

/**
 * What the agent is told on every pi run: Codex's, with a denial's reason where pi puts it (the blocked
 * call's result, not a message), and that pi has no subagents.
 */
export function piInstructions(
  options: Parameters<typeof runtimeInstructions>[0],
): string {
  return [
    runtimeInstructions(options).replace(
      "When the person gives a reason, it follows as a message: do what it says.",
      "When the person gives a reason, it comes back as that step's result: do what it says.",
    ),
    "You run on pi, which has no subagents: do the work yourself with your own tools.",
  ].join("\n\n");
}

/** The pi settings Sky writes for a run: nothing that loads code, and no telemetry. Replaced whole on every run. */
export const PI_SETTINGS = {
  packages: [],
  extensions: [],
  skills: [],
  defaultProjectTrust: "never",
  enableInstallTelemetry: false,
  quietStartup: true,
} as const;

/**
 * The run's `mcp.json`: the base profile's servers, each secret a `${NAME}` reference pi reads from its
 * own environment, so the file holds no value. Every tool is declared to the model, as Claude Code's are.
 * A server whose secret the run doesn't have is left out and named in `unresolved`.
 */
export function piMcpConfig(
  profile: Record<string, BaseProfileMcpServer>,
  env: NodeJS.ProcessEnv,
): {
  mcpServers: Record<string, unknown>;
  unresolved: { server: string; secrets: string[] }[];
} {
  const { servers, unresolved } = sessionMcpServers(profile, env);
  const refs = (named: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(named).map(([key, secret]) => [key, `\${${secret}}`]),
    );
  const mcpServers: Record<string, unknown> = {};
  for (const name of Object.keys(servers)) {
    const server = profile[name];
    if (!server) continue;
    mcpServers[name] =
      "command" in server
        ? {
            command: server.command,
            args: server.args,
            env: refs(server.env),
            exposure: "direct",
          }
        : {
            url: server.url,
            headers: refs(server.headers),
            exposure: "direct",
          };
  }
  return { mcpServers, unresolved };
}

/** The first line of a dialog title the extension sends the runner; everything after it is a JSON request. */
const REQUEST_PREFIX = "sky:";

/**
 * The extension the run loads into pi, as JavaScript. It holds no secret: the gateway token is read from
 * pi's environment, which it clears, when pi loads it. Every call it can't tell is read-only goes to the
 * runner and waits for the answer; a call the runner doesn't allow, or doesn't answer, is blocked.
 */
export function piExtensionSource(options: {
  baseUrl: string;
  model: string;
  tools: { name: string; description: string; parameters: unknown }[];
}): string {
  const config = {
    provider: PI_PROVIDER,
    tokenEnv: PI_GATEWAY_TOKEN_ENV,
    prefix: REQUEST_PREFIX,
    ungated: UNGATED_TOOLS,
    ...options,
  };
  return `// written by Sky's runner for one run; edits are replaced
const config = ${JSON.stringify(config)};

export default function (pi) {
  const token = process.env[config.tokenEnv];
  // pi's commands inherit its env: the token is for the provider below alone
  delete process.env[config.tokenEnv];
  if (!token) throw new Error("the run's gateway token is missing");
  pi.registerProvider(config.provider, {
    name: "Vercel AI Gateway, through Sky",
    baseUrl: config.baseUrl,
    apiKey: token,
    api: "openai-completions",
    models: [
      {
        id: config.model,
        name: config.model,
        reasoning: false,
        input: ["text"],
        // the gateway's models have no price pi knows: it reports tokens, and a cost of 0
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          maxTokensField: "max_tokens",
        },
      },
    ],
  });

  // a dialog the runner answers with JSON; undefined when it never does
  const ask = async (ctx, request, signal) => {
    let answer;
    try {
      answer = await ctx.ui.input(
        config.prefix + JSON.stringify(request),
        undefined,
        signal ? { signal } : undefined,
      );
    } catch {
      return undefined;
    }
    if (typeof answer !== "string") return undefined;
    try {
      return JSON.parse(answer);
    } catch {
      return undefined;
    }
  };

  const ungated = new Set(config.ungated);
  pi.on("tool_call", async (event, ctx) => {
    if (ungated.has(event.toolName)) return undefined;
    const answer = await ask(
      ctx,
      { kind: "call", id: event.toolCallId, tool: event.toolName, input: event.input },
      ctx.signal,
    );
    if (answer && answer.allow === true) return undefined;
    return {
      block: true,
      reason: (answer && answer.reason) || "no one answered in time",
    };
  });

  for (const tool of config.tools) {
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      async execute(id, params, signal, _onUpdate, ctx) {
        const answer = await ask(
          ctx,
          { kind: "tool", id, tool: tool.name, args: params },
          signal,
        );
        if (!answer) throw new Error(tool.name + " got no answer from the runner: nothing was sent.");
        if (answer.success !== true) throw new Error(answer.text || tool.name + " failed");
        return { content: [{ type: "text", text: answer.text || "(no output)" }], details: {} };
      },
    });
  }
}
`;
}

const Request = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("call"),
    id: z.string(),
    tool: z.string(),
    input: z.unknown(),
  }),
  z.object({
    kind: z.literal("tool"),
    id: z.string(),
    tool: z.string(),
    args: z.unknown(),
  }),
]);

const TextContent = z.array(
  z.looseObject({ type: z.string(), text: z.string().optional() }),
);
const textOf = (content: unknown) => {
  const parsed = TextContent.safeParse(content);
  return parsed.success
    ? parsed.data
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n")
    : "";
};

const Cost = z.looseObject({ total: z.number().optional() });
const UsageNote = z.looseObject({
  input: z.number().default(0),
  output: z.number().default(0),
  cacheRead: z.number().default(0),
  cacheWrite: z.number().default(0),
  cost: Cost.optional(),
});
const AssistantMessage = z.looseObject({
  role: z.literal("assistant"),
  content: z.unknown(),
  usage: UsageNote.optional(),
  stopReason: z.string().optional(),
  errorMessage: z.string().optional(),
});
const ToolStart = z.looseObject({
  toolCallId: z.string(),
  toolName: z.string(),
  args: z.unknown(),
});
const ToolEnd = z.looseObject({
  toolCallId: z.string(),
  toolName: z.string(),
  result: z.looseObject({ content: z.unknown() }).optional(),
  isError: z.boolean().optional(),
  durationMs: z.number().optional(),
});
const Retry = z.looseObject({
  attempt: z.number().optional(),
  maxAttempts: z.number().optional(),
  errorMessage: z.string().optional(),
});
const RetryEnd = z.looseObject({
  success: z.boolean(),
  finalError: z.string().optional(),
});
const Settled = z.looseObject({ aborted: z.boolean().optional() });
const Compaction = z.looseObject({
  result: z.looseObject({ usage: UsageNote.optional() }).optional(),
});

/** Why a pi run couldn't reach its model through the AI Gateway, as the run's error names it. */
const UNAVAILABLE_CAUSE = {
  credit: "the AI Gateway is out of credit",
  rate: "the AI Gateway rate-limited this run",
} as const;

/** The run's error for a turn the gateway refused; the API appends how to switch the environment's runtime. */
export const piUnavailable = (cause: "credit" | "rate", said: string) =>
  `pi_unavailable: ${UNAVAILABLE_CAUSE[cause]} (pi said: ${said.trim().slice(0, 300)})`;

type RunnerEvent = Omit<RunnerEventPost, "runId">;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

const bound = (s: string) => s.slice(0, RUNNER_TEXT_MAX);
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const warnStderr = (line: string) => process.stderr.write(`${line}\n`);

export type PiDeps = {
  post: PostEvent;
  awaitDecision: AwaitDecision;
  signal: AbortSignal;
  warn?: (line: string) => void;
  /** The AI Gateway key `main` took out of the runner's env; only the run's gateway proxy holds it. */
  gatewayEnv: NodeJS.ProcessEnv;
  /** Starts the run's gateway proxy; `startGatewayProxy` when absent. */
  startProxy?: (options: GatewayProxyOptions) => Promise<GatewayProxy>;
  /** The gateway the proxy forwards to; `GATEWAY_PI_URL` when absent. */
  gatewayUrl?: string;
  /** The GitHub connector variables `main` took out; publish and sync reach GitHub only through the broker. */
  connector?: NodeJS.ProcessEnv;
  /** What the environment's refresh script did before the run; none when the env has none. */
  envRefresh?: EnvRefresh;
  /** The runner's env for everything but the key; `process.env` when absent. */
  env?: NodeJS.ProcessEnv;
  /** How often a tool call in flight is reported. */
  heartbeatMs?: number;
  /** Keeps the gateway key out of the agent's commands' reach; a seal with a problem fails the run before it starts. */
  seal: Seal;
  /** The pi launcher; `SKY_PI_BIN`, else `PI_BIN`. */
  bin?: string;
  /** How long a stopped run gets to end before pi is killed. */
  stopGraceMs?: number;
};

/** Writes `content` to `file` whole, so a run starting beside this one never reads half of it. */
function writeWhole(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.${randomUUID()}`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, file);
}

/** Runs one pi turn for the run and reports it; resolves to the process exit code. */
export async function runPiSession(
  config: Config,
  deps: PiDeps,
): Promise<0 | 1> {
  const { runId } = config;
  const warn = deps.warn ?? warnStderr;
  const env = deps.env ?? process.env;
  let queue = Promise.resolve();
  const post = (event: RunnerEvent, options?: Parameters<PostEvent>[1]) => {
    const posted = queue.then(() =>
      deps.post({ runId, ...event } as RunnerEventPost, options),
    );
    queue = posted.catch(() => {});
    return posted;
  };
  const warning = (message: string) => {
    warn(`runner: ${message}`);
    void post({
      type: "runner.warning",
      payload: { message: bound(message) },
    }).catch(() => {});
  };
  let ended = false;
  let openRequest: RequestId | undefined;
  let withdrawn: AbortController | undefined;
  const abortController = new AbortController();
  let stopReason: string | undefined;
  let rpc: PiRpc | undefined;
  const stopSession = (reason: string) => {
    stopReason ??= reason;
    abortController.abort(reason);
    rpc?.abort();
  };
  const forward = () =>
    stopSession(`interrupted by ${String(deps.signal.reason)}`);
  deps.signal.addEventListener("abort", forward, { once: true });
  if (deps.signal.aborted) forward();

  const withdrawOpen = async (reason: WithdrawalReason): Promise<boolean> => {
    const requestId = openRequest;
    if (requestId === undefined) return false;
    try {
      await post(
        { type: "run.withdrawn", payload: { requestId, reason } },
        { giveUp: abortController.signal },
      );
      if (openRequest === requestId) openRequest = undefined;
      withdrawn?.abort();
      return false;
    } catch (error) {
      if (error instanceof RunEndedError) {
        ended = true;
        openRequest = undefined;
        return true;
      }
      warn(`runner: ${messageOf(error)}`);
      return false;
    }
  };
  const end = async (event: RunnerEvent) => {
    if (ended) return;
    ended = true;
    if (openRequest !== undefined && (await withdrawOpen("run_ending"))) return;
    await post(event);
  };
  const fail = async (error: string, usage?: Usage, rollup?: RunRollup) => {
    await end({
      type: "run.failed",
      payload: { error, ...(usage && { usage }), ...(rollup && { rollup }) },
    });
    return 1 as const;
  };

  // before the runner starts a single command the repo can influence, git's included
  if (deps.seal.problem) {
    deps.signal.removeEventListener("abort", forward);
    return fail(
      `credential_exposed: Sky can't keep its AI Gateway key from this repo's commands (${deps.seal.problem}); the run did not start.`,
    );
  }

  let cwd: string;
  let notes: string[];
  let refreshed: Refreshed | undefined;
  try {
    ({ cwd, notes, refreshed } = await prepareWorktree(config, {
      env: { ...env, ...deps.connector, ...config.sessionEnv },
      warn,
      signal: deps.signal,
    }));
  } catch (error) {
    deps.signal.removeEventListener("abort", forward);
    if (deps.signal.aborted)
      return fail(`interrupted by ${String(deps.signal.reason)}`);
    return fail(`worktree setup failed: ${messageOf(error)}`);
  }
  const runStart = await headSha(cwd).catch((error: unknown) =>
    error instanceof Error ? error : new Error(String(error)),
  );

  // the API keeps one open request per run, so parallel asks take turns
  let turn = Promise.resolve();
  let startLanded: Promise<void> = Promise.resolve();
  const decide = (
    request: DistributiveOmit<PendingRequest, "requestId">,
    signal: AbortSignal,
  ) => {
    const decided = turn.then(() => waitForDecision(request, signal));
    turn = decided.then(
      () => {},
      () => {},
    );
    return decided;
  };
  /** The person's decision, or undefined when the run is ending without one. */
  const waitForDecision = async (
    request: DistributiveOmit<PendingRequest, "requestId">,
    signal: AbortSignal,
  ): Promise<Decision | undefined> => {
    if (abortController.signal.aborted || signal.aborted) return undefined;
    const requestId: RequestId = `req_${randomUUID().replaceAll("-", "")}`;
    withdrawn = new AbortController();
    const stop = AbortSignal.any([
      abortController.signal,
      signal,
      withdrawn.signal,
    ]);
    let posting = false;
    try {
      await startLanded;
      const deadline = Date.now() + config.waitTimeoutMs;
      posting = true;
      await post(
        {
          type: "run.waiting",
          payload: { request: { ...request, requestId } },
        },
        { deadline, signal: stop },
      );
      posting = false;
      openRequest = requestId;
      const outcome = await deps.awaitDecision(requestId, stop, deadline);
      openRequest = undefined;
      switch (outcome.kind) {
        case "decided":
          return outcome.decision;
        case "run_ended":
          ended = true;
          stopSession("run ended while waiting");
          return undefined;
        case "lost":
          stopSession(`request ${requestId} was never recorded`);
          return undefined;
        case "expired":
          stopSession("waiting_timeout");
          return undefined;
      }
    } catch (error) {
      if (error instanceof RunEndedError) {
        openRequest = undefined;
        ended = true;
        stopSession("run ended while waiting");
        return undefined;
      }
      if (!stop.aborted) {
        if (openRequest === requestId) openRequest = undefined;
        stopSession(messageOf(error));
        return undefined;
      }
      if (posting) openRequest = requestId;
      await withdrawOpen(
        deps.signal.aborted ? "run_stopping" : "session_ending",
      );
      return undefined;
    }
  };

  const approveBrokered = async (
    ask: ApprovalAsk,
    signal: AbortSignal,
  ): Promise<ApprovalAnswer> => {
    const decision = await decide(
      {
        kind: "approval",
        toolName: ask.toolName,
        toolSummary: bound(ask.toolSummary),
        toolInput: ask.toolInput.slice(0, TOOL_INPUT_POST_MAX),
      },
      signal,
    );
    if (decision?.decision === "approve") return { approved: true };
    if (decision === undefined)
      return { approved: false, reason: "no one answered in time" };
    return {
      approved: false,
      reason:
        (decision.decision === "deny" && decision.reason) ||
        "The user denied this call.",
    };
  };

  const scratch = scratchDirOf(runId);
  let broker: Broker | undefined;
  let proxy: GatewayProxy | undefined;
  let child: ChildProcess | undefined;
  let usage: Usage | undefined;
  let lastText = "";
  const connectorEnv = deps.connector ?? {};
  const sessionEnv = { ...env, ...config.sessionEnv };
  let streamError: string | undefined;
  // the errors pi reported since its last model call that succeeded, and whether the run failed on
  // one rather than being stopped: a 429 pi got past says nothing about a later failure
  const modelErrors: { message: string }[] = [];
  let turnFailed = false;
  let heartbeat: ReturnType<typeof createHeartbeat> | undefined;
  const startedAt = Date.now();
  const progress = { giveUp: abortController.signal };

  try {
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    if (connectorEnv[CONNECTOR_ENV]) {
      broker = await startBroker({
        socketPath: brokerSocketIn(scratch),
        cwd,
        env: { ...sessionEnv, ...connectorEnv },
        sealProblem: () => deps.seal.problem ?? deps.seal.check(),
        approve: approveBrokered,
        warn: warning,
      });
    }
    const key = deps.gatewayEnv[CODEX_KEY_ENV];
    if (!key) throw new Error(`${CODEX_KEY_ENV} is not set for this run`);
    proxy = await (deps.startProxy ?? startGatewayProxy)({
      upstream: deps.gatewayUrl ?? GATEWAY_PI_URL,
      key,
      warn: warning,
    });
    const home = sessionEnv.HOME || homedir();
    const piHome = piHomeOf(sessionEnv);
    const agentDir = join(piHome, "agent");
    const sessionDir = join(piHome, "sessions");
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    writeWhole(
      join(agentDir, "settings.json"),
      `${JSON.stringify(PI_SETTINGS, null, 2)}\n`,
    );
    // the base profile's MCP servers; a file from an earlier run goes when this run has none
    const mcp = piMcpConfig(config.mcpServers, sessionEnv);
    const mcpFile = join(agentDir, "mcp.json");
    if (Object.keys(mcp.mcpServers).length > 0)
      writeWhole(
        mcpFile,
        `${JSON.stringify({ mcpServers: mcp.mcpServers }, null, 2)}\n`,
      );
    else rmSync(mcpFile, { force: true });
    if (mcp.unresolved.length > 0)
      warning(unresolvedServersWarning(mcp.unresolved));
    // skills the environment's setup installed; a directory that isn't there is skipped, with a warning
    const skills: string[] = [];
    for (const dir of config.piSkills ?? []) {
      const path = resolve(
        dir.startsWith("~/") ? join(home, dir.slice(2)) : dir,
      );
      if (existsSync(path) && statSync(path).isDirectory()) skills.push(path);
      else warning(`pi skill directory ${dir} is not there; skipped`);
    }

    const model = config.piModel ?? DEFAULT_PI_MODEL;
    const extension = join(scratch, "sky-pi-extension.mjs");
    writeFileSync(
      extension,
      piExtensionSource({
        baseUrl: proxy.baseUrl,
        model,
        tools: broker
          ? DYNAMIC_TOOLS.map((tool) => ({
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            }))
          : [],
      }),
      { mode: 0o600 },
    );
    const instructions = join(scratch, "sky-pi-instructions.md");
    writeFileSync(
      instructions,
      piInstructions({
        broker: broker !== undefined,
        refreshed,
        checks: config.checks,
        notes,
      }),
      { mode: 0o600 },
    );
    const sessionId = config.sessionId ?? randomUUID();
    const launcher = resolvePiExecutable(deps.bin ?? env.SKY_PI_BIN ?? PI_BIN);
    // pi's env, which the agent's commands get whole (the project's secrets included, as Claude Code's
    // commands get them) except the gateway token, which the extension clears: never the connector (the
    // broker does the sending), the event token (the runner posts the run's events) or the gateway key
    // (the proxy holds it), and its git runs no fsmonitor
    const {
      SKY_PI_HOME: _home,
      AGENT_TOKEN: _token,
      [CODEX_KEY_ENV]: _key,
      [PI_GATEWAY_TOKEN_ENV]: _proxyToken,
      ...childEnv
    } = withoutConnector(withSessionGitConfig(sessionEnv));
    // the seal's spawn ends the process with this signal; the run's own stop goes through `abort`
    child = deps.seal.spawn({
      command: launcher.command,
      args: [
        ...launcher.args,
        "--mode",
        "rpc",
        "--provider",
        PI_PROVIDER,
        "--model",
        model,
        "--session-id",
        sessionId,
        "--session-dir",
        sessionDir,
        // only what the runner names loads: the repo's `.pi` is ignored, and an extension, skill or
        // package an agent's command left in pi's directories is too
        "--no-extensions",
        "--extension",
        extension,
        ...(Object.keys(mcp.mcpServers).length > 0
          ? ["--extension", "builtin:mcp"]
          : ["--no-mcp"]),
        "--no-approve",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        ...skills.flatMap((dir) => ["--skill", dir]),
        "--append-system-prompt",
        instructions,
      ],
      name: "pi",
      // drained by the RPC client for the tail its exit error carries
      stderr: "pipe",
      cwd,
      env: {
        ...childEnv,
        [PI_GATEWAY_TOKEN_ENV]: proxy.token,
        PI_CODING_AGENT_DIR: agentDir,
        ...(launcher.packageDir && { PI_PACKAGE_DIR: launcher.packageDir }),
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
      },
      signal: new AbortController().signal,
    }) as ChildProcess;
    const client = new PiRpc(child);
    rpc = client;
    const gone = client.exited.then((exit) => {
      throw new Error(exit.error);
    });
    // only read if pi exits first; a later exit mustn't surface as an unhandled rejection
    gone.catch(() => {});
    const state = z
      .looseObject({ sessionId: z.string().optional() })
      .parse(
        await Promise.race([
          client.command("get_state", {}, 60_000, abortController.signal),
          gone,
        ]),
      );
    // pi is past its exec, so what the kernel does with its `/proc` entries is settled
    const exposed = deps.seal.check();
    if (exposed)
      throw new Error(`credential_exposed: ${exposed}; the run was stopped.`);
    if (config.sessionId && client.stderrText().includes("No project session"))
      warning(
        `pi had no session ${config.sessionId} to resume; this run started a fresh one`,
      );
    const session = state.sessionId ?? sessionId;

    startLanded = post(
      {
        type: "run.started",
        payload: {
          sessionId: session,
          ...(deps.envRefresh && { refresh: deps.envRefresh }),
        },
      },
      { deadline: Date.now() + 60_000, signal: abortController.signal },
    );
    await startLanded;

    heartbeat = createHeartbeat({
      beat: (beat) =>
        void post(
          { type: "runner.heartbeat", payload: beat },
          { ...progress, maxAttempts: 1 },
        ).catch(() => {}),
      intervalMs: deps.heartbeatMs,
    });

    type Call = {
      name: string;
      input: string;
      pre: boolean;
      note?: AutoApproved;
      at: number;
    };
    const calls = new Map<string, Call>();
    const tokens = { input: 0, output: 0, cost: 0, modelCalls: 0 };
    let lastAssistant: z.infer<typeof AssistantMessage> | undefined;
    let settledNote: (aborted: boolean) => void = () => {};
    const settled = new Promise<{ status: "settled"; aborted: boolean }>(
      (resolveSettled) => {
        settledNote = (aborted) =>
          resolveSettled({ status: "settled", aborted });
      },
    );

    const emitPre = (id: string) => {
      const call = calls.get(id);
      if (!call || call.pre) return;
      call.pre = true;
      heartbeat?.started(id, call.name);
      void post(
        {
          type: "claude.PreToolUse",
          payload: {
            toolName: call.name,
            toolUseId: id,
            input: bound(call.input),
            ...(call.note && { autoApproved: call.note }),
          },
        },
        progress,
      ).catch(() => {});
    };
    const track = (id: string, name: string, input: unknown) => {
      if (calls.has(id)) return;
      calls.set(id, {
        name,
        input: JSON.stringify(input),
        pre: false,
        at: Date.now(),
      });
    };
    const settle = (
      id: string,
      result: { output: string } | { error: string },
      durationMs?: number,
    ) => {
      const call = calls.get(id);
      if (!call) return;
      emitPre(id);
      heartbeat?.ended(id);
      calls.delete(id);
      const duration = Math.max(
        0,
        Math.round(durationMs ?? Date.now() - call.at),
      );
      void post(
        "output" in result
          ? {
              type: "claude.PostToolUse",
              payload: {
                toolName: call.name,
                toolUseId: id,
                input: bound(call.input),
                output: bound(result.output),
                durationMs: duration,
              },
            }
          : {
              type: "claude.PostToolUseFailure",
              payload: {
                toolName: call.name,
                toolUseId: id,
                input: bound(call.input),
                error: bound(result.error),
                durationMs: duration,
              },
            },
        progress,
      ).catch(() => {});
    };

    const scope = {
      root: cwd,
      cwd,
      realpath: (p: string) => p,
      isSymlink: () => false,
      home: sessionEnv.HOME ?? "/",
      storeHome: config.storeHome,
      scratch,
    };

    /** A call the extension asks about: answered from the policy, or held for a person. */
    const answerCall = async (
      request: Extract<z.infer<typeof Request>, { kind: "call" }>,
    ) => {
      const call = piToolCall(request.tool, request.input, cwd, home);
      if (!call) return { allow: true };
      if (!calls.has(request.id)) track(request.id, call.toolName, call.input);
      const tracked = calls.get(request.id);
      const outcome = piOutcome(config, call, scope, cwd);
      if (outcome !== "hold") {
        if (tracked && outcome === "auto-approved")
          tracked.note = {
            verdict: "approved",
            reason: "the command is on the default auto-approve list",
          };
        emitPre(request.id);
        return { allow: true };
      }
      const decision = await decide(
        {
          kind: "approval",
          toolName: call.toolName,
          toolSummary: bound(summaryOf(call)),
          toolInput: JSON.stringify(call.input).slice(0, TOOL_INPUT_POST_MAX),
        },
        abortController.signal,
      );
      if (decision?.decision === "approve") {
        emitPre(request.id);
        return { allow: true };
      }
      return {
        allow: false,
        reason:
          decision === undefined
            ? "no one answered in time"
            : (decision.decision === "deny" && decision.reason) ||
              "The person declined this call.",
      };
    };

    /** The agent's `sky_publish` or `sky_sync`: the runner asks its own broker, which opens the approval and does the sending. */
    const runTool = async (
      request: Extract<z.infer<typeof Request>, { kind: "tool" }>,
    ) => {
      const reply = (text: string, success: boolean) => ({
        text: text || "(no output)",
        success,
      });
      if (request.tool !== PUBLISH_TOOL && request.tool !== SYNC_TOOL)
        return reply(`No tool named ${request.tool} here.`, false);
      if (!broker)
        return reply(
          `${request.tool} needs the environment's GitHub connector, which this run doesn't have: nothing was sent.`,
          false,
        );
      const op = request.tool === PUBLISH_TOOL ? "publish" : "sync";
      const parsed =
        op === "publish"
          ? PublishArgs.safeParse(request.args)
          : SyncArgs.safeParse(request.args);
      if (!parsed.success)
        return reply(`Invalid arguments: ${parsed.error.message}`, false);
      const token = broker.issue(request.id, op);
      let out = "";
      try {
        const code = await askBroker(
          `sky ${op}`,
          { op, ...parsed.data },
          {
            [BROKER_SOCKET_ENV]: brokerSocketIn(scratch),
            [BROKER_TOKEN_ENV]: token,
          },
          {
            cwd,
            stdout: (s) => {
              out += s;
            },
            stderr: (s) => {
              out += s;
            },
          },
        );
        return reply(out.trim(), code === 0);
      } finally {
        broker.release(request.id);
      }
    };

    client.onUiRequest = async (ui) => {
      // only the extension's dialogs are the runner's to answer; anything else asked for a person at a terminal
      if (ui.method !== "input" || !ui.title.startsWith(REQUEST_PREFIX))
        return { cancelled: true };
      let request: z.infer<typeof Request>;
      try {
        request = Request.parse(
          JSON.parse(ui.title.slice(REQUEST_PREFIX.length)),
        );
      } catch (error) {
        warn(
          `runner: unreadable request from pi's extension: ${messageOf(error)}`,
        );
        return { cancelled: true };
      }
      const answer =
        request.kind === "call"
          ? await answerCall(request)
          : await runTool(request);
      return { value: JSON.stringify(answer) };
    };

    client.onEvent = (type, raw) => {
      try {
        switch (type) {
          case "tool_execution_start": {
            const start = ToolStart.parse(raw);
            const name = eventToolName(start.toolName);
            const ungated = (UNGATED_TOOLS as readonly string[]).includes(
              start.toolName,
            );
            const call = piToolCall(start.toolName, start.args, cwd, home);
            track(
              start.toolCallId,
              call?.toolName ?? name,
              call?.input ?? start.args ?? {},
            );
            // a read, and the runner's own tools, which open their approval through the broker, run unasked
            if (ungated) emitPre(start.toolCallId);
            return;
          }
          case "tool_execution_end": {
            const end = ToolEnd.parse(raw);
            const text = textOf(end.result?.content);
            if (end.isError)
              settle(
                end.toolCallId,
                { error: text || `${end.toolName} failed` },
                end.durationMs,
              );
            else settle(end.toolCallId, { output: text }, end.durationMs);
            return;
          }
          case "message_end": {
            const message = AssistantMessage.safeParse(
              (raw as { message?: unknown }).message,
            );
            if (!message.success) return;
            lastAssistant = message.data;
            const used = message.data.usage;
            if (used) {
              tokens.input += used.input + used.cacheRead + used.cacheWrite;
              tokens.output += used.output;
              tokens.cost += used.cost?.total ?? 0;
              tokens.modelCalls += 1;
            }
            if (message.data.stopReason === "error")
              modelErrors.push({
                message: message.data.errorMessage ?? "the model call failed",
              });
            else modelErrors.length = 0;
            const text = textOf(message.data.content);
            if (!text) return;
            lastText = text;
            void post(
              { type: "claude.Message", payload: { text: bound(text) } },
              progress,
            ).catch(() => {});
            return;
          }
          case "auto_retry_start": {
            const retry = Retry.parse(raw);
            if (retry.errorMessage)
              modelErrors.push({ message: retry.errorMessage });
            warning(
              `pi is retrying (${retry.attempt ?? "?"}/${retry.maxAttempts ?? "?"}): ${retry.errorMessage ?? "the model call failed"}`,
            );
            return;
          }
          case "auto_retry_end": {
            const retry = RetryEnd.parse(raw);
            if (retry.success) modelErrors.length = 0;
            else if (retry.finalError)
              modelErrors.push({ message: retry.finalError });
            return;
          }
          case "compaction_end": {
            // a summary is a model call of its own
            const used = Compaction.parse(raw).result?.usage;
            if (used) {
              tokens.input += used.input + used.cacheRead + used.cacheWrite;
              tokens.output += used.output;
              tokens.cost += used.cost?.total ?? 0;
              tokens.modelCalls += 1;
            }
            return;
          }
          case "extension_error": {
            const failure = z
              .looseObject({
                event: z.string().optional(),
                error: z.string().optional(),
              })
              .parse(raw);
            warning(
              `pi's extension failed on ${failure.event ?? "an event"}: ${failure.error ?? "unknown error"}`,
            );
            return;
          }
          case "agent_settled":
            settledNote(Settled.parse(raw).aborted === true);
            return;
        }
      } catch (error) {
        warn(`runner: unreadable pi ${type} event: ${messageOf(error)}`);
      }
    };

    const prompted = z
      .looseObject({ disposition: z.string().optional() })
      .optional()
      .parse(
        await client.command(
          "prompt",
          { message: config.prompt },
          120_000,
          abortController.signal,
        ),
      );
    if (prompted?.disposition === "handled")
      throw new Error("pi handled the prompt without running the agent");
    // a stop that landed while the prompt was starting
    if (abortController.signal.aborted) client.abort();

    const aborted = new Promise<{ status: "aborted" }>((resolveAbort) => {
      const onAbort = () =>
        // the aborted run gets a moment to report itself; then the run ends regardless
        setTimeout(
          () => resolveAbort({ status: "aborted" }),
          deps.stopGraceMs ?? 10_000,
        );
      if (abortController.signal.aborted) onAbort();
      else
        abortController.signal.addEventListener("abort", onAbort, {
          once: true,
        });
    });
    const outcome = await Promise.race([settled, aborted, client.exited]);
    if (outcome.status === "exited")
      streamError ??= outcome.error ?? "pi exited";
    else if (outcome.status === "settled") {
      const last = lastAssistant;
      if (last?.stopReason === "error") {
        streamError ??= last.errorMessage ?? "the model call failed";
        turnFailed = true;
      } else if (
        (outcome.aborted || last?.stopReason === "aborted") &&
        !abortController.signal.aborted
      )
        streamError ??= "the turn was aborted";
      if (!streamError)
        usage = {
          inputTokens: Math.round(tokens.input),
          outputTokens: Math.round(tokens.output),
          // pi prices a call from its model's cost, which the gateway's models don't give it: tokens only
          costUsd: tokens.cost,
          turns: tokens.modelCalls,
          durationMs: Date.now() - startedAt,
        };
    }
  } catch (error) {
    turnFailed = false;
    streamError = abortController.signal.aborted
      ? (stopReason ?? messageOf(error))
      : messageOf(error);
  } finally {
    deps.signal.removeEventListener("abort", forward);
    heartbeat?.stop();
    await broker?.close().catch(() => {});
    await rpc?.close();
    // after pi: its last model call may still be streaming until it exits
    await proxy?.close().catch(() => {});
    rmSync(scratch, { recursive: true, force: true });
  }

  let commitError: string | undefined;
  try {
    await commitAll({ cwd, agentId: config.agentId, runId });
  } catch (error) {
    commitError = `commit failed: ${messageOf(error)}`;
  }
  const rollup = ended ? undefined : await rollupOf(cwd, runStart);
  let failure = stopReason ?? streamError;
  // only a run that failed on its own: a stop, or Sky's own setup failing, is never the gateway's
  if (streamError && !stopReason && turnFailed) {
    const cause = gatewayUnavailable(
      modelErrors.map(({ message }) => ({ message })),
      proxy?.limitStatus?.(),
    );
    if (cause) failure = piUnavailable(cause, streamError);
  }
  if (failure) return fail(failure, usage, rollup);
  if (commitError) return fail(commitError, usage, rollup);
  if (!usage) return fail("session ended without a result", undefined, rollup);
  await end({
    type: "run.finished",
    payload: { summary: lastText, usage, ...(rollup && { rollup }) },
  });
  return 0;

  async function rollupOf(dir: string, since: string | Error) {
    try {
      if (since instanceof Error) throw since;
      return await diffRollup({ cwd: dir, since });
    } catch (error) {
      warn(`runner: rollup skipped: ${messageOf(error)}`);
      return undefined;
    }
  }
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type UiRequest = { id: string; method: string; title: string };

/**
 * One `pi --mode rpc` process and its protocol: one JSON object per line each way. Lines end at LF and
 * nowhere else (U+2028 and U+2029 are valid inside a JSON string), so this reads bytes and splits them
 * itself rather than through `readline`. A command's `response` settles its `command` call; a dialog the
 * extension opens goes to `onUiRequest`, whose answer is sent back; every other record is an event.
 */
export class PiRpc {
  onEvent: (type: string, record: unknown) => void = () => {};
  /** The answer to a dialog: `{ value }`, `{ confirmed }` or `{ cancelled: true }`. */
  onUiRequest: (request: UiRequest) => Promise<Record<string, unknown>> =
    async () => ({ cancelled: true });
  /** Resolves when the process exits, with the tail of what it wrote on stderr. */
  readonly exited: Promise<{ status: "exited"; error?: string }>;
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();
  private stderr = "";
  private readonly open = new Set<string>();

  constructor(private readonly child: ChildProcess) {
    this.exited = new Promise((resolveExit) => {
      const done = (detail: string) => {
        const error = `pi ${detail}${this.stderr ? `: ${this.stderr.slice(-500).trim()}` : ""}`;
        for (const call of this.pending.values()) call.reject(new Error(error));
        this.pending.clear();
        resolveExit({ status: "exited", error });
      };
      child.once("exit", (code, signal) =>
        done(`exited (${code ?? signal ?? "unknown"})`),
      );
      child.once("error", (error) =>
        done(`failed to start (${error.message})`),
      );
      // a write after the process died is an EPIPE here, which would otherwise crash the runner
      child.stdin?.on("error", (error) =>
        done(`stopped reading its stdin (${error.message})`),
      );
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-4_000);
    });
    if (child.stdout) {
      const decoder = new StringDecoder("utf8");
      let buffer = "";
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += decoder.write(chunk);
        for (
          let at = buffer.indexOf("\n");
          at >= 0;
          at = buffer.indexOf("\n")
        ) {
          const line = buffer.slice(0, at).replace(/\r$/, "");
          buffer = buffer.slice(at + 1);
          this.receive(line);
        }
      });
    }
  }

  /** What pi has written on stderr lately: the last few KB. */
  stderrText(): string {
    return this.stderr;
  }

  /** Sends a command and resolves to its response's `data`; rejects with pi's error, a timeout, or the process's exit. */
  command(
    type: string,
    body: Record<string, unknown> = {},
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const id = `sky-${this.nextId++}`;
    return new Promise((resolveCall, rejectCall) => {
      let timer: NodeJS.Timeout | undefined;
      const onAbort = () =>
        settle(() => rejectCall(new Error(String(signal?.reason))));
      const settle = (fn: () => void) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        fn();
      };
      this.pending.set(id, {
        resolve: (value) => settle(() => resolveCall(value)),
        reject: (error) => settle(() => rejectCall(error)),
      });
      if (timeoutMs)
        timer = setTimeout(
          () =>
            settle(() =>
              rejectCall(
                new Error(`pi didn't answer ${type} within ${timeoutMs} ms`),
              ),
            ),
          timeoutMs,
        );
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.send({ id, type, ...body });
    });
  }

  /** Tells pi to stop the run, and closes every dialog still open so a blocked call ends. */
  abort(): void {
    this.send({ id: `sky-${this.nextId++}`, type: "abort" });
    for (const id of this.open)
      this.send({ type: "extension_ui_response", id, cancelled: true });
    this.open.clear();
  }

  /** Ends the process: closes its stdin, then SIGTERM, then SIGKILL 5 s later if it is still running. */
  async close(): Promise<void> {
    const child = this.child;
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin?.end();
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    await this.exited;
    clearTimeout(timer);
  }

  private send(message: object): void {
    if (!this.child.stdin?.writable) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string): void {
    if (!line.trim()) return;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = String(record.type);
    if (type === "response") {
      const call =
        typeof record.id === "string" ? this.pending.get(record.id) : undefined;
      if (!call) return;
      if (record.success === false)
        call.reject(
          new Error(String(record.error ?? "pi refused the command")),
        );
      else call.resolve(record.data);
      return;
    }
    if (type === "extension_ui_request") {
      const id = String(record.id);
      const method = String(record.method);
      // only the dialogs expect an answer; a notification or status line does not
      if (!["select", "confirm", "input", "editor"].includes(method)) return;
      this.open.add(id);
      void this.onUiRequest({
        id,
        method,
        title: String(record.title ?? ""),
      }).then(
        (answer) => {
          if (this.open.delete(id))
            this.send({ type: "extension_ui_response", id, ...answer });
        },
        () => {
          if (this.open.delete(id))
            this.send({ type: "extension_ui_response", id, cancelled: true });
        },
      );
      return;
    }
    this.onEvent(type, record);
  }
}
