// The Codex runtime end to end, on a sprite or any Linux machine, with nothing mocked but the two
// services a sprite reaches over the network:
//   - Sky's API (`/internal/events`, the decision long-poll): a local server that records every event
//     and answers each approval request with the decision this script holds for it;
//   - GitHub's REST API behind the Sprites connector: a local server that implements the git data
//     calls `publish` makes, so the runner's real publish code and broker run unchanged.
// The runner (`dist/bundle/runner.mjs`), `codex app-server` and the model (Vercel AI Gateway) are real.
//
//   pnpm --filter @sky/runner build
//   AI_GATEWAY_API_KEY=... SKY_CODEX_BIN=/opt/sky/node_modules/.bin/codex [SKY_CODEX_MODEL=...] \
//     node packages/runner/e2e/codex-e2e.mjs
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

const here = dirname(fileURLToPath(import.meta.url));
const runner = join(here, "../dist/bundle/runner.mjs");
const bin = process.env.SKY_CODEX_BIN;
if (!process.env.AI_GATEWAY_API_KEY || !bin) {
  console.error("set AI_GATEWAY_API_KEY and SKY_CODEX_BIN");
  process.exit(2);
}
const root = mkdtempSync(join(tmpdir(), "sky-codex-e2e-"));
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
const listen = (server) =>
  new Promise((r) =>
    server.listen(0, "127.0.0.1", () => r(server.address().port)),
  );
const skyPort = await listen(sky);
const ghPort = await listen(github);

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
    SKY_RUNTIME: "codex",
    ...(process.env.SKY_CODEX_MODEL && {
      SKY_CODEX_MODEL: process.env.SKY_CODEX_MODEL,
    }),
    REPO_DIR: repoDir,
    WORKTREES_DIR: worktreesDir,
    // holds every file change for a person; Bash runs unasked; publish and sync ask through the broker
    APPROVAL_POLICY: JSON.stringify(["Edit", "Write"]),
    GITHUB_CONNECTOR: "conn1",
    GITHUB_GATEWAY_URL: `http://127.0.0.1:${ghPort}`,
    AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY,
    SKY_CODEX_BIN: bin,
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

console.log("== run 1: edit a file (approval), commit, publish (approval) ==");
const first = await run(
  "run_one",
  "Using apply_patch (not the shell), change src/greeting.txt so it contains exactly `hello from codex`. Then run `git add -A` and `git commit -m 'Update greeting'`. Then publish the branch with the sky_publish tool, with the title `Update greeting`. Report the pull request URL.",
);
print(first);
const types = first.events.map((e) => e.type);
const waiting = first.events
  .filter((e) => e.type === "run.waiting")
  .map((e) => e.payload.request);
const started = first.events.find((e) => e.type === "run.started");
check(
  "run 1 exit 0 and run.finished",
  first.code === 0 && types.includes("run.finished"),
  `exit ${first.code}`,
);
check(
  "run.started carries the Codex thread id",
  (started?.payload.sessionId ?? "").length > 0,
  started?.payload.sessionId,
);
check(
  "a file-change approval was asked and approved",
  waiting.some(
    (r) =>
      r.kind === "approval" &&
      (r.toolName === "Edit" || r.toolName === "Write"),
  ),
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
// the values themselves, never their names: the gateway key, the connector, the event token, and any
// 32-hex-digit string, which is what the runner's per-call broker token looks like (a `req_` id, the
// model's `chatcmpl-tool-` call id and a git sha are not matched)
const leaks = (text) => {
  const found = [];
  if (text.includes(process.env.AI_GATEWAY_API_KEY)) found.push("gateway key");
  if (text.includes("conn1")) found.push("connector");
  if (text.includes('"tok"')) found.push("event token");
  if (/(?<![0-9a-f_-])[0-9a-f]{32}(?![0-9a-f])/.test(text))
    found.push("32-hex string");
  return found;
};
check(
  "no broker token, connector, event token or gateway key reached an event",
  leaks(JSON.stringify(first.events)).length === 0,
  leaks(JSON.stringify(first.events)).join(", "),
);
const worktree = join(worktreesDir, "agt_e2e");
check(
  "file edited on disk",
  readFileSync(join(worktree, "src/greeting.txt"), "utf8").trim() ===
    "hello from codex",
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
const finished = first.events.find((e) => e.type === "run.finished");
check(
  "run.finished has usage and a rollup",
  finished?.payload.usage.turns > 0 &&
    finished?.payload.rollup?.run.commits.length >= 1,
);

console.log("\n== run 2: resume the session ==");
const second = await run(
  "run_two",
  "Without changing anything: which file did you edit earlier in this conversation, and what did you write in it? One sentence.",
  started?.payload.sessionId,
);
print(second);
const answer = second.events
  .filter((e) => e.type === "claude.Message")
  .map((e) => e.payload.text)
  .join(" ");
check("run 2 exit 0", second.code === 0, `exit ${second.code}`);
check(
  "run 2 resumed the same session",
  second.events.find((e) => e.type === "run.started")?.payload.sessionId ===
    started?.payload.sessionId,
);
check(
  "run 2's answer shows the earlier turn's context",
  /greeting/i.test(answer) && /hello from codex/i.test(answer),
  answer.slice(0, 120),
);

console.log("\n== run 2b: the resumed thread edits, commits and publishes ==");
const resumed = await run(
  "run_twob",
  "Using apply_patch (not the shell), append the line `second turn` to README.md. Then run `git add -A` and `git commit -m 'Add second line'`. Then publish with the sky_publish tool, with the title `Second publish` and the branch `claude/agt_e2e-resume`. Report the pull request URL.",
  started?.payload.sessionId,
);
print(resumed);
const resumedWaiting = resumed.events
  .filter((e) => e.type === "run.waiting")
  .map((e) => e.payload.request);
check(
  "resumed run finished",
  resumed.code === 0 && resumed.events.some((e) => e.type === "run.finished"),
  `exit ${resumed.code}`,
);
check(
  "resumed run is on the same thread",
  resumed.events.find((e) => e.type === "run.started")?.payload.sessionId ===
    started?.payload.sessionId,
);
check(
  "the resumed thread asked to publish, through the broker",
  resumedWaiting.some((r) => r.toolName === "Publish"),
);
check(
  "the resumed thread's publish reached the fake GitHub",
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
  "Append the line `denied?` to README.md using apply_patch. If you are refused, say so, quote any reason you were given, and stop.",
);
print(third);
const thirdAnswer = third.events
  .filter((e) => e.type === "claude.Message")
  .map((e) => e.payload.text)
  .join(" ");
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
  "\n== run 4: the gateway key stays out of the agent's shell; a daemonised process is reaped ==",
);
const fourth = await run(
  "run_four",
  "Run these three shell commands, one at a time, and report their output verbatim. First: `printenv AI_GATEWAY_API_KEY | wc -c`. Second: `nohup sleep 3017 >/dev/null 2>&1 &`. Third: `for p in $(ps -eo pid,args | grep '[a]pp-server' | awk '{print $1}'); do echo \"pid $p\"; cat /proc/$p/environ 2>&1 | tr '\\0' '\\n' | grep -c '^AI_GATEWAY_API_KEY='; done`. Then reply `done`.",
);
print(fourth);
// the loop's last `grep -c` finds nothing and exits 1, so the call may come back as a failure: the
// output is in `error` then
const environProbe = fourth.events.find(
  (e) =>
    (e.type === "claude.PostToolUse" ||
      e.type === "claude.PostToolUseFailure") &&
    e.payload.input.includes("/environ"),
);
const probeOutput =
  environProbe?.payload.output ?? environProbe?.payload.error ?? "";
const probedPids = probeOutput.match(/^pid \d+$/gm) ?? [];
const probeCounts = probeOutput.match(/^\d+$/gm) ?? [];
const keyProbe = fourth.events.find(
  (e) =>
    e.type === "claude.PostToolUse" && e.payload.input.includes("printenv"),
);
check("run 4 finished", fourth.code === 0, `exit ${fourth.code}`);
check(
  "AI_GATEWAY_API_KEY is not in the agent's shell (printenv prints nothing)",
  keyProbe?.payload.output.trim().startsWith("0"),
  keyProbe?.payload.output.trim(),
);
check(
  "the agent's command found Codex's process and read nothing of its environ",
  probedPids.length > 0 &&
    probeCounts.length === probedPids.length &&
    probeCounts.every((n) => n === "0") &&
    !probeOutput.includes(process.env.AI_GATEWAY_API_KEY),
  probeOutput.replaceAll(process.env.AI_GATEWAY_API_KEY, "<key>").trim(),
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
  "Run the shell command `sleep 3019` and wait for it to finish. Do nothing else.",
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

console.log(
  "\n== run 6: a plugin the environment names loads, and its hook runs without the gateway key ==",
);
// installed as an environment's setup would install one, under the run's Codex home
const probeRoot = join(home, ".sky/codex/plugins/cache/e2e/probe/local");
const hookOut = join(root, "hook-fired.txt");
mkdirSync(join(probeRoot, ".codex-plugin"), { recursive: true });
mkdirSync(join(probeRoot, "hooks"), { recursive: true });
writeFileSync(
  join(probeRoot, ".codex-plugin/plugin.json"),
  JSON.stringify({
    name: "probe",
    version: "0.0.1",
    description: "Sky's e2e probe",
    hooks: "./hooks/hooks.json",
  }),
);
writeFileSync(
  join(probeRoot, "hooks/hooks.json"),
  JSON.stringify({
    hooks: {
      SessionStart: [
        {
          matcher: "startup|resume",
          hooks: [
            {
              type: "command",
              // the key's length (0 when absent) and whether the run's proxy token is there
              command: `printf '%s %s\\n' "$(printenv AI_GATEWAY_API_KEY | wc -c)" "\${SKY_CODEX_GATEWAY_TOKEN:+token}" > '${hookOut}'`,
              timeout: 10,
            },
          ],
        },
      ],
    },
  }),
);
const sixth = await run(
  "run_six",
  "Reply with the single word `ready`. Do nothing else.",
  undefined,
  undefined,
  { SKY_CODEX_PLUGINS: "probe@e2e" },
);
console.log(sixth.events.map(show).join("\n"));
check(
  "run 6 finished",
  sixth.code === 0 && sixth.events.some((e) => e.type === "run.finished"),
  `exit ${sixth.code}`,
);
const hookLine = existsSync(hookOut)
  ? readFileSync(hookOut, "utf8").trim()
  : "";
check("the plugin's SessionStart hook ran", hookLine !== "", hookLine);
check(
  "the hook's env held no gateway key",
  hookLine.split(" ")[0] === "0" &&
    !hookLine.includes(process.env.AI_GATEWAY_API_KEY),
  hookLine.replaceAll(process.env.AI_GATEWAY_API_KEY, "<key>"),
);
check(
  "no secret reached run 6's events",
  leaks(JSON.stringify(sixth.events)).length === 0,
  leaks(JSON.stringify(sixth.events)).join(", "),
);

for (const [n, r] of [
  ["run1", first],
  ["run2", second],
  ["run2b", resumed],
  ["run3", third],
  ["run4", fourth],
  ["run5", fifth],
  ["run6", sixth],
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
process.exit(failed.length ? 1 : 0);
