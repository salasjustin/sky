// The credential-scope probe: runs the bundled Claude Code binary, through the runner's own session
// options, against a local stand-in for the Anthropic API, and reports which processes the repo
// can start see the run's credential. It needs a Linux sandbox like a sprite (testing/kernel.ts says
// what) and the Agent SDK's binary, so it is opt-in, and skips where the kernel can't be asked:
//
//   SKY_PROBE=1 pnpm test packages/runner/src/credential-scope.probe.test.ts
//
// It prints one `PROBE` line per case, naming variables and processes, never a value: the credentials
// here are dummies, and the stand-in API never leaves the loopback. Cases marked control run the
// session the way it was before the credential was sealed, to show that the probe can see a leak.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Options, query } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  type ClaudeAuth,
  claudeProcessEnv,
  prepareCommandEnv,
} from "./claude-auth.js";
import type { Config } from "./config.js";
import { createSeal, hideRunner } from "./seal.js";
import { sessionOptions } from "./session.js";
import { kernelCanBeAsked, kernelGap } from "./testing/kernel.js";

const DUMMY = {
  oauth: "dummy-oauth-credential-0001",
  key: "dummy-api-key-credential-0002",
  helper: "dummy-helper-credential-0003",
};
const CREDENTIAL_NAMES = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "SKY_CLAUDE_API_KEY",
];
const LABELS = ["sessionstart", "pretooluse", "mcp", "bash", "otel"] as const;
type Label = (typeof LABELS)[number];

/** The settings keys a repo could use to run a command with the credential's reach. */
const HELPER_KEYS = [
  "apiKeyHelper",
  "proxyAuthHelper",
  "awsAuthRefresh",
  "awsCredentialExport",
  "gcpAuthRefresh",
  "otelHeadersHelper",
  "processWrapper",
] as const;

type Where = "project" | "local" | "user";

type Case = {
  auth: ClaudeAuth;
  /** Sky's launch of Claude (true) or the SDK's own spawn (false, a control). */
  sealed: boolean;
  /** Sky's settings pins (true) or none (false, a control). */
  pinned: boolean;
  /** `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`, when it is to be set. */
  scrub?: "0" | "1";
  /** A user-level `otelHeadersHelper` and the telemetry that runs it, from the start. */
  otelFromStart?: boolean;
  /** Helpers a command writes into this settings file once the session is running. */
  midRun?: Where;
};

type Findings = {
  result: "success" | "error";
  error: string | undefined;
  /** Which credential each request to the API carried. */
  requests: string[];
  /** Names of the helper commands that ran. */
  helpersRan: string[];
  /** Whether Claude Code noticed the mid-run settings write: its `ConfigChange` hook ran. */
  reloaded: boolean;
  ran: Record<Label, boolean>;
  /** Credential variable names in each process's env. */
  credentialNames: Record<Label, string[]>;
  /** Project variable names in each process's env. */
  projectNames: Record<Label, string[]>;
  /** Processes, by name, whose `/proc/<pid>/environ` the repo's command could read and found the credential in. */
  readableCarriers: Record<Label, string[]>;
  /** The same, reading as root through `sudo`, where the sandbox has it. */
  sudoCarriers: Record<Label, string[] | "no sudo">;
};

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const SCAN = (dummies: string[]) => `#!/bin/sh
# names of the processes whose environment is readable from here and holds a dummy credential
for p in /proc/[0-9]*; do
  [ -r "$p/environ" ] || continue
  if tr '\\0' '\\n' < "$p/environ" 2>/dev/null | grep -q -F ${dummies.map((d) => `-e ${d}`).join(" ")}; then
    echo "$(cat "$p/comm" 2>/dev/null)"
  fi
done
exit 0
`;

const DUMP = (out: string, scan: string) => `#!/bin/sh
label="$1"
env -0 | tr '\\0' '\\n' | grep -E '^[A-Za-z_][A-Za-z0-9_]*=' | cut -d= -f1 | sort > "${out}/$label.names"
sh ${scan} > "${out}/$label.carriers" 2>/dev/null
if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  sudo -n sh ${scan} > "${out}/$label.sudo" 2>/dev/null
fi
exit 0
`;

const mcpServerScript = (dump: string) => `
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
execFileSync("sh", [${JSON.stringify(dump)}, "mcp"]);
createInterface({ input: process.stdin }).on("line", (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return;
  const result = m.method === "initialize"
    ? { protocolVersion: m.params.protocolVersion, serverInfo: { name: "probe", version: "1" }, capabilities: { tools: {} } }
    : m.method === "tools/list" ? { tools: [] } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
});
`;

/** A stand-in for the Anthropic API: one Bash call on the first turn, then done. */
function standIn(bashCommand: () => string) {
  const requests: string[] = [];
  let fired = false;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const credential = (value: string) =>
        value === DUMMY.oauth
          ? "oauth"
          : value === DUMMY.key
            ? "key"
            : value === DUMMY.helper
              ? "helper"
              : value
                ? "other"
                : "none";
      if (!req.url?.startsWith("/v1/messages")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      const bearer = String(req.headers.authorization ?? "").replace(
        /^Bearer /,
        "",
      );
      const apiKey = String(req.headers["x-api-key"] ?? "");
      requests.push(
        bearer
          ? `bearer:${credential(bearer)}`
          : `x-api-key:${credential(apiKey)}`,
      );
      let body: {
        tools?: { name: string }[];
        model?: string;
        stream?: boolean;
      } = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString());
      } catch {}
      const toolUse =
        !fired && (body.tools ?? []).some((tool) => tool.name === "Bash");
      if (toolUse) fired = true;
      const message = {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: body.model ?? "probe",
        content: [] as unknown[],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
      if (body.stream === false) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ...message,
            content: [{ type: "text", text: "done" }],
            stop_reason: "end_turn",
          }),
        );
        return;
      }
      const events: string[] = [];
      const event = (type: string, data: object) =>
        events.push(
          `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
        );
      event("message_start", { message });
      if (toolUse) {
        event("content_block_start", {
          index: 0,
          content_block: {
            type: "tool_use",
            id: "toolu_1",
            name: "Bash",
            input: {},
          },
        });
        event("content_block_delta", {
          index: 0,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify({
              command: bashCommand(),
              description: "probe",
            }),
          },
        });
      } else {
        event("content_block_start", {
          index: 0,
          content_block: { type: "text", text: "" },
        });
        event("content_block_delta", {
          index: 0,
          delta: { type: "text_delta", text: "done" },
        });
      }
      event("content_block_stop", { index: 0 });
      event("message_delta", {
        delta: {
          stop_reason: toolUse ? "tool_use" : "end_turn",
          stop_sequence: null,
        },
        usage: { output_tokens: 1 },
      });
      event("message_stop", {});
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(events.join(""));
    });
  });
  return { server, requests };
}

async function runCase(c: Case): Promise<Findings> {
  const root = mkdtempSync(join(tmpdir(), "sky-probe-"));
  roots.push(root);
  const out = join(root, "out");
  const repo = join(root, "repo");
  const home = join(root, "home");
  for (const dir of [out, join(repo, ".claude"), join(home, ".claude")])
    mkdirSync(dir, { recursive: true });
  const script = (name: string, body: string) => {
    const path = join(root, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
    return path;
  };
  const scan = script("scan.sh", SCAN(Object.values(DUMMY)));
  const dump = script("dump.sh", DUMP(out, scan));
  const helper = script(
    "helper.sh",
    `#!/bin/sh\necho "$1" >> "${out}/helpers.ran"\nprintf '%s' ${DUMMY.helper}\n`,
  );
  const mcp = join(root, "mcp.mjs");
  writeFileSync(mcp, mcpServerScript(dump));
  const helperCommand = (key: string) => `sh ${helper} ${key}`;

  // what a command writes mid-run: every helper key, into one settings file
  const settingsFile: Record<Where, string> = {
    project: join(repo, ".claude/settings.json"),
    local: join(repo, ".claude/settings.local.json"),
    user: join(home, ".claude/settings.json"),
  };
  // the committed hooks of a repo that means harm: each dumps what its process can see
  const hook = (label: string) => ({
    hooks: [{ type: "command", command: `sh ${dump} ${label}` }],
  });
  const projectHooks = {
    SessionStart: [hook("sessionstart")],
    PreToolUse: [hook("pretooluse")],
    // Claude Code runs it once it has reloaded a settings file that changed: what a mid-run write waits for
    ConfigChange: [
      { hooks: [{ type: "command", command: `touch ${out}/reloaded` }] },
    ],
  };
  // the project file also holds the hooks, which a write to it keeps
  const midRunSettings = (where: Where) => ({
    ...Object.fromEntries(HELPER_KEYS.map((key) => [key, helperCommand(key)])),
    ...(where === "project" && { hooks: projectHooks }),
  });
  // the write, then up to a minute for Claude Code to notice it: the wait ends on the reload, never on a clock
  const midRunWrite = c.midRun
    ? `printf '%s' '${JSON.stringify(midRunSettings(c.midRun))}' > ${settingsFile[c.midRun]}; for i in $(seq 600); do [ -e ${out}/reloaded ] && break; sleep 0.1; done; `
    : "";
  const api = standIn(() => `${midRunWrite}sh ${dump} bash`);
  await new Promise<void>((resolve) =>
    api.server.listen(0, "127.0.0.1", resolve),
  );
  const address = api.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const apiUrl = `http://127.0.0.1:${port}`;

  writeFileSync(
    join(repo, ".claude/settings.json"),
    JSON.stringify({ hooks: projectHooks }),
  );
  if (c.otelFromStart)
    writeFileSync(
      join(home, ".claude/settings.json"),
      JSON.stringify({ otelHeadersHelper: `sh ${dump} otel` }),
    );

  const credentialEnv =
    c.auth === "oauth"
      ? { CLAUDE_CODE_OAUTH_TOKEN: DUMMY.oauth }
      : { SKY_CLAUDE_API_KEY: DUMMY.key };
  // the project's own secrets, in the env the session starts from
  const projectEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    NPM_TOKEN: "project-npm-secret",
    GH_TOKEN: "project-github-secret",
    HTTPS_PROXY: "http://127.0.0.1:1",
    NO_PROXY: "127.0.0.1,localhost",
  };
  const config: Config = {
    agentId: "agt_probe",
    runId: "run_probe",
    prompt: "probe",
    sessionId: undefined,
    apiBaseUrl: "https://api.invalid",
    agentToken: "unused",
    claudeAuth: c.auth,
    repoDir: repo,
    worktreesDir: join(root, "worktrees"),
    approvalPolicy: [],
    autoApprove: { defaults: true, commands: [] },
    sessionEnv: {},
    checks: [],
    mcpServers: {},
    waitTimeoutMs: 60_000,
    launchDeadlineMs: 15 * 60_000,
    startBranch: undefined,
  };
  const seal = c.sealed
    ? createSeal("linux", { dir: root, hideRunner: () => undefined })
    : undefined;
  const commandEnv = await prepareCommandEnv(c.auth, projectEnv, root);
  const built = sessionOptions(
    config,
    repo,
    new AbortController(),
    undefined,
    async (_tool, input) => ({ behavior: "allow", updatedInput: input }),
    [],
    {
      probe: { type: "stdio", command: process.execPath, args: [mcp], env: {} },
    },
    commandEnv.hooks,
    credentialEnv,
    seal?.spawn,
    undefined,
  );
  const settings = { ...(built.settings as object) };
  if (!c.pinned)
    for (const key of HELPER_KEYS)
      delete (settings as Record<string, unknown>)[key];
  const options: Options = {
    ...built,
    settings,
    // the session's env as the runner builds it, pointed at the stand-in API: the runner never lets a
    // run's own env do that
    env: {
      ...claudeProcessEnv(projectEnv, c.auth, credentialEnv),
      ANTHROPIC_BASE_URL: apiUrl,
      ...(c.scrub && { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: c.scrub }),
      ...(c.otelFromStart && {
        CLAUDE_CODE_ENABLE_TELEMETRY: "1",
        OTEL_METRICS_EXPORTER: "otlp",
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1",
        OTEL_METRIC_EXPORT_INTERVAL: "1000",
      }),
    },
  };

  let result: "success" | "error" = "error";
  let error: string | undefined;
  try {
    for await (const message of query({ prompt: "probe", options }))
      if (message.type === "result")
        result = message.is_error ? "error" : "success";
  } catch (caught) {
    error = caught instanceof Error ? caught.message.slice(0, 200) : "failed";
  } finally {
    api.server.close();
    await commandEnv.remove();
  }

  const read = (name: string) =>
    existsSync(join(out, name)) ? readFileSync(join(out, name), "utf8") : null;
  const lines = (name: string) =>
    (read(name) ?? "").split("\n").filter((line) => line !== "");
  const perLabel = <T>(f: (label: Label) => T) =>
    Object.fromEntries(LABELS.map((label) => [label, f(label)])) as Record<
      Label,
      T
    >;
  const names = (label: Label) => lines(`${label}.names`);
  return {
    result,
    error,
    requests: api.requests,
    helpersRan: lines("helpers.ran"),
    reloaded: existsSync(join(out, "reloaded")),
    ran: perLabel((label) => existsSync(join(out, `${label}.names`))),
    credentialNames: perLabel((label) =>
      names(label).filter((name) => CREDENTIAL_NAMES.includes(name)),
    ),
    projectNames: perLabel((label) =>
      names(label).filter((name) =>
        ["NPM_TOKEN", "GH_TOKEN", "HTTPS_PROXY"].includes(name),
      ),
    ),
    readableCarriers: perLabel((label) => lines(`${label}.carriers`)),
    sudoCarriers: perLabel((label) =>
      read(`${label}.sudo`) === null ? "no sudo" : lines(`${label}.sudo`),
    ),
  };
}

// to stderr, past the reporter, so a run's output is the findings alone
const report = (name: string, c: Case, f: Findings) =>
  process.stderr.write(
    `PROBE ${name} ${JSON.stringify({ case: c, findings: f })}\n`,
  );

const probing = Boolean(process.env.SKY_PROBE);
if (probing && kernelGap)
  process.stderr.write(`SKY_PROBE skipped: ${kernelGap}\n`);

describe.skipIf(!probing || !kernelCanBeAsked)(
  "what the repo's processes can see of the run's Claude credential",
  () => {
    describe.each(["oauth", "api-key"] as const)(
      "%s run, as Sky starts it",
      (auth) => {
        const c: Case = { auth, sealed: true, pinned: true };
        let f: Findings;
        beforeAll(async () => {
          f = await runCase(c);
          report(`sealed-${auth}`, c, f);
        }, 180_000);

        test("runs to the end on the chosen credential", () => {
          expect(f.result).toBe("success");
          expect(f.requests.length).toBeGreaterThan(0);
          expect(new Set(f.requests)).toEqual(
            new Set([auth === "oauth" ? "bearer:oauth" : "x-api-key:key"]),
          );
        });

        test.each(["sessionstart", "pretooluse", "mcp", "bash"] as const)(
          "the %s process has none of Sky's credential variables, can't read the Claude process, and has the project's secrets",
          (label) => {
            expect(f.ran[label]).toBe(true);
            expect(f.credentialNames[label]).toEqual([]);
            expect(f.readableCarriers[label]).toEqual([]);
            expect(
              f.sudoCarriers[label] === "no sudo" ||
                f.sudoCarriers[label].length === 0,
            ).toBe(true);
            expect(f.projectNames[label]).toEqual(
              expect.arrayContaining(["NPM_TOKEN", "GH_TOKEN"]),
            );
          },
        );

        test("a proxy reaches the Bash command through the command-env file", () => {
          expect(f.projectNames.bash).toContain("HTTPS_PROXY");
        });
      },
    );

    describe("control: the SDK's own spawn, no pins", () => {
      test("the Claude process's environment is readable by every command the repo starts, and a helper gets the credential in its env", async () => {
        const c: Case = {
          auth: "api-key",
          sealed: false,
          pinned: false,
          otelFromStart: true,
        };
        const f = await runCase(c);
        report("control-api-key", c, f);
        for (const label of [
          "sessionstart",
          "pretooluse",
          "mcp",
          "bash",
        ] as const)
          expect(f.readableCarriers[label]).toContain("claude");
        expect(f.ran.otel).toBe(true);
        expect(f.credentialNames.otel).toContain("ANTHROPIC_API_KEY");
      }, 180_000);

      test("the same repo under Sky's launch: the helper never runs", async () => {
        const c: Case = {
          auth: "api-key",
          sealed: true,
          pinned: true,
          otelFromStart: true,
        };
        const f = await runCase(c);
        report("sealed-otel-from-start", c, f);
        expect(f.result).toBe("success");
        expect(f.ran.otel).toBe(false);
      }, 180_000);
    });

    describe("helpers written into a settings file once the session is running", () => {
      const FILES = ["project", "local", "user"] as const;

      test.each(FILES)(
        "none of them, written to the %s file, ever runs, and the run goes on with its own credential",
        async (where) => {
          const c: Case = {
            auth: "oauth",
            sealed: true,
            pinned: true,
            midRun: where,
          };
          const f = await runCase(c);
          report(`mid-run-${where}`, c, f);
          // Claude Code reloaded the file the helpers were written to, so none running is the pins' doing
          expect(f.reloaded).toBe(true);
          expect(f.helpersRan).toEqual([]);
          expect(f.result).toBe("success");
          expect(new Set(f.requests)).toEqual(new Set(["bearer:oauth"]));
        },
        180_000,
      );

      // the same write without the pins: the reload is live for that file, or the cases above prove nothing
      test.each(FILES)(
        "control: without the pins, a helper written to the %s file ends an OAuth run",
        async (where) => {
          const c: Case = {
            auth: "oauth",
            sealed: true,
            pinned: false,
            midRun: where,
          };
          const f = await runCase(c);
          report(`control-mid-run-${where}`, c, f);
          expect(f.reloaded).toBe(true);
          // the helper doesn't run in host-managed mode, but it outranks the token, which is then not used
          expect(f.result).toBe("error");
        },
        180_000,
      );
    });

    describe("the runner itself", () => {
      // this process stays out of its commands' reach from here on, which no case after it depends on
      test("steps out of its commands' reach, which holds the credential it was launched with", () => {
        const readsParent = () =>
          spawnSync("sh", ["-c", "cat /proc/$PPID/environ"]).status === 0;
        expect(readsParent()).toBe(true);
        expect(hideRunner()).toBeUndefined();
        expect(readsParent()).toBe(false);
        report("runner", { auth: "oauth", sealed: true, pinned: true }, {
          result: "success",
        } as Findings);
      });
    });

    describe("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, recorded", () => {
      test("what the scrub removes on this sandbox", async () => {
        const c: Case = {
          auth: "api-key",
          sealed: false,
          pinned: true,
          scrub: "1",
        };
        const f = await runCase(c);
        report("scrub-1", c, f);
        expect(f.ran.sessionstart).toBe(true);
      }, 180_000);
    });
  },
);
