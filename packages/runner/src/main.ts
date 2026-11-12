import { appendFileSync } from "node:fs";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { removeCommandEnvNow } from "./claude-auth.js";
import { type Config, ConfigError, loadConfig } from "./config.js";
import { writeClaudeCredentials } from "./credentials.js";
import { createPoster, warningReporter } from "./events.js";
import { holdSprite, spriteApiFrom } from "./keepalive.js";
import { refreshPlugins } from "./plugins.js";
import { publishMain } from "./publish.js";
import { endSessionProcesses } from "./reap.js";
import { repoPullMain } from "./repo.js";
import { createDecisionWaiter } from "./requests.js";
import { claimRunLog } from "./runlog.js";
import { runSession } from "./session.js";
import { storeSyncMain, syncStoreQuietly } from "./store.js";
import { branchCheckMain } from "./sync.js";

// the runner's stderr is the exec session's terminal, gone once the API detaches, so every line also
// lands in a log file beside the run's prompt: what a stuck launch was doing is readable on the sprite.
// Set only once this process has been checked to be the run's runner and holds its lock (`claimRunLog`):
// the agent's shell inherits PROMPT_FILE, so any `runner.mjs` it starts could otherwise write here
let logFile: string | undefined;
const warn = (message: string) => {
  const line = `${new Date().toISOString()} ${message}\n`;
  process.stderr.write(line);
  if (logFile)
    try {
      appendFileSync(logFile, line);
    } catch {}
};

/** Refuses to start as a run, saying why on stderr alone: the run's log is not this process's to write. */
function refuse(message: string): void {
  process.stderr.write(`${new Date().toISOString()} runner: ${message}\n`);
  process.exitCode = 2;
}

const NOT_A_RUN =
  "only the Sky API starts a run (an agent's own command is `runner.mjs publish`)";

async function step<T>(name: string, task: () => Promise<T>): Promise<T> {
  const started = Date.now();
  warn(`runner: ${name} started`);
  try {
    return await task();
  } finally {
    warn(`runner: ${name} done in ${Date.now() - started}ms`);
  }
}

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    refuse(`${error.message}; ${NOT_A_RUN}`);
    return;
  }
  // the launcher passes the run's id as the argument; anything else is not the launcher
  if (process.argv[2] !== config.runId) {
    refuse(
      `${process.argv[2] ? `unknown command ${JSON.stringify(process.argv[2])}` : "no command"}; ${NOT_A_RUN}`,
    );
    return;
  }
  const claim = process.env.PROMPT_FILE
    ? claimRunLog(process.env.PROMPT_FILE)
    : undefined;
  if (claim && !claim.ok) {
    refuse(`${claim.reason}; not starting a second runner for ${config.runId}`);
    return;
  }
  const release = claim?.release ?? (() => {});
  if (claim) {
    logFile = claim.logFile;
    // a normal end; death by a signal fires no 'exit', so `dieBy` releases first. A lock left
    // behind is only ever from a process killed outright (SIGKILL, a crash of Node itself)
    process.on("exit", release);
  }

  // the first SIGTERM/SIGINT/SIGHUP aborts the session and lets the run report and commit; a second one
  // kills what the session left running and then the runner, at once
  const controller = new AbortController();
  let caught: NodeJS.Signals | undefined;
  // a hangup from the exec session that started the runner is a stop, not a death
  const STOPS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
  const stopListening = () => {
    for (const stop of STOPS) process.off(stop, onSignal);
  };
  // so the caller sees the process was stopped, not that it failed
  const dieBy = (signal: NodeJS.Signals) => {
    stopListening();
    release();
    // the session's `finally` never runs on this path, and the file may hold the project's key
    removeCommandEnvNow();
    process.kill(process.pid, signal);
  };
  let dying = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (dying) return;
    if (caught) {
      // the session's leftovers get their SIGKILL first, with no grace; bounded, so later signals wait for it
      dying = true;
      void endSessionProcesses({ runId: config.runId, graceMs: 0, warn }).then(
        () => dieBy(signal),
      );
      return;
    }
    caught = signal;
    controller.abort(signal);
  };
  for (const stop of STOPS) process.on(stop, onSignal);
  // first, so the sprite can't pause and freeze the run before it is held; held through waits for a
  // decision too: a paused sprite drops the long-poll and the event posts
  const post = createPoster({ ...config, warn });
  const hold = holdSprite({
    runId: config.runId,
    warn,
    // the local log is unreadable once the sprite sleeps, so a hold that fails also reaches the run's events
    report: warningReporter(post, config.runId),
    ...spriteApiFrom(process.env),
    signal: controller.signal,
  });
  await step("sprite hold", () => hold.ready);
  // a stop while the hold was landing skips setup; the session reports it as run.failed
  if (!controller.signal.aborted)
    await setUpSession(controller.signal, config.claudeAuth);
  warn("runner: session starting");
  try {
    process.exitCode = await runSession(config, {
      query,
      post,
      awaitDecision: createDecisionWaiter(config),
      signal: controller.signal,
      warn,
    });
  } finally {
    // the run is over, whatever way: nothing it started may keep its memory on a sprite other runs share
    await endSessionProcesses({ runId: config.runId, warn });
    await syncStoreQuietly("push", process.env, warn);
    await hold.release();
  }
  // a second signal's own reap ends in `dieBy`
  if (dying) return;
  if (caught) dieBy(caught);
  else stopListening();
}

async function setUpSession(
  signal: AbortSignal,
  claudeAuth: Config["claudeAuth"],
): Promise<void> {
  // so a nested `claude -p` in the sandbox is logged in; a failure costs the Kru checks, not the run.
  // An API-key run writes nothing: the file is shared by every agent on the sprite and holds a subscription
  if (claudeAuth === "oauth") {
    await step("claude credentials", () =>
      writeClaudeCredentials(process.env).catch((error: unknown) =>
        warn(
          `runner: nested claude login not set up: ${error instanceof Error ? error.message : String(error)}`,
        ),
      ),
    );
  }
  // agents on one sprite share the Kru store; a failed sync is logged, never the run's failure
  await step("store sync", () => syncStoreQuietly("pull", process.env, warn));
  // so the session runs the plugins' current versions, not those the env setup installed; bounded, never fails the run
  await step("plugin refresh", () =>
    refreshPlugins({ env: process.env, warn, signal }),
  );
}

const io = {
  stdout: (s: string) => process.stdout.write(s),
  stderr: (s: string) => process.stderr.write(s),
};
// `runner.mjs publish …` is the agent's own command, run from its worktree; `store-sync` and
// `repo-pull` are the API's, at provisioning, and `branch-check` before it starts an agent on an
// existing branch; anything else is a run
const commands: Record<
  string,
  (argv: string[], env: NodeJS.ProcessEnv) => Promise<number>
> = {
  publish: (argv, env) => publishMain(argv, env, { cwd: process.cwd(), ...io }),
  "store-sync": (argv, env) => storeSyncMain(argv, env, io),
  "repo-pull": (argv, env) => repoPullMain(argv, env, io),
  "branch-check": (argv, env) => branchCheckMain(argv, env, io),
};
const command = Object.hasOwn(commands, process.argv[2] ?? "")
  ? commands[process.argv[2] as string]
  : undefined;
const entry = command
  ? command(process.argv.slice(3), process.env).then((code) => {
      process.exitCode = code;
    })
  : main();

entry.catch((error: unknown) => {
  warn(`runner: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
