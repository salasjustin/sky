import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpritesClient } from "@fly/sprites";
import { type Db, migrate, openDb } from "@sky/db";
import { BaseProfile } from "@sky/shared";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { server } from "../../../test/msw.js";
import { createApp } from "./app.js";
import { failInterruptedProvisioning } from "./provision.js";
import { spriteNameFor } from "./sprites.js";
import {
  envFileOf,
  type SpritesWire,
  spritesToken,
  stubSprites,
  testConfig,
} from "./testing/sprites.js";

const apiKey = "k".repeat(40);

let db: Db;
let app: ReturnType<typeof createApp>;
let wire: SpritesWire;
beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
  wire = stubSprites();
  app = createApp({
    db,
    config: testConfig({ baseProfiles: profiles }),
    sprites: new SpritesClient(spritesToken),
    log: () => {},
    nudgeDeliveries: () => {},
  });
});
afterEach(() => {
  if (db.$client.open) db.$client.close();
});

const auth = { Authorization: `Bearer ${apiKey}` };
const json = { ...auth, "Content-Type": "application/json" };

const post = (body: unknown) =>
  app.request("/v1/environments", {
    method: "POST",
    headers: json,
    body: JSON.stringify(body),
  });

const get = async (id: string) => {
  const res = await app.request(`/v1/environments/${id}`, { headers: auth });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
};

/** Polls the env until its background provisioning ends. */
const settled = (id: string, timeout = 1_000) =>
  vi.waitFor(
    async () => {
      const { body } = await get(id);
      expect(body.status).not.toBe("provisioning");
      return body;
    },
    { timeout },
  );

const kru = { name: "kru", repo: "acme/kru", setup: "pnpm install" };

/** A profile the way an operator would configure one: a store the runner syncs, and nothing else. */
const team = BaseProfile.parse({
  storeRepo: "acme/store",
  storeLayout: { home: ".store" },
});
const profiles = { team };

// the runner bundle externalizes the Agent SDK, so the sprite installs the exact version the runner builds against
const runnerSdk = JSON.parse(
  readFileSync(
    new URL("../../../packages/runner/package.json", import.meta.url),
    "utf8",
  ),
).dependencies["@anthropic-ai/claude-agent-sdk"];
const installRunnerSdk = `[ -w /opt/sky ] || sudo install -d -o "$(id -u)" -g "$(id -g)" /opt/sky; npm install --prefix /opt/sky --no-audit --no-fund @anthropic-ai/claude-agent-sdk@${runnerSdk}`;
// the setup runs as `bash -c <setup>` behind an `sh -c` wrapper; what the wrapper does, the shell-run tests pin
const isSetup = (argv: string[]) => argv[0] === "sh" && argv[4] === "bash";
const setupCall = (sprite: string, setup: string) =>
  expect.stringMatching(
    new RegExp(
      `^exec ${sprite} /workspace/repo sh -c .+ sh bash -c ${setup.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} &> /tmp/sky-setup\\.log$`,
    ),
  );

// the plugin step's script is opaque here; the plugin tests below run it in node and pin what it does
const pluginsCall = (sprite: string) =>
  expect.stringMatching(
    new RegExp(
      `^exec ${sprite} /workspace/repo node -e [\\s\\S]+ /opt/sky &> /tmp/sky-plugins\\.log$`,
    ),
  );

const BASE_FILE = "/tmp/sky-base.json";
const LEFTOVER_BASE_FILE = "/tmp/sky-base-profile.json";
// the profile step's script is opaque here; the base profile tests below run it in node and pin what it does
const baseApplyCall = (sprite: string) =>
  expect.stringMatching(
    new RegExp(
      `^exec ${sprite} /workspace/repo node -e [\\s\\S]+ /opt/sky ${BASE_FILE} ${LEFTOVER_BASE_FILE} &> /tmp/sky-base\\.log$`,
    ),
  );
const baseApplyCalls = (sprite: string) => [
  `write ${sprite} ${BASE_FILE}`,
  baseApplyCall(sprite),
  `exec ${sprite} - rm -f ${BASE_FILE} ${LEFTOVER_BASE_FILE}`,
];

/**
 * Runs the setup in a real local shell, as a sprite would: HOME is `home`, and node's bin holds
 * `corepack` (a script standing in for it) but no pnpm. Git, rm and the runner SDK's install stay stubbed.
 */
function runSetupLocally(home: string, corepack: string) {
  const nodeBin = join(home, "node-bin");
  mkdirSync(nodeBin);
  writeFileSync(join(nodeBin, "corepack"), corepack, { mode: 0o755 });
  wire.exec = (argv) => {
    if (!isSetup(argv)) return { exitCode: 0 };
    const out = spawnSync(argv[0] ?? "", argv.slice(1), {
      cwd: home,
      env: { HOME: home, PATH: `${nodeBin}:/usr/bin:/bin` },
      encoding: "utf8",
      timeout: 10_000,
    });
    return {
      exitCode: out.status ?? 1,
      stdout: out.stdout,
      stderr: out.stderr,
    };
  };
}

// `enable --install-directory <dir>` writes shims that log which path ran them, so a host pnpm can't pass
const COREPACK_STAND_IN = `#!/bin/sh
[ "$1 $2" = "enable --install-directory" ] || exit 1
for pm in pnpm yarn; do printf '#!/bin/sh\\necho "$0 $*" >>"$HOME/shim-runs"\\n' >"$3/$pm"; chmod +x "$3/$pm"; done
`;

test("POST returns 202 provisioning, then the sprite is created, cloned, set up and checkpointed", async () => {
  const res = await post(kru);
  expect(res.status).toBe(202);
  const created = (await res.json()) as { id: string };
  expect(created).toEqual({
    id: expect.stringMatching(/^env_[0-9A-Za-z]+$/),
    ...kru,
    base: null,
    status: "provisioning",
    spriteName: spriteNameFor(created.id),
    checkpointId: null,
    concurrency: 3,
    approvalPolicy: [],
    autoApprove: { defaults: true, commands: [] },
    failure: null,
    createdAt: expect.stringMatching(
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/,
    ),
  });
  expect(res.headers.get("location")).toBe(`/v1/environments/${created.id}`);

  expect(await settled(created.id)).toMatchObject({
    status: "ready",
    checkpointId: "v1",
    failure: null,
  });
  const sprite = spriteNameFor(created.id);
  expect(wire.calls).toEqual([
    `get ${sprite}`,
    `create ${sprite}`,
    `label ${sprite}`,
    `exec ${sprite} - sh -c ${installRunnerSdk} &> /tmp/sky-sdk.log`,
    `exec ${sprite} - rm -rf /workspace/repo /workspace/worktrees`,
    `exec ${sprite} - git clone https://github.com/acme/kru.git /workspace/repo &> /tmp/sky-clone.log`,
    ...baseApplyCalls(sprite),
    setupCall(sprite, "pnpm install"),
    pluginsCall(sprite),
    `exec ${sprite} - ${ENV_FILES_RM}`,
    `checkpoint ${sprite}`,
  ]);
});

const labelLines = (logged: string[]) =>
  logged.filter((line) => / label: (failed|timed out)/.test(line));

test("a new sprite is labeled with its env, repo and base role by a PUT carrying only the labels, its url settings untouched", async () => {
  const logged: string[] = [];
  app = createApp({
    db,
    config: testConfig(),
    sprites: new SpritesClient(spritesToken),
    log: (line) => logged.push(line),
    nudgeDeliveries: () => {},
  });
  const { id } = (await (await post(kru)).json()) as { id: string };
  expect(await settled(id)).toMatchObject({ status: "ready", failure: null });
  const sprite = spriteNameFor(id);
  expect(wire.updates.get(sprite)).toEqual({
    labels: ["sky", `env:${id}`, "repo:acme/kru", "role:base"],
  });
  expect(wire.stored.get(sprite)?.url_settings).toEqual({ auth: "sprite" });
  expect(labelLines(logged)).toEqual([]);
});

test("a label call that fails is attempted, logged once with the sprite and cause, and provisioning still succeeds", async () => {
  const logged: string[] = [];
  app = createApp({
    db,
    config: testConfig(),
    sprites: new SpritesClient(spritesToken),
    log: (line) => logged.push(line),
    nudgeDeliveries: () => {},
  });
  wire.updateStatus = 500;
  const { id } = (await (await post(kru)).json()) as { id: string };
  const sprite = spriteNameFor(id);
  expect(await settled(id)).toMatchObject({
    status: "ready",
    checkpointId: "v1",
    failure: null,
  });
  expect(wire.calls).toContain(`label ${sprite}`);
  expect(wire.updates.size).toBe(0);
  expect(labelLines(logged)).toEqual([
    expect.stringMatching(
      new RegExp(`^sprite ${sprite} label: failed in \\d+ms: .+`),
    ),
  ]);
});

test("a label call that hangs is cut at the Sprites bound, logged once, and provisioning goes on", {
  timeout: 10_000,
}, async () => {
  const logged: string[] = [];
  // only label calls hang, and the bound leaves every other call ample room on a slow runner
  app = createApp({
    db,
    config: testConfig(),
    sprites: new SpritesClient(spritesToken),
    spritesTimeoutMs: 1_500,
    log: (line) => logged.push(line),
    nudgeDeliveries: () => {},
  });
  wire.hangs = (call) => call.startsWith("label ");
  // the SDK's update takes no signal, so the hung PUT outlives the bound; the finally keeps it inside this test
  wire.hangMs = 2_000;
  try {
    const { id } = (await (await post(kru)).json()) as { id: string };
    const sprite = spriteNameFor(id);
    expect(await settled(id, 4_000)).toMatchObject({
      status: "ready",
      failure: null,
    });
    expect(wire.calls).toContain(`label ${sprite}`);
    expect(labelLines(logged)).toEqual([
      `sprite ${sprite} label: timed out after 1500ms`,
    ]);
  } finally {
    await wire.hangsSettled();
  }
});

test("an existing sprite is relabeled when the repo changes, its url settings kept", async () => {
  const id = await ready();
  const sprite = spriteNameFor(id);
  expect(wire.stored.get(sprite)?.labels).toContain("repo:acme/kru");
  // set outside sky after the first provision; a relabel must not reset it
  wire.stored.set(sprite, {
    labels: wire.stored.get(sprite)?.labels ?? [],
    url_settings: { auth: "public" },
  });
  expect((await patch(id, { repo: "acme/other" })).status).toBe(202);
  await settled(id);
  expect(wire.updates.get(sprite)).toEqual({
    labels: ["sky", `env:${id}`, "repo:acme/other", "role:base"],
  });
  expect(wire.stored.get(sprite)).toEqual({
    labels: ["sky", `env:${id}`, "repo:acme/other", "role:base"],
    url_settings: { auth: "public" },
  });
});

test("a label that failed on first provision lands when the env is retried", async () => {
  wire.updateStatus = 500;
  const { id } = (await (await post(kru)).json()) as { id: string };
  await settled(id);
  const sprite = spriteNameFor(id);
  expect(wire.stored.get(sprite)?.labels).toEqual([]);
  wire.updateStatus = 200;
  expect(
    (await patch(id, { setup: "pnpm install --frozen-lockfile" })).status,
  ).toBe(202);
  expect(await settled(id)).toMatchObject({ status: "ready", failure: null });
  expect(wire.stored.get(sprite)).toEqual({
    labels: ["sky", `env:${id}`, "repo:acme/kru", "role:base"],
    url_settings: { auth: "sprite" },
  });
});

test("the setup script finds pnpm though the sprite ships only node, and a rerun finds it too", async () => {
  const home = mkdtempSync(join(tmpdir(), "sky-home-"));
  runSetupLocally(home, COREPACK_STAND_IN);
  try {
    const { id } = (await (await post(kru)).json()) as { id: string };
    expect(await settled(id)).toMatchObject({ status: "ready", failure: null });
    expect(
      (await patch(id, { setup: "pnpm install --frozen-lockfile" })).status,
    ).toBe(202);
    expect(await settled(id)).toMatchObject({ status: "ready", failure: null });
    expect(readFileSync(join(home, "shim-runs"), "utf8")).toBe(
      `${home}/.local/bin/pnpm install\n${home}/.local/bin/pnpm install --frozen-lockfile\n`,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a corepack that can't enable its shims ends failed at the setup step with its stderr, and the setup never runs", async () => {
  const home = mkdtempSync(join(tmpdir(), "sky-home-"));
  runSetupLocally(
    home,
    '#!/bin/sh\necho "Internal Error: EACCES" >&2\nexit 1\n',
  );
  try {
    const { id } = (await (await post(kru)).json()) as { id: string };
    expect(await settled(id)).toMatchObject({
      status: "failed",
      failure: { step: "setup", stderr: "Internal Error: EACCES\n" },
    });
    expect(existsSync(join(home, "shim-runs"))).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

const isPluginInstall = (argv: string[]) =>
  argv[0] === "node" && argv[1] === "-e" && !argv.includes(BASE_FILE);

// logs its argv; `marketplace add` makes a marketplace known under its source's last path segment,
// and `marketplace list --json` prints the known ones
const CLAUDE_STAND_IN = `#!/bin/sh
echo "$*" >>"$HOME/claude-runs"
if [ "$1 $2 $3" = "plugin marketplace add" ]; then n=\${4%%#*}; n=\${n##*/}; echo "\${n%.git}" >>"$HOME/known"; fi
if [ "$1 $2 $3" = "plugin marketplace list" ]; then
  printf '['; sep=
  [ -f "$HOME/known" ] && while read -r n; do printf '%s{"name":"%s"}' "$sep" "$n"; sep=,; done <"$HOME/known"
  echo ']'
fi
`;

/**
 * Runs the plugin step in a real local node, as a sprite would: the clone carries `settings`, and
 * the runner dir holds the SDK's bundled `claude` (by default {@link CLAUDE_STAND_IN}).
 */
function runPluginsLocally(home: string, settings: unknown, claude?: string) {
  const repo = join(home, "repo");
  mkdirSync(join(repo, ".claude"), { recursive: true });
  if (settings !== undefined) {
    writeFileSync(
      join(repo, ".claude", "settings.json"),
      JSON.stringify(settings),
    );
  }
  const runner = join(home, "runner");
  const sdkPlatform = join(
    runner,
    "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64",
  );
  mkdirSync(sdkPlatform, { recursive: true });
  writeFileSync(join(sdkPlatform, "claude"), claude ?? CLAUDE_STAND_IN, {
    mode: 0o755,
  });
  wire.exec = (argv) => {
    if (!isPluginInstall(argv)) return { exitCode: 0 };
    const out = spawnSync(
      process.execPath,
      argv.slice(1).map((a) => (a === "/opt/sky" ? runner : a)),
      {
        cwd: repo,
        env: { HOME: home, PATH: "/usr/bin:/bin" },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    return {
      exitCode: out.status ?? 1,
      stdout: out.stdout,
      stderr: out.stderr,
    };
  };
  return () => {
    const runs = join(home, "claude-runs");
    return existsSync(runs) ? readFileSync(runs, "utf8") : "";
  };
}

const kruSettings = {
  extraKnownMarketplaces: {
    kru: {
      source: {
        source: "github",
        repo: "ap-justin/kru",
        ref: "v2",
        sparsePaths: [".claude-plugin", "plugins"],
      },
    },
    tools: {
      source: {
        source: "git",
        url: "https://example.com/tools.git",
        ref: "main",
      },
    },
    // no enabled plugin comes from it, so its unsupported source is never checked
    unused: { source: { source: "npm", package: "@acme/marketplace" } },
  },
  enabledPlugins: {
    "kru@kru": true,
    "lint@tools": true,
    "off@kru": false,
  },
};

test("the plugins the clone's .claude/settings.json enables are installed for the user and brought to their marketplace's latest, after their marketplaces are added and refreshed", async () => {
  const home = mkdtempSync(join(tmpdir(), "sky-home-"));
  const claudeRuns = runPluginsLocally(home, kruSettings);
  try {
    const { id } = (await (await post(kru)).json()) as { id: string };
    expect(await settled(id)).toMatchObject({ status: "ready", failure: null });
    expect(claudeRuns()).toBe(
      [
        "plugin marketplace add ap-justin/kru#v2 --sparse .claude-plugin plugins",
        "plugin marketplace add https://example.com/tools.git#main",
        "plugin marketplace list --json",
        "plugin marketplace update",
        "plugin install kru@kru --scope user",
        "plugin install lint@tools --scope user",
        "plugin update kru@kru --scope user",
        "plugin update lint@tools --scope user",
        "",
      ].join("\n"),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test.each([
  ["no .claude/settings.json", undefined],
  ["settings that enable no plugin", { enabledPlugins: { "off@kru": false } }],
])("a clone with %s installs no plugin and ends ready", async (_, settings) => {
  const home = mkdtempSync(join(tmpdir(), "sky-home-"));
  const claudeRuns = runPluginsLocally(home, settings);
  try {
    const { id } = (await (await post(kru)).json()) as { id: string };
    expect(await settled(id)).toMatchObject({ status: "ready", failure: null });
    expect(claudeRuns()).toBe("");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a plugin that fails to install ends failed at the setup step with claude's output, and nothing is checkpointed", async () => {
  const home = mkdtempSync(join(tmpdir(), "sky-home-"));
  runPluginsLocally(
    home,
    kruSettings,
    CLAUDE_STAND_IN.replace(
      "\n",
      '\n[ "$2" = install ] && { echo "network unreachable" >&2; exit 1; }\n',
    ),
  );
  try {
    const { id } = (await (await post(kru)).json()) as { id: string };
    expect(await settled(id)).toMatchObject({
      status: "failed",
      failure: {
        step: "setup",
        stderr: expect.stringContaining("network unreachable"),
      },
    });
    expect(wire.calls.some((c) => c.startsWith("checkpoint"))).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a plugin whose marketplace is neither declared nor added by the setup ends failed at the setup step naming the marketplace, before any install", async () => {
  const home = mkdtempSync(join(tmpdir(), "sky-home-"));
  const claudeRuns = runPluginsLocally(home, {
    ...kruSettings,
    enabledPlugins: { ...kruSettings.enabledPlugins, "turso@turso": true },
  });
  try {
    const { id } = (await (await post(kru)).json()) as { id: string };
    expect(await settled(id)).toMatchObject({
      status: "failed",
      failure: {
        step: "setup",
        stderr: expect.stringContaining(
          'plugin "turso@turso" in .claude/settings.json: marketplace "turso" is not known; declare it in extraKnownMarketplaces, or add it in the setup with "$SKY_CLAUDE" plugin marketplace add <source>',
        ),
      },
    });
    expect(claudeRuns()).not.toContain("plugin install");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a setup can add a marketplace with $SKY_CLAUDE, the SDK's bundled claude, and the plugin step installs from it", async () => {
  const home = mkdtempSync(join(tmpdir(), "sky-home-"));
  const claudeRuns = runPluginsLocally(home, {
    enabledPlugins: { "turso@turso": true },
  });
  const installPlugins = wire.exec;
  const nodeBin = join(home, "node-bin");
  mkdirSync(nodeBin);
  writeFileSync(join(nodeBin, "corepack"), COREPACK_STAND_IN, { mode: 0o755 });
  // the setup runs in a real local shell, with the runner dir where the sprite's would be
  wire.exec = (argv) => {
    if (!isSetup(argv)) return installPlugins(argv);
    const out = spawnSync(
      argv[0] ?? "",
      argv.slice(1).map((a) => a.replaceAll("/opt/sky", join(home, "runner"))),
      {
        cwd: home,
        env: { HOME: home, PATH: `${nodeBin}:/usr/bin:/bin` },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    return {
      exitCode: out.status ?? 1,
      stdout: out.stdout,
      stderr: out.stderr,
    };
  };
  try {
    const { id } = (await (
      await post({
        ...kru,
        setup: '"$SKY_CLAUDE" plugin marketplace add acme/turso',
      })
    ).json()) as { id: string };
    expect(await settled(id)).toMatchObject({ status: "ready", failure: null });
    expect(claudeRuns()).toContain(
      [
        "plugin marketplace add acme/turso",
        "plugin marketplace list --json",
        "plugin marketplace update",
        "plugin install turso@turso --scope user",
        "",
      ].join("\n"),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test.each([
  "https://github.com/acme/tools",
  "git@git.example.com:acme/tools",
  "https://dev.azure.com/acme/_git/tools",
])(
  "a git marketplace at %s, which marketplace add clones without .git, is added as is",
  async (url) => {
    const home = mkdtempSync(join(tmpdir(), "sky-home-"));
    const claudeRuns = runPluginsLocally(home, {
      extraKnownMarketplaces: { tools: { source: { source: "git", url } } },
      enabledPlugins: { "lint@tools": true },
    });
    try {
      const { id } = (await (await post(kru)).json()) as { id: string };
      expect(await settled(id)).toMatchObject({
        status: "ready",
        failure: null,
      });
      expect(claudeRuns()).toContain(`plugin marketplace add ${url}\n`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test.each([
  [
    "an npm source",
    { source: { source: "npm", package: "@acme/tools" } },
    "unsupported source: npm",
  ],
  [
    "a git url that marketplace add would fetch as JSON",
    { source: { source: "git", url: "https://git.example.com/acme/tools" } },
    "isn't a url marketplace add clones",
  ],
  [
    "a url source with headers",
    {
      source: {
        source: "url",
        url: "https://example.com/marketplace.json",
        headers: { Authorization: "Bearer t" },
      },
    },
    "headers",
  ],
  [
    "a github source with a path",
    {
      source: {
        source: "github",
        repo: "acme/tools",
        path: "meta/marketplace.json",
      },
    },
    "path",
  ],
  ["no source", {}, "no source"],
])(
  "a used marketplace with %s ends failed at the setup step naming it, before claude runs",
  async (_, tools, reason) => {
    const home = mkdtempSync(join(tmpdir(), "sky-home-"));
    const claudeRuns = runPluginsLocally(home, {
      ...kruSettings,
      extraKnownMarketplaces: { ...kruSettings.extraKnownMarketplaces, tools },
    });
    try {
      const { id } = (await (await post(kru)).json()) as { id: string };
      expect(await settled(id)).toMatchObject({
        status: "failed",
        failure: {
          step: "setup",
          stderr: expect.stringMatching(
            new RegExp(
              `marketplace "tools" in \\.claude/settings\\.json: .*${reason}`,
            ),
          ),
        },
      });
      expect(claudeRuns()).toBe("");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

const ghToken = `ghp_${"a1B2".repeat(9)}`;

test.each([
  {
    step: "create",
    arrange: () => {
      wire.createStatus = 500;
    },
    stderr: expect.stringContaining("sprite quota exceeded"),
  },
  {
    step: "clone",
    arrange: () => {
      wire.exec = (argv) =>
        argv[0] === "git"
          ? {
              exitCode: 128,
              stderr: `fatal: could not read from https://${ghToken}@github.com\n`,
            }
          : { exitCode: 0 };
    },
    stderr: "fatal: could not read from https://[redacted]@github.com\n",
  },
  {
    step: "setup",
    arrange: () => {
      wire.exec = (argv) =>
        isSetup(argv)
          ? {
              exitCode: 1,
              stdout: "installing\n",
              stderr: "ERR_PNPM_NO_LOCKFILE\n",
            }
          : { exitCode: 0 };
    },
    stderr: "installing\nERR_PNPM_NO_LOCKFILE\n",
  },
  {
    step: "checkpoint",
    arrange: () => {
      wire.checkpointLines = [
        { type: "error", error: "Checkpoint failed: disk full", time: "t" },
      ];
    },
    stderr: "Checkpoint failed: disk full",
  },
])(
  "a failed $step step ends failed, naming the step with a redacted stderr tail",
  async ({ step, arrange, stderr }) => {
    arrange();
    const { id } = (await (await post(kru)).json()) as { id: string };
    expect(await settled(id)).toMatchObject({
      status: "failed",
      checkpointId: null,
      failure: { step, stderr },
    });
  },
);

test("a runner SDK install that fails ends failed at the setup step, before any clone", async () => {
  wire.exec = (argv) =>
    argv[0] === "sh"
      ? { exitCode: 1, stderr: "npm ERR! network\n" }
      : { exitCode: 0 };
  const { id } = (await (await post(kru)).json()) as { id: string };
  expect(await settled(id)).toMatchObject({
    status: "failed",
    failure: { step: "setup", stderr: "npm ERR! network\n" },
  });
  expect(wire.calls.some((c) => c.includes("bash -c"))).toBe(false);
  expect(wire.calls.some((c) => c.includes("git clone"))).toBe(false);
});

test("a plain clone that fails after the SDK install ends failed at the clone step", async () => {
  wire.exec = (argv) =>
    argv[0] === "git"
      ? { exitCode: 128, stderr: "fatal: repository not found\n" }
      : { exitCode: 0 };
  const { id } = (await (await post(kru)).json()) as { id: string };
  expect(await settled(id)).toMatchObject({
    status: "failed",
    failure: { step: "clone", stderr: "fatal: repository not found\n" },
  });
});

test("a clone that hangs past the long bound ends failed at the clone step with the timeout, and logs it", async () => {
  const logged: string[] = [];
  app = createApp({
    db,
    config: testConfig({ spritesLongTimeoutMs: 100 }),
    sprites: new SpritesClient(spritesToken),
    log: (line) => logged.push(line),
    nudgeDeliveries: () => {},
  });
  wire.hangs = (call) => call.includes("git clone");
  const { id } = (await (await post(kru)).json()) as { id: string };
  const sprite = spriteNameFor(id);
  expect(await settled(id)).toMatchObject({
    status: "failed",
    failure: {
      step: "clone",
      stderr: `sprite ${sprite}: clone timed out after 100 ms`,
    },
  });
  expect(logged).toContain(`sprite ${sprite} clone: timed out after 100ms`);
  expect(wire.calls.some((c) => c.startsWith(`checkpoint`))).toBe(false);
});

test("a setup that fails with no stderr names its exit code", async () => {
  wire.exec = (argv) => (isSetup(argv) ? { exitCode: 2 } : { exitCode: 0 });
  const { id } = (await (await post(kru)).json()) as { id: string };
  expect(await settled(id)).toMatchObject({
    failure: { step: "setup", stderr: "exited with code 2" },
  });
});

test("a setup whose large output arrives re-chunked still ends ready", async () => {
  wire.execChunkBytes = 1024;
  wire.exec = (argv) =>
    isSetup(argv)
      ? {
          exitCode: 0,
          stdout: "Progress: resolved 1, reused 1\n".repeat(20_000),
        }
      : { exitCode: 0 };
  const { id } = (await (await post(kru)).json()) as { id: string };
  expect(await settled(id)).toMatchObject({ status: "ready", failure: null });
});

test("a failed setup's tail is the last 4000 bytes of its stdout and stderr, however its output arrives", async () => {
  wire.execChunkBytes = 1024;
  wire.exec = (argv) =>
    isSetup(argv)
      ? {
          exitCode: 1,
          stdout: `${"Progress: resolved 1\n".repeat(20_000)}ERR_PNPM_NO_LOCKFILE\n`,
        }
      : { exitCode: 0 };
  const { id } = (await (await post(kru)).json()) as { id: string };
  const { failure } = (await settled(id)) as {
    failure: { step: string; stderr: string };
  };
  expect(failure.step).toBe("setup");
  expect(failure.stderr).toHaveLength(4000);
  expect(failure.stderr.endsWith("resolved 1\nERR_PNPM_NO_LOCKFILE\n")).toBe(
    true,
  );
});

test("a second POST with the same name gets 409 and never creates a second sprite", async () => {
  const first = (await (await post(kru)).json()) as { id: string };
  await settled(first.id);
  const res = await post({ ...kru, repo: "acme/other" });
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({
    error: { code: "name_taken", message: expect.any(String) },
  });
  expect(wire.calls.filter((c) => c.startsWith("create"))).toHaveLength(1);
});

test("POST without a bearer gets 401 and touches no sprite", async () => {
  const res = await app.request("/v1/environments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(kru),
  });
  expect(res.status).toBe(401);
  expect(wire.calls).toEqual([]);
});

test.each([
  [
    "a repo that isn't owner/name",
    { ...kru, repo: "acme/kru; rm -rf /" },
    400,
    "invalid_body",
  ],
  ["a missing setup", { name: "kru", repo: "acme/kru" }, 400, "invalid_body"],
  ["an unknown field", { ...kru, status: "ready" }, 400, "invalid_body"],
  [
    "a non-positive concurrency",
    { ...kru, concurrency: 0 },
    400,
    "invalid_body",
  ],
])(
  "POST with %s gets %i %s and creates nothing",
  async (_, payload, status, code) => {
    const res = await post(payload);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({
      error: { code, message: expect.any(String) },
    });
    expect(wire.calls).toEqual([]);
  },
);

test.each([
  ["no content type", auth, JSON.stringify(kru), 415, "unsupported_media_type"],
  [
    "a form content type",
    { ...auth, "Content-Type": "application/x-www-form-urlencoded" },
    "name=kru",
    415,
    "unsupported_media_type",
  ],
  ["malformed JSON", json, "{", 400, "invalid_json"],
])(
  "POST with %s gets an enveloped %i",
  async (_, headers, body, status, code) => {
    const res = await app.request("/v1/environments", {
      method: "POST",
      headers,
      body,
    });
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({
      error: { code, message: expect.any(String) },
    });
  },
);

test("GET lists environments oldest first; an unknown or malformed id is 404", async () => {
  const b = (await (await post({ ...kru, name: "b" })).json()) as {
    id: string;
  };
  const a = (await (await post({ ...kru, name: "a" })).json()) as {
    id: string;
  };
  await settled(a.id);
  await settled(b.id);
  // both can land in the same millisecond; pin the order the list must follow
  db.$client
    .prepare("update environments set created_at = ? where id = ?")
    .run("2026-01-02T00:00:00.000Z", a.id);
  db.$client
    .prepare("update environments set created_at = ? where id = ?")
    .run("2026-01-01T00:00:00.000Z", b.id);
  const res = await app.request("/v1/environments", { headers: auth });
  expect(res.status).toBe(200);
  const { data } = (await res.json()) as { data: { id: string }[] };
  expect(data.map((e) => e.id)).toEqual([b.id, a.id]);
  for (const id of ["env_doesNotExist", "not-an-id"]) {
    const missing = await get(id);
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({
      error: { code: "not_found", message: expect.any(String) },
    });
  }
});

test("GET breaks a same-millisecond tie by insert order, not id", async () => {
  const insert = db.$client.prepare(
    "insert into environments (id, name, repo, setup, status, sprite_name, created_at) values (?, ?, 'o/r', '', 'ready', ?, '2026-01-01T00:00:00.000Z')",
  );
  const first = `env_${"z".repeat(22)}`;
  const second = `env_${"A".repeat(22)}`;
  insert.run(first, "first", "sprite-first");
  insert.run(second, "second", "sprite-second");
  const res = await app.request("/v1/environments", { headers: auth });
  const { data } = (await res.json()) as { data: { id: string }[] };
  expect(data.map((e) => e.id)).toEqual([first, second]);
});

/** Inserts an agent on the env with one run in `status`. */
function seedRun(envId: string, status: "running" | "finished") {
  const agentId = `agt_${envId.slice(4)}`;
  db.$client
    .prepare(
      "insert into agents (id, env_id, branch, status) values (?, ?, ?, 'idle')",
    )
    .run(agentId, envId, `claude/${agentId}`);
  db.$client
    .prepare("insert into runs (id, agent_id, status) values (?, ?, ?)")
    .run(`run_${envId.slice(4)}`, agentId, status);
}

const patch = (id: string, body: unknown) =>
  app.request(`/v1/environments/${id}`, {
    method: "PATCH",
    headers: json,
    body: JSON.stringify(body),
  });

const ready = async (env = kru) => {
  const { id } = (await (await post(env)).json()) as { id: string };
  await settled(id);
  wire.calls.length = 0;
  return id;
};

test("PATCH of name, concurrency or policy updates in place with 200 and no sprite calls", async () => {
  const id = await ready({ ...kru, concurrency: 5 } as typeof kru);
  const res = await patch(id, { name: "kru2", approvalPolicy: ["Bash"] });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    name: "kru2",
    concurrency: 5,
    approvalPolicy: ["Bash"],
    status: "ready",
    checkpointId: "v1",
  });
  expect(wire.calls).toEqual([]);
});

test("POST stores a custom autoApprove, which GET returns", async () => {
  const autoApprove = { defaults: false, commands: ["make check"] };
  const res = await post({ ...kru, autoApprove });
  expect(res.status).toBe(202);
  const { id } = (await res.json()) as { id: string };
  expect(await settled(id)).toMatchObject({ status: "ready", autoApprove });
});

test("POST with an autoApprove command holding a shell operator gets 400 naming the command and creates nothing", async () => {
  const res = await post({ ...kru, autoApprove: { commands: ["ls; rm x"] } });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: {
      code: "invalid_body",
      message: expect.stringContaining("autoApprove.commands[0]"),
    },
  });
  const list = await app.request("/v1/environments", { headers: auth });
  expect(await list.json()).toEqual({ data: [] });
  expect(wire.calls).toEqual([]);
});

test("PATCH of autoApprove updates in place with 200, and a later GET returns it", async () => {
  const id = await ready();
  const autoApprove = { defaults: false, commands: ["make check"] };
  const res = await patch(id, { autoApprove });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ autoApprove });
  expect((await get(id)).body).toMatchObject({ autoApprove });
  expect(wire.calls).toEqual([]);
});

test.each([
  [
    "commands keeps the stored defaults",
    { commands: ["make check", "make lint"] },
    { defaults: false, commands: ["make check", "make lint"] },
  ],
  [
    "defaults keeps the stored commands",
    { defaults: true },
    { defaults: true, commands: ["make check"] },
  ],
])("PATCH of autoApprove with only %s", async (_, sent, stored) => {
  const id = await ready();
  await patch(id, {
    autoApprove: { defaults: false, commands: ["make check"] },
  });
  const res = await patch(id, { autoApprove: sent });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ autoApprove: stored });
  expect((await get(id)).body).toMatchObject({ autoApprove: stored });
});

test("PATCH with an autoApprove command holding a shell operator gets 400 naming the command and keeps the stored value", async () => {
  const id = await ready();
  const res = await patch(id, { autoApprove: { commands: ["ls; rm x"] } });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: {
      code: "invalid_body",
      message: expect.stringContaining("autoApprove.commands[0]"),
    },
  });
  expect((await get(id)).body).toMatchObject({
    autoApprove: { defaults: true, commands: [] },
  });
});

test("PATCH that changes setup reruns setup and replaces checkpointId", async () => {
  const id = await ready();
  const res = await patch(id, { setup: "pnpm install --frozen-lockfile" });
  expect(res.status).toBe(202);
  expect(await res.json()).toMatchObject({
    status: "provisioning",
    checkpointId: null,
  });
  expect(await settled(id)).toMatchObject({
    status: "ready",
    checkpointId: "v2",
  });
  const sprite = spriteNameFor(id);
  expect(wire.calls).toEqual([
    `get ${sprite}`,
    `label ${sprite}`,
    `exec ${sprite} - sh -c ${installRunnerSdk} &> /tmp/sky-sdk.log`,
    `exec ${sprite} - rm -rf /workspace/repo /workspace/worktrees`,
    `exec ${sprite} - git clone https://github.com/acme/kru.git /workspace/repo &> /tmp/sky-clone.log`,
    ...baseApplyCalls(sprite),
    setupCall(sprite, "pnpm install --frozen-lockfile"),
    pluginsCall(sprite),
    `exec ${sprite} - ${ENV_FILES_RM}`,
    `checkpoint ${sprite}`,
  ]);
});

const STORE_ENV_FILE = "/tmp/sky-store.env";
const REPO_ENV_FILE = "/tmp/sky-repo.env";
/** The removal of both env files that every provision runs before its checkpoint. */
const ENV_FILES_RM = `rm -f ${REPO_ENV_FILE} ${STORE_ENV_FILE}`;
/** The variables provisioning's store pull sources. */
const storeEnv = () => envFileOf(wire, { env: { ENV_FILE: STORE_ENV_FILE } });

type SecretInput = { value: string } | { connector: string };
const githubConnector = { GITHUB_CONNECTOR: { connector: "VPpb7x" } };

/**
 * Reprovisions a ready env holding `stored` as its secrets, on an API that has `bundle` as its
 * runner bundle to upload, or none when null; `beforePatch` runs once the secrets are stored.
 */
async function reprovisionWith(
  stored: Record<string, SecretInput>,
  bundle: string | null = "// runner",
  beforePatch = () => {},
  base: string | null = "team",
) {
  const id = await ready();
  const dir = mkdtempSync(join(tmpdir(), "sky-bundle-"));
  const runnerBundlePath = join(dir, "runner.mjs");
  if (bundle !== null) writeFileSync(runnerBundlePath, bundle);
  const logged: string[] = [];
  app = createApp({
    db,
    config: testConfig({ runnerBundlePath, baseProfiles: profiles }),
    sprites: new SpritesClient(spritesToken),
    log: (line) => logged.push(line),
    nudgeDeliveries: () => {},
  });
  for (const [name, input] of Object.entries(stored)) {
    const put = await app.request(`/v1/environments/${id}/secrets/${name}`, {
      method: "PUT",
      headers: json,
      body: JSON.stringify(input),
    });
    expect(put.status).toBe(200);
  }
  beforePatch();
  wire.calls.length = 0;
  const res = await patch(id, {
    setup: "pnpm install --frozen-lockfile",
    ...(base === null ? {} : { base }),
  });
  expect(res.status).toBe(202);
  const env = await settled(id);
  rmSync(dir, { recursive: true, force: true });
  return { id, env, logged };
}

test("with a connector, provisioning checks the profile's store out through the runner before the checkpoint, then runs the store's own setup", async () => {
  const { id, env } = await reprovisionWith(githubConnector);
  expect(env).toMatchObject({ status: "ready", failure: null });
  const sprite = spriteNameFor(id);
  expect(wire.calls).toEqual([
    `get ${sprite}`,
    `label ${sprite}`,
    // the runner loads the SDK at startup, so a fresh sprite's repo-pull needs it installed first
    `exec ${sprite} - sh -c ${installRunnerSdk} &> /tmp/sky-sdk.log`,
    `exec ${sprite} - rm -rf /workspace/repo /workspace/worktrees`,
    `exec ${sprite} - sha256sum /opt/sky/runner.mjs`,
    `write ${sprite} /opt/sky/runner.mjs.provision-${id}`,
    `exec ${sprite} - mv -f /opt/sky/runner.mjs.provision-${id} /opt/sky/runner.mjs`,
    `write ${sprite} ${REPO_ENV_FILE}`,
    expect.stringMatching(
      new RegExp(
        `^exec ${sprite} - sh -c .*node /opt/sky/runner\\.mjs repo-pull "\\$2" "\\$3" sh ${REPO_ENV_FILE} acme/kru /workspace/repo &> /tmp/sky-clone\\.log$`,
      ),
    ),
    `exec ${sprite} - rm -f ${REPO_ENV_FILE}`,
    ...baseApplyCalls(sprite),
    setupCall(sprite, "pnpm install --frozen-lockfile"),
    pluginsCall(sprite),
    `exec ${sprite} - sha256sum /opt/sky/runner.mjs`,
    `write ${sprite} ${STORE_ENV_FILE}`,
    expect.stringMatching(
      new RegExp(
        `^exec ${sprite} - sh -c .*node /opt/sky/runner\\.mjs store-sync pull sh ${STORE_ENV_FILE} &> /tmp/sky-store\\.log$`,
      ),
    ),
    expect.stringMatching(
      new RegExp(
        `^exec ${sprite} - bash -c .*setup\\.sh.* bash ${STORE_ENV_FILE} &> /tmp/sky-store-setup\\.log$`,
      ),
    ),
    `exec ${sprite} - rm -f ${STORE_ENV_FILE}`,
    `exec ${sprite} - ${ENV_FILES_RM}`,
    `checkpoint ${sprite}`,
  ]);
  // like a run's, the pull's env rides in a file only the sprite user reads, never in the exec URL
  expect(wire.modes.get(STORE_ENV_FILE)).toBe("0600");
  expect(storeEnv()).toEqual({
    GITHUB_CONNECTOR: "VPpb7x",
    SKY_STORE_REPO: "acme/store",
    SKY_STORE_HOME: ".store",
    SKY_STORE_LAYOUT: JSON.stringify(team.storeLayout),
  });
  expect(wire.execUrls.join("\n")).not.toContain("VPpb7x");
  // the repo pull's env is only the connector (the runner defaults the gateway), in a 0600 file
  expect(wire.modes.get(REPO_ENV_FILE)).toBe("0600");
  expect(envFileOf(wire, { env: { ENV_FILE: REPO_ENV_FILE } })).toEqual({
    GITHUB_CONNECTOR: "VPpb7x",
  });
  expect(wire.calls.some((c) => c.includes("git clone"))).toBe(false);
});

test("with a connector, the repo is pulled through the runner with only the connector and gateway env, and an unrelated secret that won't decrypt doesn't fail it", async () => {
  const { env } = await reprovisionWith(
    {
      ...githubConnector,
      GITHUB_GATEWAY_URL: { value: "https://gw.example/github" },
      TOKEN: { value: "t0ken" },
    },
    "// runner",
    () => {
      db.$client
        .prepare(
          "UPDATE secrets SET ciphertext = zeroblob(16) WHERE name = 'TOKEN'",
        )
        .run();
    },
  );
  expect(env).toMatchObject({ status: "ready", failure: null });
  // the store step still reads every secret, fails on that one and only logs it
  expect(envFileOf(wire, { env: { ENV_FILE: REPO_ENV_FILE } })).toEqual({
    GITHUB_CONNECTOR: "VPpb7x",
    GITHUB_GATEWAY_URL: "https://gw.example/github",
  });
});

test("a failed repo pull ends failed at the clone step with the runner's output, and the env file is removed", async () => {
  const { id, env } = await reprovisionWith(
    githubConnector,
    "// runner",
    () => {
      wire.exec = (argv) =>
        argv.join(" ").includes("repo-pull")
          ? { exitCode: 1, stderr: "repo pull: failed: 404 Not Found" }
          : { exitCode: 0 };
    },
  );
  expect(env).toMatchObject({
    status: "failed",
    failure: {
      step: "clone",
      stderr: expect.stringContaining("repo pull: failed: 404 Not Found"),
    },
  });
  expect(wire.calls).toContain(
    `exec ${spriteNameFor(id)} - rm -f ${REPO_ENV_FILE}`,
  );
});

test("a repo env file write that fails ends failed at the clone step, runs no pull, and still removes the file", async () => {
  const { id, env } = await reprovisionWith(
    githubConnector,
    "// runner",
    () => {
      // the bundle's upload lands; the env file's write after it fails
      wire.exec = (argv) => {
        if (argv[0] === "mv") wire.writeStatus = 500;
        return { exitCode: 0 };
      };
    },
  );
  expect(env).toMatchObject({ status: "failed", failure: { step: "clone" } });
  const sprite = spriteNameFor(id);
  expect(wire.calls.some((c) => c.includes("repo-pull"))).toBe(false);
  expect(wire.calls).toContain(`exec ${sprite} - rm -f ${REPO_ENV_FILE}`);
});

test("a repo env file that won't remove after a failed pull keeps the pull's failure and logs the file it left", async () => {
  const { env, logged } = await reprovisionWith(
    githubConnector,
    "// runner",
    () => {
      wire.exec = (argv) => {
        if (argv.join(" ").includes("repo-pull")) {
          return { exitCode: 1, stderr: "repo pull: failed: 404 Not Found" };
        }
        if (argv[0] === "rm" && argv[2] === REPO_ENV_FILE) {
          return { exitCode: 1, stderr: "rm: VPpb7x Read-only file system" };
        }
        return { exitCode: 0 };
      };
    },
  );
  expect(env).toMatchObject({
    status: "failed",
    failure: {
      step: "clone",
      stderr: expect.stringContaining("repo pull: failed: 404 Not Found"),
    },
  });
  expect(logged.join("\n")).toContain(REPO_ENV_FILE);
  expect(logged.join("\n")).toContain("Read-only file system");
  expect(logged.join("\n")).not.toContain("VPpb7x");
});

test("a repo env file that won't remove after a pull ends failed at the clone step naming the file, with nothing checkpointed", async () => {
  const { env } = await reprovisionWith(githubConnector, "// runner", () => {
    wire.exec = (argv) =>
      argv[0] === "rm" && argv[2] === REPO_ENV_FILE
        ? { exitCode: 1, stderr: "rm: Read-only file system" }
        : { exitCode: 0 };
  });
  expect(env).toMatchObject({
    status: "failed",
    failure: {
      step: "clone",
      stderr: expect.stringContaining(REPO_ENV_FILE),
    },
  });
  expect(wire.calls.some((c) => c.startsWith("checkpoint"))).toBe(false);
});

test("with a connector but no runner bundle to upload, the clone step fails naming the bundle, writing no env file and running no pull", async () => {
  const { env } = await reprovisionWith(githubConnector, null);
  expect(env).toMatchObject({
    status: "failed",
    failure: { step: "clone", stderr: expect.stringContaining("runner.mjs") },
  });
  expect(wire.calls.some((c) => c.includes(REPO_ENV_FILE))).toBe(false);
  expect(wire.calls.some((c) => c.includes("repo-pull"))).toBe(false);
  expect(wire.calls.some((c) => c.includes("git clone"))).toBe(false);
});

const failedPullEchoing = (gateway: string) =>
  reprovisionWith(
    { ...githubConnector, GITHUB_GATEWAY_URL: { value: gateway } },
    "// runner",
    () => {
      wire.exec = (argv) =>
        argv.join(" ").includes("repo-pull")
          ? {
              exitCode: 1,
              stderr: `repo pull: failed: GET ${gateway}/VPpb7x/repos/acme/kru returned 502`,
            }
          : argv[0] === "rm" && argv[2] === REPO_ENV_FILE
            ? { exitCode: 1, stderr: `rm: ${gateway} VPpb7x busy` }
            : { exitCode: 0 };
    },
  );

test("a failed repo pull whose output carries the gateway URL and connector id stores neither, and the log of a file left behind scrubs the gateway URL and connector id", async () => {
  const gateway = "https://gw.example/github";
  const { env, logged } = await failedPullEchoing(gateway);
  expect(env).toMatchObject({
    status: "failed",
    failure: { step: "clone", stderr: expect.stringContaining("returned 502") },
  });
  const logs = logged.join("\n");
  expect(logs).toContain("kept");
  expect(JSON.stringify(env)).not.toContain(gateway);
  expect(JSON.stringify(env)).not.toContain("VPpb7x");
  expect(logs).not.toContain(gateway);
  expect(logs).not.toContain("VPpb7x");
});

test("provisioning's store steps see the env's own gateway and the profile's store home, as a run does", async () => {
  const local = mkdtempSync(join(tmpdir(), "sky-store-"));
  const storeHome = join(local, ".store");
  mkdirSync(storeHome);
  writeFileSync(join(storeHome, "setup.sh"), 'touch "$(dirname "$0")/ran"\n');
  // the store's setup runs in a real shell, under a HOME that holds the profile's store home; the pull stays stubbed
  wire.exec = (argv) => {
    if (argv[0] !== "bash" || !argv[2]?.includes("setup.sh")) {
      return { exitCode: 0 };
    }
    const envPath = join(local, "store.env");
    writeFileSync(envPath, wire.files.get(argv[4] ?? "") ?? "");
    const out = spawnSync("bash", [...argv.slice(1, 4), envPath], {
      env: { HOME: local, PATH: "/usr/bin:/bin" },
      encoding: "utf8",
      timeout: 10_000,
    });
    return { exitCode: out.status ?? 1, stderr: out.stderr };
  };
  const { env } = await reprovisionWith({
    ...githubConnector,
    GITHUB_GATEWAY_URL: { value: "https://gw.example/github" },
  });
  expect(env).toMatchObject({ status: "ready", failure: null });
  expect(storeEnv()).toEqual({
    GITHUB_CONNECTOR: "VPpb7x",
    GITHUB_GATEWAY_URL: "https://gw.example/github",
    SKY_STORE_REPO: "acme/store",
    SKY_STORE_HOME: ".store",
    SKY_STORE_LAYOUT: JSON.stringify(team.storeLayout),
  });
  expect(existsSync(join(storeHome, "ran"))).toBe(true);
  rmSync(local, { recursive: true, force: true });
});

test.each(["SKY_NO_STORE_SYNC", "KRU_NO_STORE_SYNC"])(
  "an env that stores %s, which turns a run's sync off, gets no store pull or store setup",
  async (name) => {
    const { id, env } = await reprovisionWith({
      ...githubConnector,
      [name]: { value: "1" },
    });
    expect(env).toMatchObject({ status: "ready", failure: null });
    const sprite = spriteNameFor(id);
    expect(wire.calls.at(-3)).toEqual(pluginsCall(sprite));
    expect(wire.calls.at(-2)).toBe(`exec ${sprite} - ${ENV_FILES_RM}`);
    expect(wire.calls.at(-1)).toBe(`checkpoint ${sprite}`);
  },
);

test("a GITHUB_CONNECTOR stored as a value, not a connector, triggers no store pull", async () => {
  const { id, env } = await reprovisionWith({
    GITHUB_CONNECTOR: { value: "ghp_pasted-token" },
  });
  expect(env).toMatchObject({ status: "ready", failure: null });
  const sprite = spriteNameFor(id);
  expect(wire.calls.at(-3)).toEqual(pluginsCall(sprite));
  expect(wire.calls.at(-2)).toBe(`exec ${sprite} - ${ENV_FILES_RM}`);
  expect(wire.calls.at(-1)).toBe(`checkpoint ${sprite}`);
});

test("a store checkout that fails is logged without the connector id and never fails provisioning", async () => {
  const id = await ready();
  wire.exec = (argv) =>
    argv.some((arg) => arg.includes("store-sync pull"))
      ? {
          exitCode: 1,
          stderr: "store sync: pull failed: GitHub gateway: 502 VPpb7x",
        }
      : { exitCode: 0 };
  const dir = mkdtempSync(join(tmpdir(), "sky-bundle-"));
  writeFileSync(join(dir, "runner.mjs"), "// runner");
  const logged: string[] = [];
  app = createApp({
    db,
    config: testConfig({
      runnerBundlePath: join(dir, "runner.mjs"),
      baseProfiles: profiles,
    }),
    sprites: new SpritesClient(spritesToken),
    log: (line) => logged.push(line),
    nudgeDeliveries: () => {},
  });
  await app.request(`/v1/environments/${id}/secrets/GITHUB_CONNECTOR`, {
    method: "PUT",
    headers: json,
    body: JSON.stringify({ connector: "VPpb7x" }),
  });
  await patch(id, { setup: "pnpm install --frozen-lockfile", base: "team" });
  expect(await settled(id)).toMatchObject({ status: "ready", failure: null });
  rmSync(dir, { recursive: true, force: true });
  expect(logged.join("\n")).toContain("checking out the store");
  expect(logged.join("\n")).toContain("pull failed");
  expect(logged.join("\n")).not.toContain("VPpb7x");
});

test("env secrets that fail to decrypt for the store step are logged and never fail provisioning", async () => {
  const { env, logged } = await reprovisionWith(
    { ...githubConnector, TOKEN: { value: "t0ken" } },
    "// runner",
    () => {
      db.$client
        .prepare(
          "UPDATE secrets SET ciphertext = zeroblob(16) WHERE name = 'TOKEN'",
        )
        .run();
    },
  );
  expect(env).toMatchObject({ status: "ready", failure: null });
  expect(logged.join("\n")).toContain("checking out the store");
});

test("a store setup.sh that fails is logged and still leaves provisioning ready, with the env file removed", async () => {
  const { id, env, logged } = await reprovisionWith(
    githubConnector,
    "// runner",
    () => {
      wire.exec = (argv) =>
        argv[0] === "bash" && argv[2]?.includes("setup.sh")
          ? { exitCode: 3, stderr: "setup.sh: npm exploded" }
          : { exitCode: 0 };
    },
  );
  expect(env).toMatchObject({ status: "ready", failure: null });
  expect(logged.join("\n")).toContain("checking out the store");
  expect(logged.join("\n")).toContain("npm exploded");
  const sprite = spriteNameFor(id);
  expect(wire.calls.at(-3)).toBe(`exec ${sprite} - rm -f ${STORE_ENV_FILE}`);
  expect(wire.calls.at(-2)).toBe(`exec ${sprite} - ${ENV_FILES_RM}`);
  expect(wire.calls.at(-1)).toBe(`checkpoint ${sprite}`);
});

test("both env files are removed right before the checkpoint, so it never keeps one left behind", async () => {
  const { id, env } = await reprovisionWith(githubConnector);
  expect(env).toMatchObject({ status: "ready", failure: null });
  const sprite = spriteNameFor(id);
  expect(wire.calls.slice(-2)).toEqual([
    `exec ${sprite} - ${ENV_FILES_RM}`,
    `checkpoint ${sprite}`,
  ]);
});

test("env files that won't remove before the checkpoint end failed at the checkpoint step naming them, with nothing checkpointed and no secret stored", async () => {
  // a secret only the store's env file carries
  const token = "store-only-t0ken";
  const { env } = await reprovisionWith(
    { ...githubConnector, TOKEN: { value: token } },
    "// runner",
    () => {
      wire.exec = (argv) =>
        argv.join(" ") === ENV_FILES_RM
          ? { exitCode: 1, stderr: `rm: Read-only file system ${token}` }
          : { exitCode: 0 };
    },
  );
  expect(env).toMatchObject({
    status: "failed",
    failure: {
      step: "checkpoint",
      stderr: expect.stringContaining(
        `could not remove ${REPO_ENV_FILE} ${STORE_ENV_FILE}: rm: Read-only file system`,
      ),
    },
  });
  expect(JSON.stringify(env)).not.toContain(token);
  expect(wire.calls.some((c) => c.startsWith("checkpoint"))).toBe(false);
});

test("a removal before the checkpoint that errors ends failed at the checkpoint step naming the env files, with nothing checkpointed", async () => {
  const { env } = await reprovisionWith(githubConnector, "// runner", () => {
    server.use(
      http.post(
        "https://api.sprites.dev/v1/sprites/:name/exec",
        ({ request }) => {
          const argv = new URL(request.url).searchParams.getAll("cmd");
          if (argv.join(" ") !== ENV_FILES_RM) return;
          return HttpResponse.json({ error: "upstream down" }, { status: 500 });
        },
      ),
    );
  });
  expect(env).toMatchObject({
    status: "failed",
    failure: {
      step: "checkpoint",
      stderr: expect.stringContaining(
        `could not remove ${REPO_ENV_FILE} ${STORE_ENV_FILE}:`,
      ),
    },
  });
  expect(wire.calls.some((c) => c.startsWith("checkpoint"))).toBe(false);
});

test("PATCH that changes repo re-clones from the new remote", async () => {
  const id = await ready();
  expect((await patch(id, { repo: "acme/kru-next" })).status).toBe(202);
  expect(await settled(id)).toMatchObject({
    status: "ready",
    repo: "acme/kru-next",
  });
  expect(wire.calls).toContain(
    `exec ${spriteNameFor(id)} - git clone https://github.com/acme/kru-next.git /workspace/repo &> /tmp/sky-clone.log`,
  );
});

test("PATCH that resends the current repo and setup is an in-place 200", async () => {
  const id = await ready();
  expect((await patch(id, { repo: kru.repo, setup: kru.setup })).status).toBe(
    200,
  );
  expect(wire.calls).toEqual([]);
});

test("PATCH after a failed create recreates the sprite before cloning", async () => {
  wire.createStatus = 500;
  const { id } = (await (await post(kru)).json()) as { id: string };
  await settled(id);
  wire.createStatus = 201;
  expect((await patch(id, { setup: "true" })).status).toBe(202);
  expect(await settled(id)).toMatchObject({ status: "ready", failure: null });
  expect(wire.calls.filter((c) => c.startsWith("create"))).toHaveLength(2);
});

test("PATCH is 409 while a run is active, and a finished run doesn't block it", async () => {
  const id = await ready();
  seedRun(id, "running");
  const res = await patch(id, { concurrency: 4 });
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({
    error: { code: "run_active", message: expect.any(String) },
  });

  const other = await ready({ ...kru, name: "other" });
  seedRun(other, "finished");
  expect((await patch(other, { concurrency: 4 })).status).toBe(200);
});

test("PATCH of repo or setup is 409 agents_exist while an agent is unarchived, and proceeds once all are archived", async () => {
  const id = await ready();
  seedRun(id, "finished");
  const agentId = `agt_${id.slice(4)}`;
  for (const change of [{ setup: "make" }, { repo: "acme/kru-next" }]) {
    const res = await patch(id, change);
    expect(res.status).toBe(409);
    const { error } = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(error.code).toBe("agents_exist");
    expect(error.message).toContain(agentId);
    expect(error.message).toMatch(/archive/);
  }
  expect((await patch(id, { concurrency: 4 })).status).toBe(200);
  expect(wire.calls).toEqual([]);

  db.$client
    .prepare("update agents set archived_at = ? where id = ?")
    .run("2026-10-29T12:00:00.000Z", agentId);
  expect((await patch(id, { setup: "make" })).status).toBe(202);
  expect(await settled(id)).toMatchObject({ status: "ready", setup: "make" });
});

test("PATCH of repo or setup is 409 while provisioning; a rename is not", async () => {
  const { id } = (await (await post(kru)).json()) as { id: string };
  const res = await patch(id, { setup: "make" });
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({
    error: { code: "provisioning", message: expect.any(String) },
  });
  expect((await patch(id, { name: "renamed" })).status).toBe(200);
  expect(await settled(id)).toMatchObject({ name: "renamed", status: "ready" });
});

test("PATCH to a taken name is 409; an empty PATCH changes nothing", async () => {
  await ready({ ...kru, name: "taken" });
  const id = await ready();
  expect((await patch(id, { name: "taken" })).status).toBe(409);
  const res = await patch(id, {});
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    name: "kru",
    concurrency: 3,
    approvalPolicy: [],
    autoApprove: { defaults: true, commands: [] },
  });
});

const del = (id: string) =>
  app.request(`/v1/environments/${id}`, { method: "DELETE", headers: auth });

test("DELETE destroys the sprite, then the row and its agents' history", async () => {
  const id = await ready();
  seedRun(id, "finished");
  const res = await del(id);
  expect(res.status).toBe(204);
  expect(wire.calls).toEqual([`delete ${spriteNameFor(id)}`]);
  expect(wire.sprites.size).toBe(0);
  expect((await get(id)).status).toBe(404);
  expect(db.$client.prepare("select count(*) as n from agents").get()).toEqual({
    n: 0,
  });
});

test("DELETE removes the env's webhook deliveries and run requests with its runs", async () => {
  const id = await ready();
  seedRun(id, "finished");
  const runId = `run_${id.slice(4)}`;
  const sql = (statement: string, ...params: unknown[]) =>
    db.$client.prepare(statement).run(...params);
  const eventId = sql(
    "insert into events (run_id, ts, type, payload) values (?, '2026-10-29T12:00:00.000Z', 'run.finished', '{}')",
    runId,
  ).lastInsertRowid;
  sql(
    "insert into webhooks (id, url, event_types) values ('wh_1', 'https://x', '[\"run.finished\"]')",
  );
  sql(
    "insert into webhook_deliveries (webhook_id, event_id, status, next_attempt_at) values ('wh_1', ?, 'pending', '2026-10-29T12:00:00.000Z')",
    eventId,
  );
  sql(
    "insert into run_requests (id, run_id, kind, request) values ('req_1', ?, 'question', ?)",
    runId,
    JSON.stringify({ kind: "question", requestId: "req_1", prompt: "which?" }),
  );
  expect((await del(id)).status).toBe(204);
  const count = (table: string) =>
    db.$client.prepare(`select count(*) as n from ${table}`).get();
  for (const table of [
    "environments",
    "agents",
    "runs",
    "events",
    "webhook_deliveries",
    "run_requests",
  ]) {
    expect(count(table), table).toEqual({ n: 0 });
  }
  expect(count("webhooks")).toEqual({ n: 1 });
});

test("DELETE whose row delete fails after the sprite is gone leaves the env failed, and a retry removes it", async () => {
  const id = await ready();
  db.$client.exec(
    "create trigger refuse before delete on environments begin select raise(abort, 'refused'); end",
  );
  expect((await del(id)).status).toBe(500);
  expect(wire.sprites.size).toBe(0);
  expect((await get(id)).body).toMatchObject({ status: "failed" });
  db.$client.exec("drop trigger refuse");
  expect((await del(id)).status).toBe(204);
  expect((await get(id)).status).toBe(404);
});

test("DELETE is 409 while a run is active and while provisioning, and keeps the sprite", async () => {
  const id = await ready();
  seedRun(id, "running");
  expect((await del(id)).status).toBe(409);
  const { id: fresh } = (await (
    await post({ ...kru, name: "fresh" })
  ).json()) as { id: string };
  const res = await del(fresh);
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({
    error: { code: "provisioning", message: expect.any(String) },
  });
  await settled(fresh);
  expect(wire.calls.filter((c) => c.startsWith("delete"))).toEqual([]);
});

test("DELETE keeps the row and answers 502 when the sprite can't be destroyed", async () => {
  const id = await ready();
  wire.deleteStatus = 503;
  const res = await del(id);
  expect(res.status).toBe(502);
  expect(await res.json()).toEqual({
    error: { code: "sprite_destroy_failed", message: expect.any(String) },
  });
  expect((await get(id)).status).toBe(200);
});

test("DELETE of an env whose sprite never got created still removes the row", async () => {
  wire.createStatus = 500;
  const { id } = (await (await post(kru)).json()) as { id: string };
  await settled(id);
  expect((await del(id)).status).toBe(204);
  expect((await get(id)).status).toBe(404);
});

test("a failure is persisted, so it survives the app that recorded it", async () => {
  wire.exec = (argv) =>
    isSetup(argv) ? { exitCode: 1, stderr: "boom\n" } : { exitCode: 0 };
  const { id } = (await (await post(kru)).json()) as { id: string };
  await settled(id);
  expect(
    db.$client
      .prepare(
        "select failure_step, failure_stderr from environments where id = ?",
      )
      .get(id),
  ).toEqual({ failure_step: "setup", failure_stderr: "boom\n" });
});

test("a retry clears the previous failure while it provisions", async () => {
  wire.exec = (argv) =>
    isSetup(argv) ? { exitCode: 1, stderr: "boom\n" } : { exitCode: 0 };
  const { id } = (await (await post(kru)).json()) as { id: string };
  await settled(id);
  wire.exec = () => ({ exitCode: 0 });
  const res = await patch(id, { setup: "true" });
  expect(await res.json()).toMatchObject({
    status: "provisioning",
    failure: null,
  });
  expect(await settled(id)).toMatchObject({ status: "ready", failure: null });
});

const retry = (id: string, headers: Record<string, string> = auth) =>
  app.request(`/v1/environments/${id}/retry`, { method: "POST", headers });

test("retry of a setup failure reruns provisioning on the same spec and ends ready", async () => {
  wire.exec = (argv) =>
    isSetup(argv) ? { exitCode: 1, stderr: "boom\n" } : { exitCode: 0 };
  const { id } = (await (await post(kru)).json()) as { id: string };
  await settled(id);
  wire.exec = () => ({ exitCode: 0 });
  wire.calls.length = 0;
  const res = await retry(id);
  expect(res.status).toBe(202);
  expect(await res.json()).toMatchObject({
    status: "provisioning",
    setup: kru.setup,
    failure: null,
  });
  expect(await settled(id)).toMatchObject({ status: "ready", failure: null });
  const sprite = spriteNameFor(id);
  expect(wire.calls).toEqual([
    `get ${sprite}`,
    `label ${sprite}`,
    `exec ${sprite} - sh -c ${installRunnerSdk} &> /tmp/sky-sdk.log`,
    `exec ${sprite} - rm -rf /workspace/repo /workspace/worktrees`,
    `exec ${sprite} - git clone https://github.com/acme/kru.git /workspace/repo &> /tmp/sky-clone.log`,
    ...baseApplyCalls(sprite),
    setupCall(sprite, "pnpm install"),
    pluginsCall(sprite),
    `exec ${sprite} - ${ENV_FILES_RM}`,
    `checkpoint ${sprite}`,
  ]);
});

test("retry of a create failure recreates the sprite before cloning", async () => {
  wire.createStatus = 500;
  const { id } = (await (await post(kru)).json()) as { id: string };
  await settled(id);
  wire.createStatus = 201;
  wire.calls.length = 0;
  expect((await retry(id)).status).toBe(202);
  expect(await settled(id)).toMatchObject({ status: "ready", failure: null });
  expect(wire.calls.slice(0, 2)).toEqual([
    `get ${spriteNameFor(id)}`,
    `create ${spriteNameFor(id)}`,
  ]);
});

test("an env a restart interrupts mid-setup is failed at that step, its detail saying so", async () => {
  let reached = false;
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.use(
    http.post(
      "https://api.sprites.dev/v1/sprites/:name/exec",
      async ({ request }) => {
        if (!new URL(request.url).searchParams.getAll("cmd").includes("bash"))
          return;
        reached = true;
        await held;
        return HttpResponse.error();
      },
    ),
  );
  const { id } = (await (await post(kru)).json()) as { id: string };
  try {
    await vi.waitFor(() => expect(reached).toBe(true));
    expect((await get(id)).body).toMatchObject({
      status: "provisioning",
      failure: null,
    });
    // the boot of the next process
    failInterruptedProvisioning(db);
    expect((await get(id)).body).toMatchObject({
      status: "failed",
      failure: {
        step: "setup",
        stderr: expect.stringContaining("interrupted"),
      },
    });
  } finally {
    release();
  }
});

/** A ready env whose provisioning a restart then interrupted before it began a step, as boot records it. */
const interruptedAtBoot = async () => {
  const id = await ready();
  db.$client
    .prepare("update environments set status = 'provisioning' where id = ?")
    .run(id);
  failInterruptedProvisioning(db);
  expect((await get(id)).body).toMatchObject({
    status: "failed",
    failure: { step: "create", stderr: expect.stringContaining("interrupted") },
  });
  return id;
};

test("retry after a boot interruption creates the sprite it never got", async () => {
  const id = await interruptedAtBoot();
  wire.sprites.delete(spriteNameFor(id));
  expect((await retry(id)).status).toBe(202);
  expect(await settled(id)).toMatchObject({ status: "ready", failure: null });
  expect(wire.calls.slice(0, 2)).toEqual([
    `get ${spriteNameFor(id)}`,
    `create ${spriteNameFor(id)}`,
  ]);
});

test("retry after a boot interruption keeps the sprite that exists", async () => {
  const id = await interruptedAtBoot();
  expect((await retry(id)).status).toBe(202);
  expect(await settled(id)).toMatchObject({ status: "ready", failure: null });
  expect(wire.calls.filter((c) => c.startsWith("create"))).toEqual([]);
});

test("retry is 409 not_failed unless failed, 404 for an unknown env, 401 without a bearer", async () => {
  const id = await ready();
  const res = await retry(id);
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({
    error: { code: "not_failed", message: expect.any(String) },
  });
  expect((await retry("env_nope")).status).toBe(404);
  expect((await retry(id, {})).status).toBe(401);
  expect(wire.calls).toEqual([]);
});

test("a second retry while the first provisions is 409 and starts nothing", async () => {
  wire.exec = (argv) => (isSetup(argv) ? { exitCode: 1 } : { exitCode: 0 });
  const { id } = (await (await post(kru)).json()) as { id: string };
  await settled(id);
  wire.exec = () => ({ exitCode: 0 });
  wire.calls.length = 0;
  const [first, second] = await Promise.all([retry(id), retry(id)]);
  expect([first.status, second.status].sort()).toEqual([202, 409]);
  await settled(id);
  expect(wire.calls.filter((c) => c.startsWith("checkpoint"))).toHaveLength(1);
});

// stands in for a writer that commits the same name between the check and the write
const raceOnName = (raced: string) =>
  db.$client.exec(`
    create temp trigger race before insert on environments when new.name = '${raced}'
    begin
      insert into environments (id, name, repo, setup, status, sprite_name)
      values ('env_racer', '${raced}', 'acme/kru', '', 'ready', 'sky-env_racer');
    end;
    create temp trigger race_rename before update of name on environments when new.name = '${raced}'
    begin
      insert into environments (id, name, repo, setup, status, sprite_name)
      values ('env_racer', '${raced}', 'acme/kru', '', 'ready', 'sky-env_racer');
    end;`);

test("a name another writer took between check and insert is still 409 name_taken", async () => {
  raceOnName("kru");
  const res = await post(kru);
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({
    error: { code: "name_taken", message: expect.any(String) },
  });
  expect(wire.calls).toEqual([]);
});

test("a rename another writer raced to is still 409 name_taken", async () => {
  const id = await ready();
  raceOnName("taken");
  const res = await patch(id, { name: "taken" });
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({
    error: { code: "name_taken", message: expect.any(String) },
  });
});

const acme = BaseProfile.parse({
  marketplaces: ["acme/plugins"],
  plugins: ["review@plugins"],
  mcpServers: {
    docs: {
      command: "npx",
      args: ["-y", "docs-mcp"],
      env: { DOCS_KEY: "DOCS_SECRET" },
    },
    search: {
      url: "https://search.example.com/mcp",
      headers: { "X-Api-Key": "SEARCH_SECRET" },
    },
  },
});

/** Replaces the app with one configured with `baseProfiles`. */
const serveProfiles = (baseProfiles: Record<string, BaseProfile>) => {
  app = createApp({
    db,
    config: testConfig({ baseProfiles }),
    sprites: new SpritesClient(spritesToken),
    log: () => {},
    nudgeDeliveries: () => {},
  });
};

// how a profile writes an env secret into the sprite's MCP config
const ref = (name: string) => `\${${name}}`;

type ClaudeState = {
  marketplaces: string[];
  plugins: string[];
  mcpServers: Record<string, unknown>;
};

/**
 * A `claude` that keeps the user config the profile steps touch in `$HOME/claude-state.json` and
 * answers as the real one does: `marketplace add --json` names the marketplace (its source's last
 * path segment), the lists print JSON, and removing what isn't there exits 1.
 */
function statefulClaude() {
  const fs = require("node:fs") as typeof import("node:fs");
  const home = process.env.HOME ?? "";
  const [group, verb, ...rest] = process.argv.slice(2);
  fs.appendFileSync(
    `${home}/claude-runs`,
    `${process.argv.slice(2).join(" ")}\n`,
  );
  const file = `${home}/claude-state.json`;
  const state: ClaudeState = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : { marketplaces: [], plugins: [], mcpServers: {} };
  const save = () => fs.writeFileSync(file, JSON.stringify(state));
  const fail = (message: string) => {
    process.stderr.write(`${message}\n`);
    process.exit(1);
  };
  const list = (items: object[]) =>
    process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
  const without = (items: string[], item: string) => {
    if (!items.includes(item)) fail(`'${item}' not found`);
    return items.filter((i) => i !== item);
  };
  const action = group === "plugin" && verb === "marketplace" ? rest[0] : verb;
  const arg = group === "plugin" && verb === "marketplace" ? rest[1] : rest[0];
  if (group === "plugin" && verb === "marketplace") {
    if (action === "add" && arg) {
      const name =
        (arg.split("#")[0] ?? "")
          .split("/")
          .pop()
          ?.replace(/\.git$/, "") ?? "";
      if (!state.marketplaces.includes(name)) state.marketplaces.push(name);
      if (rest.includes("--json"))
        process.stdout.write(
          `${JSON.stringify({ outcome: "ok", marketplace: name })}\n`,
        );
    }
    if (action === "remove" && arg)
      state.marketplaces = without(state.marketplaces, arg);
    if (action === "list") list(state.marketplaces.map((name) => ({ name })));
  } else if (group === "plugin") {
    if (action === "install" && arg && !state.plugins.includes(arg))
      state.plugins.push(arg);
    if (action === "uninstall" && arg)
      state.plugins = without(state.plugins, arg);
    if (action === "list")
      list(state.plugins.map((id) => ({ id, scope: "user" })));
  } else if (group === "mcp") {
    if (action === "remove" && arg) {
      if (!(arg in state.mcpServers))
        fail(`No MCP server named "${arg}" in user scope`);
      delete state.mcpServers[arg];
    }
    if (action === "add-json" && arg)
      state.mcpServers[arg] = JSON.parse(rest[1] ?? "");
  }
  save();
}

/**
 * Runs the profile and plugin steps in a real local node against {@link statefulClaude}, with the
 * sprite's profile files copied in; `user` is config the sprite held before, from no profile.
 */
function runBaseLocally(home: string, user?: Partial<ClaudeState>) {
  writeFileSync(
    join(home, "claude-state.json"),
    JSON.stringify({ marketplaces: [], plugins: [], mcpServers: {}, ...user }),
  );
  const claudeRuns = runPluginsLocally(
    home,
    undefined,
    `#!${process.execPath}\n(${statefulClaude.toString()})();\n`,
  );
  const runLocally = wire.exec;
  const local = (path: string) => join(home, path.replaceAll("/", "_"));
  wire.exec = (argv) => {
    if (argv[0] === "rm") {
      for (const path of argv.slice(2)) wire.files.delete(path);
      return { exitCode: 0 };
    }
    if (!argv.includes(BASE_FILE)) return runLocally(argv);
    const files = [BASE_FILE, LEFTOVER_BASE_FILE];
    for (const path of files) {
      const bytes = wire.files.get(path);
      if (bytes) writeFileSync(local(path), bytes);
      else rmSync(local(path), { force: true });
    }
    return runLocally(argv.map((a) => (files.includes(a) ? local(a) : a)));
  };
  return {
    claudeRuns,
    state: (): ClaudeState =>
      JSON.parse(readFileSync(join(home, "claude-state.json"), "utf8")),
  };
}

const other = BaseProfile.parse({
  marketplaces: ["acme/tools"],
  plugins: ["lint@tools"],
  mcpServers: {
    search: {
      url: "https://search.example.com/mcp",
      headers: { "X-Api-Key": "SEARCH_SECRET" },
    },
  },
});
// what a session's own setup or a person put in the sprite's user config, outside any profile
const userConfig = {
  marketplaces: ["own"],
  plugins: ["mine@own"],
  mcpServers: { local: { type: "stdio", command: "local-mcp" } },
};

test("a rebuild onto another profile leaves exactly what that profile declares, beside what no profile declared", async () => {
  serveProfiles({ acme, other });
  const home = mkdtempSync(join(tmpdir(), "sky-home-"));
  const sprite = runBaseLocally(home, userConfig);
  try {
    const id = await ready({ ...kru, base: "acme" } as typeof kru);
    expect(sprite.state().plugins).toContain("review@plugins");
    expect((await patch(id, { base: "other" })).status).toBe(202);
    expect(await settled(id)).toMatchObject({ status: "ready", failure: null });
    expect(sprite.state()).toEqual({
      marketplaces: ["own", "tools"],
      plugins: ["mine@own", "lint@tools"],
      mcpServers: {
        local: userConfig.mcpServers.local,
        search: {
          type: "http",
          url: "https://search.example.com/mcp",
          headers: { "X-Api-Key": ref("SEARCH_SECRET") },
        },
      },
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an unknown base is refused on create and on patch, naming the profiles the server has", async () => {
  serveProfiles({ acme });
  const created = await post({ ...kru, base: "nope" });
  expect(created.status).toBe(400);
  expect(await created.json()).toEqual({
    error: {
      code: "unknown_base",
      message: expect.stringContaining('"nope"; this server has: acme'),
    },
  });
  const id = await ready();
  const patched = await patch(id, { base: "nope" });
  expect(patched.status).toBe(400);
  expect(
    ((await patched.json()) as { error: { code: string } }).error.code,
  ).toBe("unknown_base");
  expect((await get(id)).body).toMatchObject({ base: null, status: "ready" });
});

test("with no profiles configured, any base is refused and says there are none", async () => {
  serveProfiles({});
  const res = await post({ ...kru, base: "acme" });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({
    error: { message: expect.stringContaining("none configured") },
  });
});

test("an env created with a base reports it, and one without reports null", async () => {
  serveProfiles({ acme });
  const withBase = (await (await post({ ...kru, base: "acme" })).json()) as {
    id: string;
    base: string | null;
  };
  expect(withBase.base).toBe("acme");
  expect((await get(withBase.id)).body.base).toBe("acme");
  const without = (await (await post({ ...kru, name: "plain" })).json()) as {
    base: string | null;
  };
  expect(without.base).toBeNull();
});

test("PATCH of base reprovisions like a setup change, is refused while agents exist, and a repeat of the same base does nothing", async () => {
  serveProfiles({ acme });
  const id = await ready();
  seedRun(id, "finished");
  const res = await patch(id, { base: "acme" });
  expect(res.status).toBe(409);
  const { error } = (await res.json()) as {
    error: { code: string; message: string };
  };
  expect(error.code).toBe("agents_exist");
  expect(error.message).toContain("base");
  expect(wire.calls).toEqual([]);

  db.$client
    .prepare("update agents set archived_at = ? where id = ?")
    .run("2026-10-29T12:00:00.000Z", `agt_${id.slice(4)}`);
  const changed = await patch(id, { base: "acme" });
  expect(changed.status).toBe(202);
  expect(await changed.json()).toMatchObject({
    base: "acme",
    status: "provisioning",
  });
  expect(await settled(id)).toMatchObject({ status: "ready", base: "acme" });

  wire.calls.length = 0;
  const same = await patch(id, { base: "acme" });
  expect(same.status).toBe(200);
  expect(wire.calls).toEqual([]);
});

test("PATCH of base to null reprovisions and takes everything the profile added out of the sprite", async () => {
  serveProfiles({ acme });
  const home = mkdtempSync(join(tmpdir(), "sky-home-"));
  const sprite = runBaseLocally(home, userConfig);
  try {
    const id = await ready({ ...kru, base: "acme" } as typeof kru);
    expect(Object.keys(sprite.state().mcpServers)).toContain("docs");
    expect((await patch(id, { base: null })).status).toBe(202);
    expect(await settled(id)).toMatchObject({
      status: "ready",
      base: null,
      failure: null,
    });
    expect(sprite.state()).toEqual(userConfig);
    expect(wire.files.has(BASE_FILE)).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a rebuild after a profile drops a server and a plugin removes just those", async () => {
  serveProfiles({ acme });
  const home = mkdtempSync(join(tmpdir(), "sky-home-"));
  const sprite = runBaseLocally(home);
  try {
    const id = await ready({ ...kru, base: "acme" } as typeof kru);
    const { docs: _, ...rest } = acme.mcpServers;
    serveProfiles({ acme: { ...acme, plugins: [], mcpServers: rest } });
    expect((await patch(id, { setup: "make" })).status).toBe(202);
    expect(await settled(id)).toMatchObject({ status: "ready", failure: null });
    expect(sprite.state()).toMatchObject({
      marketplaces: ["plugins"],
      plugins: [],
      mcpServers: { search: expect.anything() },
    });
    expect(Object.keys(sprite.state().mcpServers)).toEqual(["search"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("what the profile added but someone already removed doesn't fail the rebuild", async () => {
  serveProfiles({ acme });
  const home = mkdtempSync(join(tmpdir(), "sky-home-"));
  const sprite = runBaseLocally(home, userConfig);
  try {
    const id = await ready({ ...kru, base: "acme" } as typeof kru);
    writeFileSync(join(home, "claude-state.json"), JSON.stringify(userConfig));
    expect((await patch(id, { base: null })).status).toBe(202);
    expect(await settled(id)).toMatchObject({ status: "ready", failure: null });
    expect(sprite.state()).toEqual(userConfig);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a sprite holding only the profile file an earlier version left loses that profile's plugins and servers, and the file", async () => {
  serveProfiles({ acme });
  const home = mkdtempSync(join(tmpdir(), "sky-home-"));
  const sprite = runBaseLocally(home, {
    ...userConfig,
    plugins: [...userConfig.plugins, "review@plugins"],
    mcpServers: { ...userConfig.mcpServers, docs: {}, search: {} },
  });
  try {
    const id = await ready();
    wire.files.set(
      LEFTOVER_BASE_FILE,
      new TextEncoder().encode(JSON.stringify(acme)),
    );
    expect((await patch(id, { setup: "make" })).status).toBe(202);
    expect(await settled(id)).toMatchObject({ status: "ready", failure: null });
    expect(sprite.state()).toEqual(userConfig);
    expect(wire.files.has(LEFTOVER_BASE_FILE)).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("provisioning with a profile applies it after the clone and before the env's setup, then installs the repo's own plugins", async () => {
  serveProfiles({ acme });
  const home = mkdtempSync(join(tmpdir(), "sky-home-"));
  const { claudeRuns } = runBaseLocally(home);
  try {
    const { id } = (await (await post({ ...kru, base: "acme" })).json()) as {
      id: string;
    };
    expect(await settled(id)).toMatchObject({ status: "ready", failure: null });
    const sprite = spriteNameFor(id);
    const clone = wire.calls.findIndex((c) => c.includes("git clone"));
    const apply = wire.calls.findIndex((c) => c.includes("sky-base.log"));
    const setup = wire.calls.findIndex((c) => c.includes("sky-setup.log"));
    expect(wire.calls[apply - 1]).toBe(`write ${sprite} ${BASE_FILE}`);
    expect(clone).toBeLessThan(apply - 1);
    expect(apply).toBeLessThan(setup);
    expect(wire.calls[apply]).toEqual(baseApplyCall(sprite));
    expect(claudeRuns().split("\n")).toEqual([
      "plugin marketplace add acme/plugins --json",
      "plugin marketplace update",
      "plugin install review@plugins --scope user",
      "plugin update review@plugins --scope user",
      "mcp remove docs --scope user",
      `mcp add-json docs ${JSON.stringify({
        type: "stdio",
        command: "npx",
        args: ["-y", "docs-mcp"],
        env: { DOCS_KEY: ref("DOCS_SECRET") },
      })} --scope user`,
      "mcp remove search --scope user",
      `mcp add-json search ${JSON.stringify({
        type: "http",
        url: "https://search.example.com/mcp",
        headers: { "X-Api-Key": ref("SEARCH_SECRET") },
      })} --scope user`,
      "",
    ]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the profile file holds names of secrets, never a value", async () => {
  serveProfiles({ acme });
  const id = await ready({ ...kru, base: "acme" } as typeof kru);
  await app.request(`/v1/environments/${id}/secrets/DOCS_SECRET`, {
    method: "PUT",
    headers: json,
    body: JSON.stringify({ value: "docs-secret-value" }),
  });
  expect((await patch(id, { setup: "make" })).status).toBe(202);
  await settled(id);
  const written = Buffer.from(wire.files.get(BASE_FILE) ?? "").toString();
  expect(written).toContain("DOCS_SECRET");
  expect(written).not.toContain("docs-secret-value");
  expect(wire.execUrls.join("\n")).not.toContain("docs-secret-value");
});

test("a profile with only a store or checks adds nothing to the sprite's user config", async () => {
  serveProfiles({
    light: BaseProfile.parse({ checks: ["lint"], storeRepo: "acme/store" }),
  });
  const home = mkdtempSync(join(tmpdir(), "sky-home-"));
  const sprite = runBaseLocally(home, userConfig);
  try {
    const { id } = (await (await post({ ...kru, base: "light" })).json()) as {
      id: string;
    };
    expect(await settled(id)).toMatchObject({ status: "ready", failure: null });
    expect(sprite.state()).toEqual(userConfig);
    expect(sprite.claudeRuns()).toBe("");
    expect(wire.files.has(BASE_FILE)).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an env with no base pulls no store, even with a connector", async () => {
  const { id, env } = await reprovisionWith(
    githubConnector,
    "// runner",
    () => {},
    null,
  );
  expect(env).toMatchObject({ status: "ready", failure: null });
  expect(wire.calls.some((c) => c.includes("store-sync"))).toBe(false);
  expect(wire.calls.at(-1)).toBe(`checkpoint ${spriteNameFor(id)}`);
});

test("a profile that fails to apply ends failed at the setup step with the command's output, before the env's setup runs", async () => {
  serveProfiles({ acme });
  wire.exec = (argv) =>
    argv[1] === "-e" && argv.includes(BASE_FILE)
      ? {
          exitCode: 1,
          stderr: "plugin install failed: review@plugins not found",
        }
      : { exitCode: 0 };
  const { id } = (await (await post({ ...kru, base: "acme" })).json()) as {
    id: string;
  };
  expect(await settled(id)).toMatchObject({
    status: "failed",
    failure: {
      step: "setup",
      stderr: expect.stringContaining("review@plugins not found"),
    },
  });
  expect(wire.calls.some((c) => c.includes("sky-setup.log"))).toBe(false);
});

test("an env whose base profile was removed from the config fails provisioning naming it", async () => {
  serveProfiles({ acme });
  const { id } = (await (await post({ ...kru, base: "acme" })).json()) as {
    id: string;
  };
  await settled(id);
  serveProfiles({});
  db.$client
    .prepare(
      "update environments set status = 'failed', failure_step = 'setup' where id = ?",
    )
    .run(id);
  wire.calls.length = 0;
  expect(
    (
      await app.request(`/v1/environments/${id}/retry`, {
        method: "POST",
        headers: auth,
      })
    ).status,
  ).toBe(202);
  expect(await settled(id)).toMatchObject({
    status: "failed",
    failure: {
      step: "create",
      stderr: expect.stringContaining('base profile "acme" is not configured'),
    },
  });
  expect(wire.calls).toEqual([]);
});
