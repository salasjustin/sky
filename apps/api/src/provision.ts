import { type Db, type environmentFailureSteps, environments } from "@sky/db";
import type { BaseProfile, EnvironmentId } from "@sky/shared";
import { eq, sql } from "drizzle-orm";
import { storeEnv } from "./base-profile.js";
import { type KnownSecrets, redact } from "./redact.js";
import { cloneUrl } from "./remote.js";
import type { BundleInstaller } from "./runner-bundle.js";
import {
  hasConnectorSecret,
  hasValueSecret,
  openEnvSecrets,
} from "./secrets.js";
import {
  baseSpriteLabels,
  checkpointSprite,
  ensureSprite,
  execInSprite,
  execLogged,
  type SpriteOps,
  spriteNameFor,
  writeSpriteFile,
} from "./sprites.js";

export const REPO_DIR = "/workspace/repo";
// the runner's worktrees point at the clone, so they go when it does
export const WORKTREES_DIR = "/workspace/worktrees";
export const RUNNER_DIR = "/opt/sky";
export const RUNNER = `${RUNNER_DIR}/runner.mjs`;
// = the version in packages/runner/package.json; the runner bundle leaves the SDK external
const RUNNER_SDK = "@anthropic-ai/claude-agent-sdk@0.3.312";
// no --omit=optional: the SDK ships the Claude Code binary as a platform-specific optional dep
const installRunnerSdk = `[ -w ${RUNNER_DIR} ] || sudo install -d -o "$(id -u)" -g "$(id -g)" ${RUNNER_DIR}; npm install --prefix ${RUNNER_DIR} --no-audit --no-fund ${RUNNER_SDK}`;
// finds the SDK's bundled `claude` under the runner dir, which is the script's first argument
const FIND_CLAUDE = `
const sdk = process.argv[1] + "/node_modules/@anthropic-ai";
const platform = readdirSync(sdk).find(
  (d) => d.startsWith("claude-agent-sdk-") && existsSync(sdk + "/" + d + "/claude"),
);
if (!platform) throw new Error("no claude binary under " + sdk);
const bin = sdk + "/" + platform + "/claude";
`;
// under $HOME, which outlives reprovisioning as the user config it records does
const APPLIED_BASE_FILE = ".sky/base-applied.json";
// the base profile holds no secret value, but its JSON is longer than an exec's URL query allows
const BASE_PROFILE_FILE = "/tmp/sky-base.json";
// a sprite with no `APPLIED_BASE_FILE` may hold the profile an earlier API version applied here and
// left; its plugins and MCP servers are what that version added
const LEFTOVER_BASE_FILE = "/tmp/sky-base-profile.json";
/**
 * Makes the sprite user's profile-added config match a base profile, which may declare nothing.
 * `$HOME/.claude` outlives reprovisioning, so what earlier applies added is recorded in
 * `APPLIED_BASE_FILE` (a marketplace by the name its `add` reported), and whatever of it the profile
 * no longer declares is removed first; config no profile declared is never touched. Then it adds the
 * marketplaces, installs and updates the plugins at user scope, and registers the MCP servers at user
 * scope. The record is written before the adds, so a failed apply still names what it may have added.
 * It runs as `node -e` with the runner dir, the profile's JSON file and `LEFTOVER_BASE_FILE` as
 * arguments. A secret an MCP server needs is written as a `${NAME}` reference the session expands
 * from its own env, so the profile's config holds no value. Marketplaces and plugins refresh on every
 * run; an MCP server is removed first so a rerun replaces it.
 */
const APPLY_BASE = `
const { execFileSync } = require("node:child_process");
const { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { dirname } = require("node:path");
const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined);
const profile = JSON.parse(readFileSync(process.argv[2], "utf8"));
const recordFile = homedir() + "/${APPLIED_BASE_FILE}";
const leftover = readJson(process.argv[3]);
const applied = readJson(recordFile) ?? {
  marketplaces: {},
  plugins: leftover?.plugins ?? [],
  mcpServers: Object.keys(leftover?.mcpServers ?? {}),
};
const dropped = {
  marketplaces: Object.entries(applied.marketplaces)
    .filter(([source]) => !profile.marketplaces.includes(source))
    .map(([, name]) => name),
  plugins: applied.plugins.filter((plugin) => !profile.plugins.includes(plugin)),
  mcpServers: applied.mcpServers.filter((name) => !(name in profile.mcpServers)),
};
const record = {
  marketplaces: Object.fromEntries(
    Object.entries(applied.marketplaces).filter(([source]) => profile.marketplaces.includes(source)),
  ),
  plugins: profile.plugins,
  mcpServers: Object.keys(profile.mcpServers),
};
const declaresNothing = profile.marketplaces.length === 0 && record.plugins.length === 0 && record.mcpServers.length === 0;
const save = () => {
  if (declaresNothing) return rmSync(recordFile, { force: true });
  mkdirSync(dirname(recordFile), { recursive: true });
  writeFileSync(recordFile, JSON.stringify(record));
};
if (declaresNothing && Object.values(dropped).every((items) => items.length === 0)) {
  save();
  process.exit(0);
}
${FIND_CLAUDE}
const claude = (...args) => {
  try {
    execFileSync(bin, args, { stdio: "inherit" });
  } catch (err) {
    process.exit(err.status || 1);
  }
};
const claudeOut = (...args) => {
  try {
    const out = execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
    process.stdout.write(out);
    return out;
  } catch (err) {
    process.exit(err.status || 1);
  }
};
// claude has no JSON list of MCP servers, and \`mcp get\` health-checks the server, so absence is read
// from the message this pinned version prints
const removeMcp = (name) => {
  try {
    execFileSync(bin, ["mcp", "remove", name, "--scope", "user"], { encoding: "utf8", stdio: ["ignore", "inherit", "pipe"] });
  } catch (err) {
    if (String(err.stderr).includes("No MCP server named")) return;
    process.stderr.write(err.stderr ?? "");
    process.exit(err.status || 1);
  }
};
// plugins before their marketplaces: removing a marketplace leaves its plugins installed
if (dropped.plugins.length > 0) {
  const installed = JSON.parse(claudeOut("plugin", "list", "--json"))
    .filter((plugin) => plugin.scope === "user")
    .map((plugin) => plugin.id);
  for (const plugin of dropped.plugins) {
    if (installed.includes(plugin)) claude("plugin", "uninstall", plugin, "--scope", "user");
  }
}
if (dropped.marketplaces.length > 0) {
  const known = JSON.parse(claudeOut("plugin", "marketplace", "list", "--json")).map((m) => m.name);
  for (const name of dropped.marketplaces) {
    if (known.includes(name)) claude("plugin", "marketplace", "remove", name, "--scope", "user");
  }
}
for (const name of dropped.mcpServers) removeMcp(name);
save();
for (const source of profile.marketplaces) {
  const added = claudeOut("plugin", "marketplace", "add", source, "--json").trim().split("\\n").at(-1);
  record.marketplaces[source] = JSON.parse(added).marketplace;
  save();
}
if (profile.plugins.length > 0) {
  claude("plugin", "marketplace", "update");
  for (const plugin of profile.plugins) claude("plugin", "install", plugin, "--scope", "user");
  for (const plugin of profile.plugins) claude("plugin", "update", plugin, "--scope", "user");
}
const refs = (names) => Object.fromEntries(Object.entries(names).map(([key, secret]) => [key, "\${" + secret + "}"]));
for (const [name, server] of Object.entries(profile.mcpServers)) {
  removeMcp(name);
  const config = "command" in server
    ? { type: "stdio", command: server.command, args: server.args, env: refs(server.env) }
    : { type: "http", url: server.url, headers: refs(server.headers) };
  claude("mcp", "add-json", name, JSON.stringify(config), "--scope", "user");
}
`;
/**
 * Installs, for the sprite's user, the plugins the clone's `.claude/settings.json` enables, after
 * adding the `extraKnownMarketplaces` entries they come from. A headless session honors
 * `enabledPlugins` only for a plugin already installed; it never fetches one. Runs as `node -e` in
 * the clone with the runner dir as its argument, so it uses the `claude` the SDK bundles. It runs
 * after the env's setup, which may add a marketplace the settings don't declare, so a plugin whose
 * marketplace is known by neither fails naming it before any install.
 * `$HOME/.claude` outlives reprovisioning and a repeat add or install fetches nothing, so every
 * run refreshes the marketplaces and updates each plugin.
 */
const INSTALL_PLUGINS = `
const { execFileSync } = require("node:child_process");
const { existsSync, readdirSync, readFileSync } = require("node:fs");
const file = ".claude/settings.json";
const settings = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
const enabled = settings.enabledPlugins ?? {};
const plugins = Object.keys(enabled).filter((p) => enabled[p] === true);
if (plugins.length === 0) process.exit(0);
const sdk = process.argv[1] + "/node_modules/@anthropic-ai";
const platform = readdirSync(sdk).find(
  (d) => d.startsWith("claude-agent-sdk-") && existsSync(sdk + "/" + d + "/claude"),
);
if (!platform) throw new Error("no claude binary under " + sdk);
const claude = (...args) => {
  try {
    execFileSync(sdk + "/" + platform + "/claude", args, { stdio: "inherit" });
  } catch (err) {
    process.exit(err.status || 1);
  }
};
const fail = (name, why) => {
  console.error('marketplace "' + name + '" in ' + file + ": " + why);
  process.exit(1);
};
// the url forms marketplace add clones; any other http(s) url it fetches as a marketplace.json
const addClones = (url) =>
  /^[^/@:]+@[^/:]+:/.test(url) ||
  (/^https?:/.test(url) && URL.canParse(url) &&
    (url.endsWith(".git") || url.includes("/_git/") || ["github.com", "gitlab.com"].includes(new URL(url).hostname)));
// marketplace add takes one source string, so a field that string can't carry is refused, not dropped
const addArgs = (name, source) => {
  if (typeof source?.source !== "string") fail(name, "no source object");
  const { source: type, repo, url, path, ref, sparsePaths } = source;
  const pinned = (where) => (ref ? where + "#" + ref : where);
  const sparse = sparsePaths?.length ? ["--sparse", ...sparsePaths] : [];
  if ((type === "github" || type === "git") && path) fail(name, "marketplace add can't read a " + type + " source's path");
  if (type === "github") return [pinned(repo), ...sparse];
  if (type === "git") {
    if (typeof url !== "string" || !addClones(url)) fail(name, url + " isn't a url marketplace add clones; end it in .git");
    return [pinned(url), ...sparse];
  }
  if (type === "url") {
    if (source.headers || source.headersHelper) fail(name, "marketplace add can't send a url source's headers");
    return [url];
  }
  if (type === "directory" || type === "file") return [path];
  fail(name, "unsupported source: " + type);
};
const marketplaceOf = (plugin) => plugin.slice(plugin.lastIndexOf("@") + 1);
const used = new Set(plugins.map(marketplaceOf));
const adds = Object.entries(settings.extraKnownMarketplaces ?? {})
  .filter(([name]) => used.has(name))
  .map(([name, entry]) => addArgs(name, entry?.source));
for (const args of adds) claude("plugin", "marketplace", "add", ...args);
let listed;
try {
  listed = execFileSync(sdk + "/" + platform + "/claude", ["plugin", "marketplace", "list", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
} catch (err) {
  process.exit(err.status || 1);
}
const known = new Set(JSON.parse(listed).map((m) => m.name));
const missing = plugins.filter((p) => !known.has(marketplaceOf(p)));
for (const plugin of missing) {
  console.error(
    'plugin "' + plugin + '" in ' + file + ': marketplace "' + marketplaceOf(plugin) + '" is not known; declare it in ' +
      'extraKnownMarketplaces, or add it in the setup with "$SKY_CLAUDE" plugin marketplace add <source>',
  );
}
if (missing.length > 0) process.exit(1);
claude("plugin", "marketplace", "update");
for (const plugin of plugins) claude("plugin", "install", plugin, "--scope", "user");
for (const plugin of plugins) claude("plugin", "update", plugin, "--scope", "user");
`;
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** `export NAME='value'` lines for sh to source; later names override earlier ones. */
export const envFile = (vars: Iterable<readonly [string, string]>) =>
  [...vars]
    .map(([name, value]) => `export ${name}=${shellQuote(value)}\n`)
    .join("");

// the store steps' env, as a run's, rides in a file: an exec's argv and env reach the sprite as URL
// query params
const STORE_ENV_FILE = "/tmp/sky-store.env";
// the repo pull's env, the connector, gateway and read token only, rides in a file for the same reason
const REPO_ENV_FILE = "/tmp/sky-repo.env";
const PULL_REPO = `. "$1" && exec node ${RUNNER} repo-pull "$2" "$3"`;
const PULL_STORE = `. "$1" && exec node ${RUNNER} store-sync pull`;
// the store's own setup script, when it has one, in the checkout the profile's layout names. Only
// the root resolution sees the env file
const RUN_STORE_SETUP = `home=$(. "$1" || exit 1; printf %s "$HOME/\${SKY_STORE_HOME:-.sky-store}") || exit 1; if [ -f "$home/setup.sh" ]; then bash "$home/setup.sh"; fi`;
// the sprite's node ships corepack but no pnpm or yarn; corepack's shims go under $HOME, so need no
// root, and resolve the repo's `packageManager` version when run
const PACKAGE_MANAGERS_DIR = "$HOME/.local/bin";
/**
 * Puts the shims first on PATH for a non-login shell, which reads no profile. Turns corepack's
 * download prompt off, since with a TTY it can stop to ask before fetching a package manager.
 */
export const WITH_PACKAGE_MANAGERS = `export PATH="${PACKAGE_MANAGERS_DIR}:$PATH" COREPACK_ENABLE_DOWNLOAD_PROMPT=0`;
/**
 * Points `SKY_CLAUDE` at the SDK's bundled `claude`, so a setup can add a marketplace the plugin step
 * then installs from; the first one that runs, since a glob can also match the other libc's build.
 * Then enables the shims and execs its argv (the setup); enabling again on a rerun is harmless.
 */
const PREPARE_SETUP = `for c in ${RUNNER_DIR}/node_modules/@anthropic-ai/claude-agent-sdk-*/claude; do "$c" --version >/dev/null 2>&1 && export SKY_CLAUDE="$c" && break; done; mkdir -p "${PACKAGE_MANAGERS_DIR}" && corepack enable --install-directory "${PACKAGE_MANAGERS_DIR}" && ${WITH_PACKAGE_MANAGERS} && exec "$@"`;
// ≤ the length CHECK on environments.failure_stderr in db/src/schema.ts
const TAIL_CHARS = 4000;

const INTERRUPTED =
  "interrupted: the API restarted during this step; a retry provisions from the start";

class StepFailed extends Error {}

type Deps = {
  db: Db;
  secretEncryptionKey: Buffer;
  secrets: KnownSecrets;
  sprites: SpriteOps;
  ensureBundle: BundleInstaller;
  /** The API's configured base profiles, by name. */
  baseProfiles: Record<string, BaseProfile>;
  log: (line: string) => void;
};
type Target = {
  id: EnvironmentId;
  repo: string;
  setup: string;
  base: string | null;
};

/**
 * Runs provisioning as in-process background jobs. A failure lands in `failure_step` and
 * `failure_stderr`: the failed command's output tail (stdout and stderr together), or the Sprites
 * error for create/checkpoint, a timeout's included. Clone, installs, setup and checkpoint are bounded
 * by `sprites.longTimeoutMs`, every other call by `sprites.timeoutMs`.
 */
export function createProvisioner({
  db,
  secretEncryptionKey,
  secrets,
  sprites,
  ensureBundle,
  baseProfiles,
  log,
}: Deps) {
  async function run(env: Target): Promise<void> {
    const name = spriteNameFor(env.id);
    const profile = env.base === null ? undefined : baseProfiles[env.base];
    // env secret values a step handed to the sprite, which its output may echo into the stored failure
    const stepSecrets: string[] = [];
    const exec = async (argv: [string, ...string[]], op: string) => {
      const out = await execInSprite(sprites, name, argv, { op });
      if (out.exitCode !== 0) {
        throw new StepFailed(out.stderr || `exited with code ${out.exitCode}`);
      }
    };
    // clone, install and setup print plenty, so their output stays in a log in the sprite
    const execNoisy = async (
      argv: [string, ...string[]],
      op: string,
      log: string,
      { cwd, known }: { cwd?: string; known?: readonly string[] } = {},
    ) => {
      const out = await execLogged(sprites, name, argv, {
        op,
        timeoutMs: sprites.longTimeoutMs,
        known,
        cwd,
        log,
        tailBytes: TAIL_CHARS,
      });
      if (out.exitCode !== 0) {
        throw new StepFailed(out.tail || `exited with code ${out.exitCode}`);
      }
    };
    // the checkpoint must not keep the env's secrets, so a file that stays fails the step
    const removeEnvFiles = async (paths: string[], op: string) => {
      const failed = (detail: string) =>
        new StepFailed(`could not remove ${paths.join(" ")}: ${detail}`);
      const out = await execInSprite(sprites, name, ["rm", "-f", ...paths], {
        op,
        known: stepSecrets,
      }).catch((err: unknown) => {
        throw failed(err instanceof Error ? err.message : String(err));
      });
      if (out.exitCode !== 0) {
        throw failed(out.stderr || `exited with code ${out.exitCode}`);
      }
    };
    /**
     * The sprite reaches GitHub only through its connector, which carries REST and no git
     * transport, so the profile's store (possibly private) is checked out by the runner's
     * `store-sync pull`, then the store's own `setup.sh` runs. The checkout outlives reprovisioning
     * and a pull merges what is there, so this is safe to repeat. Without a connector secret there
     * is nothing to reach GitHub with. A failure, a timeout included, is logged and never fails
     * provisioning: each run's own pull tries again.
     */
    const checkoutStore = async (
      envId: EnvironmentId,
      sprite: string,
      profile: BaseProfile | undefined,
    ): Promise<void> => {
      let stored = new Map<string, string>();
      try {
        if (!profile?.storeRepo) return;
        if (!hasConnectorSecret(db, envId, "GITHUB_CONNECTOR")) return;
        stored = openEnvSecrets(db, secretEncryptionKey, envId);
        // the runner's own off switches, `KRU_NO_STORE_SYNC` being the earlier name, read from the same env on every run
        if (
          stored.get("SKY_NO_STORE_SYNC") ||
          stored.get("KRU_NO_STORE_SYNC")
        ) {
          return;
        }
        const known = [...stored.values()];
        await ensureBundle(sprite, `provision-${envId}`);
        await writeSpriteFile(
          sprites,
          sprite,
          STORE_ENV_FILE,
          envFile([...stored, ...storeEnv(profile)]),
          { op: "write-store-env", mode: 0o600, known },
        );
        try {
          await execNoisy(
            ["sh", "-c", PULL_STORE, "sh", STORE_ENV_FILE],
            "store-pull",
            "/tmp/sky-store.log",
            { known },
          );
          await execNoisy(
            ["bash", "-c", RUN_STORE_SETUP, "bash", STORE_ENV_FILE],
            "store-setup",
            "/tmp/sky-store-setup.log",
            { known },
          );
        } finally {
          // the checkpoint must not keep the env's secrets
          await execInSprite(sprites, sprite, ["rm", "-f", STORE_ENV_FILE], {
            op: "rm-store-env",
            known,
          });
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        log(
          `checking out the store in ${sprite} failed: ${redact(detail, [...secrets.values(), ...stored.values()])}`,
        );
      }
    };
    /**
     * Puts the env's repo at `REPO_DIR`. With a `GITHUB_READ_TOKEN` or a connector secret the
     * runner's `repo-pull` fetches it, over git with the token (no REST calls) or else through the
     * gateway, so a private repo works; the checkout holds GitHub's own commit, which
     * the agents' worktrees branch from and their publishes build on. Without one, a plain clone
     * of a public repo.
     */
    const cloneRepo = async (): Promise<void> => {
      const viaConnector = hasConnectorSecret(db, env.id, "GITHUB_CONNECTOR");
      const viaToken = hasValueSecret(db, env.id, "GITHUB_READ_TOKEN");
      if (!viaConnector && !viaToken) {
        await execNoisy(
          ["git", "clone", cloneUrl(env.repo), REPO_DIR],
          "clone",
          "/tmp/sky-clone.log",
        );
        return;
      }
      // only these two are read, so an unrelated secret that won't decrypt can't fail the clone
      const pulled = openEnvSecrets(db, secretEncryptionKey, env.id, [
        "GITHUB_CONNECTOR",
        "GITHUB_GATEWAY_URL",
        "GITHUB_READ_TOKEN",
      ]);
      const known = [...pulled.values()];
      stepSecrets.push(...known);
      const removeEnvFile = () =>
        removeEnvFiles([REPO_ENV_FILE], "rm-repo-env");
      await ensureBundle(name, `provision-${env.id}`);
      try {
        // in the try: a write that errors client-side may still have landed
        await writeSpriteFile(sprites, name, REPO_ENV_FILE, envFile(pulled), {
          op: "write-repo-env",
          mode: 0o600,
          known,
        });
        await execNoisy(
          ["sh", "-c", PULL_REPO, "sh", REPO_ENV_FILE, env.repo, REPO_DIR],
          "clone",
          "/tmp/sky-clone.log",
          { known },
        );
      } catch (err) {
        // the pull's failure is the one recorded; a file left behind is only logged
        await removeEnvFile().catch((rmErr: unknown) => {
          const detail = rmErr instanceof Error ? rmErr.message : String(rmErr);
          log(
            `sprite ${name} kept ${REPO_ENV_FILE} after a failed clone: ${redact(detail, [...secrets.values(), ...known])}`,
          );
        });
        throw err;
      }
      await removeEnvFile();
    };
    /**
     * Makes the sprite's user config hold the profile's plugins and MCP servers and none an earlier
     * profile added, so it runs with no profile too; its values are secret names, never secrets.
     */
    const applyBase = async (profile: BaseProfile | undefined) => {
      const {
        marketplaces = [],
        plugins = [],
        mcpServers = {},
      } = profile ?? {};
      await writeSpriteFile(
        sprites,
        name,
        BASE_PROFILE_FILE,
        JSON.stringify({ marketplaces, plugins, mcpServers }),
        { op: "write-base-profile", known: [] },
      );
      await execNoisy(
        [
          "node",
          "-e",
          APPLY_BASE,
          RUNNER_DIR,
          BASE_PROFILE_FILE,
          LEFTOVER_BASE_FILE,
        ],
        "apply-base",
        "/tmp/sky-base.log",
        { cwd: REPO_DIR },
      );
      await exec(
        ["rm", "-f", BASE_PROFILE_FILE, LEFTOVER_BASE_FILE],
        "rm-base-profile",
      );
    };
    let step: (typeof environmentFailureSteps)[number] = "create";
    // the step in progress is stored as it starts, so a restart can name where it stopped
    const begin = (next: typeof step) => {
      step = next;
      db.update(environments)
        .set({ failureStep: next })
        .where(eq(environments.id, env.id))
        .run();
    };
    try {
      if (env.base !== null && !profile) {
        throw new StepFailed(
          `base profile ${JSON.stringify(env.base)} is not configured on this server`,
        );
      }
      begin("create");
      await ensureSprite(sprites, name, baseSpriteLabels(env.id, env.repo));
      // before the clone: the runner imports the SDK at load, and the connector's repo-pull runs it
      begin("setup");
      await execNoisy(
        ["sh", "-c", installRunnerSdk],
        "install-sdk",
        "/tmp/sky-sdk.log",
      );
      begin("clone");
      await exec(["rm", "-rf", REPO_DIR, WORKTREES_DIR], "rm-repo");
      await cloneRepo();
      begin("setup");
      // the profile first, so the env's setup can use what it installs
      await applyBase(profile);
      await execNoisy(
        ["sh", "-c", PREPARE_SETUP, "sh", "bash", "-c", env.setup],
        "setup",
        "/tmp/sky-setup.log",
        { cwd: REPO_DIR },
      );
      await execNoisy(
        ["node", "-e", INSTALL_PLUGINS, RUNNER_DIR],
        "install-plugins",
        "/tmp/sky-plugins.log",
        { cwd: REPO_DIR },
      );
      await checkoutStore(env.id, name, profile);
      begin("checkpoint");
      // a write that landed after its timeout, or a removal that only got logged, can leave either
      await removeEnvFiles([REPO_ENV_FILE, STORE_ENV_FILE], "rm-env-files");
      const checkpointId = await checkpointSprite(sprites, name, "sky setup");
      db.update(environments)
        .set({ status: "ready", checkpointId, failureStep: null })
        .where(eq(environments.id, env.id))
        .run();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      db.update(environments)
        .set({
          status: "failed",
          failureStep: step,
          failureStderr: redact(detail, [
            ...secrets.values(),
            ...stepSecrets,
          ]).slice(-TAIL_CHARS),
        })
        .where(eq(environments.id, env.id))
        .run();
    }
  }

  return {
    /** Starts provisioning without waiting. The caller clears any previous failure. */
    start(env: Target): void {
      run(env).catch((err: unknown) => {
        log(`provisioning ${env.id} could not record its outcome: ${err}`);
      });
    },
  };
}

export type Provisioner = ReturnType<typeof createProvisioner>;

/**
 * Provisioning jobs die with the process; call at boot so none stays `provisioning` forever. Each is
 * failed at the step it was in, `create` when it never started one.
 */
export function failInterruptedProvisioning(db: Db): void {
  db.update(environments)
    .set({
      status: "failed",
      failureStep: sql`coalesce(${environments.failureStep}, 'create')`,
      failureStderr: INTERRUPTED,
    })
    .where(eq(environments.status, "provisioning"))
    .run();
}
