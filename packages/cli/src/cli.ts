import { parseArgs } from "node:util";
import { prepareAdmin } from "./admin.js";
import { type AgentCommand, agentCommands } from "./agent.js";
import { type Api, ApiError, createApi } from "./api.js";
import { apply } from "./apply.js";
import { claudeCredentials } from "./claude-credentials.js";
import { type Config, configPath, type Env, resolveConfig } from "./config.js";
import { env } from "./env.js";
import { key } from "./key.js";
import { createOutput, type Output, UsageError } from "./output.js";
import { secretDelete, secretList, secretSet } from "./secret.js";
import { version } from "./version.js";
import { webhook } from "./webhook.js";

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
  /** Wall-clock epoch ms: `admin drain --wait` compares it to the API's deadline. */
  now(): number;
  /** From return until the returned disarm runs, SIGINT or SIGTERM writes `stdout` (when given) to stdout and `sky: <note>` to stderr before the process dies by that signal; arm before printing anything that invites a Ctrl-C. */
  onInterrupt(note: string, stdout?: string): () => void;
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
  sky env show <env> [--yaml] [options]
      Print the same line for one environment (<env> is its id or name),
      then its runtime, and a refresh line when it has a script; a sandbox
      that stopped answering adds a health line with its last error and the
      sky env rebuild that fixes it; a failed
      environment adds the step it failed at and that step's stderr. --yaml prints
      the environment as an env.yaml that sky apply takes as a no-op
      (every field, scripts as block scalars), with the runtime and the
      secrets' names, never their values, as comments.
  sky env delete <env> [--yes] [options]
      Destroy the environment's sandbox and delete it with all its agents,
      runs and events. Refused while a run is active or it is provisioning.
      Asks to confirm on a terminal; anywhere else, or with --json, it
      needs --yes.
  sky env retry <env> [options]
      Provision a failed environment again. Prints its line, now
      provisioning; sky env show reports when it's ready.
  sky env rebuild <env> [--yes] [--force] [options]
      Reprovision a ready or failed environment (clone, setup, checkpoint)
      and keep its agents: each starts a new worktree on its next run, from
      the first of the branch it was started on, the branch its runs
      recorded publishing to and its own branch that GitHub still has, else
      from the default branch, and says so in its prompt. Every agent's
      session is dropped, since the sandbox's sessions are gone. Refused
      while a run is active or it is provisioning. Refused with
      unpublished_work, naming each agent, its branch and what is at risk
      (uncommitted files, commits not on GitHub, a branch never published),
      when work exists only on the sandbox; have each agent publish first.
      If the sandbox doesn't answer, the check uses what the runs recorded,
      which can't see uncommitted changes, so the list may be incomplete;
      it says so, and warns when it rebuilds on that check. --force
      rebuilds anyway after listing what is lost; on a terminal, without
      --yes, it asks a second time. Asks to confirm on a terminal; anywhere else, or with
      --json, it needs --yes. Use it when sky env show reports the sandbox
      unreachable, or to rerun setup on an environment that has agents.
      Needs the admin key.
  sky env set-claude <env> <name|api-key|api-key:<name>|pool|default>
      [--pool=<name,...>] [--fallback=api-key|none] [options]
      Choose the Claude credential the environment's runs use: the name of
      a subscription token the server holds (CLAUDE_OAUTH_TOKEN_<NAME>),
      api-key for the pay-per-use Anthropic API key (api-key:<name> for a
      named one, SKY_ANTHROPIC_API_KEY_<NAME>), or default for the
      server's default token. A run on an API key whose credit runs out
      moves on to the next key with credit. --fallback=none stops a run
      from using the API keys while its subscription is at its usage
      limit; the launch fails with the reset time instead. Only pool moves runs between
      subscriptions: the environment's runs go to the subscription with
      the most headroom and, on a usage limit, on to the next one.
      --pool=a,b limits and orders the choice; --pool=all (any case)
      resets it to every subscription the server holds, so no
      subscription named "all" can be listed there. Without --pool the
      list stays as it is, so --fallback alone never widens an ordered
      pool. Needs the admin key.
  sky env set-runtime <env> <claude-code|codex|default> [options]
      Switch the environment's runs between Claude Code and Codex; default
      stores no runtime, so the environment follows its SKY_RUNTIME secret
      again (Claude Code without one). Codex
      needs the environment's AI_GATEWAY_API_KEY secret, else the switch is
      refused with gateway_key_missing. Codex is installed on the sandbox
      if it lacks it, so the first switch to Codex can take a few minutes;
      if the install fails the switch is refused with codex_install_failed
      and the runtime is unchanged. An agent's next run after a switch
      starts a fresh session on its branch. A run that fails with
      claude_unavailable: or codex_unavailable: names the exact
      set-runtime command to run. Needs the admin key.
  sky env set-refresh <env> <@file|-> [options]
      Set the script every run of the environment runs first (see Per-run
      refresh in the README), without a whole env.yaml: @file reads it from
      a file, - from stdin; an empty one clears it. Never reprovisions, and
      is allowed while agents exist and while a run is active: a run keeps
      the script it started with, and runs launched later get the new one.
      Needs the admin key.
  sky claude-credentials [options]
      Print "<name> <subscription|api-key>
      <limited-until=<time>|out-of-credit|-> <runs today> <env ids|->
      <5h=N%|-> <7d=N%|-> <pool env ids|->" per credential: its limit or,
      for an API key (api-key, or api-key:<name> for a named one), whether
      it is marked out of credit, its environments, its last-seen usage and
      the pool environments that may use it. Values are never printed. Needs
      the admin key.
  sky claude-credentials clear-credit <name> [options]
      Clear an API key's out-of-credit mark once it is topped up; <name> is
      as the list prints it (api-key:backup) or the bare name (backup,
      default for the plain key). Nothing else clears a mark but an API
      restart: a run that finishes on the key doesn't. Needs the admin key.
  sky webhook add <url> --events=<types,...> [options]
      [--format=standard|openbot --secret=@file|-] [--env=<id|name>,...]
      Subscribe an https URL to event types. --format=standard signs
      deliveries as Standard Webhooks and needs the whsec_<base64> secret;
      --format=openbot signs them the way OpenBot webhook routines verify
      and takes the routine's signing secret (up to 256 characters)
      exactly as written apart from one trailing newline; a secret that
      begins or ends with whitespace is refused. The secret is read from a
      file or stdin, never argv. --env limits it to events from agents in
      those environments. On a terminal, --secret=- prompts for the secret
      without echoing it. Prints the line webhook list prints.
  sky webhook list [options]
      Print "<id> <format> <url> <types> [<env ids>]" per webhook; secrets
      are never printed. Once the webhook has had a delivery attempt, the
      line goes on with " | " and how its deliveries are going: FAILING
      from a give-up (after the 30th attempt, or at once when the server
      refuses the URL or its address) until a delivery succeeds, the last
      attempt's status or error, its attempt number, and how many
      deliveries failed in a row, such as
      "| FAILING, last 401 at 2026-11-21T09:30:00.000Z (attempt 30), 13
      failed in a row". That part is for reading; a script reads
      lastAttempt, failedStreak and failing from --json.
  sky webhook deliveries <id> [--limit=<1-100>] [--cursor=<cursor>]
      [options]
      Print "<created> <status> <event type> <run> attempts <n> [last
      <status|error>]" per delivery, newest first: status is pending,
      delivered or failed. --limit is at most 100 (20 without it); when
      older deliveries remain, a note on stderr gives the --cursor for the
      next page, which --json output also carries as nextCursor. Request
      bodies, headers and secrets are never printed. A runs key sees only
      its own webhooks' deliveries.
  sky webhook delete <id> [options]
      Remove a webhook.
  sky admin drain [--timeout=<seconds>] [--wait] [options]
  sky admin drain --status [options]
  sky admin drain --cancel [options]
      Hold new launches (agent start, follow-up, a retry) as queued runs
      while the runs already starting or running carry on; a run waiting
      on an approval or an answer doesn't count. --timeout is how long the
      drain lasts (1800 without it, at most 7200): at its end, or at
      --cancel, the held launches start, oldest first. A restart of the
      API starts them too. Prints "<draining|idle> deadline=<time|->
      active=<n> held=<n> ready=<yes|no>" and, while runs are active, a
      line "active <run ids>". --wait polls until no run is active
      (starting, running or awaiting a retry) while the drain is still on
      and exits 0. It stops polling just before the deadline the start
      gave and exits 4 with the run ids still active; it exits 4 too as
      soon as it finds the drain ended early (a --cancel, a restart). A
      check that fails on an unreachable API or a server error is
      retried; if some check was answered, such a failure at the deadline
      still exits 4 by the last status it got, and the line names the
      error and that status's age. If checks were made and none was
      answered, the API stopped answering, and --wait exits 1 saying so.
      With runs active and no time for a check, it exits 4 by the start's
      status. Starting the drain isn't retried: any error then, an
      unreachable API or a server error included, exits 1, and so does a
      check that fails and isn't retried (a rejected key exits 2, as for
      any command). --status only reports. Needs the admin key.
  sky key create <name> --env=<id|name>,... [--role=runs] [options]
      Issue an API key that can run agents only in those environments.
      --env repeats or takes a comma list. Names are resolved to ids when
      the key is created, so an environment deleted and recreated must be
      added to a new key. Prints "<id> <secret>"; the secret is shown only
      this once. Needs the admin key, as do key list and key revoke.
  sky key list [options]
      Print "<id> <role> <active|revoked> <name> <env ids>" per key, oldest
      first; secrets are never printed.
  sky key revoke <id> [options]
      Revoke a key: requests made with it are refused from then on, and the
      webhooks it created are deleted.
  sky agent start <env> [--branch=<name>] --prompt=<text|@file> [options]
  sky agent follow-up <agent> --prompt=<text|@file> [options]
      Start an agent on an environment (<env> is its id or name), or start
      an agent's next run once its last one has ended; @file reads the
      prompt from that file. Prints "<agentId> <runId>".
      --branch starts the agent on an existing GitHub branch, such as an
      open pull request's; its publishes update that branch. Refused for
      the repo's default branch and on an environment with no
      GITHUB_CONNECTOR secret. Sandboxes have no git transport, so the
      agent can't fetch or push itself: Sky fetches the branch through the
      connector when each run starts, and the agent runs runner.mjs only
      for publish and sync. The connector stays with the run's runner, which
      opens one approval for you before each (in sky inbox: "approval
      <requestId> Publish" or "Sync", then the branch, commits, files and
      diff stat), whatever the environment's approval policy says.
  sky agent list [--env=<id|name>,...] [--status=<state>,...] [--archived]
      [--limit=N] [--cursor=<c>] [options]
      Print "<agent> <state> <run> <last event> <open requests> <branch>
      <env>" per agent, newest activity first: the state, run and last
      event (UTC) of its latest run, the requests that run still has open,
      and the GitHub branch it works on (its own claude/ branch when it was
      started without one), then the env name, last since it may contain
      spaces. An agent with no run yet shows - in their place.
      --env and --status repeat or take a comma list. States: starting,
      running, waiting_approval, waiting_answer, finished, failed, stopped
      (queued is a launch held while the API drains).
      --archived lists archived agents too, not only live ones. --limit is
      at most 200 (50 without it); when more agents match, a note on stderr
      gives the --cursor for the next page, to pass with the same filters.
      A runs key sees only the agents it started; the admin key sees all.
  sky agent preview <agent> --port=<n> [--build=<command|none>]
      [--start=<command>] [--ttl=<duration>] [--no-wait] [options]
  sky agent preview <agent> --stop [options]
  sky agent preview <agent> [options]
      Preview the agent's branch as a production build: build the app once
      in the agent's worktree on its environment's sandbox, then serve it
      (--start, listening on --port; both get $PORT, NODE_ENV=production
      and the environment's secrets, less the GitHub connector). --build
      and --start default from the
      worktree's lockfile (pnpm build and pnpm start, yarn build and yarn
      start, bun run build and bun run start, or npm run build and npm
      start); with no lockfile, pass both. --build=none skips the build.
      The build is stopped after 15 minutes. It prints the link at once
      (anyone who opens it in a browser, with no Sky or Fly login, sees a
      page saying it is building, then the app at its root path), then
      waits, printing building, starting and ready on stderr as it changes
      (exit 0 once ready). A build or start that fails prints the tail of
      its output (exit 1); --no-wait returns at once, exit 0. With --json,
      the object goes to stdout once ready or failed, and also when the
      wait is interrupted (Ctrl-C or SIGTERM), since the link is never
      shown again; the preview keeps building on the server. The link
      works until --ttl (a duration such as 90m, 24h or 7d; 24h by
      default, 7d at most) or --stop, which ends the preview (exit 0 when
      none is running). The server doesn't pick up worktree edits: a new
      commit needs a new preview, so run the command again, which rebuilds
      and replaces the running one. An environment has one preview: one
      started on another agent replaces the running one, which a note on
      stderr names; a runs key can't replace a preview another key started
      (preview_busy). The preview outlives the agent's runs. It ends when
      the agent is archived or the environment is deleted. A build is a
      heavy job on the sandbox's memory: start a preview while no other
      heavy job runs on the environment. Without flags, it prints
      "<state> <port> <expires> <app> <proxy>": the state (building,
      starting, ready, failed), the port, the expiry (UTC) and how the app
      and the link's proxy are doing, or a note on stderr when none is
      running. A failed preview also prints what failed and exits 1. The
      link is shown only when the preview starts.
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
      Print "<runId> <status>", then its summary, error, the Claude
      credential it used, its compare link and the plugins it ran with: how
      the plugin refresh at the start ended (refreshed, timed_out, failed or
      skipped, with the reason) and, per plugin, the version before the
      refresh, after it and the one the session loaded.
  sky approve <agent> <requestId> [--reason=<text>] [options]
  sky deny <agent> <requestId> --reason=<text> [options]
  sky answer <agent> <requestId> -- <text>
      Decide a pending request. Options go before --, and everything after
      it is the answer, even text starting with '-'. Repeating the same
      decision exits 0; a request already decided differently exits 1 and
      the earlier decision stands. A deny's --reason is what the agent is
      told; an approve's is recorded with the decision and passed to the
      agent as a note.

Options:
  --url=<url>            API URL
  --api-key-env=<VAR>    read the API key from environment variable VAR
  --json                 print the API's object on stdout (inbox, wait and
                         status: the newest run; secret list: only each
                         name and kind; env delete, secret delete and
                         webhook delete: {"id"|"name": …, "deleted": true};
                         key create: the key with its secret; key list:
                         {"data": [keys]}, never a secret; agent list: the
                         page {"data": [agents], "nextCursor"?: …};
                         webhook deliveries: the page {"data":
                         [deliveries], "nextCursor"?: …};
                         agent preview: {"preview": {…, "link"}}, or
                         {"preview": null, "stopped": {…}|null} for --stop;
                         key revoke: {"id": …, "revoked": true})
  -h, --help             show this help
  -v, --version          print the version (on its own: sky --version)

Configuration, first found wins:
  url:     --url, SKY_URL, "url" in the config file
  API key: --api-key-env, SKY_API_KEY, "apiKey" in the config file
  config file: ${configPath(io.env, io.home)}

Exit status: 0 done; 1 failed (API error, including a key not allowed the
  command; provisioning failed); 2 usage or config error, a rejected API
  key included
  inbox, wait and status exit with the newest run's state:
  0 finished; 3 waiting (needs input); 4 queued, starting or running
  (wait: timed out); 5 failed; 6 stopped
  admin drain --wait exits 4 when the wait ran out, or the drain ended,
  before it saw the runs finish; 1 if it checked and got no answer
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
      case "admin":
        return await runAdmin(rest, io);
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
  O extends Record<
    string,
    { type: "string" | "boolean"; short?: string; multiple?: boolean }
  >,
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

// its own parse: --status here is a flag, where agent list's takes states
async function runAdmin(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(args, {
    ...commonOptions,
    timeout: { type: "string" },
    wait: { type: "boolean" },
    status: { type: "boolean" },
    cancel: { type: "boolean" },
  });
  if (values.help) {
    io.stdout(help(io));
    return 0;
  }
  const action = prepareAdmin(positionals, {
    timeout: values.timeout,
    wait: values.wait === true,
    status: values.status === true,
    cancel: values.cancel === true,
  });
  return await withApi(values, io, (api, out) => action(api, io, out));
}

const commands: Record<string, AgentCommand> = {
  ...agentCommands,
  "claude-credentials": claudeCredentials,
  env,
  key,
  webhook,
};

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
  // parseArgs types a spread option set's values as string | boolean or an array of either
  const text = (v: unknown) => (typeof v === "string" ? v : undefined);
  const list = (v: unknown) =>
    Array.isArray(v)
      ? v.filter((s) => typeof s === "string").join(",")
      : text(v);
  const action = spec.prepare(positionals, {
    prompt: text(values.prompt),
    timeout: text(values.timeout),
    reason: text(values.reason),
    yes: values.yes === true,
    force: values.force === true,
    branch: text(values.branch),
    events: text(values.events),
    format: text(values.format),
    secret: text(values.secret),
    env: list(values.env),
    role: text(values.role),
    fallback: text(values.fallback),
    pool: text(values.pool),
    status: list(values.status),
    archived: values.archived === true,
    limit: text(values.limit),
    cursor: text(values.cursor),
    build: text(values.build),
    start: text(values.start),
    "no-wait": values["no-wait"] === true,
    port: text(values.port),
    ttl: text(values.ttl),
    stop: values.stop === true,
    yaml: values.yaml === true,
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
