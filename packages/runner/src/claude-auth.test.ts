import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  type CommandEnv,
  claudeProcessEnv,
  commandEnvScript,
  credentialDir,
  prepareCommandEnv,
  removeCredentialFilesNow,
  sweepCredentialFiles,
  withdrawCredential,
} from "./claude-auth.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sky-claude-auth-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const runnerEnv = {
  PATH: "/bin",
  ANTHROPIC_API_KEY: "project-key",
  ANTHROPIC_AUTH_TOKEN: "project-auth",
  CLAUDE_CODE_OAUTH_TOKEN: "subscription-token",
  SKY_CLAUDE_AUTH: "oauth",
  SKY_CLAUDE_API_KEY: "sky-key",
  ANTHROPIC_BASE_URL: "https://gateway.example",
  CLAUDE_CODE_USE_BEDROCK: "1",
  CLAUDE_CODE_USE_VERTEX: "1",
  CLAUDE_CODE_USE_FOUNDRY: "1",
  CLAUDE_CODE_USE_ANTHROPIC_AWS: "1",
  CLAUDE_CODE_USE_MANTLE: "1",
};

test("a subscription run's process env keeps the token and no API key of any name, gateway or provider switch", () => {
  expect(claudeProcessEnv(runnerEnv, "oauth")).toEqual({
    PATH: "/bin",
    CLAUDE_CODE_OAUTH_TOKEN: "subscription-token",
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
  });
});

test("an API-key run's process env holds Sky's key as ANTHROPIC_API_KEY, and no token, gateway or provider switch", () => {
  expect(claudeProcessEnv(runnerEnv, "api-key")).toEqual({
    PATH: "/bin",
    ANTHROPIC_API_KEY: "sky-key",
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
  });
});

test("the credential comes from the runner's own env, never from a session env merged over it", () => {
  const merged = {
    ...runnerEnv,
    CLAUDE_CODE_OAUTH_TOKEN: "profile-token",
    SKY_CLAUDE_API_KEY: "profile-key",
  };
  expect(claudeProcessEnv(merged, "oauth", runnerEnv)).toEqual({
    PATH: "/bin",
    CLAUDE_CODE_OAUTH_TOKEN: "subscription-token",
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
  });
  expect(claudeProcessEnv(merged, "api-key", runnerEnv)).toEqual({
    PATH: "/bin",
    ANTHROPIC_API_KEY: "sky-key",
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
  });
});

test.each(["oauth", "api-key"] as const)(
  "a %s run's Claude is host-managed, whatever the secrets or the profile set the switch to",
  (auth) => {
    const secrets = {
      ...runnerEnv,
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "0",
    };
    for (const profileValue of ["0", ""])
      expect(
        claudeProcessEnv(
          { ...secrets, CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: profileValue },
          auth,
          secrets,
        ).CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST,
      ).toBe("1");
  },
);

test("the command script gives commands the project's key, or unsets Sky's on an API-key run", () => {
  expect(commandEnvScript("oauth", { ANTHROPIC_API_KEY: "pk'1" })).toBe(
    "export ANTHROPIC_API_KEY='pk'\\''1'\n",
  );
  expect(commandEnvScript("api-key", { ANTHROPIC_API_KEY: "pk" })).toBe(
    "export ANTHROPIC_API_KEY='pk'\n",
  );
  expect(commandEnvScript("api-key", { PATH: "/bin" })).toBe(
    "unset ANTHROPIC_API_KEY\n",
  );
  expect(commandEnvScript("oauth", { PATH: "/bin" })).toBeUndefined();
});

test("the command script gives commands back every project value the Claude process drops, and no run credential", () => {
  const script = commandEnvScript("oauth", runnerEnv);
  expect(script).toBe(
    [
      "export ANTHROPIC_API_KEY='project-key'",
      "export ANTHROPIC_AUTH_TOKEN='project-auth'",
      "export ANTHROPIC_BASE_URL='https://gateway.example'",
      "export CLAUDE_CODE_USE_BEDROCK='1'",
      "export CLAUDE_CODE_USE_VERTEX='1'",
      "export CLAUDE_CODE_USE_FOUNDRY='1'",
      "export CLAUDE_CODE_USE_ANTHROPIC_AWS='1'",
      "export CLAUDE_CODE_USE_MANTLE='1'",
      "",
    ].join("\n"),
  );
  expect(script).not.toContain("subscription-token");
  expect(script).not.toContain("sky-key");
  expect(commandEnvScript("api-key", runnerEnv)).toBe(script);
});

test("the command script exports the project's proxies and custom headers, and no OAuth refresh token or scopes", () => {
  expect(
    commandEnvScript("oauth", {
      PATH: "/bin",
      HTTPS_PROXY: "http://proxy.example:3128",
      https_proxy: "http://proxy.example:3129",
      ANTHROPIC_CUSTOM_HEADERS: "x-team: acme",
      CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "refresh-token-opaque",
      CLAUDE_CODE_OAUTH_SCOPES: "user:inference",
    }),
  ).toBe(
    [
      "export ANTHROPIC_CUSTOM_HEADERS='x-team: acme'",
      "export HTTPS_PROXY='http://proxy.example:3128'",
      "export https_proxy='http://proxy.example:3129'",
      "",
    ].join("\n"),
  );
});

test("an API-key run whose project has a gateway but no key still unsets Sky's key for commands", () => {
  const script = commandEnvScript("api-key", {
    ANTHROPIC_AUTH_TOKEN: "gw'token",
    ANTHROPIC_BASE_URL: "https://gateway.example",
    SKY_CLAUDE_API_KEY: "sky-key",
  });
  expect(script).toBe(
    [
      "unset ANTHROPIC_API_KEY",
      "export ANTHROPIC_AUTH_TOKEN='gw'\\''token'",
      "export ANTHROPIC_BASE_URL='https://gateway.example'",
      "",
    ].join("\n"),
  );
});

type Hooks = { SessionStart?: { hooks: { command: string }[] }[] };

function hookCommand(env: CommandEnv): string {
  const hooks = env.hooks as unknown as Hooks | undefined;
  return hooks?.SessionStart?.[0]?.hooks[0]?.command ?? "";
}

const scriptIn = (where: string) =>
  readdirSync(where)
    .filter((name) => name.startsWith("sky-command-env-"))
    .map((name) => join(where, name));

/** Runs the hook as Claude Code does; `command` then sources `CLAUDE_ENV_FILE` as a command's shell does. */
function runHookThenCommand(env: CommandEnv) {
  const envFile = join(dir, "claude-env-file");
  writeFileSync(envFile, "");
  const shellEnv = { PATH: process.env.PATH, CLAUDE_ENV_FILE: envFile };
  execFileSync("sh", ["-c", hookCommand(env)], { env: shellEnv });
  const command = () =>
    execFileSync(
      "sh",
      [
        "-c",
        `. "$CLAUDE_ENV_FILE" && printf %s "\${ANTHROPIC_API_KEY-unset} \${ANTHROPIC_BASE_URL-unset}"`,
      ],
      { env: shellEnv, encoding: "utf8" },
    );
  return { envFile, command };
}

const PROJECT = {
  ANTHROPIC_API_KEY: "project-key",
  ANTHROPIC_BASE_URL: "https://gateway.example",
};

test("the script file is readable by its owner alone, and gone once removed", async () => {
  const env = await prepareCommandEnv("oauth", PROJECT, dir);
  const [path = ""] = scriptIn(dir);
  expect(readFileSync(path, "utf8")).toContain("project-key");
  expect(statSync(path).mode & 0o777).toBe(0o600);
  await env.remove();
  expect(existsSync(path)).toBe(false);
});

test("the hook command names the script file and carries none of its values", async () => {
  const env = await prepareCommandEnv("oauth", PROJECT, dir);
  const command = hookCommand(env);
  expect(command).toContain(scriptIn(dir)[0]);
  expect(command).not.toContain("project-key");
  expect(command).not.toContain("gateway.example");
  await env.remove();
});

test("once the hook has run, a command sourcing Claude Code's env file gets the project's values, which that file never holds", async () => {
  const env = await prepareCommandEnv("oauth", PROJECT, dir);
  const { envFile, command } = runHookThenCommand(env);
  expect(command()).toBe("project-key https://gateway.example");
  const appended = readFileSync(envFile, "utf8");
  expect(appended).not.toContain("project-key");
  expect(appended).not.toContain("gateway.example");
  await env.remove();
});

test("once the script is removed, sourcing Claude Code's env file still succeeds and exports nothing", async () => {
  const env = await prepareCommandEnv("oauth", PROJECT, dir);
  const { command } = runHookThenCommand(env);
  await env.remove();
  expect(command()).toBe("unset unset");
});

test("removeCredentialFilesNow deletes a script still on disk before it returns, and a later remove still resolves", async () => {
  const env = await prepareCommandEnv("oauth", PROJECT, dir);
  const [path = ""] = scriptIn(dir);
  expect(existsSync(path)).toBe(true);
  removeCredentialFilesNow();
  expect(existsSync(path)).toBe(false);
  await expect(env.remove()).resolves.toBeUndefined();
});

test("with nothing to say there is no hook and nothing to remove", async () => {
  const env = await prepareCommandEnv("oauth", { PATH: "/bin" }, dir);
  expect(env.hooks).toBeUndefined();
  await expect(env.remove()).resolves.toBeUndefined();
});

describe("withdrawCredential", () => {
  test("takes the subscription token and Sky's key out of the env, returns them, and leaves the project's own values", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/bin",
      CLAUDE_CODE_OAUTH_TOKEN: "subscription-token",
      SKY_CLAUDE_API_KEY: "sky-key",
      SKY_CLAUDE_AUTH: "api-key",
      ANTHROPIC_API_KEY: "project-key",
      NPM_TOKEN: "npm-secret",
    };
    const held = withdrawCredential(env);
    expect(held).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: "subscription-token",
      SKY_CLAUDE_API_KEY: "sky-key",
    });
    expect(env).toEqual({
      PATH: "/bin",
      SKY_CLAUDE_AUTH: "api-key",
      ANTHROPIC_API_KEY: "project-key",
      NPM_TOKEN: "npm-secret",
    });
  });

  test("an env with neither holds nothing, and what it hands back still chooses the Claude process's credential", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/bin" };
    expect(withdrawCredential(env)).toEqual({});
    const withdrawn: NodeJS.ProcessEnv = {
      CLAUDE_CODE_OAUTH_TOKEN: "subscription-token",
    };
    const held = withdrawCredential(withdrawn);
    expect(claudeProcessEnv({ PATH: "/bin" }, "oauth", held)).toMatchObject({
      CLAUDE_CODE_OAUTH_TOKEN: "subscription-token",
    });
  });
});

// the module as Node itself loads it, types stripped, so a child process can die with it loaded
const CLAUDE_AUTH = join(import.meta.dirname, "claude-auth.ts");
const CLAUDE_AUTH_URL = pathToFileURL(CLAUDE_AUTH).href;

test.each([
  ["an uncaught exception", "setImmediate(() => { throw boom; });"],
  ["an unhandled rejection", "Promise.reject(boom);"],
])(
  "the credential files are removed when the process dies of %s",
  (_, death) => {
    const script = [
      `import * as auth from ${JSON.stringify(CLAUDE_AUTH_URL)};`,
      "auth.removeCredentialFilesOnExit();",
      "const dir = process.env.DIR;",
      'const login = { CLAUDE_CODE_OAUTH_TOKEN: "token" };',
      'await auth.prepareNestedLogin("oauth", login, "run_1", dir);',
      'const project = { ANTHROPIC_API_KEY: "project-key" };',
      'await auth.prepareCommandEnv("oauth", project, dir);',
      'process.stdout.write("written");',
      'const boom = new Error("boom");',
      death,
    ].join("\n");
    const child = spawnSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--input-type=module",
        "-e",
        script,
      ],
      { env: { PATH: process.env.PATH, DIR: dir }, encoding: "utf8" },
    );
    expect(child.stdout).toBe("written");
    expect(child.stderr).toContain("boom");
    expect(child.status).toBe(1);
    expect(readdirSync(dir)).toEqual([]);
  },
);

test("the sweep removes a dead runner's credential files and leaves a live runner's", () => {
  const [dead, live, self] = [101, 102, 103];
  for (const pid of [dead, live, self]) {
    const runner = credentialDir(dir, pid);
    mkdirSync(runner);
    writeFileSync(join(runner, "sky-nested-claude-run_1"), "");
  }
  writeFileSync(join(dir, "sky-runner-notes"), "");
  // this runner's own pid is alive, and its directory still a dead process's
  sweepCredentialFiles((pid) => pid === live || pid === self, dir, self);
  expect(readdirSync(dir).sort()).toEqual([
    "sky-runner-102",
    "sky-runner-notes",
  ]);
  expect(readdirSync(credentialDir(dir, live))).toEqual([
    "sky-nested-claude-run_1",
  ]);
});

test("the sweep of a missing directory does nothing and never throws", () => {
  const absent = join(dir, "absent");
  expect(() => sweepCredentialFiles(() => false, absent)).not.toThrow();
});
