import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BaseProfileMcpServer } from "@sky/shared";
import { describe, expect, test } from "vitest";
import { codexConfigToml } from "./codex.js";
import {
  codexMcpTables,
  codexRefusedWarning,
  codexUnresolvedWarning,
} from "./codex-mcp.js";
import { matchesPolicy, policyOutcome } from "./policy.js";

const SECRET = "fake-secret-value-123";
const http: BaseProfileMcpServer = {
  url: "https://doop.example/mcp",
  headers: { Authorization: "DOOP_KEY", "X-Team": "TEAM_ID" },
};
const stdio: BaseProfileMcpServer = {
  command: "npx",
  args: ["-y", "docs-mcp", "--flag=a b"],
  env: { DOCS_KEY: "DOCS_KEY" },
};
const env = { DOOP_KEY: SECRET, TEAM_ID: `${SECRET}-team`, DOCS_KEY: SECRET };
const write = (profile: Record<string, BaseProfileMcpServer>) =>
  codexConfigToml(
    "http://127.0.0.1:1/v1",
    [],
    codexMcpTables(profile, env).tables,
  );

/** Python's tomllib stands in for a TOML parser, which the repo has none of; where it's missing off CI, only the text checks run. */
const python = (() => {
  try {
    execFileSync("python3", ["-c", "import tomllib"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const parses = test.skipIf(!python && !process.env.CI);
const parse = (toml: string): { mcp_servers: Record<string, unknown> } => {
  expect(python, "CI needs python3 >= 3.11 (tomllib) to parse").toBe(true);
  const dir = mkdtempSync(join(tmpdir(), "codex-mcp-"));
  try {
    const file = join(dir, "config.toml");
    writeFileSync(file, toml);
    return JSON.parse(
      execFileSync(
        "python3",
        [
          "-I",
          "-c",
          "import json,sys,tomllib;print(json.dumps(tomllib.load(open(sys.argv[1],'rb'))))",
          file,
        ],
        { encoding: "utf8" },
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe("codexMcpTables", () => {
  test("an http server names its headers' env vars and asks for every tool call", () => {
    const toml = write({ doop: http });
    expect(toml).toContain(
      [
        '[mcp_servers."doop"]',
        'url = "https://doop.example/mcp"',
        'env_http_headers = { "Authorization" = "DOOP_KEY", "X-Team" = "TEAM_ID" }',
        'default_tools_approval_mode = "prompt"',
      ].join("\n"),
    );
    expect(toml).not.toContain(SECRET);
  });

  test("a stdio server names the env vars Codex passes through", () => {
    const toml = write({ docs: stdio });
    expect(toml).toContain(
      [
        '[mcp_servers."docs"]',
        'command = "npx"',
        'args = ["-y","docs-mcp","--flag=a b"]',
        'env_vars = ["DOCS_KEY"]',
        'default_tools_approval_mode = "prompt"',
      ].join("\n"),
    );
    expect(toml).not.toContain(SECRET);
  });

  parses("the file parses as TOML and holds names only", () => {
    const toml = write({ doop: http, docs: stdio });
    expect(toml).not.toContain(SECRET);
    const servers = parse(toml).mcp_servers as Record<string, unknown>;
    expect(servers.doop).toEqual({
      url: "https://doop.example/mcp",
      env_http_headers: { Authorization: "DOOP_KEY", "X-Team": "TEAM_ID" },
      default_tools_approval_mode: "prompt",
    });
    expect(servers.docs).toEqual({
      command: "npx",
      args: ["-y", "docs-mcp", "--flag=a b"],
      env_vars: ["DOCS_KEY"],
      default_tools_approval_mode: "prompt",
    });
  });

  const awkward = 'a"b\\c\nd\te\u007ff';
  const escaped: BaseProfileMcpServer = {
    command: `/bin/${awkward}`,
    args: [awkward, "plain \u{1f642}"],
    env: { DOCS_KEY: "DOCS_KEY" },
  };

  test("a stdio server's command and args are escaped, DEL included", () => {
    const toml = write({ docs: escaped });
    expect(toml).toContain('command = "/bin/a\\"b\\\\c\\nd\\te\\u007ff"');
    expect(toml).toContain(
      'args = ["a\\"b\\\\c\\nd\\te\\u007ff","plain \u{1f642}"]',
    );
    expect(toml).not.toContain("\u007f");
  });

  parses("an escaped command and args parse back to the same strings", () => {
    expect(parse(write({ docs: escaped })).mcp_servers.docs).toEqual({
      command: `/bin/${awkward}`,
      args: [awkward, "plain \u{1f642}"],
      env_vars: ["DOCS_KEY"],
      default_tools_approval_mode: "prompt",
    });
  });

  test("a server with no secrets writes no header or env line", () => {
    const toml = write({
      open: { url: "https://open.example/mcp", headers: {} },
      bare: { command: "tool", args: [], env: {} },
    });
    expect(toml).not.toContain("env_http_headers");
    expect(toml).not.toContain("env_vars");
  });

  test("a server whose secret the run lacks is left out and named, with the secret's name only", () => {
    const result = codexMcpTables(
      { doop: http, docs: stdio },
      { DOCS_KEY: "x" },
    );
    expect(result.tables).toHaveLength(1);
    expect(result.unresolved).toEqual([
      { server: "doop", secrets: ["DOOP_KEY", "TEAM_ID"] },
    ]);
    expect(codexUnresolvedWarning(result.unresolved)).toContain(
      "doop (DOOP_KEY, TEAM_ID)",
    );
    // an empty value is no value
    expect(
      codexMcpTables({ docs: stdio }, { DOCS_KEY: "" }).unresolved,
    ).toHaveLength(1);
  });

  test.each([
    ["a quote in the name", { 'a"b': http }, "its name"],
    ["a backslash in the name", { "a\\b": http }, "its name"],
    ["a newline in the name", { "a\nb": http }, "its name"],
    ["a control character in the name", { "a\u0007b": http }, "its name"],
    ["a DEL in the name", { "a\u007fb": http }, "its name"],
    ["a lone surrogate in the name", { "a\ud800b": http }, "its name"],
    [
      "a quote in the url",
      { ok: { url: 'https://x.example/"\nbad = 1', headers: {} } },
      "its url",
    ],
    [
      "a backslash in the url",
      { ok: { url: "https://x.example/\\", headers: {} } },
      "its url",
    ],
    [
      "a newline in the url",
      { ok: { url: "https://x.example/\nbad = 1", headers: {} } },
      "its url",
    ],
    [
      "a DEL in the url",
      { ok: { url: "https://x.example/\u007f", headers: {} } },
      "its url",
    ],
    [
      "a quote in a header name",
      { ok: { url: "https://x.example", headers: { 'A"': "DOOP_KEY" } } },
      "a name it passes",
    ],
    [
      "a quote in a secret's env name",
      { ok: { url: "https://x.example", headers: { A: 'DOOP"KEY' } } },
      "a name it passes",
    ],
    [
      "a lone surrogate in an arg",
      { ok: { command: "t", args: ["a\udc00"], env: {} } },
      "its command or an arg",
    ],
    [
      "a stdio env var passed under another name than its secret's",
      { ok: { command: "t", args: [], env: { KEY: "DOCS_KEY" } } },
      "an env var it names under another name than its secret's",
    ],
  ] as const)("%s is skipped and warned about", (_, profile, why) => {
    const result = codexMcpTables(
      profile as Record<string, BaseProfileMcpServer>,
      env,
    );
    expect(result.tables).toEqual([]);
    expect(result.unresolved).toEqual([]);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]?.why).toBe(why);
    expect(codexRefusedWarning(result.refused)).toContain("not passed");
  });

  test("no servers means no mcp_servers table", () => {
    expect(write({})).not.toContain("mcp_servers");
    expect(codexConfigToml("http://127.0.0.1:1/v1")).not.toContain(
      "mcp_servers",
    );
  });
});

describe("an MCP tool call's approval", () => {
  // the runner asks `matchesPolicy`; a Claude Code run asks `policyOutcome`: the two agree
  const scope = {
    root: "/w",
    cwd: "/w",
    realpath: (p: string) => p,
    isSymlink: () => false,
    home: "/h",
    storeHome: undefined,
    scratch: "/s",
  };
  test.each([
    [["mcp__doop__draw"], "hold"],
    [["Bash", "Edit"], "run"],
    [["mcp__doop__other"], "run"],
    [[], "run"],
  ] as const)("policy %j is %s on both runtimes", (policy, outcome) => {
    const input = { shape: "box" };
    expect(
      policyOutcome(
        policy,
        { defaults: true, commands: [] },
        scope,
        "mcp__doop__draw",
        input,
      ),
    ).toBe(outcome);
    expect(matchesPolicy(policy, "mcp__doop__draw", input)).toBe(
      outcome === "hold",
    );
  });
});

describe("secret names the run's own channels use", () => {
  test.each([
    "SKY_TOOLS_SOCKET",
    "SKY_TOOLS_SECRET",
    "SKY_BROKER_SOCKET",
    "SKY_BROKER_TOKEN",
  ])(
    "%s is refused as a stdio env var and as an http header's secret, with a warning, never written",
    (name) => {
      const result = codexMcpTables(
        {
          docs: { command: "docs", args: [], env: { [name]: name } },
          web: { url: "https://x.test/", headers: { Authorization: name } },
        },
        { [name]: "channel-value" },
      );
      expect(result.tables).toEqual([]);
      expect(result.unresolved).toEqual([]);
      expect(result.refused).toEqual([
        {
          server: "docs",
          why: "a secret name Sky's own publish and sync channels use",
        },
        {
          server: "web",
          why: "a secret name Sky's own publish and sync channels use",
        },
      ]);
      expect(codexRefusedWarning(result.refused)).not.toContain(
        "channel-value",
      );
    },
  );
});
