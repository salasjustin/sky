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

/** Python's tomllib stands in for a TOML parser, which the repo has none of; absent, only the text checks run. */
const python = (() => {
  try {
    execFileSync("python3", ["-c", "import tomllib"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const parse = (toml: string): { mcp_servers: Record<string, unknown> } => {
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

  test.skipIf(!python)("the file parses as TOML and holds names only", () => {
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
    ["a quote in the name", { 'a"b': http }],
    ["a newline in the name", { "a\nb": http }],
    ["a control character in the name", { "a\u0007b": http }],
    [
      "a quote in the url",
      { ok: { url: 'https://x.example/"\nbad = 1', headers: {} } },
    ],
    [
      "a newline in the url",
      { ok: { url: "https://x.example/\nbad = 1", headers: {} } },
    ],
    [
      "a quote in a header name",
      { ok: { url: "https://x.example", headers: { 'A"': "DOOP_KEY" } } },
    ],
    [
      "a stdio env var passed under another name than its secret's",
      { ok: { command: "t", args: [], env: { KEY: "DOCS_KEY" } } },
    ],
  ] as const)("%s is skipped and warned about", (_, profile) => {
    const result = codexMcpTables(
      profile as Record<string, BaseProfileMcpServer>,
      env,
    );
    expect(result.tables).toEqual([]);
    expect(result.refused).toHaveLength(1);
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
