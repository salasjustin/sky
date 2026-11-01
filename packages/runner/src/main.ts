import { appendFileSync } from "node:fs";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { type Config, ConfigError, loadConfig } from "./config.js";
import { writeClaudeCredentials } from "./credentials.js";
import { createPoster } from "./events.js";
import { holdSprite } from "./keepalive.js";
import { refreshPlugins } from "./plugins.js";
import { publishMain } from "./publish.js";
import { repoPullMain } from "./repo.js";
import { createDecisionWaiter } from "./requests.js";
import { runSession } from "./session.js";
import { storeSyncMain, syncStoreQuietly } from "./store.js";

// the runner's stderr is the exec session's terminal, gone once the API detaches, so every line also
// lands in a log file beside the run's prompt: what a stuck launch was doing is readable on the sprite
const logFile = process.env.PROMPT_FILE?.replace(/\.prompt$/, ".log");
const warn = (message: string) => {
  const line = `${new Date().toISOString()} ${message}\n`;
  process.stderr.write(line);
  if (logFile)
    try {
      appendFileSync(logFile, line);
    } catch {}
};

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
    warn(`runner: ${error.message}`);
    process.exitCode = 2;
    return;
  }

  // the first SIGTERM/SIGINT/SIGHUP aborts the session and lets the run report and commit; a second one kills at once
  const controller = new AbortController();
  let caught: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals) => {
    caught = signal;
    controller.abort(signal);
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  // a hangup from the exec session that started the runner is a stop, not a death
  process.once("SIGHUP", onSignal);
  // first, so the sprite can't pause and freeze the run before it is held; held through waits for a
  // decision too: a paused sprite drops the long-poll and the event posts
  const hold = holdSprite({
    runId: config.runId,
    warn,
    signal: controller.signal,
  });
  await step("sprite hold", () => hold.ready);
  // a stop while the hold was landing skips setup; the session reports it as run.failed
  if (!controller.signal.aborted) await setUpSession(controller.signal);
  warn("runner: session starting");
  try {
    process.exitCode = await runSession(config, {
      query,
      post: createPoster({ ...config, warn }),
      awaitDecision: createDecisionWaiter(config),
      signal: controller.signal,
      warn,
    });
  } finally {
    await syncStoreQuietly("push", process.env, warn);
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    process.off("SIGHUP", onSignal);
    await hold.release();
  }
  // die by the signal so the caller sees the process was stopped, not that it failed
  if (caught) process.kill(process.pid, caught);
}

async function setUpSession(signal: AbortSignal): Promise<void> {
  // so a nested `claude -p` in the sandbox is logged in; a failure costs the Kru checks, not the run
  await step("claude credentials", () =>
    writeClaudeCredentials(process.env).catch((error: unknown) =>
      warn(
        `runner: nested claude login not set up: ${error instanceof Error ? error.message : String(error)}`,
      ),
    ),
  );
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
// `repo-pull` are the API's, at provisioning; anything else is a run
const entry =
  process.argv[2] === "publish"
    ? publishMain(process.argv.slice(3), process.env, {
        cwd: process.cwd(),
        ...io,
      }).then((code) => {
        process.exitCode = code;
      })
    : process.argv[2] === "store-sync"
      ? storeSyncMain(process.argv.slice(3), process.env, io).then((code) => {
          process.exitCode = code;
        })
      : process.argv[2] === "repo-pull"
        ? repoPullMain(process.argv.slice(3), process.env, io).then((code) => {
            process.exitCode = code;
          })
        : main();

entry.catch((error: unknown) => {
  warn(`runner: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
