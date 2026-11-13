import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  credentialDir,
  HOST_MANAGED,
  type NestedLogin,
  type NestedPrefix,
  nestedLoginDir,
  prepareNestedLogin,
  sweepCredentialFiles,
} from "./claude-auth.js";
import { nestedClaude } from "./session.js";

// the Claude Code binary the Agent SDK ships beside itself, the one a run's nested `claude` is: the
// platform package for this arch and libc, glibc or musl, the SDK installed with the optional
// dependency that matches
// undefined when the SDK or its platform package isn't installed, so the tests that need no binary
// still run
const claudeBinary = (): string | undefined => {
  try {
    const sdk = realpathSync(
      join(
        import.meta.dirname,
        "../node_modules/@anthropic-ai/claude-agent-sdk",
      ),
    );
    return ["", "-musl"]
      .map((libc) =>
        join(
          dirname(sdk),
          `claude-agent-sdk-${process.platform}-${process.arch}${libc}`,
          "claude",
        ),
      )
      .find((path) => existsSync(path));
  } catch {
    return undefined;
  }
};

const SUBSCRIPTION = "subscription-token-0001";
const POOL = "pool-subscription-token-0002";

type Seen = { auth: string | undefined; key: string | undefined };

/** An Anthropic API that refuses every request and records what each model request was signed with. */
async function listen(status = 401): Promise<{
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
    res.writeHead(status, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        type: "error",
        error: {
          type:
            status === 401 ? "authentication_error" : "invalid_request_error",
          message: "refused",
        },
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
  // a 400, which Claude Code does not retry for minutes as it does a refused key
  decoy = await listen(400);
});
afterEach(async () => {
  for (const { server } of [api, decoy]) {
    server.closeAllConnections();
    server.close();
  }
  rmSync(root, { recursive: true, force: true });
});

/**
 * Runs the prompt's nested command in a shell as a Bash command sees it: the credential variables
 * Claude Code strips are absent, the project's own (key, auth token, gateway, proxies) are set, and
 * its repo holds a settings file that tries to send the session to the decoy. Only the API's address
 * is added, after the command's own `-u` list (host-managed claude takes its endpoint from no other
 * place), so a leaked project gateway is for the unit test of the command's env to catch, and a
 * leaked key, auth token or proxy shows here. `hostManaged: false` leaves the mode out, to show the
 * settings file is live. Resolves with the command's output; a command that outlasts its timeout fails.
 */
async function runNested(
  login: NestedPrefix | undefined,
  commandEnv: Record<string, string> = {},
  { hostManaged = true }: { hostManaged?: boolean } = {},
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
  const managed = nestedClaude(login);
  const command = (
    hostManaged ? managed : managed.replace(` ${HOST_MANAGED}=1`, "")
  ).replace(
    /claude -p …$/,
    `ANTHROPIC_BASE_URL=${api.url} ${claudeBinary()} -p "reply ok" </dev/null`,
  );
  return await new Promise((resolve, reject) =>
    execFile(
      "bash",
      ["-c", command],
      {
        cwd: repo,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          ANTHROPIC_API_KEY: "project-api-key",
          ANTHROPIC_AUTH_TOKEN: "project-auth-token",
          ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
          HTTP_PROXY: "http://127.0.0.1:9",
          HTTPS_PROXY: "http://127.0.0.1:9",
          // the real binary calls no host of its own: no telemetry, no update check
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          DISABLE_AUTOUPDATER: "1",
          ...commandEnv,
        },
        timeout: 60_000,
      },
      (error, stdout, stderr) =>
        error?.killed
          ? reject(new Error("the nested claude outlasted its timeout"))
          : resolve(`${stdout}${stderr}`),
    ),
  );
}

const pathOf = (login: NestedLogin) =>
  /<'([^']+)'/.exec(login.prefix?.assignment ?? "")?.[1] ?? "";

// CI installs the SDK's platform package with the rest, so a missing binary there is an install
// problem to fail on, not coverage to skip
test.runIf(process.env.CI && !claudeBinary())(
  "the Claude Code binary the real-binary tests drive is installed",
  () => {
    expect.fail(
      `no claude-agent-sdk-${process.platform}-${process.arch} package beside the SDK`,
    );
  },
);

describe.skipIf(!claudeBinary())(
  "a follow-up run of an agent (real binary)",
  () => {
    test("finds a live credential at the path the first run named, holding its own run's token", async () => {
      const links = join(root, "links");
      const prepare = (token: string, runId: string, agent = "agt_1") =>
        prepareNestedLogin(
          "oauth",
          { CLAUDE_CODE_OAUTH_TOKEN: token },
          runId,
          links,
          agent,
          join(root, runId),
        );
      const first = await prepare(SUBSCRIPTION, "run_first");
      const named = pathOf(first);
      await first.remove();
      // the link, which `existsSync` would follow to the file that is gone
      expect(readdirSync(links)).toEqual([]);
      // a pool run that moved to another subscription
      const followUp = await prepare(POOL, "run_follow");
      expect(pathOf(followUp)).toBe(named);
      expect(readFileSync(named, "utf8")).toBe(POOL);
      const output = await runNested(first.prefix);
      expect(api.seen[0]).toEqual({ auth: `Bearer ${POOL}`, key: undefined });
      expect(output).not.toContain(POOL);
      await followUp.remove();
      expect(readdirSync(links)).toEqual([]);
    }, 90_000);
  },
);

describe("the nested login of an agent across runs", () => {
  const prepare = (token: string, runId: string, agent: string) =>
    prepareNestedLogin(
      "oauth",
      { CLAUDE_CODE_OAUTH_TOKEN: token },
      runId,
      join(root, "links"),
      agent,
      join(root, "runner"),
    );

  test("a run's end leaves a later run's link alone", async () => {
    const early = await prepare(SUBSCRIPTION, "run_early", "agt_1");
    const late = await prepare(POOL, "run_late", "agt_1");
    // the path the first run named is the one the later run's prompt names
    expect(pathOf(late)).toBe(pathOf(early));
    await early.remove();
    expect(readFileSync(pathOf(late), "utf8")).toBe(POOL);
    await late.remove();
    expect(readdirSync(join(root, "links"))).toEqual([]);
  });

  test("a run's end deletes its link and its file", async () => {
    const login = await prepare(SUBSCRIPTION, "run_end", "agt_1");
    expect(readdirSync(join(root, "links"))).toEqual([
      "sky-nested-claude-agt_1",
    ]);
    expect(readdirSync(join(root, "runner"))).toHaveLength(1);
    await login.remove();
    expect(readdirSync(join(root, "links"))).toEqual([]);
    expect(readdirSync(join(root, "runner"))).toEqual([]);
  });

  test("two agents' files stay apart", async () => {
    const a = await prepare(SUBSCRIPTION, "run_a", "agt_a");
    const b = await prepare(POOL, "run_b", "agt_b");
    expect(pathOf(a)).not.toBe(pathOf(b));
    expect(readFileSync(pathOf(a), "utf8")).toBe(SUBSCRIPTION);
    expect(readFileSync(pathOf(b), "utf8")).toBe(POOL);
    await a.remove();
    expect(readdirSync(join(root, "links"))).toEqual([
      "sky-nested-claude-agt_b",
    ]);
    expect(readFileSync(pathOf(b), "utf8")).toBe(POOL);
    await b.remove();
    expect(readdirSync(join(root, "links"))).toEqual([]);
  });

  describe("the sweep of links whose runner was hard-killed", () => {
    const links = () => nestedLoginDir(root);
    const prepareFor = (pid: number, agent: string, token: string) =>
      prepareNestedLogin(
        "oauth",
        { CLAUDE_CODE_OAUTH_TOKEN: token },
        `run_${agent}`,
        links(),
        `agt_${agent}`,
        credentialDir(root, pid),
      );

    test("a hard-killed runner's link is swept, and a live runner's is not", async () => {
      await prepareFor(4001, "dead", SUBSCRIPTION);
      const live = await prepareFor(4002, "live", POOL);
      // listed, not followed: the dead runner's link dangles once its directory goes
      expect(readdirSync(links()).sort()).toEqual([
        "sky-nested-claude-agt_dead",
        "sky-nested-claude-agt_live",
      ]);
      sweepCredentialFiles((pid) => pid === 4002, root, 1);
      expect(readdirSync(links())).toEqual(["sky-nested-claude-agt_live"]);
      expect(readFileSync(pathOf(live), "utf8")).toBe(POOL);
      expect(readdirSync(credentialDir(root, 4002))).toHaveLength(1);
      expect(existsSync(credentialDir(root, 4001))).toBe(false);
      await live.remove();
    });

    test("a dangling link that is not a nested login's is kept, and a staged leftover is swept", async () => {
      await prepareFor(4001, "dead", SUBSCRIPTION);
      // a staged link is named like an agent's, so one left by a runner killed before the rename matches
      const staged = "sky-nested-claude-0b9f7d52.staged";
      symlinkSync(join(root, "nowhere"), join(links(), staged));
      symlinkSync(join(root, "nowhere"), join(links(), "notes"));
      sweepCredentialFiles(() => false, root, 1);
      expect(readdirSync(links())).toEqual(["notes"]);
    });
  });
});
