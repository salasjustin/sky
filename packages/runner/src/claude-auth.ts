import { randomUUID } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readlinkSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";

/** Which credential the run's Claude session authenticates with, as the API chose it. */
export type ClaudeAuth = "oauth" | "api-key";

// what Claude Code authenticates with, in the order it prefers them; only the credential the API
// chose may be left in the session's env
const AUTH_VARIABLES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
];

// what sends Claude Code's requests, credential included, somewhere other than the Anthropic API: the
// endpoint override, and the provider switches that outrank every credential
// (code.claude.com/docs/en/env-vars, code.claude.com/docs/en/authentication#authentication-precedence)
const ROUTING_VARIABLES = [
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_MANTLE",
];

// the rest of what changes where Claude Code sends its requests or with what it signs them: other
// providers' endpoints and credentials, extra request headers, workload identity, and the proxies
// the requests go through (code.claude.com/docs/en/env-vars)
export const REDIRECT_ENV_VARIABLES = [
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_AWS_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_AWS_API_KEY",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_WORKSPACE_ID",
  "ANTHROPIC_PROFILE",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_SCOPES",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "https_proxy",
  "http_proxy",
  "all_proxy",
];

/**
 * Every environment variable that would redirect the Claude session or swap its credential, as a
 * name a settings file's `env` block could set; the session's own env and those blocks are held to
 * this one list.
 */
export const REDIRECT_VARIABLES = [
  ...AUTH_VARIABLES,
  ...ROUTING_VARIABLES,
  ...REDIRECT_ENV_VARIABLES,
];

// the names `claudeProcessEnv` drops whose values are the project's, handed back to its commands by
// `commandEnvScript`, and unset for a check's nested `claude`. The `CLAUDE_CODE_OAUTH_` names are a
// Claude login rather than a project value, so commands never get them back: CLAUDE_CODE_OAUTH_TOKEN
// is only ever the run's chosen token, which the API reserves
export const PROJECT_VARIABLES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  ...ROUTING_VARIABLES,
  ...REDIRECT_ENV_VARIABLES.filter(
    (name) => !name.startsWith("CLAUDE_CODE_OAUTH_"),
  ),
];

// Sky is the host choosing where the Claude process sends its requests and with what credential: in
// this mode Claude Code ignores the endpoint, provider and credential variables a settings file sets,
// mid-session edits included (code.claude.com/docs/en/env-vars)
export const HOST_MANAGED = "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST";

/**
 * The env of the Claude process itself, carrying exactly the chosen credential and sending it to the
 * Anthropic API. Claude Code prefers `ANTHROPIC_API_KEY` over the subscription token, so a project's
 * own key (an env secret, in the runner's env) must never reach a subscription run, and Sky's key
 * stands alone in an API-key run. A project's `ANTHROPIC_BASE_URL` or provider switch would send the
 * chosen credential to the project's gateway or cloud, so those go too. Sky's key arrives as
 * `SKY_CLAUDE_API_KEY` so it never shares a name with the project's. The credential is read from
 * `runnerEnv`, the env the API launched the runner with, so a profile's session env merged into
 * `env` can't swap it. Host-managed mode is always on, whatever the project or profile set it to.
 */
export function claudeProcessEnv(
  env: NodeJS.ProcessEnv,
  auth: ClaudeAuth,
  runnerEnv: NodeJS.ProcessEnv = env,
): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const name of [
    ...REDIRECT_VARIABLES,
    "SKY_CLAUDE_API_KEY",
    "SKY_CLAUDE_AUTH",
  ]) {
    delete out[name];
  }
  if (auth === "api-key") {
    if (runnerEnv.SKY_CLAUDE_API_KEY)
      out.ANTHROPIC_API_KEY = runnerEnv.SKY_CLAUDE_API_KEY;
  } else if (runnerEnv.CLAUDE_CODE_OAUTH_TOKEN) {
    out.CLAUDE_CODE_OAUTH_TOKEN = runnerEnv.CLAUDE_CODE_OAUTH_TOKEN;
  }
  out[HOST_MANAGED] = "1";
  return out;
}

// what the API launches the runner with to hand the session its credential: the subscription token, or
// Sky's API key under a name of its own
const CREDENTIAL_VARIABLES = ["SKY_CLAUDE_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"];

/**
 * Takes the run's Claude credential out of `env` and returns it, so the runner's own children, such as
 * the git commands that run a repo's hooks and config, never inherit it. Only the session's Claude
 * process gets it back, through `claudeProcessEnv`'s `runnerEnv`.
 */
export function withdrawCredential(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const held: NodeJS.ProcessEnv = {};
  for (const name of CREDENTIAL_VARIABLES) {
    const value = env[name];
    if (value === undefined) continue;
    held[name] = value;
    delete env[name];
  }
  return held;
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * Gives the session's Bash commands back the project's own values of what `claudeProcessEnv` drops
 * (`PROJECT_VARIABLES`: its API key, auth token, base URL, provider switches, proxies and the like,
 * read from `env`, the session's env before the credential is chosen), so its commands work as they
 * always did; and on an API-key run with no project key, unsets Sky's. A SessionStart hook has the
 * file Claude Code sources before each command source this in turn, which reaches the commands and not
 * Claude itself. Sky's key and the OAuth token, refresh token and scopes are never written here.
 * Undefined when there is nothing to say.
 */
export function commandEnvScript(
  auth: ClaudeAuth,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const lines = PROJECT_VARIABLES.flatMap((name) => {
    const value = env[name];
    return value ? [`export ${name}=${shellQuote(value)}`] : [];
  });
  if (auth === "api-key" && !env.ANTHROPIC_API_KEY)
    lines.unshift("unset ANTHROPIC_API_KEY");
  return lines.length > 0 ? `${lines.join("\n")}\n` : undefined;
}

const RUNNER_DIR = /^sky-runner-(\d+)$/;

/**
 * Where this runner writes its credential files: a directory of `root` named for its pid, which is
 * how `sweepCredentialFiles` tells a dead runner's files from a live one's.
 */
export const credentialDir = (root: string = tmpdir(), pid = process.pid) =>
  join(root, `sky-runner-${pid}`);

const uid = () => process.getuid?.() ?? "user";
const NESTED_DIR = /^sky-nested-claude-/;

/**
 * The directory of the agents' nested login links, one path for every run of every runner of this
 * user: the path the agent's resumed session still holds from an earlier run has to be live in a
 * later one. Holds a symlink per agent to its current run's credential file, which sits in that
 * runner's own pid-named directory.
 */
export const nestedLoginDir = (root: string = tmpdir()) =>
  join(root, `sky-nested-claude-${uid()}`);

/**
 * The shell assignment that logs a check's nested `claude` in: it sets `variable` from the credential
 * file as the command runs, ahead of `env`, so the value is in that command's environment alone.
 */
export type NestedPrefix = {
  variable: "CLAUDE_CODE_OAUTH_TOKEN";
  assignment: string;
};

export type NestedLogin = {
  /** Undefined on an API-key run. */
  prefix: NestedPrefix | undefined;
  /** Deletes the credential's file, and the agent's link while it still points there. */
  remove: () => Promise<void>;
};

/**
 * Host-managed mode makes Claude Code ignore a stored login, and Claude Code removes
 * `CLAUDE_CODE_OAUTH_TOKEN` from the env of the commands it runs, so a nested `claude -p` finds its
 * credential in neither place. A subscription or pool run's token goes in a 0600 file of the runner's
 * credential directory, named for the run; every process of the sprite's user can still read it while
 * it exists. The path the agent is given is stable across the agent's runs: a symlink named for
 * `agentId` in `dir` (a 0700 directory of this user's), which each run points at its own file at start
 * and deletes at its end. A follow-up resumes the session that holds the first run's instructions, so
 * its nested `claude` must find a live credential at that same path, holding this run's token. Two
 * runs of one agent never overlap. `prefix` has the shell read the link into the nested command's
 * environment, the one place Claude Code takes the credential in host-managed mode, and it always wins
 * over a value of that name already in the command's env. The value never reaches the prompt, any
 * program's argv, Claude's env or its env file.
 *
 * An API-key run gets no file and no prefix: every process of the sprite's user could read Sky's key
 * from that file.
 */
export async function prepareNestedLogin(
  auth: ClaudeAuth,
  runnerEnv: NodeJS.ProcessEnv,
  runId: string,
  dir: string = nestedLoginDir(),
  agentId: string = runId,
  fileDir: string = credentialDir(),
): Promise<NestedLogin> {
  const value =
    auth === "oauth" ? runnerEnv.CLAUDE_CODE_OAUTH_TOKEN : undefined;
  if (!value) return { prefix: undefined, remove: async () => {} };
  await ownDirectory(dir);
  await ownDirectory(fileDir);
  const file = join(fileDir, `sky-nested-claude-${runId}-${randomUUID()}`);
  const path = join(dir, `sky-nested-claude-${agentId}`);
  // before the write: a signal can land while it is in flight
  unremoved.add(file);
  await writeFile(file, value, { mode: 0o600, flag: "wx" });
  try {
    await linkInPlace(file, path);
  } catch (error) {
    unremoved.delete(file);
    await rm(file, { force: true });
    throw error;
  }
  const variable = "CLAUDE_CODE_OAUTH_TOKEN";
  return {
    // quoted, so the value is never split or globbed
    prefix: { variable, assignment: `${variable}="$(<${shellQuote(path)})"` },
    remove: async () => {
      unremoved.delete(file);
      if (unremovedLinks.get(path) === file) unremovedLinks.delete(path);
      await rm(file, { force: true });
      // only while it points at this run's file: a later run of the agent may have re-pointed it
      if ((await readlink(path).catch(() => undefined)) === file)
        await rm(path, { force: true });
    },
  };
}

/**
 * Creates `dir` as a 0700 directory of this user, or holds an existing one to that. Refuses a
 * directory another user made first and a symlink standing in for one, so no other user can read or
 * swap what this runner writes there; every process of this user still can.
 */
async function ownDirectory(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.uid !== (process.getuid?.() ?? info.uid))
    throw new Error(
      `${dir} is not a directory of this user; remove it, and the next run creates its own`,
    );
  // `mkdir`'s mode is masked by the umask and never applies to a directory already there
  await chmod(dir, 0o700);
}

/**
 * Points `path` at `file` in one step: a link made beside it under a unique name and renamed over it,
 * so `path` never goes missing and whatever stood there (the earlier run's link, dangling or not, or a
 * file) is replaced rather than followed. A directory there refuses the run; it is never deleted.
 */
async function linkInPlace(file: string, path: string): Promise<void> {
  // named like an agent's link, so a runner killed before the rename leaves one the sweep finds
  const staged = join(
    dirname(path),
    `sky-nested-claude-${randomUUID()}.staged`,
  );
  await symlink(file, staged);
  unremovedLinks.set(staged, file);
  try {
    await rename(staged, path);
  } catch (error) {
    await rm(staged, { force: true });
    throw new Error(
      `${path} can't be replaced by this run's nested login link; if it is a directory, remove it`,
      { cause: error },
    );
  } finally {
    unremovedLinks.delete(staged);
  }
  unremovedLinks.set(path, file);
}

type Settings = Exclude<Options["settings"], string | undefined>;

export type CommandEnv = {
  /** The `settings.hooks` that apply the script; undefined when there is no script. */
  hooks: Settings["hooks"];
  /** Deletes the script, which may hold the project's key and token. */
  remove: () => Promise<void>;
};

// every credential file `prepareCommandEnv` and `prepareNestedLogin` wrote that its `remove` hasn't
// deleted yet
const unremoved = new Set<string>();
// every nested login link `prepareNestedLogin` put in place that its `remove` hasn't deleted yet, with
// the file it points at
const unremovedLinks = new Map<string, string>();

/**
 * Deletes every command-env script and nested login file still on disk, and each nested login link
 * still pointing at this runner's file, synchronously: for a process about to die by a signal or an
 * uncaught exception, neither of which reaches the session's own `remove`. A link a later run
 * re-pointed is left to it. Never throws, so the death goes ahead.
 */
export function removeCredentialFilesNow(): void {
  for (const path of unremoved)
    try {
      rmSync(path, { force: true });
    } catch {}
  unremoved.clear();
  for (const [link, file] of unremovedLinks)
    try {
      if (readlinkSync(link) === file) unlinkSync(link);
    } catch {}
  unremovedLinks.clear();
}

/**
 * Runs `removeCredentialFilesNow` on 'exit', which Node also fires for an uncaught exception or
 * unhandled rejection; death by a signal fires none, so that path calls it itself.
 */
export function removeCredentialFilesOnExit(): void {
  process.on("exit", removeCredentialFilesNow);
}

/**
 * Deletes the credential files a runner killed outright (SIGKILL, the OOM killer) left behind, which
 * no exit handler reaches. Runs on one sprite share its tmpdir and pid space, so a directory is swept
 * only when `isAlive` finds no process with its pid; a pid reused by any process keeps its directory
 * until that one ends too. A directory under this runner's own pid is a dead process's and is swept
 * too, so this runs before the runner writes any. Then each nested login link in `nestedLoginDir`
 * whose file is gone is deleted. Never throws.
 */
export function sweepCredentialFiles(
  isAlive: (pid: number) => boolean,
  root: string = tmpdir(),
  self = process.pid,
): void {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    const pid = Number(RUNNER_DIR.exec(name)?.[1]);
    if (!pid || (pid !== self && isAlive(pid))) continue;
    try {
      rmSync(join(root, name), { recursive: true, force: true });
    } catch {}
  }
  // an agent's nested login link outlives its run's file when the runner was killed outright: one
  // whose file is gone is dead
  const links = nestedLoginDir(root);
  try {
    for (const name of readdirSync(links))
      if (NESTED_DIR.test(name) && !existsSync(join(links, name)))
        rmSync(join(links, name), { force: true });
  } catch {}
}

/**
 * Writes `commandEnvScript` to a file only this user reads, and the SessionStart hook that appends
 * to `$CLAUDE_ENV_FILE` a line sourcing that file while it exists. The values live in that file
 * alone, never in argv, Claude's env or Claude Code's env file; once `remove` or
 * `removeCredentialFilesNow` deletes it, the line sources nothing and still succeeds.
 */
export async function prepareCommandEnv(
  auth: ClaudeAuth,
  env: NodeJS.ProcessEnv,
  dir: string = credentialDir(),
): Promise<CommandEnv> {
  const script = commandEnvScript(auth, env);
  if (script === undefined) return { hooks: undefined, remove: async () => {} };
  await ownDirectory(dir);
  const path = join(dir, `sky-command-env-${randomUUID()}.sh`);
  // before the write: a signal can land while it is in flight
  unremoved.add(path);
  await writeFile(path, script, { mode: 0o600, flag: "wx" });
  const quoted = shellQuote(path);
  const sourceWhileExists = `if [ -r ${quoted} ]; then . ${quoted}; fi`;
  const appendSourceLine = `printf '%s\\n' ${shellQuote(sourceWhileExists)} >> "$CLAUDE_ENV_FILE"`;
  return {
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: "command",
              command: appendSourceLine,
            },
          ],
        },
      ],
    },
    remove: () => {
      unremoved.delete(path);
      return rm(path, { force: true });
    },
  };
}
