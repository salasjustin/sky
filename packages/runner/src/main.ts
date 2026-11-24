import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { brokerPublishMain, brokerSyncMain } from "./broker-client.js";
import {
  removeCredentialFilesNow,
  removeCredentialFilesOnExit,
  sweepCredentialFiles,
  withdrawCredential,
} from "./claude-auth.js";
import { runCodexSession, withdrawCodexKey } from "./codex.js";
import { type Config, ConfigError, loadConfig } from "./config.js";
import { takeConnector } from "./connector.js";
import { removeSkyLogin } from "./credentials.js";
import { createPoster, warningReporter } from "./events.js";
import { holdSprite, spriteApiFrom } from "./keepalive.js";
import {
  killRefreshCommands,
  type PluginRefreshRecord,
  refreshPlugins,
} from "./plugins.js";
import { previewProxyMain } from "./preview-proxy.js";
import { endSessionProcesses } from "./reap.js";
import { repoPullMain } from "./repo.js";
import { createDecisionWaiter } from "./requests.js";
import { claimRunLog, processAlive } from "./runlog.js";
import { createSeal, hideRunner, removeSealedCopiesNow } from "./seal.js";
import { removeScratchNow, runSession } from "./session.js";
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
  "only the Sky API starts a run (an agent's own commands are `runner.mjs publish` and `runner.mjs sync`)";

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
  // first of all: the connector is the runner's alone, so no git, `claude` or hook it starts, and no
  // command of the session, inherits it. The runner's own code reads it from `connector`.
  const connector = takeConnector(process.env);
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
  // before the runner starts a command of any kind: its credential is taken out of the env its git and
  // `claude` commands inherit, and the runner is put out of its commands' reach, so the repo's hooks and
  // config, which those run, find nothing; only the session's Claude process gets the credential back
  const credentialEnv = withdrawCredential(process.env);
  // a Codex run's AI Gateway key leaves the env the same way, for the Codex process alone
  const codexEnv =
    config.runtime === "codex" ? withdrawCodexKey(process.env) : {};
  const seal = createSeal();
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
  // the session's `finally` never runs for an uncaught exception, which still fires 'exit'
  removeCredentialFilesOnExit();
  // and the run's scratch directory, with the approved copies of outside reads it holds
  process.on("exit", removeScratchNow);
  // the copy of Claude's binary the session started from goes the same way
  process.on("exit", removeSealedCopiesNow);
  // a runner killed outright (SIGKILL, the OOM killer) left its credential files and its copy of
  // Claude's binary behind
  sweepCredentialFiles(processAlive);
  // an earlier runner may have left its run's token in Claude Code's credential file, where any later
  // run's commands can read it; removed before this run starts any. A failure is a warning, not the run's
  try {
    if (await removeSkyLogin(process.env))
      warn(
        "runner: removed the Claude login an earlier runner stored in Claude Code's credential file",
      );
  } catch (error) {
    warn(
      `runner: a Claude login an earlier runner stored may remain in Claude Code's credential file: ${error instanceof Error ? error.message : String(error)}`,
    );
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
    // the session's `finally` never runs on this path, and its files may hold the project's key or
    // the run's own credential
    removeCredentialFilesNow();
    removeScratchNow();
    removeSealedCopiesNow();
    // a plugin command runs in its own process group, which the runner's signal death wouldn't reach
    killRefreshCommands();
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
  // a stop while the hold was landing skips setup; the session reports it as run.failed. A Codex run
  // only pulls the store: the plugin refresh runs `claude`, whose plugins Codex doesn't load
  const codex = config.runtime === "codex";
  if (codex && !controller.signal.aborted)
    await step("store sync", () =>
      syncStoreQuietly("pull", { ...process.env, ...connector }, warn),
    );
  const pluginRefresh =
    controller.signal.aborted || codex
      ? undefined
      : await setUpSession(
          controller.signal,
          join(config.worktreesDir, config.agentId),
          connector,
        );
  warn("runner: session starting");
  try {
    process.exitCode = codex
      ? await runCodexSession(config, {
          post,
          awaitDecision: createDecisionWaiter(config),
          signal: controller.signal,
          warn,
          codexEnv,
          connector,
        })
      : await runSession(config, {
          query,
          post,
          awaitDecision: createDecisionWaiter(config),
          signal: controller.signal,
          warn,
          credentialEnv,
          seal,
          pluginRefresh,
          connector,
        });
  } finally {
    // the run is over, whatever way: nothing it started may keep its memory on a sprite other runs share
    await endSessionProcesses({ runId: config.runId, warn });
    await syncStoreQuietly("push", { ...process.env, ...connector }, warn);
    await hold.release();
  }
  // a second signal's own reap ends in `dieBy`
  if (dying) return;
  if (caught) dieBy(caught);
  else stopListening();
}

async function setUpSession(
  signal: AbortSignal,
  worktree: string,
  connector: NodeJS.ProcessEnv,
): Promise<PluginRefreshRecord> {
  // agents on one sprite share the Kru store; a failed sync is logged, never the run's failure
  await step("store sync", () =>
    syncStoreQuietly("pull", { ...process.env, ...connector }, warn),
  );
  // so the session runs the plugins' current versions, not those the env setup installed; bounded, never fails
  // the run. The marketplaces need no Claude login, and these `claude` processes are neither sealed nor
  // pinned, so they get the env with the credential taken out. What it did rides the run's `run.started`.
  // The worktree's own project-scope plugin records are updated too; a first run has no worktree yet
  return step("plugin refresh", () =>
    refreshPlugins({
      env: process.env,
      warn,
      signal,
      ...(existsSync(worktree) && { projectDir: worktree }),
    }),
  );
}

const io = {
  stdout: (s: string) => process.stdout.write(s),
  stderr: (s: string) => process.stderr.write(s),
};
// `runner.mjs publish …` and `sync` are the agent's own commands, run from its worktree; `store-sync` and
// `repo-pull` are the API's, at provisioning, and `branch-check` before it starts an agent on an
// existing branch; anything else is a run
const commands: Record<
  string,
  (argv: string[], env: NodeJS.ProcessEnv) => Promise<number>
> = {
  // thin clients of the run's runner, which holds the connector and asks the person before it sends
  publish: (argv, env) =>
    brokerPublishMain(argv, env, { cwd: process.cwd(), ...io }),
  sync: (argv, env) => brokerSyncMain(argv, env, { cwd: process.cwd(), ...io }),
  "store-sync": (argv, env) => storeSyncMain(argv, env, io),
  "repo-pull": (argv, env) => repoPullMain(argv, env, io),
  "branch-check": (argv, env) => branchCheckMain(argv, env, io),
  // a sprite service the API starts for an agent's preview; it runs until the API removes it
  "preview-proxy": (argv, env) => previewProxyMain(argv, env, io),
};
const command = Object.hasOwn(commands, process.argv[2] ?? "")
  ? commands[process.argv[2] as string]
  : undefined;
/**
 * Runs a subcommand. The API's own subcommands keep the connector in the env they are handed, and
 * out of the process's own, which the git commands they start inherit.
 */
async function runCommand(
  run: (argv: string[], env: NodeJS.ProcessEnv) => Promise<number>,
): Promise<number> {
  const connector = takeConnector(process.env);
  if (Object.keys(connector).length > 0) {
    // taking it out of process.env leaves it in /proc/<pid>/environ, which every process of this user
    // reads, the hooks of the git this command runs included, until the kernel hides this process. The
    // connector is readable there from exec until this step runs
    const exposed = hideRunner();
    if (exposed) {
      io.stderr(
        `runner: ${process.argv[2]} can't keep the GitHub connector from this user's other processes: ${exposed}\n`,
      );
    }
  }
  return run(process.argv.slice(3), { ...process.env, ...connector });
}

const entry = command
  ? runCommand(command).then((code) => {
      process.exitCode = code;
    })
  : main();

entry.catch((error: unknown) => {
  warn(`runner: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
