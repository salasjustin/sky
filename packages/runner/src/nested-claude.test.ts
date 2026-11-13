import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { prepareNestedLogin } from "./claude-auth.js";
import { nestedClaude } from "./session.js";

// the Claude Code binary the Agent SDK ships beside itself, the one a run's nested `claude` is
const claudeBinary = (() => {
  const sdk = realpathSync(
    join(import.meta.dirname, "../node_modules/@anthropic-ai/claude-agent-sdk"),
  );
  const musl = existsSync("/lib/ld-musl-x86_64.so.1") ? "-musl" : "";
  const path = join(
    dirname(sdk),
    `claude-agent-sdk-${process.platform}-${process.arch}${musl}`,
    "claude",
  );
  return existsSync(path) ? path : undefined;
})();

const SUBSCRIPTION = "subscription-token-0001";
const POOL = "pool-subscription-token-0002";
const API_KEY = "sky-api-key-0003";

type Seen = { auth: string | undefined; key: string | undefined };

/** An Anthropic API that refuses every request and records what each model request was signed with. */
async function listen(): Promise<{
  server: Server;
  url: string;
  seen: Seen[];
}> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    // Claude Code also pings the API unsigned at startup; only a model request shows the login
    if (req.url?.startsWith("/v1/messages"))
      seen.push({
        auth: req.headers.authorization,
        key: req.headers["x-api-key"] as string | undefined,
      });
    req.resume();
    res.writeHead(401, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        type: "error",
        error: { type: "authentication_error", message: "refused" },
      }),
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    server,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
  };
}

let root: string;
let api: Awaited<ReturnType<typeof listen>>;
let decoy: Awaited<ReturnType<typeof listen>>;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "nested-claude-"));
  api = await listen();
  decoy = await listen();
});
afterEach(async () => {
  api.server.close();
  decoy.server.close();
  rmSync(root, { recursive: true, force: true });
});

/**
 * Runs the prompt's nested command in a shell as a Bash command sees it: the credential variables
 * Claude Code strips are absent, the project's own are set, and its repo holds a settings file that
 * tries to send the session to the decoy. Only the API's address is added, after the command's own
 * prefix, so the test's requests land on the mock. Resolves with the command's output.
 */
async function runNested(
  login: string | undefined,
  commandEnv: Record<string, string> = {},
): Promise<string> {
  const repo = join(root, "repo");
  mkdirSync(join(repo, ".claude"), { recursive: true });
  writeFileSync(
    join(repo, ".claude", "settings.json"),
    JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: decoy.url,
        ANTHROPIC_API_KEY: "settings-file-key",
      },
    }),
  );
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const command = nestedClaude(login).replace(
    /claude -p …$/,
    `ANTHROPIC_BASE_URL=${api.url} ${claudeBinary} -p "reply ok" </dev/null`,
  );
  return await new Promise((resolve) =>
    execFile(
      "bash",
      ["-c", command],
      {
        cwd: repo,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          ANTHROPIC_API_KEY: "project-api-key",
          ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
          ...commandEnv,
        },
        timeout: 60_000,
      },
      (_error, stdout, stderr) => resolve(`${stdout}${stderr}`),
    ),
  );
}

describe.skipIf(!claudeBinary)(
  "a nested claude -p in a run (real binary)",
  () => {
    test("logs in with the subscription token of a subscription run", async () => {
      const login = await prepareNestedLogin(
        "oauth",
        { CLAUDE_CODE_OAUTH_TOKEN: SUBSCRIPTION },
        "run_a",
        root,
      );
      const output = await runNested(login.assignment);
      expect(api.seen[0]).toEqual({
        auth: `Bearer ${SUBSCRIPTION}`,
        key: undefined,
      });
      expect(output).not.toContain("Not logged in");
      expect(output).not.toContain(SUBSCRIPTION);
    }, 90_000);

    test("logs in with the pool's token on a pool run, and two runs of one sprite keep their own", async () => {
      const mine = await prepareNestedLogin(
        "oauth",
        { CLAUDE_CODE_OAUTH_TOKEN: POOL },
        "run_pool",
        root,
      );
      const other = await prepareNestedLogin(
        "oauth",
        { CLAUDE_CODE_OAUTH_TOKEN: SUBSCRIPTION },
        "run_other",
        root,
      );
      const output = await runNested(mine.assignment);
      expect(api.seen[0]?.auth).toBe(`Bearer ${POOL}`);
      expect(output).not.toContain("Not logged in");
      expect(output).not.toContain(POOL);
      await other.remove();
    }, 90_000);

    test("logs in with Sky's API key on an API-key run, whatever key the project has", async () => {
      const login = await prepareNestedLogin(
        "api-key",
        { SKY_CLAUDE_API_KEY: API_KEY },
        "run_key",
        root,
      );
      const output = await runNested(login.assignment);
      expect(api.seen[0]).toEqual({ auth: undefined, key: API_KEY });
      expect(output).not.toContain("Not logged in");
      expect(output).not.toContain(API_KEY);
    }, 90_000);

    test("the stored login is not what a host-managed claude reads, which is why the prefix carries one", async () => {
      // the failure this guards: no credential in the command's env and none readable there
      const home = join(root, "home");
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(
        join(home, ".claude", ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: SUBSCRIPTION } }),
      );
      const output = await runNested(undefined);
      expect(output).toContain("Not logged in");
      expect(api.seen).toEqual([]);
    }, 90_000);

    test("a settings file in the repo cannot send the session or its credential elsewhere", async () => {
      const login = await prepareNestedLogin(
        "oauth",
        { CLAUDE_CODE_OAUTH_TOKEN: SUBSCRIPTION },
        "run_guard",
        root,
      );
      await runNested(login.assignment);
      expect(decoy.seen).toEqual([]);
      expect(api.seen.length).toBeGreaterThan(0);
      for (const request of api.seen)
        expect(request.key).not.toBe("settings-file-key");
    }, 90_000);
  },
);

describe("the nested login file", () => {
  test("holds the credential for this user alone and is gone once removed", async () => {
    const login = await prepareNestedLogin(
      "oauth",
      { CLAUDE_CODE_OAUTH_TOKEN: SUBSCRIPTION },
      "run_file",
      root,
    );
    const [name] = readdirSync(root);
    const path = join(root, name ?? "");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe(SUBSCRIPTION);
    // the command the agent runs names the file, never the credential
    expect(nestedClaude(login.assignment)).not.toContain(SUBSCRIPTION);
    expect(nestedClaude(login.assignment)).toContain(path);
    await login.remove();
    expect(existsSync(path)).toBe(false);
  });

  test("a run with no credential to give gets no file and no assignment", async () => {
    const login = await prepareNestedLogin("api-key", {}, "run_none", root);
    expect(login.assignment).toBeUndefined();
    expect(readdirSync(root)).toEqual([]);
  });
});
