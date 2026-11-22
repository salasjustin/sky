import { HttpResponse, http } from "msw";
import { beforeEach, expect, test } from "vitest";
import { server } from "../../../test/msw.js";
import { apiUrl, runCli } from "./testing.js";

const since = "2026-11-22T10:00:00.000Z";
const t0 = Date.parse(since);
/** The time `s` seconds after the drain started, as the API writes it. */
const at = (s: number) => new Date(t0 + s * 1000).toISOString();
/** The CLI with its clock at the drain's start, since `--wait` counts down to the API's deadline. */
const cli = (argv: string[]) => runCli(argv, { clockStart: t0 });

const drain = (over: Record<string, unknown> = {}) => ({
  draining: true,
  since,
  deadline: at(1800),
  active: [],
  held: 0,
  ready: true,
  ...over,
});
const busy = (...active: string[]) => drain({ active, ready: false });

const posts: unknown[] = [];
const requests: string[] = [];
beforeEach(() => {
  posts.length = 0;
  requests.length = 0;
});

/** POST answers the first status; each GET the next one, the last repeating. */
function drainApi(
  first: Record<string, unknown>,
  ...polls: Record<string, unknown>[]
) {
  let n = 0;
  server.use(
    http.post(`${apiUrl}/v1/admin/drain`, async ({ request }) => {
      requests.push("POST");
      posts.push(await request.json());
      return HttpResponse.json(first);
    }),
    http.get(`${apiUrl}/v1/admin/drain`, () => {
      requests.push("GET");
      return HttpResponse.json(polls[Math.min(n++, polls.length - 1)]);
    }),
    http.delete(`${apiUrl}/v1/admin/drain`, () => {
      requests.push("DELETE");
      return HttpResponse.json(
        drain({ draining: false, since: null, deadline: null }),
      );
    }),
  );
}

test("drain posts the timeout and prints the state without waiting", async () => {
  drainApi(busy("run_a"));
  const r = await cli(["admin", "drain", "--timeout=600"]);
  expect(r.code).toBe(0);
  expect(posts).toEqual([{ timeoutSeconds: 600 }]);
  expect(requests).toEqual(["POST"]);
  expect(r.stdout).toBe(
    "draining deadline=2026-11-22T10:30:00.000Z active=1 held=0 ready=no\nactive run_a\n",
  );
});

test("drain without --timeout sends none, leaving the server's default", async () => {
  drainApi(drain());
  const r = await cli(["admin", "drain"]);
  expect(r.code).toBe(0);
  expect(posts).toEqual([{}]);
});

test("--wait exits 0 once nothing is starting or running", async () => {
  drainApi(busy("run_a", "run_b"), busy("run_b"), drain({ held: 3 }));
  const r = await cli(["admin", "drain", "--wait"]);
  expect(r.code).toBe(0);
  expect(requests).toEqual(["POST", "GET", "GET"]);
  expect(r.sleeps).toHaveLength(2);
  expect(r.stderr).toContain("waiting for 2 active runs: run_a run_b");
  expect(r.stdout).toContain("ready=yes");
});

test("--wait exits 0 at once when the first answer is already ready", async () => {
  drainApi(drain());
  const r = await cli(["admin", "drain", "--wait"]);
  expect(r.code).toBe(0);
  expect(requests).toEqual(["POST"]);
});

test("--wait exits 4 at the deadline naming the runs still active", async () => {
  const held = drain({ active: ["run_a"], ready: false, deadline: at(20) });
  drainApi(held, held);
  const r = await cli(["admin", "drain", "--wait", "--timeout=20"]);
  expect(r.code).toBe(4);
  expect(r.stderr).toContain("1 run still active after 20s: run_a");
  expect(r.stdout).toContain("active run_a");
  // the drain ends at its own deadline; the CLI doesn't end it
  expect(requests).not.toContain("DELETE");
  // the last poll lands a second before the API ends the drain
  expect(r.sleeps.reduce((a, b) => a + b, 0)).toBe(19_000);
});

test("--wait stops at the deadline the API answers, not its own --timeout", async () => {
  const held = drain({ active: ["run_a"], ready: false, deadline: at(60) });
  drainApi(held, held);
  const r = await cli(["admin", "drain", "--wait", "--timeout=600"]);
  expect(r.code).toBe(4);
  expect(r.sleeps.reduce((a, b) => a + b, 0)).toBe(59_000);
});

test("--wait exits 4 when the drain ends before the runs finish, even with none active", async () => {
  drainApi(
    busy("run_a"),
    drain({ draining: false, since: null, deadline: null }),
  );
  const r = await cli(["admin", "drain", "--wait"]);
  expect(r.code).toBe(4);
  expect(requests).toEqual(["POST", "GET"]);
  expect(r.stderr).toContain("the drain ended before the runs finished");
  expect(r.stdout).toContain("idle");
});

test("--wait names the runs still active when the drain ends early", async () => {
  drainApi(
    busy("run_a"),
    drain({
      draining: false,
      since: null,
      deadline: null,
      active: ["run_a", "run_b"],
      ready: false,
    }),
  );
  const r = await cli(["admin", "drain", "--wait"]);
  expect(r.code).toBe(4);
  expect(r.stderr).toContain(
    "the drain ended before the runs finished; 2 runs still active: run_a run_b",
  );
});

test("--wait exits 1 when the API can't be reached to start", async () => {
  server.use(http.post(`${apiUrl}/v1/admin/drain`, () => HttpResponse.error()));
  const r = await cli(["admin", "drain", "--wait"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("cannot reach");
});

test("--wait exits 1 when the API stops answering until the deadline", async () => {
  server.use(
    http.post(`${apiUrl}/v1/admin/drain`, () =>
      HttpResponse.json(
        drain({ active: ["run_a"], ready: false, deadline: at(15) }),
      ),
    ),
    http.get(
      `${apiUrl}/v1/admin/drain`,
      () => new HttpResponse(null, { status: 502 }),
    ),
  );
  const r = await cli(["admin", "drain", "--wait", "--timeout=15"]);
  expect(r.code).toBe(1);
});

test("--wait exits 1 for a key that isn't the admin key", async () => {
  server.use(
    http.post(`${apiUrl}/v1/admin/drain`, () =>
      HttpResponse.json(
        {
          error: {
            code: "forbidden",
            message: "only the admin key can do this",
          },
        },
        { status: 403 },
      ),
    ),
  );
  const r = await cli(["admin", "drain", "--wait"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("only the admin key");
});

test("--status reads and --cancel deletes", async () => {
  drainApi(drain(), busy("run_a"));
  const status = await cli(["admin", "drain", "--status"]);
  expect(status.code).toBe(0);
  expect(status.stdout).toContain("active=1");
  const cancel = await cli(["admin", "drain", "--cancel"]);
  expect(cancel.code).toBe(0);
  expect(cancel.stdout).toMatch(/^idle deadline=- active=0 held=0 ready=yes/);
  expect(requests).toEqual(["GET", "DELETE"]);
});

test("--json prints the API's object", async () => {
  drainApi(busy("run_a"));
  const r = await cli(["admin", "drain", "--json"]);
  expect(JSON.parse(r.stdout)).toMatchObject({
    draining: true,
    active: ["run_a"],
  });
});

test.each([
  [["admin"], /needs a subcommand/],
  [["admin", "flush"], /unknown admin subcommand/],
  [["admin", "drain", "extra"], /takes no arguments/],
  [["admin", "drain", "--wait", "--cancel"], /can't be combined/],
  [["admin", "drain", "--status", "--timeout=5"], /only goes with starting/],
  [["admin", "drain", "--timeout=0"], /whole number of seconds from 1 to 7200/],
  [
    ["admin", "drain", "--timeout=7201"],
    /whole number of seconds from 1 to 7200/,
  ],
  [["admin", "drain", "--timeout=soon"], /whole number of seconds/],
])("%j is a usage error", async (argv, message) => {
  const r = await cli(argv);
  expect(r.code).toBe(2);
  expect(r.stderr).toMatch(message);
});
