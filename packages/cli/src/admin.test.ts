import { HttpResponse, http } from "msw";
import { beforeEach, expect, test, vi } from "vitest";
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

test("--wait exits 4, not 1, when only the final check fails, naming the runs of the last good poll", async () => {
  // mirror admin.ts: a check every 5 s, the last one 1 s before the API's deadline
  const pollMs = 5_000;
  const marginMs = 1_000;
  const deadlineS = 15;
  const checks = Math.ceil((deadlineS * 1000 - marginMs) / pollMs); // at 5 s, 10 s, 14 s
  let gets = 0;
  server.use(
    http.post(`${apiUrl}/v1/admin/drain`, () =>
      HttpResponse.json(
        drain({ active: ["run_a"], ready: false, deadline: at(deadlineS) }),
      ),
    ),
    http.get(`${apiUrl}/v1/admin/drain`, () => {
      gets++;
      // run_b differs from the POST's run_a so the exit shows which status it follows
      return gets < checks
        ? HttpResponse.json(
            drain({ active: ["run_b"], ready: false, deadline: at(deadlineS) }),
          )
        : new HttpResponse(null, { status: 502 });
    }),
  );
  const r = await cli(["admin", "drain", "--wait", `--timeout=${deadlineS}`]);
  expect(gets).toBe(checks);
  expect(r.sleeps.reduce((a, b) => a + b, 0)).toBe(deadlineS * 1000 - marginMs);
  expect(r.code).toBe(4);
  // the status is 4 s old (answered at 10 s, the check that failed at 14 s) and the error sits beside it
  expect(r.stderr).toMatch(
    /1 run still active after 15s \(status from 4s ago; the last check failed: .+\): run_b/,
  );
  expect(r.stdout).toContain("active run_b");
  expect(r.stdout).not.toContain("run_a");
});

test("--wait exits 1, not 4, when no check after the start is ever answered, so a broken API can't block a deploy", async () => {
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
  expect(r.stderr).toContain(
    "the API stopped answering after the drain started",
  );
  expect(r.stderr).toContain("last error");
  expect(r.stderr).not.toContain("still active");
});

test("--wait exits 1 when every check after the start is unreachable", async () => {
  server.use(
    http.post(`${apiUrl}/v1/admin/drain`, () =>
      HttpResponse.json(
        drain({ active: ["run_a"], ready: false, deadline: at(15) }),
      ),
    ),
    http.get(`${apiUrl}/v1/admin/drain`, () => HttpResponse.error()),
  );
  const r = await cli(["admin", "drain", "--wait", "--timeout=15"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("stopped answering");
});

test("--wait retries a check whose answer is cut off and exits 4 by the last good one", async () => {
  drainApi(
    drain({ active: ["run_a"], ready: false, deadline: at(15) }),
    drain({ active: ["run_b"], ready: false, deadline: at(15) }),
  );
  // the first check reaches MSW; each later one gets headers, then a body that fails
  const fetchOf = globalThis.fetch;
  let checks = 0;
  const spy = vi.spyOn(globalThis, "fetch");
  spy.mockImplementation(async (input, init) => {
    if (init?.method !== "GET" || ++checks === 1) return fetchOf(input, init);
    const cause = { code: "UND_ERR_SOCKET" };
    const body = new ReadableStream<Uint8Array>({
      start: (c) => c.error(new TypeError("terminated", { cause })),
    });
    return new Response(body);
  });
  try {
    const r = await cli(["admin", "drain", "--wait", "--timeout=15"]);
    // at 5 s, 10 s and 14 s
    expect(checks).toBe(3);
    expect(r.code).toBe(4);
    expect(r.stderr).toContain(
      "1 run still active after 15s (status from 9s ago; the last check failed: cannot reach https://sky.test: UND_ERR_SOCKET): run_b",
    );
    expect(r.stdout).toContain("active run_b");
  } finally {
    spy.mockRestore();
  }
});

test("--wait carries on past a 5xx mid-poll and exits 0 once the drain is ready", async () => {
  let gets = 0;
  server.use(
    http.post(`${apiUrl}/v1/admin/drain`, () =>
      HttpResponse.json(busy("run_a")),
    ),
    http.get(`${apiUrl}/v1/admin/drain`, () => {
      gets++;
      return gets === 1
        ? new HttpResponse(null, { status: 502 })
        : HttpResponse.json(drain());
    }),
  );
  const r = await cli(["admin", "drain", "--wait"]);
  expect(r.code).toBe(0);
  expect(gets).toBe(2);
  expect(r.stdout).toContain("ready=yes");
});

test("--wait ends at once on a 4xx mid-poll instead of retrying it until the deadline", async () => {
  let gets = 0;
  server.use(
    http.post(`${apiUrl}/v1/admin/drain`, () =>
      HttpResponse.json(busy("run_a")),
    ),
    http.get(`${apiUrl}/v1/admin/drain`, () => {
      gets++;
      return HttpResponse.json(
        { error: { code: "forbidden", message: "only the admin key" } },
        { status: 403 },
      );
    }),
  );
  const r = await cli(["admin", "drain", "--wait"]);
  expect(r.code).toBe(1);
  expect(gets).toBe(1);
});

test("--wait exits 1 for a key that isn't the admin key, without retrying", async () => {
  server.use(
    http.post(`${apiUrl}/v1/admin/drain`, () => {
      requests.push("POST");
      return HttpResponse.json(
        {
          error: {
            code: "forbidden",
            message: "only the admin key can do this",
          },
        },
        { status: 403 },
      );
    }),
    http.get(`${apiUrl}/v1/admin/drain`, () => {
      requests.push("GET");
      return HttpResponse.json(drain());
    }),
  );
  const r = await cli(["admin", "drain", "--wait"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("only the admin key");
  expect(requests).toEqual(["POST"]);
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
