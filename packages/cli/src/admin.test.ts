import { HttpResponse, http } from "msw";
import { beforeEach, expect, test } from "vitest";
import { server } from "../../../test/msw.js";
import { apiUrl, runCli } from "./testing.js";

const drain = (over: Record<string, unknown> = {}) => ({
  draining: true,
  since: "2026-11-22T10:00:00.000Z",
  deadline: "2026-11-22T10:30:00.000Z",
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
  const r = await runCli(["admin", "drain", "--timeout=600"]);
  expect(r.code).toBe(0);
  expect(posts).toEqual([{ timeoutSeconds: 600 }]);
  expect(requests).toEqual(["POST"]);
  expect(r.stdout).toBe(
    "draining deadline=2026-11-22T10:30:00.000Z active=1 held=0 ready=no\nactive run_a\n",
  );
});

test("drain without --timeout sends none, leaving the server's default", async () => {
  drainApi(drain());
  const r = await runCli(["admin", "drain"]);
  expect(r.code).toBe(0);
  expect(posts).toEqual([{}]);
});

test("--wait exits 0 once nothing is starting or running", async () => {
  drainApi(busy("run_a", "run_b"), busy("run_b"), drain({ held: 3 }));
  const r = await runCli(["admin", "drain", "--wait"]);
  expect(r.code).toBe(0);
  expect(requests).toEqual(["POST", "GET", "GET"]);
  expect(r.sleeps).toHaveLength(2);
  expect(r.stderr).toContain("waiting for 2 active runs: run_a run_b");
  expect(r.stdout).toContain("ready=yes");
});

test("--wait exits 0 at once when the first answer is already ready", async () => {
  drainApi(drain());
  const r = await runCli(["admin", "drain", "--wait"]);
  expect(r.code).toBe(0);
  expect(requests).toEqual(["POST"]);
});

test("--wait exits 4 at the deadline naming the runs still active", async () => {
  drainApi(busy("run_a"), busy("run_a"));
  const r = await runCli(["admin", "drain", "--wait", "--timeout=20"]);
  expect(r.code).toBe(4);
  expect(r.stderr).toContain("1 run still active after 20s: run_a");
  expect(r.stdout).toContain("active run_a");
  // the CLI leaves the drain on for its caller to cancel
  expect(requests).not.toContain("DELETE");
  expect(r.sleeps.reduce((a, b) => a + b, 0)).toBe(20_000);
});

test("--wait exits 1 when the API can't be reached to start", async () => {
  server.use(http.post(`${apiUrl}/v1/admin/drain`, () => HttpResponse.error()));
  const r = await runCli(["admin", "drain", "--wait"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("cannot reach");
});

test("--wait exits 1 when the API stops answering until the deadline", async () => {
  server.use(
    http.post(`${apiUrl}/v1/admin/drain`, () =>
      HttpResponse.json(busy("run_a")),
    ),
    http.get(
      `${apiUrl}/v1/admin/drain`,
      () => new HttpResponse(null, { status: 502 }),
    ),
  );
  const r = await runCli(["admin", "drain", "--wait", "--timeout=15"]);
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
  const r = await runCli(["admin", "drain", "--wait"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("only the admin key");
});

test("--status reads and --cancel deletes", async () => {
  drainApi(drain(), busy("run_a"));
  const status = await runCli(["admin", "drain", "--status"]);
  expect(status.code).toBe(0);
  expect(status.stdout).toContain("active=1");
  const cancel = await runCli(["admin", "drain", "--cancel"]);
  expect(cancel.code).toBe(0);
  expect(cancel.stdout).toMatch(/^idle deadline=- active=0 held=0 ready=yes/);
  expect(requests).toEqual(["GET", "DELETE"]);
});

test("--json prints the API's object", async () => {
  drainApi(busy("run_a"));
  const r = await runCli(["admin", "drain", "--json"]);
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
  const r = await runCli(argv);
  expect(r.code).toBe(2);
  expect(r.stderr).toMatch(message);
});
