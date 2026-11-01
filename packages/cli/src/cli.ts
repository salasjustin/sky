import { parseArgs } from "node:util";
import { type AgentCommand, agentCommands } from "./agent.js";
import { type Api, ApiError, createApi } from "./api.js";
import { apply } from "./apply.js";
import { type Config, configPath, type Env, resolveConfig } from "./config.js";
import { env } from "./env.js";
import { createOutput, type Output, UsageError } from "./output.js";
import { secretDelete, secretList, secretSet } from "./secret.js";
import { version } from "./version.js";

export interface Io {
  argv: string[];
  env: Env;
  home: string;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  stderrIsTTY: boolean;
  stdin: {
    isTTY: boolean;
    readAll(): Promise<string>;
    /** Reads one line from the terminal without echoing it; the prompt goes to stderr. */
    promptHidden(prompt: string): Promise<string>;
    /** Reads one echoed line from the terminal, "" at end of input; the prompt goes to stderr. */
    prompt(prompt: string): Promise<string>;
  };
  sleep(ms: number): Promise<void>;
  now(): number;
  /** From return until the returned disarm runs, Ctrl-C prints `sky: <note>` on stderr before the process dies by SIGINT; arm before printing anything that invites a Ctrl-C. */
  onInterrupt(note: string): () => void;
}

const help = (io: Io) => `Usage:
  sky apply <env.yaml> [options]
      Create or update the environment env.yaml describes, wait until it's
      provisioned, and write sky-lock.json beside env.yaml.
  sky secret set <env> <NAME> [--connector=<connection id>] [options]
      Store a secret on an environment (<env> is its id or name). The value
      is read from stdin, or prompted for without echo on a terminal. With
      --connector, agents get the Sprites connection id as $NAME instead.
  sky secret list <env> [options]
      Print "<NAME> <kind>" per secret, kind being value or connector.
      Values are never printed.
  sky secret delete <env> <NAME> [options]
      Remove a secret from an environment.
  sky env list [options]
      Print "<id> <status> <repo> <name>" per environment.
  sky env show <env> [options]
      Print the same line for one environment (<env> is its id or name);
      a failed one adds the step it failed at and that step's stderr.
  sky env delete <env> [--yes] [options]
      Destroy the environment's sandbox and delete it with all its agents,
      runs and events. Refused while a run is active or it is provisioning.
      Asks to confirm on a terminal; anywhere else, or with --json, it
      needs --yes.
  sky env retry <env> [options]
      Provision a failed environment again. Prints its line, now
      provisioning; sky env show reports when it's ready.
  sky agent start <env> --prompt=<text|@file> [options]
  sky agent follow-up <agent> --prompt=<text|@file> [options]
      Start an agent on an environment (<env> is its id or name), or start
      an agent's next run once its last one has ended; @file reads the
      prompt from that file. Prints "<agentId> <runId>".
  sky agent archive <agent> [options]
      Stop any active run and delete the agent's worktree; uncommitted work
      in it is lost.
  sky inbox <agent> [options]
      Print what the agent's newest run is waiting on: "question <requestId>"
      then the question, or "approval <requestId> <tool>" then what the tool
      would do; nothing when nothing is pending. "<runId> <status>" goes to
      stderr.
  sky wait <agent> [--timeout=<seconds>] [options]
      Wait until the newest run needs input or ends, then print what inbox
      prints. An unreachable API or a 5xx is retried with backoff (at most
      30s apart); a 4xx ends the wait. With no --timeout it waits as long as
      the run and any outage take; --timeout bounds both.
  sky status <agent> [options]
      Print "<runId> <status>", then its summary, error and compare link.
  sky approve <agent> <requestId> [--reason=<text>] [options]
  sky deny <agent> <requestId> --reason=<text> [options]
  sky answer <agent> <requestId> -- <text>
      Decide a pending request. Options go before --, and everything after
      it is the answer, even text starting with '-'. Repeating the same
      decision exits 0; a request already decided differently exits 1 and
      the earlier decision stands.

Options:
  --url=<url>            API URL
  --api-key-env=<VAR>    read the API key from environment variable VAR
  --json                 print the API's object on stdout (inbox, wait and
                         status: the newest run; secret list: only each
                         name and kind; env delete and secret delete:
                         {"id"|"name": …, "deleted": true})
  -h, --help             show this help
  -v, --version          print the version (on its own: sky --version)

Configuration, first found wins:
  url:     --url, SKY_URL, "url" in the config file
  API key: --api-key-env, SKY_API_KEY, "apiKey" in the config file
  config file: ${configPath(io.env, io.home)}

Exit status: 0 done; 1 failed (API error, provisioning failed); 2 usage or
  config error, a rejected API key included
  inbox, wait and status exit with the newest run's state:
  0 finished; 3 waiting (needs input); 4 starting or running (wait: timed
  out); 5 failed; 6 stopped
`;

const commonOptions = {
  url: { type: "string" },
  "api-key-env": { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

/** Runs one invocation and returns its exit status; never throws for an expected failure. */
export async function run(io: Io): Promise<number> {
  const [command, ...rest] = io.argv;
  if (
    command === undefined ||
    command === "--help" ||
    command === "-h" ||
    command === "help"
  ) {
    (command === undefined ? io.stderr : io.stdout)(help(io));
    return command === undefined ? 2 : 0;
  }
  if (command === "--version" || command === "-v") {
    io.stdout(`${version}\n`);
    return 0;
  }
  try {
    switch (command) {
      case "apply":
        return await runApply(rest, io);
      case "secret":
        return await runSecret(rest, io);
      default:
        if (Object.hasOwn(commands, command)) {
          return await runCommand(command, rest, io);
        }
        throw new UsageError(`unknown command '${command}'`, true);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr(`sky: ${err.message}\n`);
      if (err.showHelpPointer) io.stderr("Run 'sky --help' for usage.\n");
      return 2;
    }
    throw err;
  }
}

function parse<
  O extends Record<string, { type: "string" | "boolean"; short?: string }>,
>(args: string[], options: O, unknownOptionHint?: string) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" && unknownOptionHint) {
      throw new UsageError(
        // drop parseArgs' own hint: it quotes only the first character of "- staging"
        `${(err as Error).message.replace(/ To specify a positional .*$/s, "")} ${unknownOptionHint}`,
        true,
      );
    }
    if (code?.startsWith("ERR_PARSE_ARGS_")) {
      throw new UsageError((err as Error).message, true);
    }
    throw err;
  }
}

/** Resolves config, runs the command, and turns an API error into its exit status. */
async function withApi(
  values: { url?: string; "api-key-env"?: string; json?: boolean },
  io: Io,
  action: (api: Api, out: Output) => Promise<number>,
): Promise<number> {
  const out = createOutput(values.json ?? false, io.stdout, io.stderr);
  const resolved = resolveConfig(
    { url: values.url, apiKeyEnv: values["api-key-env"] },
    io.env,
    io.home,
  );
  if (!resolved.ok) throw new UsageError(resolved.error);
  try {
    return await action(createApi(resolved.config), out);
  } catch (err) {
    if (err instanceof ApiError) return failApi(err, resolved.config, out);
    throw err;
  }
}

async function runApply(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(args, commonOptions);
  if (values.help) {
    io.stdout(help(io));
    return 0;
  }
  if (positionals.length !== 1) {
    throw new UsageError("apply takes one argument, the env.yaml path", true);
  }
  const file = positionals[0] as string;
  return await withApi(values, io, (api, out) => apply(file, api, io, out));
}

async function runSecret(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(args, {
    ...commonOptions,
    connector: { type: "string" },
  });
  if (values.help) {
    io.stdout(help(io));
    return 0;
  }
  const [sub, envRef, name, ...extra] = positionals;
  if (sub !== "set" && sub !== "list" && sub !== "delete") {
    throw new UsageError(
      sub === undefined
        ? "secret needs a subcommand: set, list or delete"
        : `unknown secret subcommand '${sub}'`,
      true,
    );
  }
  if (sub !== "set" && values.connector !== undefined) {
    throw new UsageError("--connector only goes with secret set", true);
  }
  if (sub === "list") {
    if (envRef === undefined || name !== undefined) {
      throw new UsageError("secret list takes one argument, <env>", true);
    }
    return await withApi(values, io, (api, out) =>
      secretList(envRef, api, out),
    );
  }
  if (sub === "delete") {
    if (envRef === undefined || name === undefined || extra.length > 0) {
      throw new UsageError("secret delete takes <env> <NAME>", true);
    }
    return await withApi(values, io, (api, out) =>
      secretDelete(envRef, name, api, out),
    );
  }
  if (envRef === undefined || name === undefined || extra.length > 0) {
    // never echo the extra arguments: one of them may be a value typed where it doesn't belong
    throw new UsageError(
      "secret set takes <env> <NAME>; the value is read from stdin, not argv",
      true,
    );
  }
  return await withApi(values, io, (api, out) =>
    secretSet(envRef, name, values.connector, api, io, out),
  );
}

const commands: Record<string, AgentCommand> = { ...agentCommands, env };

async function runCommand(
  command: string,
  args: string[],
  io: Io,
): Promise<number> {
  const spec = commands[command] as AgentCommand;
  const { values, positionals } = parse(
    args,
    { ...commonOptions, ...spec.options },
    command === "answer"
      ? "An answer starting with '-' goes after --: sky answer <agent> <requestId> -- <text>"
      : undefined,
  );
  if (values.help) {
    io.stdout(help(io));
    return 0;
  }
  // parseArgs types a spread option set as string | boolean
  const text = (v: string | boolean | undefined) =>
    typeof v === "string" ? v : undefined;
  const action = spec.prepare(positionals, {
    prompt: text(values.prompt),
    timeout: text(values.timeout),
    reason: text(values.reason),
    yes: values.yes === true,
  });
  return await withApi(values, io, (api, out) => action(api, io, out));
}

/** A rejected key is a config error (2): retrying with the same key can't succeed. */
function failApi(err: ApiError, config: Config, out: Output): number {
  const showCode = !out.json && err.code !== "unreachable";
  const message = showCode ? `${err.message} (${err.code})` : err.message;
  if (err.status === 401) {
    out.fail(err.code, `${message}; check the key from ${config.apiKeySource}`);
    return 2;
  }
  return out.fail(err.code, message);
}
