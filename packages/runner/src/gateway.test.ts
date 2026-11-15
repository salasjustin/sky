import { HttpResponse, http } from "msw";
import { expect, test } from "vitest";
import { server } from "../../../test/msw.js";
import { GatewayError, gateway } from "./publish.js";

const GATEWAY = "https://gateway.test/v1/gateway/github";
const CONNECTOR = "conn_secret_id";
const REPO = `${GATEWAY}/${CONNECTOR}/repos/acme/private`;
const NOW_S = 1_800_000_000;

/** A gateway on a clock and sleeper of the test's own: no wait is real, each is recorded. */
const gatewayWith = (
  limits: { floor?: number; maxResetWaitS?: number } = {},
) => {
  const slept: number[] = [];
  const call = gateway({
    gatewayUrl: GATEWAY,
    connectorId: CONNECTOR,
    owner: "acme",
    repo: "private",
    rateLimit: {
      paceMs: 1000,
      now: () => NOW_S * 1000,
      sleep: async (ms) => {
        slept.push(ms);
      },
      ...limits,
    },
  });
  return { call, slept };
};

const limit = (remaining: number) => ({
  "x-ratelimit-remaining": String(remaining),
  "x-ratelimit-reset": String(NOW_S + 1800),
});

test("with plenty of calls left, calls aren't slowed", async () => {
  server.use(
    http.get(`${REPO}/x`, () =>
      HttpResponse.json({ ok: true }, { headers: limit(4000) }),
    ),
  );
  const { call, slept } = gatewayWith();
  await call("GET", "/x");
  await call("GET", "/x");
  expect(slept).toEqual([]);
});

test("once the remaining calls drop under the floor, each later call waits first", async () => {
  server.use(
    http.get(`${REPO}/x`, () =>
      HttpResponse.json({ ok: true }, { headers: limit(499) }),
    ),
  );
  const { call, slept } = gatewayWith();
  await call("GET", "/x");
  expect(slept).toEqual([]);
  await call("GET", "/x");
  await call("GET", "/x");
  expect(slept).toEqual([1000, 1000]);
});

test("a calls-left count at the floor is not slowed", async () => {
  server.use(
    http.get(`${REPO}/x`, () =>
      HttpResponse.json({ ok: true }, { headers: limit(500) }),
    ),
  );
  const { call, slept } = gatewayWith();
  await call("GET", "/x");
  await call("GET", "/x");
  expect(slept).toEqual([]);
});

test("a rate-limit 403 whose reset is within the bound waits until the reset, then succeeds", async () => {
  let answered = 0;
  server.use(
    http.get(`${REPO}/x`, () => {
      answered++;
      return answered === 1
        ? HttpResponse.json(
            { message: "API rate limit exceeded" },
            {
              status: 403,
              headers: {
                "x-ratelimit-remaining": "0",
                "x-ratelimit-reset": String(NOW_S + 120),
              },
            },
          )
        : HttpResponse.json({ ok: true }, { headers: limit(5000) });
    }),
  );
  const { call, slept } = gatewayWith();

  expect(await call("GET", "/x")).toEqual({ ok: true });

  expect(answered).toBe(2);
  // the 120 s to the reset, plus a quarter second of margin, and no slowdown once the quota is back
  expect(slept).toEqual([120_250]);
});

test("a rate-limit 429 waits for the reset too", async () => {
  let answered = 0;
  server.use(
    http.get(`${REPO}/x`, () => {
      answered++;
      return answered === 1
        ? HttpResponse.json(
            { message: "rate limited" },
            {
              status: 429,
              headers: {
                "x-ratelimit-remaining": "0",
                "x-ratelimit-reset": String(NOW_S + 10),
              },
            },
          )
        : HttpResponse.json({ ok: true });
    }),
  );
  const { call, slept } = gatewayWith();
  await call("GET", "/x");
  expect(slept).toEqual([10_250]);
});

test("a rate-limit 403 whose reset is past the bound fails with github_rate_limited and the reset time in UTC, without waiting", async () => {
  server.use(
    http.get(`${REPO}/x`, () =>
      HttpResponse.json(
        { message: "API rate limit exceeded" },
        {
          status: 403,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(NOW_S + 2400),
          },
        },
      ),
    ),
  );
  const { call, slept } = gatewayWith();

  const error = await call("GET", "/x").catch((e: unknown) => e);

  expect(error).toBeInstanceOf(GatewayError);
  expect((error as GatewayError).rateLimited).toBe(true);
  expect((error as GatewayError).status).toBe(403);
  expect((error as Error).message).toMatch(
    new RegExp(
      `^github_rate_limited: GitHub's hourly API limit is used up until ${new Date((NOW_S + 2400) * 1000).toISOString()}`,
    ),
  );
  expect((error as Error).message).not.toContain("API rate limit exceeded");
  expect(slept).toEqual([]);
});

test("the bound is the policy's: a reset a minute away fails when the bound is thirty seconds", async () => {
  server.use(
    http.get(`${REPO}/x`, () =>
      HttpResponse.json(
        { message: "API rate limit exceeded" },
        {
          status: 403,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(NOW_S + 60),
          },
        },
      ),
    ),
  );
  const { call } = gatewayWith({ maxResetWaitS: 30 });
  await expect(call("GET", "/x")).rejects.toThrow(/^github_rate_limited: /);
});

test("a secondary limit's retry-after is waited out", async () => {
  let answered = 0;
  server.use(
    http.get(`${REPO}/x`, () => {
      answered++;
      return answered === 1
        ? HttpResponse.json(
            { message: "secondary rate limit" },
            { status: 403, headers: { "retry-after": "7" } },
          )
        : HttpResponse.json({ ok: true });
    }),
  );
  const { call, slept } = gatewayWith();
  await call("GET", "/x");
  expect(slept).toEqual([7000]);
});

test("a call sends no credential, and a failure never names the connector", async () => {
  let sent: Headers | undefined;
  server.use(
    http.get(`${REPO}/x`, ({ request }) => {
      sent = request.headers;
      return HttpResponse.json({ message: "Not Found" }, { status: 404 });
    }),
  );
  const { call } = gatewayWith();
  const error = await call("GET", "/x").catch((e: unknown) => e);
  expect(sent?.get("authorization")).toBeNull();
  expect((error as Error).message).not.toContain(CONNECTOR);
});
