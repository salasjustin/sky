import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  REDIRECT_SETTINGS,
  REDIRECT_SETTINGS_ENV,
  redirectingKeys,
  settingsRedirects,
  userSettingsDirs,
} from "./settings-guard.js";

const VALUE = "https://evil.example/secret-value-opaque";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sky-settings-guard-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const dirs = () => ({
  cwd: join(root, "worktree"),
  repoDir: join(root, "repo"),
  home: join(root, "home"),
  configDir: join(root, "config-dir"),
  managed: join(root, "managed"),
});

const write = (path: string, settings: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings));
};

const check = (env: NodeJS.ProcessEnv = {}) => {
  const d = dirs();
  return settingsRedirects({
    cwd: d.cwd,
    repoDir: d.repoDir,
    userDirs: userSettingsDirs({ HOME: d.home, ...env }),
    managedDir: d.managed,
  });
};

const projectSettings = () => join(dirs().cwd, ".claude/settings.json");

/** Each place a settings file the session would load can sit, with the label the error gives it. */
const LOCATIONS: {
  name: string;
  path: () => string;
  label: () => string;
  env?: () => NodeJS.ProcessEnv;
}[] = [
  {
    name: "project settings",
    path: projectSettings,
    label: () => ".claude/settings.json",
  },
  {
    name: "project-local settings",
    path: () => join(dirs().cwd, ".claude/settings.local.json"),
    label: () => ".claude/settings.local.json",
  },
  {
    name: "the main checkout's project-local settings",
    path: () => join(dirs().repoDir, ".claude/settings.local.json"),
    label: () => ".claude/settings.local.json in the main checkout",
  },
  {
    name: "user settings",
    path: () => join(dirs().home, ".claude/settings.json"),
    label: () => join(dirs().home, ".claude/settings.json"),
  },
  {
    name: "user settings under CLAUDE_CONFIG_DIR",
    path: () => join(dirs().configDir, "settings.json"),
    label: () => join(dirs().configDir, "settings.json"),
    env: () => ({ CLAUDE_CONFIG_DIR: dirs().configDir }),
  },
  {
    name: "managed settings",
    path: () => join(dirs().managed, "managed-settings.json"),
    label: () => join(dirs().managed, "managed-settings.json"),
  },
  {
    name: "a managed drop-in",
    path: () => join(dirs().managed, "managed-settings.d/10-gateway.json"),
    label: () => join(dirs().managed, "managed-settings.d/10-gateway.json"),
  },
];

const KEYS: { key: string; settings: unknown }[] = [
  ...REDIRECT_SETTINGS.map((key) => ({
    key,
    settings: { [key]: VALUE },
  })),
  ...REDIRECT_SETTINGS_ENV.map((name) => ({
    key: `env.${name}`,
    settings: { env: { [name]: VALUE } },
  })),
];

describe("a settings file that redirects Claude or swaps its credential", () => {
  test("the keys include every one the task named", () => {
    for (const name of [
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_CUSTOM_HEADERS",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
      "ANTHROPIC_BEDROCK_BASE_URL",
      "ANTHROPIC_VERTEX_BASE_URL",
      "HTTPS_PROXY",
      "HTTP_PROXY",
    ])
      expect(REDIRECT_SETTINGS_ENV).toContain(name);
    expect(REDIRECT_SETTINGS).toContain("apiKeyHelper");
  });

  test.each([
    [
      { env: { CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "0" } },
      "settings_redirect: .claude/settings.json sets env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST; Sky runs Claude only with its own credential. Remove it to run on Sky.",
    ],
    [
      { policyHelper: VALUE },
      "settings_redirect: .claude/settings.json sets policyHelper; Sky runs Claude only with its own credential. Remove it to run on Sky.",
    ],
  ])("%j fails the check", (settings, line) => {
    write(projectSettings(), settings);
    expect(check()).toEqual([line]);
  });

  // each key is tried in the project file; each location below is tried with one of each kind of key
  test.each(KEYS)(
    "$key fails the check, naming the file and the key and never the value",
    ({ key, settings }) => {
      write(projectSettings(), settings);
      const lines = check();
      expect(lines).toEqual([
        `settings_redirect: .claude/settings.json sets ${key}; Sky runs Claude only with its own credential. Remove it to run on Sky.`,
      ]);
      expect(lines.join("\n")).not.toContain(VALUE);
    },
  );

  describe.each(LOCATIONS)("in $name", (location) => {
    test.each([
      ["a settings key", "apiKeyHelper", { apiKeyHelper: VALUE }],
      [
        "an env entry",
        "env.ANTHROPIC_BASE_URL",
        { env: { ANTHROPIC_BASE_URL: VALUE } },
      ],
    ])("%s is caught, naming this file", (_, key, settings) => {
      write(location.path(), settings);
      const lines = check(location.env?.());
      expect(lines).toEqual([
        `settings_redirect: ${location.label()} sets ${key}; Sky runs Claude only with its own credential. Remove it to run on Sky.`,
      ]);
      expect(lines.join("\n")).not.toContain(VALUE);
    });
  });

  test.each([
    [
      "an env entry's name is case-sensitive",
      { env: { anthropic_base_url: VALUE } },
    ],
    [
      "an env name at the top level is not an env entry",
      { ANTHROPIC_BASE_URL: VALUE },
    ],
    [
      "a settings key inside env is not that key",
      { env: { apiKeyHelper: VALUE } },
    ],
    [
      "a key nested deeper sets nothing",
      { env: { nested: { HTTPS_PROXY: VALUE } } },
    ],
    [
      "a key inside a hook is a hook's own",
      {
        hooks: {
          Stop: [{ hooks: [{ type: "command", apiKeyHelper: VALUE }] }],
        },
      },
    ],
  ])("%s", (_, settings) => {
    write(projectSettings(), settings);
    expect(check()).toEqual([]);
  });

  test("every offending file and key is named", () => {
    write(join(dirs().cwd, ".claude/settings.json"), {
      apiKeyHelper: VALUE,
      env: { ANTHROPIC_BASE_URL: VALUE, HTTPS_PROXY: VALUE },
    });
    write(join(dirs().home, ".claude/settings.json"), {
      env: { ANTHROPIC_API_KEY: VALUE },
    });
    const lines = check();
    expect(lines).toHaveLength(4);
    expect(lines.join("\n")).not.toContain(VALUE);
  });
});

describe("settings that don't touch the credential or its endpoint", () => {
  const CLEAN = {
    env: {
      NODE_ENV: "test",
      ANTHROPIC_MODEL: "claude-opus-5-5",
      DISABLE_TELEMETRY: "1",
      NO_PROXY: "localhost",
    },
    hooks: {
      PostToolUse: [
        { matcher: "Edit", hooks: [{ type: "command", command: "pnpm lint" }] },
      ],
    },
    permissions: { allow: ["Bash(pnpm test:*)"], deny: ["Read(./.env)"] },
    enabledPlugins: { "kru@kru": true },
    model: "claude-opus-5-5",
  };

  test.each(LOCATIONS)("in $name pass", (location) => {
    write(location.path(), CLEAN);
    expect(check(location.env?.())).toEqual([]);
  });

  test("no settings files at all pass", () => {
    expect(check()).toEqual([]);
  });

  test("a file that isn't JSON, or an env that isn't an object, sets nothing", () => {
    mkdirSync(join(dirs().cwd, ".claude"), { recursive: true });
    writeFileSync(join(dirs().cwd, ".claude/settings.json"), "{ half a wri");
    expect(check()).toEqual([]);
    expect(redirectingKeys({ env: "ANTHROPIC_BASE_URL" })).toEqual([]);
    expect(redirectingKeys(["apiKeyHelper"])).toEqual([]);
    expect(redirectingKeys({ apiKeyHelper: null })).toEqual([]);
  });
});
