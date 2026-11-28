// The pi runtime end to end, on a sprite or any Linux machine, with nothing mocked but the two
// services a sprite reaches over the network:
//   - Sky's API (`/internal/events`, the decision long-poll): a local server that records every event
//     and answers each approval request with the decision this script holds for it;
//   - GitHub's REST API behind the Sprites connector: a local server that implements the git data
//     calls `publish` makes, so the runner's real publish code and broker run unchanged.
// The runner (`dist/bundle/runner.mjs`), `pi --mode rpc` and the model (Vercel AI Gateway) are real.
//
//   pnpm --filter @sky/runner build
//   AI_GATEWAY_API_KEY=... SKY_PI_BIN=/opt/sky/node_modules/.bin/pi [SKY_PI_MODEL=...] \
//     node packages/runner/e2e/pi-e2e.mjs
//
// `--mock-gateway` swaps the model for a scripted one on a local server, to check this harness and the
// runner without a key or a model's variance: no AI_GATEWAY_API_KEY needed, and one more run (a 402 from
// the gateway) that a real gateway can't be made to give. The runner bundle is copied beside itself with
// the gateway's URL pointed at the local server; the runner itself has no such setting.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const mock = process.argv.includes("--mock-gateway");
const here = dirname(fileURLToPath(import.meta.url));
const bundle = join(here, "../dist/bundle/runner.mjs");
const bin = process.env.SKY_PI_BIN;
const gatewayKey = mock ? "mock-gateway-key" : process.env.AI_GATEWAY_API_KEY;
if (!gatewayKey || !bin) {
  console.error(
    "set AI_GATEWAY_API_KEY and SKY_PI_BIN (or pass --mock-gateway)",
  );
  process.exit(2);
}
const root = mkdtempSync(join(tmpdir(), "sky-pi-e2e-"));
const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const gitEnv = {
  GIT_AUTHOR_NAME: "Sky Agent",
  GIT_AUTHOR_EMAIL: "agent@sky.local",
  GIT_COMMITTER_NAME: "Sky Agent",
  GIT_COMMITTER_EMAIL: "agent@sky.local",
};

// --- the repo: a bare origin, and the sprite's clone of it, whose origin URL names GitHub -------------
const origin = join(root, "origin.git");
const seed = join(root, "seed");
git(root, "init", "-q", "--bare", "-b", "main", origin);
git(root, "init", "-q", "-b", "main", seed);
mkdirSync(join(seed, "src"));
writeFileSync(join(seed, "src/greeting.txt"), "hello world\n");
writeFileSync(join(seed, "README.md"), "# demo\n");
git(seed, "add", "-A");
git(
  seed,
  "-c",
  "user.name=t",
  "-c",
  "user.email=t@t",
  "commit",
  "-q",
  "-m",
  "seed",
);
git(seed, "push", "-q", origin, "main");
const repoDir = join(root, "workspace/repo");
const worktreesDir = join(root, "workspace/worktrees");
mkdirSync(worktreesDir, { recursive: true });
git(root, "clone", "-q", origin, repoDir);
git(repoDir, "remote", "set-head", "origin", "main");
git(repoDir, "remote", "set-url", "origin", "https://github.com/acme/demo.git");
const baseSha = git(repoDir, "rev-parse", "origin/main");

// --- the fake GitHub (the connector's gateway) -------------------------------------------------------
const gh = {
  blobs: new Set(),
  refs: new Map([["heads/main", baseSha]]),
  pulls: [],
  calls: [],
};
const fakeSha = (s) => createHash("sha1").update(s).digest("hex");
const github = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => {
    body += c;
  });
  req.on("end", () => {
    const url = new URL(req.url, "http://x");
    const path = url.pathname.replace(/^\/[^/]+\/repos\/[^/]+\/[^/]+/, "");
    gh.calls.push(`${req.method} ${path}`);
    const send = (code, json) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };
    const json = body ? JSON.parse(body) : {};
    if (req.method === "GET" && path === "") return send(200, {});
    if (req.method === "GET" && path === "/pulls") {
      const head = url.searchParams.get("head")?.split(":").pop();
      return send(
        200,
        head ? gh.pulls.filter((pull) => pull.head === head) : gh.pulls,
      );
    }
    if (req.method === "GET" && path.startsWith("/git/ref/")) {
      const sha = gh.refs.get(path.slice("/git/ref/".length));
      return sha
        ? send(200, { object: { sha } })
        : send(404, { message: "Not Found" });
    }
    if (req.method === "GET" && path.startsWith("/git/blobs/"))
      return send(gh.blobs.has(path.split("/").pop()) ? 200 : 404, {
        sha: path.split("/").pop(),
      });
    if (req.method === "POST" && path === "/git/blobs") {
      const sha = fakeSha(json.content);
      gh.blobs.add(sha);
      return send(201, { sha });
    }
    if (req.method === "POST" && path === "/git/trees")
      return send(201, { sha: fakeSha(JSON.stringify(json)) });
    if (req.method === "POST" && path === "/git/commits")
      return send(201, { sha: fakeSha(JSON.stringify(json)) });
    if (req.method === "POST" && path === "/git/refs") {
      gh.refs.set(json.ref.replace(/^refs\//, ""), json.sha);
      return send(201, {});
    }
    if (req.method === "POST" && path === "/pulls") {
      const pull = {
        number: 1,
        html_url: "https://github.example/acme/demo/pull/1",
        ...json,
      };
      gh.pulls.push(pull);
      return send(201, pull);
    }
    return send(404, { message: `fake gateway has no ${req.method} ${path}` });
  });
});

// --- the fake Sky API ---------------------------------------------------------------------------------
const events = [];
const requests = new Map();
let decideFor = () => ({ decision: "approve" });
const sky = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => {
    body += c;
  });
  req.on("end", async () => {
    if (req.method === "POST" && req.url === "/internal/events") {
      const event = JSON.parse(body);
      events.push(event);
      if (event.type === "run.waiting")
        requests.set(event.payload.request.requestId, event.payload.request);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end("{}");
    }
    const match = /\/requests\/(req_\w+)$/.exec(req.url);
    if (match) {
      const request = requests.get(match[1]);
      if (!request) {
        res.writeHead(404);
        return res.end("{}");
      }
      await new Promise((r) => setTimeout(r, 300));
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          status: "decided",
          decision: { requestId: request.requestId, ...decideFor(request) },
        }),
      );
    }
    res.writeHead(404);
    res.end("{}");
  });
});

// --- the scripted model, with --mock-gateway: an OpenAI-compatible chat completions server -----------
// A run's script is named by the `(e2e:<name>)` its prompt carries; the step is the number of replies the
// model has already given since that prompt, so a script is a list of what to do after each tool result.
const seen = { auths: new Set(), bodies: [] };
const lastText = (messages) =>
  [...messages].reverse().find((m) => m.role === "tool")?.content ?? "";
const scripts = {
  one: (step, messages) =>
    [
      { calls: [["bash", { command: "git status" }]] },
      { calls: [["read", { path: "src/greeting.txt" }]] },
      {
        calls: [
          [
            "edit",
            {
              path: "src/greeting.txt",
              edits: [{ oldText: "hello world", newText: "hello from pi" }],
            },
          ],
        ],
      },
      { calls: [["bash", { command: "mkdir notes" }]] },
      { calls: [["bash", { command: "git add -A" }]] },
      { calls: [["bash", { command: "git commit -m 'Update greeting'" }]] },
      { calls: [["bash", { command: "touch denied.txt" }]] },
      { calls: [["sky_publish", { title: "Update greeting" }]] },
      { text: `Published: ${lastText(messages)}` },
    ][step],
  two: (_step, messages) => ({
    text: JSON.stringify(messages).includes("hello from pi")
      ? "I edited src/greeting.txt earlier and wrote `hello from pi` in it."
      : "I have no memory of an edit.",
  }),
  resumed: (step, messages) =>
    [
      {
        calls: [
          [
            "edit",
            {
              path: "README.md",
              edits: [{ oldText: "# demo", newText: "# demo\nsecond turn" }],
            },
          ],
        ],
      },
      { calls: [["bash", { command: "git add -A" }]] },
      { calls: [["bash", { command: "git commit -m 'Add second line'" }]] },
      {
        calls: [
          [
            "sky_publish",
            { title: "Second publish", branch: "claude/agt_e2e-resume" },
          ],
        ],
      },
      { text: `Published: ${lastText(messages)}` },
    ][step],
  denied: (step, messages) =>
    [
      {
        calls: [
          [
            "edit",
            {
              path: "README.md",
              edits: [{ oldText: "# demo", newText: "# demo\ndenied?" }],
            },
          ],
        ],
      },
      { text: `I was refused: ${lastText(messages)}` },
    ][step],
  probe: (step) =>
    [
      {
        calls: [
          [
            "bash",
            {
              command:
                "printenv AI_GATEWAY_API_KEY SKY_PI_GATEWAY_TOKEN | wc -c",
            },
          ],
        ],
      },
      { calls: [["bash", { command: "nohup sleep 3017 >/dev/null 2>&1 &" }]] },
      {
        calls: [
          [
            "bash",
            {
              command:
                "for p in $(pgrep -x pi); do echo \"pid $p\"; cat /proc/$p/environ 2>&1 | tr '\\0' '\\n' | grep -cE '^(AI_GATEWAY_API_KEY|SKY_PI_GATEWAY_TOKEN)='; done",
            },
          ],
        ],
      },
      { text: "done" },
    ][step],
  long: (step) =>
    [{ calls: [["bash", { command: "sleep 3019" }]] }, { text: "done" }][step],
  skill: (_step, messages) => ({
    text: JSON.stringify(messages[0]).includes("e2e-fruit")
      ? "kumquat"
      : "I have no such skill.",
  }),
  credit: () => ({ status: 402 }),
};
const chunk = (delta, finish = null) =>
  `data: ${JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const gateway = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => {
    body += c;
  });
  req.on("end", () => {
    seen.auths.add(req.headers.authorization);
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404);
      return res.end("{}");
    }
    const { messages } = JSON.parse(body);
    seen.bodies.push(JSON.parse(body));
    const lastUser = messages.findLastIndex((m) => m.role === "user");
    const prompt = JSON.stringify(messages[lastUser]?.content);
    const name = /\(e2e:(\w+)\)/.exec(prompt)?.[1];
    const step = messages
      .slice(lastUser)
      .filter((m) => m.role === "assistant").length;
    const reply = scripts[name]?.(step, messages) ?? { text: "(no script)" };
    if (reply.status) {
      res.writeHead(reply.status, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({ error: { message: "insufficient credits" } }),
      );
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (reply.text !== undefined) {
      res.write(chunk({ role: "assistant", content: reply.text }));
      res.write(chunk({}, "stop"));
    } else {
      reply.calls.forEach(([tool, args], i) => {
        res.write(
          chunk({
            role: "assistant",
            tool_calls: [
              {
                index: i,
                id: `call_${name}_${step}_${i}`,
                type: "function",
                function: { name: tool, arguments: JSON.stringify(args) },
              },
            ],
          }),
        );
      });
      res.write(chunk({}, "tool_calls"));
    }
    res.write(
      `data: ${JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion.chunk", created: 0, model: "mock", choices: [], usage: { prompt_tokens: 120, completion_tokens: 12, total_tokens: 132 } })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  });
});

const listen = (server) =>
  new Promise((r) =>
    server.listen(0, "127.0.0.1", () => r(server.address().port)),
  );
const skyPort = await listen(sky);
const ghPort = await listen(github);
let runner = bundle;
if (mock) {
  const gatewayPort = await listen(gateway);
  // the bundle's gateway URL, pointed at the scripted model; copied beside the original so it still
  // resolves the Agent SDK it leaves external
  const source = readFileSync(bundle, "utf8");
  const url = "https://ai-gateway.vercel.sh/v1";
  if (!source.includes(url)) {
    console.error(`the runner bundle doesn't hold ${url}: rebuild it`);
    process.exit(2);
  }
  runner = join(dirname(bundle), "runner.mock-gateway.mjs");
  writeFileSync(
    runner,
    source.replaceAll(url, `http://127.0.0.1:${gatewayPort}/v1`),
  );
}

// --- one run of the real runner ----------------------------------------------------------------------
const home = join(root, "home");
mkdirSync(home);
async function run(runId, prompt, sessionId, until, extraEnv = {}) {
  const from = events.length;
  const env = {
    ...extraEnv,
    PATH: process.env.PATH,
    HOME: home,
    ...gitEnv,
    AGENT_ID: "agt_e2e",
    RUN_ID: runId,
    PROMPT: prompt,
    ...(sessionId && { SESSION_ID: sessionId }),
    API_BASE_URL: `http://127.0.0.1:${skyPort}`,
    AGENT_TOKEN: "tok",
    SKY_RUNTIME: "pi",
    ...(process.env.SKY_PI_MODEL && { SKY_PI_MODEL: process.env.SKY_PI_MODEL }),
    REPO_DIR: repoDir,
    WORKTREES_DIR: worktreesDir,
    // holds every Bash command (the read-only ones skip it) and file change for a person; publish and
    // sync ask through the broker
    APPROVAL_POLICY: JSON.stringify(["Bash", "Edit", "Write"]),
    GITHUB_CONNECTOR: "conn1",
    GITHUB_GATEWAY_URL: `http://127.0.0.1:${ghPort}`,
    AI_GATEWAY_API_KEY: gatewayKey,
    SKY_PI_BIN: bin,
    // the clone's origin is a github.com URL this machine can't fetch from, as a sprite's is without a
    // credential: the runner's fetch fails and it reads the base through the connector's gateway
    GIT_TERMINAL_PROMPT: "0",
  };
  const child = spawn(process.execPath, [runner, runId], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (c) => {
    log += c;
  });
  child.stderr.on("data", (c) => {
    log += c;
  });
  // `until` names the moment to stop the run: a SIGTERM, as the API's stop sends
  const stopper = until
    ? setInterval(() => {
        if (until(events.slice(from))) {
          child.kill("SIGTERM");
          clearInterval(stopper);
        }
      }, 200)
    : undefined;
  const code = await new Promise((r) => child.on("exit", (c, s) => r(c ?? s)));
  clearInterval(stopper);
  return { code, log, events: events.slice(from) };
}
const show = (e) => {
  const p = e.payload;
  const detail =
    e.type === "run.waiting"
      ? `${p.request.kind} ${p.request.toolName ?? ""} :: ${(p.request.toolSummary ?? p.request.prompt ?? "").split("\n")[0].slice(0, 90)}`
      : e.type.startsWith("claude.P")
        ? `${p.toolName} ${(p.input ?? "").slice(0, 90)}${p.autoApproved ? ` [${p.autoApproved.verdict}]` : ""}`
        : e.type === "claude.Message"
          ? p.text.slice(0, 100)
          : e.type === "run.finished"
            ? `${p.summary.slice(0, 100)} | usage ${JSON.stringify(p.usage)} | commits ${p.rollup?.run.commits.map((c) => c.subject)}`
            : e.type === "run.failed"
              ? p.error
              : e.type === "run.started"
                ? p.sessionId
                : e.type === "runner.warning"
                  ? p.message.slice(0, 120)
                  : "";
  return `  ${e.type.padEnd(26)} ${detail}`;
};
const print = (r) =>
  console.log(
    r.events
      .filter((e) => e.type !== "runner.heartbeat")
      .map(show)
      .join("\n"),
  );

const result = { checks: [] };
const check = (name, ok, note = "") => {
  result.checks.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? ` (${note})` : ""}`);
};
const waitingOf = (r) =>
  r.events
    .filter((e) => e.type === "run.waiting")
    .map((e) => e.payload.request);
const messagesOf = (r) =>
  r.events
    .filter((e) => e.type === "claude.Message")
    .map((e) => e.payload.text)
    .join(" ");

// the values themselves, never their names: the gateway key, the connector, the event token, and any
// 32-hex-digit string, which is what the runner's per-call broker token looks like (a `req_` id, a
// model's call id and a git sha are not matched); the proxy token is made per run, so it is matched by
// its shape: 64 hex digits
const TOKEN_SHAPE = /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/g;
// probe check notes go through this, so a key or token a probe caught is never printed
const mask = (text) =>
  text.replaceAll(gatewayKey, "<key>").replace(TOKEN_SHAPE, "<token>");
const leaks = (text) => {
  const found = [];
  if (text.includes(gatewayKey)) found.push("gateway key");
  if (new RegExp(TOKEN_SHAPE).test(text)) found.push("proxy token");
  if (text.includes("conn1")) found.push("connector");
  if (text.includes('"tok"')) found.push("event token");
  if (/(?<![0-9a-f_-])[0-9a-f]{32}(?![0-9a-f])/.test(text))
    found.push("32-hex string");
  return found;
};
const worktree = join(worktreesDir, "agt_e2e");

console.log(
  `== run 1: read, edit, one command approved and one denied, commit, publish${mock ? " (scripted model)" : ""} ==`,
);
// a command is denied when it touches `denied.txt`; everything else asked is approved
decideFor = (request) =>
  /denied\.txt/.test(request.toolSummary ?? "")
    ? { decision: "deny", reason: "no stray files" }
    : { decision: "approve" };
const first = await run(
  "run_one",
  "(e2e:one) Do these steps in order with your tools, and skip none. 1. Run `git status` with bash. 2. Read src/greeting.txt with the read tool. 3. Use the edit tool to change src/greeting.txt so that it contains exactly `hello from pi`. 4. Run `mkdir notes` with bash. 5. Run `git add -A` with bash. 6. Run `git commit -m 'Update greeting'` with bash. 7. Run `touch denied.txt` with bash; if you are refused, say why and go on. 8. Publish the branch with the sky_publish tool, with the title `Update greeting`. Report the pull request URL.",
);
print(first);
const types = first.events.map((e) => e.type);
const waiting = waitingOf(first);
const started = first.events.find((e) => e.type === "run.started");
const finished = first.events.find((e) => e.type === "run.finished");
const tools = first.events.filter((e) => e.type === "claude.PreToolUse");
check(
  "run 1 exit 0 and run.finished",
  first.code === 0 && types.includes("run.finished"),
  `exit ${first.code}`,
);
check(
  "run.started carries the pi session id",
  (started?.payload.sessionId ?? "").length > 0,
  started?.payload.sessionId,
);
check(
  "the read ran with its event and no question",
  tools.some((e) => e.payload.toolName === "Read") &&
    !waiting.some((r) => r.toolName === "Read"),
);
check(
  "a read-only command self-approved: its event carries the note and no request was opened for it",
  tools.some(
    (e) =>
      e.payload.toolName === "Bash" &&
      e.payload.input.includes("git status") &&
      e.payload.autoApproved,
  ) && !waiting.some((r) => (r.toolSummary ?? "").includes("git status")),
);
check(
  "a file-change approval was asked, with the file's path, and approved",
  waiting.some(
    (r) =>
      r.kind === "approval" &&
      r.toolName === "Edit" &&
      (r.toolSummary ?? "").endsWith("src/greeting.txt"),
  ),
);
check(
  "a command approval was asked with the real command, and approved: it ran",
  waiting.some(
    (r) =>
      r.toolName === "Bash" && (r.toolSummary ?? "").includes("mkdir notes"),
  ) && existsSync(join(worktree, "notes")),
);
check(
  "the denied command was asked, and failed with the person's reason",
  waiting.some((r) => (r.toolSummary ?? "").includes("denied.txt")) &&
    first.events.some(
      (e) =>
        e.type === "claude.PostToolUseFailure" &&
        e.payload.input.includes("denied.txt") &&
        e.payload.error.includes("no stray files"),
    ),
);
check(
  "the denied command did not run",
  !existsSync(join(worktree, "denied.txt")),
);
check(
  "the publish approval came from the broker",
  waiting.some((r) => r.toolName === "Publish"),
);
check(
  "tool events: PreToolUse and PostToolUse",
  types.includes("claude.PreToolUse") && types.includes("claude.PostToolUse"),
);
check("claude.Message events", types.includes("claude.Message"));
check(
  "no broker token, connector, event token, gateway key or proxy token reached an event",
  leaks(JSON.stringify(first.events)).length === 0,
  leaks(JSON.stringify(first.events)).join(", "),
);
check(
  "file edited on disk",
  readFileSync(join(worktree, "src/greeting.txt"), "utf8").trim() ===
    "hello from pi",
);
check(
  "commit in the worktree",
  git(worktree, "log", "--format=%s", "-3").includes("Update greeting"),
);
check(
  "fake GitHub got a ref and a pull request",
  gh.refs.has("heads/claude/agt_e2e") && gh.pulls.length === 1,
  gh.calls.slice(-4).join(", "),
);
check(
  "run.finished has token usage (and pi's cost estimate) and a rollup",
  finished?.payload.usage.turns > 0 &&
    finished?.payload.usage.inputTokens > 0 &&
    finished?.payload.usage.outputTokens > 0 &&
    finished?.payload.usage.costUsd >= 0 &&
    finished?.payload.rollup?.run.commits.length >= 1,
  JSON.stringify(finished?.payload.usage),
);
if (mock)
  check(
    "the model saw the gateway key the proxy swapped in, and never the run's token",
    [...seen.auths].every((a) => a === `Bearer ${gatewayKey}`),
    [...seen.auths].map((a) => mask(String(a))).join(", "),
  );

console.log("\n== run 2: resume the session ==");
const second = await run(
  "run_two",
  "(e2e:two) Without changing anything: which file did you edit earlier in this conversation, and what did you write in it? One sentence.",
  started?.payload.sessionId,
);
print(second);
const answer = messagesOf(second);
check("run 2 exit 0", second.code === 0, `exit ${second.code}`);
check(
  "run 2 resumed the same session",
  second.events.find((e) => e.type === "run.started")?.payload.sessionId ===
    started?.payload.sessionId,
);
check(
  "run 2's answer shows the earlier turn's context",
  /greeting/i.test(answer) && /hello from pi/i.test(answer),
  answer.slice(0, 120),
);

console.log("\n== run 2b: the resumed session edits, commits and publishes ==");
const resumed = await run(
  "run_twob",
  "(e2e:resumed) Use the edit tool to add the line `second turn` to README.md. Then run `git add -A` and `git commit -m 'Add second line'`. Then publish with the sky_publish tool, with the title `Second publish` and the branch `claude/agt_e2e-resume`. Report the pull request URL.",
  started?.payload.sessionId,
);
print(resumed);
check(
  "resumed run finished",
  resumed.code === 0 && resumed.events.some((e) => e.type === "run.finished"),
  `exit ${resumed.code}`,
);
check(
  "the resumed session has the runner's tools: it asked to publish, through the broker",
  waitingOf(resumed).some((r) => r.toolName === "Publish"),
);
check(
  "the resumed session's publish reached the fake GitHub",
  gh.refs.has("heads/claude/agt_e2e-resume") && gh.pulls.length === 2,
  gh.calls.slice(-4).join(", "),
);
check(
  "no secret reached the resumed run's events",
  leaks(JSON.stringify(resumed.events)).length === 0,
  leaks(JSON.stringify(resumed.events)).join(", "),
);

console.log("\n== run 3: a denied approval, with a reason ==");
decideFor = (request) =>
  request.toolName === "Edit" || request.toolName === "Write"
    ? { decision: "deny", reason: "leave README alone" }
    : { decision: "approve" };
const third = await run(
  "run_three",
  "(e2e:denied) Use the edit tool to append the line `denied?` to README.md. If you are refused, say so, quote any reason you were given, and stop.",
);
print(third);
const thirdAnswer = messagesOf(third);
check("run 3 finished", third.code === 0, `exit ${third.code}`);
check(
  "denied edit did not change README",
  !readFileSync(join(worktree, "README.md"), "utf8").includes("denied?"),
);
check(
  "denied call is a PostToolUseFailure",
  third.events.some((e) => e.type === "claude.PostToolUseFailure"),
);
check(
  "the denial's reason reached the model",
  /README alone/i.test(thirdAnswer),
  thirdAnswer.slice(0, 120),
);
decideFor = () => ({ decision: "approve" });

const alive = (needle) =>
  execFileSync("ps", ["-eo", "args"], { encoding: "utf8" })
    .split("\n")
    .some((l) => l.includes(needle) && !l.includes("ps -eo"));

console.log(
  "\n== run 4: the gateway key and proxy token stay out of the agent's shell; a daemonised process is reaped ==",
);
const fourth = await run(
  "run_four",
  "(e2e:probe) Run these three shell commands, one at a time, and report their output verbatim. First: `printenv AI_GATEWAY_API_KEY SKY_PI_GATEWAY_TOKEN | wc -c`. Second: `nohup sleep 3017 >/dev/null 2>&1 &`. Third: `for p in $(pgrep -x pi); do echo \"pid $p\"; cat /proc/$p/environ 2>&1 | tr '\\0' '\\n' | grep -cE '^(AI_GATEWAY_API_KEY|SKY_PI_GATEWAY_TOKEN)='; done`. Then reply `done`.",
);
print(fourth);
// the loop's last `grep -c` finds nothing and exits 1, so the call may come back as a failure: the
// output is in `error` then
const environProbe = fourth.events.find(
  (e) =>
    (e.type === "claude.PostToolUse" ||
      e.type === "claude.PostToolUseFailure") &&
    e.payload.input.includes("/environ") &&
    e.payload.input.includes("SKY_PI_GATEWAY_TOKEN"),
);
const probeOutput =
  environProbe?.payload.output ?? environProbe?.payload.error ?? "";
const probedPids = probeOutput.match(/^pid \d+$/gm) ?? [];
const probeCounts = probeOutput.match(/^\d+$/gm) ?? [];
const keyProbe = fourth.events.find(
  (e) =>
    e.type === "claude.PostToolUse" &&
    e.payload.input.includes("printenv") &&
    e.payload.input.includes("SKY_PI_GATEWAY_TOKEN"),
);
check("run 4 finished", fourth.code === 0, `exit ${fourth.code}`);
check(
  "neither the gateway key nor the proxy token is in the agent's shell (printenv prints nothing)",
  keyProbe?.payload.output.trim() === "0",
  mask(keyProbe?.payload.output.trim() ?? ""),
);
check(
  "the agent's command found pi's process and read neither the key nor the token from its environ",
  probedPids.length > 0 &&
    probeCounts.length === probedPids.length &&
    probeCounts.every((n) => n === "0") &&
    leaks(probeOutput).length === 0,
  mask(probeOutput.trim()),
);
check(
  "the daemonised `sleep 3017` was reaped at run end",
  !alive("sleep 3017"),
);

console.log(
  "\n== run 5: a long call heartbeats, and a stop ends the run and its processes ==",
);
const fifth = await run(
  "run_five",
  "(e2e:long) Run the shell command `sleep 3019` and wait for it to finish. Do nothing else.",
  undefined,
  (evs) => evs.some((e) => e.type === "runner.heartbeat"),
);
console.log(fifth.events.map(show).join("\n"));
check(
  "a runner.heartbeat named the running Bash call",
  fifth.events.some(
    (e) => e.type === "runner.heartbeat" && e.payload.toolName === "Bash",
  ),
);
check(
  "SIGTERM ended the run as run.failed 'interrupted by SIGTERM'",
  fifth.events.some(
    (e) =>
      e.type === "run.failed" && /interrupted by SIGTERM/.test(e.payload.error),
  ),
  String(fifth.code),
);
check("the stopped run left no `sleep 3019`", !alive("sleep 3019"));

console.log("\n== run 6: a skill directory the environment names loads ==");
// installed as an environment's setup would install one: an ordinary SKILL.md under $HOME/.sky/pi/skills
const skillDir = join(home, ".sky/pi/skills/e2e-fruit");
mkdirSync(skillDir, { recursive: true });
writeFileSync(
  join(skillDir, "SKILL.md"),
  "---\nname: e2e-fruit\ndescription: The e2e fruit word. Use when asked for the e2e fruit word.\n---\n\n# e2e fruit\n\nThe e2e fruit word is kumquat. Reply with it and nothing else.\n",
);
const sixth = await run(
  "run_six",
  "(e2e:skill) What is the e2e fruit word? Use your skills to find out, and reply with only that word.",
  undefined,
  undefined,
  { SKY_PI_SKILLS: "~/.sky/pi/skills" },
);
print(sixth);
check("run 6 finished", sixth.code === 0, `exit ${sixth.code}`);
check(
  "the skill loaded: the model answered from it",
  /kumquat/i.test(messagesOf(sixth)),
  messagesOf(sixth).slice(0, 80),
);

let credit;
if (mock) {
  console.log(
    "\n== run 7: the gateway out of credit fails the run pi_unavailable ==",
  );
  credit = await run("run_seven", "(e2e:credit) Say hello.");
  print(credit);
  const failure = credit.events.find((e) => e.type === "run.failed");
  check(
    "a 402 from the gateway fails the run as pi_unavailable, out of credit",
    credit.code === 1 &&
      /^pi_unavailable: the AI Gateway is out of credit/.test(
        failure?.payload.error ?? "",
      ),
    failure?.payload.error.slice(0, 120),
  );
}

for (const [n, r] of [
  ["run1", first],
  ["run2", second],
  ["run2b", resumed],
  ["run3", third],
  ["run4", fourth],
  ["run5", fifth],
  ["run6", sixth],
  ...(credit ? [["run7", credit]] : []),
])
  writeFileSync(join(root, `${n}.log`), r.log);
writeFileSync(join(root, "events.json"), JSON.stringify(events, null, 1));
console.log(`\nlogs and events: ${root}`);
const failed = result.checks.filter((c) => !c.ok);
console.log(
  `${result.checks.length - failed.length}/${result.checks.length} passed`,
);
console.log(failed.length ? `${failed.length} FAILED` : "ALL PASSED");
sky.close();
github.close();
gateway.close();
process.exit(failed.length ? 1 : 0);
