import { HttpResponse, http } from "msw";
import { beforeEach, expect, test } from "vitest";
import { server } from "../../../test/msw.js";
import { apiKey, apiUrl, runCli } from "./testing.js";

const row = (over: Record<string, unknown> = {}) => ({
  id: "agt_1",
  envId: "env_1",
  envName: "trail",
  branch: "claude/agt_1",
  remoteBranch: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  archivedAt: null,
  run: {
    id: "run_1",
    status: "waiting",
    state: "waiting_answer",
    createdAt: "2026-01-01T00:01:00.000Z",
    lastEventAt: "2026-01-01T00:05:00.000Z",
    endedAt: null,
    openRequests: 1,
  },
  ...over,
});

let queries: URLSearchParams[];
let page: { data: unknown[]; nextCursor?: string };

beforeEach(() => {
  queries = [];
  page = { data: [] };
  server.use(
    http.get(`${apiUrl}/v1/agents`, ({ request }) => {
      if (request.headers.get("authorization") !== `Bearer ${apiKey}`) {
        return new HttpResponse(null, { status: 401 });
      }
      queries.push(new URL(request.url).searchParams);
      return HttpResponse.json(page);
    }),
  );
});

test("agent list prints one line per agent: id, state, run, last event, open requests, branch, env", async () => {
  page = {
    data: [
      row(),
      row({
        id: "agt_2",
        envName: "sky",
        branch: "claude/agt_2",
        remoteBranch: "feature/login",
        run: {
          id: "run_2",
          status: "running",
          state: "running",
          createdAt: "2026-01-01T00:00:00.000Z",
          lastEventAt: "2026-01-01T00:09:00.000Z",
          endedAt: null,
          openRequests: 0,
        },
      }),
      row({ id: "agt_3", branch: "claude/agt_3", run: null }),
    ],
  };
  const r = await runCli(["agent", "list"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe(
    [
      "agt_1 waiting_answer run_1 2026-01-01T00:05:00.000Z 1 claude/agt_1 trail",
      "agt_2 running run_2 2026-01-01T00:09:00.000Z 0 feature/login sky",
      "agt_3 - - - 0 claude/agt_3 trail",
      "",
    ].join("\n"),
  );
  expect(r.stderr).toBe("");
  // no filter given, so none is sent
  expect(queries.map((q) => q.toString())).toEqual([""]);
});

test("an env name with a space comes last, so the fields before it keep their places", async () => {
  page = { data: [row({ envName: "web staging" })] };
  const r = await runCli(["agent", "list"]);
  expect(r.code).toBe(0);
  const fields = r.stdout.trim().split(" ");
  expect(fields.slice(0, 6)).toEqual([
    "agt_1",
    "waiting_answer",
    "run_1",
    "2026-01-01T00:05:00.000Z",
    "1",
    "claude/agt_1",
  ]);
  expect(fields.slice(6).join(" ")).toBe("web staging");
});

test("--json prints the page the API returned", async () => {
  page = { data: [row()], nextCursor: "abc" };
  const r = await runCli(["agent", "list", "--json"]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual(page);
});

test("the filters reach the API: --env and --status repeat or take a comma list, --archived lists every agent, --limit sets the page size, --cursor picks the page", async () => {
  const r = await runCli([
    "agent",
    "list",
    "--env=trail,env_2",
    "--env=sky",
    "--status=waiting_answer",
    "--status=waiting_approval,running",
    "--archived",
    "--limit=25",
    "--cursor=c_next",
  ]);
  expect(r.code).toBe(0);
  const [query] = queries;
  expect(Object.fromEntries(query ?? [])).toEqual({
    env: "trail,env_2,sky",
    status: "waiting_answer,waiting_approval,running",
    archived: "all",
    limit: "25",
    cursor: "c_next",
  });
});

test("no agent matching prints nothing on stdout and says so on stderr", async () => {
  const r = await runCli(["agent", "list"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("");
  expect(r.stderr).toBe("no agents match\n");
});

test("no agent matching an --env says a name the key can't use matches nothing", async () => {
  const r = await runCli(["agent", "list", "--env=trial"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("");
  expect(r.stderr).toBe(
    "no agents match (an env name this key can't use matches nothing)\n",
  );
});

test("a page with more behind it gives the next page's --cursor on stderr, not stdout", async () => {
  page = { data: [row()], nextCursor: "abc" };
  const r = await runCli(["agent", "list", "--limit=200"]);
  expect(r.code).toBe(0);
  expect(r.stdout.trim().split("\n")).toHaveLength(1);
  expect(r.stderr).toContain(
    "more agents match; for the next page pass --cursor=abc with the same filters",
  );
});

test("a bad --status, --limit or argument exits 2 before any request", async () => {
  const cases: [string[], string][] = [
    [["--status=waiting"], "--status 'waiting' is not a state"],
    [["--status=,"], "--status names nothing"],
    [["--limit=0"], "--limit takes a whole number from 1 to 200"],
    [["--limit=201"], "--limit takes a whole number from 1 to 200"],
    [["--limit=ten"], "--limit takes a whole number from 1 to 200"],
    [["--cursor="], "--cursor is empty"],
    [["agt_1"], "agent list takes no arguments"],
    [["--prompt=x"], "agent list takes no --prompt"],
  ];
  for (const [args, message] of cases) {
    const r = await runCli(["agent", "list", ...args]);
    expect(r.code, args.join(" ")).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(message);
  }
  expect(queries).toEqual([]);
});

test("the list's flags are refused on the other agent subcommands", async () => {
  const r = await runCli(["agent", "archive", "agt_1", "--status=running"]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("--status only goes with agent list");
});

test("a key the API refuses exits 2 naming where the key came from", async () => {
  const r = await runCli(["agent", "list"], {
    env: { SKY_API_KEY: "wrong" },
  });
  expect(r.code).toBe(2);
});

test("--help documents agent list", async () => {
  const r = await runCli(["--help"]);
  const text = r.stdout.replace(/\s+/g, " ");
  expect(text).toContain(
    "sky agent list [--env=<id|name>,...] [--status=<state>,...] [--archived] [--limit=N] [--cursor=<c>]",
  );
  expect(text).toContain(
    "States: starting, running, waiting_approval, waiting_answer, finished, failed, stopped.",
  );
});
