import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  FIRST_HOLD_BUDGET_MS,
  holdSprite,
  REQUEST_TIMEOUT_MS,
  spriteApiFrom,
} from "./keepalive.js";

let dir: string;
let api: Server | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "runner-keepalive-"));
});
afterEach(async () => {
  if (api) {
    api.closeAllConnections();
    api.close();
    api = undefined;
  }
  rmSync(dir, { recursive: true, force: true });
});

type Call = {
  method?: string;
  url?: string;
  host?: string;
  body: string;
  /** What the stand-in answered. */
  status: number;
};

/** A stand-in for the sprite's management socket that records every Tasks API call. */
async function spriteApi(initial = 200) {
  const calls: Call[] = [];
  let status = initial;
  api = createServer((req, res) => {
    // a 400 for a task name outside lowercase letters, digits and hyphens, as the Sprites API does for a sprite name
    const named = /^\/v1\/tasks\/[a-z0-9-]+$/.test(req.url ?? "");
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const answered = named ? status : 400;
      calls.push({
        method: req.method,
        url: req.url,
        host: req.headers.host,
        body,
        status: answered,
      });
      res.writeHead(answered).end();
    });
  });
  const socketPath = join(dir, "api.sock");
  api.listen(socketPath);
  await once(api, "listening");
  return {
    calls,
    socketPath,
    /** The status the API answers from now on. */
    answer: (next: number) => {
      status = next;
    },
  };
}

test("holds a task named for the run, refreshes it, and deletes it on release", async () => {
  const { calls, socketPath } = await spriteApi();
  const warnings: string[] = [];
  const hold = holdSprite({
    runId: "run_1",
    socketPath,
    refreshMs: 20,
    warn: (m) => warnings.push(m),
  });
  await sleep(70);
  await hold.release();
  const settled = calls.length;
  await sleep(50);

  const url = "/v1/tasks/sky-run-37ddff8ee13f1e57937fd048";
  const put = {
    method: "PUT",
    url,
    host: "sprite",
    body: JSON.stringify({ expire: "5m" }),
    status: 200,
  };
  expect(calls.length).toBe(settled);
  expect(calls.at(-1)).toEqual({
    method: "DELETE",
    url,
    host: "sprite",
    body: "",
    status: 200,
  });
  const puts = calls.slice(0, -1);
  expect(puts.length).toBeGreaterThanOrEqual(2);
  for (const call of puts) expect(call).toEqual(put);
  expect(warnings).toEqual([]);
});

test("a hold that lands and keeps refreshing reports nothing", async () => {
  const { socketPath } = await spriteApi();
  const reports: string[] = [];
  const hold = holdSprite({
    runId: "run_1",
    socketPath,
    refreshMs: 10,
    warn: () => {},
    report: (m) => reports.push(m),
  });
  await sleep(50);
  await hold.release();
  expect(reports).toEqual([]);
});

test("a first hold that never lands reports only that it gave up", async () => {
  const { socketPath } = await spriteApi(500);
  const reports: string[] = [];
  const warnings: string[] = [];
  const hold = holdSprite({
    runId: "run_1",
    socketPath,
    refreshMs: 10,
    firstRetryMs: 5,
    firstBudgetMs: 15,
    warn: (m) => warnings.push(m),
    report: (m) => reports.push(m),
  });
  await expect(hold.ready).resolves.toBe(false);
  // refreshes that keep failing after the first retries ran out add nothing: the hold never landed
  await vi.waitFor(() =>
    expect(
      warnings.filter((w) => /failed: HTTP 500/.test(w)).length,
    ).toBeGreaterThanOrEqual(5),
  );
  await hold.release();
  expect(reports).toEqual([
    "runner: sprite not held after the first retries; it may pause the run",
  ]);
  // the failed PUTs are still lines in the local log
  expect(warnings[0]).toMatch(/sprite task PUT failed: HTTP 500/);
  expect(warnings).toContain(reports[0]);
});

test("a first hold that fails, then lands within the quick retries, reports nothing", async () => {
  let refusals = 2;
  api = createServer((req, res) => {
    req.resume();
    req.on("end", () => res.writeHead(refusals-- > 0 ? 503 : 200).end());
  });
  const socketPath = join(dir, "api.sock");
  api.listen(socketPath);
  await once(api, "listening");
  const reports: string[] = [];
  const warnings: string[] = [];
  const hold = holdSprite({
    runId: "run_1",
    socketPath,
    refreshMs: 60_000,
    firstRetryMs: 5,
    warn: (m) => warnings.push(m),
    report: (m) => reports.push(m),
  });
  await expect(hold.ready).resolves.toBe(true);
  await hold.release();
  expect(reports).toEqual([]);
  expect(warnings.filter((w) => /HTTP 503/.test(w))).toHaveLength(2);
});

test("a refresh that fails after the hold landed is reported, once per streak of failures", async () => {
  const { calls, socketPath, answer } = await spriteApi();
  const reports: string[] = [];
  const hold = holdSprite({
    runId: "run_1",
    socketPath,
    refreshMs: 10,
    warn: () => {},
    report: (m) => reports.push(m),
  });
  /** Waits until at least `count` PUTs answered `status` have arrived since `from`. */
  const putsAnswered = (status: number, count: number, from: number) =>
    vi.waitFor(
      () =>
        expect(
          calls
            .slice(from)
            .filter((c) => c.method === "PUT" && c.status === status).length,
        ).toBeGreaterThanOrEqual(count),
      { timeout: 5_000 },
    );
  await expect(hold.ready).resolves.toBe(true);
  expect(reports).toEqual([]);
  answer(503);
  await vi.waitFor(() => expect(reports).toHaveLength(1), { timeout: 5_000 });
  expect(reports[0]).toMatch(/sprite task PUT failed: HTTP 503/);
  // refreshes are serial, so by the second further failure the first has been handled: same streak
  await putsAnswered(503, 2, calls.length);
  expect(reports).toHaveLength(1);
  // the hold recovers, then fails again: a new streak, reported again
  answer(200);
  await putsAnswered(200, 2, calls.length);
  answer(500);
  await vi.waitFor(() => expect(reports).toHaveLength(2), { timeout: 5_000 });
  expect(reports[1]).toMatch(/HTTP 500/);
  await hold.release();
});

test("off a sprite, a missing socket means no sprite: logged once, never retried or reported to the API", async () => {
  const reports: string[] = [];
  const warnings: string[] = [];
  const hold = holdSprite({
    runId: "run_1",
    socketPath: join(dir, "absent.sock"),
    onSprite: false,
    refreshMs: 10,
    firstRetryMs: 5,
    warn: (m) => warnings.push(m),
    report: (m) => reports.push(m),
  });
  await expect(hold.ready).resolves.toBe(false);
  await sleep(50);
  await hold.release();
  expect(warnings).toEqual([
    `runner: no sprite API found at ${join(dir, "absent.sock")}; the run is not held`,
  ]);
  expect(reports).toEqual([]);
});

test("on a sprite, a socket that never appears is retried for the whole budget, then only the give-up is reported", async () => {
  const reports: string[] = [];
  const warnings: string[] = [];
  const budgetMs = 200;
  const retryMs = 2;
  const started = performance.now();
  const hold = holdSprite({
    runId: "run_1",
    socketPath: join(dir, "absent.sock"),
    onSprite: true,
    refreshMs: 60_000,
    firstRetryMs: retryMs,
    firstBudgetMs: budgetMs,
    warn: (m) => warnings.push(m),
    report: (m) => reports.push(m),
  });
  await expect(hold.ready).resolves.toBe(false);
  const tookMs = performance.now() - started;
  await hold.release();
  // a missing socket fails at once, so a deadline, unlike a count of attempts, keeps it retried
  expect(
    warnings.filter((w) => /sprite task PUT failed: .*ENOENT/.test(w)).length,
  ).toBeGreaterThan(15);
  expect(tookMs).toBeGreaterThanOrEqual(budgetMs - retryMs);
  expect(reports).toEqual([
    "runner: sprite not held after the first retries; it may pause the run",
  ]);
});

test("no first-hold attempt starts past the budget, so only the last, slow attempt runs past it", async () => {
  const replyMs = 100;
  const budgetMs = 150;
  const arrivals: number[] = [];
  let started = 0;
  api = createServer((req, res) => {
    arrivals.push(performance.now() - started);
    req.resume();
    req.on("end", () => {
      setTimeout(() => res.writeHead(500).end(), replyMs);
    });
  });
  const socketPath = join(dir, "api.sock");
  api.listen(socketPath);
  await once(api, "listening");
  const reports: string[] = [];
  started = performance.now();
  const hold = holdSprite({
    runId: "run_1",
    socketPath,
    refreshMs: 60_000,
    firstRetryMs: 5,
    firstBudgetMs: budgetMs,
    warn: () => {},
    report: (m) => reports.push(m),
  });
  await expect(hold.ready).resolves.toBe(false);
  const tookMs = performance.now() - started;
  // the second attempt starts inside the budget and runs past it; a third would start late
  expect(arrivals).toHaveLength(2);
  for (const at of arrivals) expect(at).toBeLessThanOrEqual(budgetMs);
  // a slow reply stands in for REQUEST_TIMEOUT_MS, which the test can't wait out
  expect(tookMs).toBeLessThan(budgetMs + replyMs + 50);
  expect(reports).toEqual([
    "runner: sprite not held after the first retries; it may pause the run",
  ]);
  await hold.release();
});

test("the default first-hold budget plus one idled-out attempt fits the API's hold with the runner's boot to spare", () => {
  // inside launch.ts HOLD_EXPIRE (2m), with 20s left for the boot and the give-up report's POST
  expect(FIRST_HOLD_BUDGET_MS + REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(
    100_000,
  );
});

test("on a sprite, a socket that appears mid-budget lands the hold, stops the retries and reports nothing", async () => {
  const socketPath = join(dir, "api.sock");
  const reports: string[] = [];
  const hold = holdSprite({
    runId: "run_1",
    socketPath,
    onSprite: true,
    refreshMs: 60_000,
    firstRetryMs: 5,
    firstBudgetMs: 10_000,
    warn: () => {},
    report: (m) => reports.push(m),
  });
  await sleep(30);
  const { calls } = await spriteApi();
  await expect(hold.ready).resolves.toBe(true);
  await hold.release();
  expect(calls.map((c) => c.method)).toEqual(["PUT", "DELETE"]);
  expect(reports).toEqual([]);
});

test.each([
  ["unset", {}],
  ["empty", { SKY_SPRITE_API_SOCKET: "" }],
])(
  "SKY_SPRITE_API_SOCKET %s means the sprite's own socket, on a sprite",
  (_, env) => {
    expect(spriteApiFrom(env)).toEqual({
      socketPath: undefined,
      onSprite: true,
    });
  },
);

test("SKY_SPRITE_API_SOCKET set is a chosen socket, not assumed a sprite", () => {
  expect(spriteApiFrom({ SKY_SPRITE_API_SOCKET: "/tmp/api.sock" })).toEqual({
    socketPath: "/tmp/api.sock",
    onSprite: false,
  });
});

test("a report that throws never breaks the hold", async () => {
  const { socketPath } = await spriteApi(500);
  const hold = holdSprite({
    runId: "run_1",
    socketPath,
    firstRetryMs: 5,
    firstBudgetMs: 10,
    warn: () => {},
    report: () => {
      throw new Error("post failed");
    },
  });
  await expect(hold.ready).resolves.toBe(false);
  await hold.release();
});

test("a warn that throws leaves the first hold and the refresh running", async () => {
  const { calls, socketPath, answer } = await spriteApi(500);
  const hold = holdSprite({
    runId: "run_1",
    socketPath,
    refreshMs: 10,
    firstRetryMs: 5,
    firstBudgetMs: 15,
    warn: () => {
      throw new Error("log pipe closed");
    },
  });
  // the first-hold loop ran out of budget without rejecting
  await expect(hold.ready).resolves.toBe(false);
  answer(200);
  const before = calls.length;
  await vi.waitFor(() =>
    expect(calls.length).toBeGreaterThanOrEqual(before + 3),
  );
  await expect(hold.release()).resolves.toBeUndefined();
  expect(calls.at(-1)?.method).toBe("DELETE");
});

test("two runs in one sprite hold tasks under distinct valid names", async () => {
  const { calls, socketPath } = await spriteApi();
  const warnings: string[] = [];
  for (const runId of [
    "run_4kQ9zXbT2mN7pLw1Rv8sYc",
    "run_4kQ9zXbT2mN7pLw1Rv8sYd",
  ]) {
    await holdSprite({
      runId,
      socketPath,
      warn: (m) => warnings.push(m),
    }).release();
  }
  expect(warnings).toEqual([]);
  const urls = new Set(calls.map((c) => c.url));
  expect(urls.size).toBe(2);
});

test("a socket that refuses the first call is warned about and tried again", async () => {
  // connecting to a file that isn't a listening socket is refused, as a sprite API not yet up would be
  const socketPath = join(dir, "api.sock");
  writeFileSync(socketPath, "");
  const warnings: string[] = [];
  const hold = holdSprite({
    runId: "run_1",
    socketPath,
    refreshMs: 10,
    warn: (m) => warnings.push(m),
  });
  await sleep(50);
  await hold.release();
  expect(warnings.length).toBeGreaterThanOrEqual(2);
  expect(warnings[0]).toMatch(/ECONNREFUSED/);
});

test("with no sprite socket it says so once on warn and carries on", async () => {
  const warnings: string[] = [];
  const hold = holdSprite({
    runId: "run_1",
    socketPath: join(dir, "absent.sock"),
    refreshMs: 10,
    warn: (m) => warnings.push(m),
  });
  await sleep(50);
  await expect(hold.release()).resolves.toBeUndefined();
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toMatch(/absent\.sock/);
});

test("a refused refresh is one warning per failure, and the hold keeps trying", async () => {
  const { calls, socketPath } = await spriteApi(500);
  const warnings: string[] = [];
  const hold = holdSprite({
    runId: "run_1",
    socketPath,
    refreshMs: 20,
    firstRetryMs: 5,
    firstBudgetMs: 10,
    warn: (m) => warnings.push(m),
  });
  await expect(hold.ready).resolves.toBe(false);
  await sleep(70);
  await hold.release();
  const puts = calls.filter((c) => c.method === "PUT").length;
  expect(puts).toBeGreaterThanOrEqual(3);
  // one line per failed call, and one saying the quick first retries ran out
  expect(warnings.filter((w) => /failed: HTTP 500/.test(w))).toHaveLength(
    calls.length,
  );
  expect(warnings.filter((w) => /not held/.test(w))).toHaveLength(1);
  expect(warnings[0]).toMatch(/HTTP 500/);
});

test("a socket that refuses at first is retried quickly, and ready says once the hold lands", async () => {
  let refusals = 2;
  const calls: string[] = [];
  api = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      calls.push(req.method ?? "");
      res.writeHead(refusals-- > 0 ? 503 : 200).end();
    });
  });
  const socketPath = join(dir, "api.sock");
  api.listen(socketPath);
  await once(api, "listening");
  const warnings: string[] = [];
  const hold = holdSprite({
    runId: "run_1",
    socketPath,
    refreshMs: 60_000,
    firstRetryMs: 5,
    warn: (m) => warnings.push(m),
  });
  await expect(hold.ready).resolves.toBe(true);
  // the third PUT held the sprite, long before the minute-long refresh would have tried again
  expect(calls).toEqual(["PUT", "PUT", "PUT"]);
  expect(warnings.some((w) => /not held/.test(w))).toBe(false);
  await hold.release();
});

test("a stop during the first-hold retries settles ready unheld at once and puts no more", async () => {
  const { calls, socketPath } = await spriteApi(500);
  const stop = new AbortController();
  const hold = holdSprite({
    runId: "run_1",
    socketPath,
    refreshMs: 60_000,
    firstRetryMs: 1_000,
    signal: stop.signal,
    warn: () => {},
  });
  // the first PUT has failed, so the loop is in its retry sleep
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  const stopped = Date.now();
  stop.abort("SIGTERM");
  await expect(hold.ready).resolves.toBe(false);
  expect(Date.now() - stopped).toBeLessThan(250);
  await hold.release();
  expect(calls.map((c) => c.method)).toEqual(["PUT", "DELETE"]);
});

test("a stop abandons a first PUT the sprite API is stalling on", async () => {
  let puts = 0;
  api = createServer((req) => {
    // never answers, as a sprite API that accepts and then stalls
    req.resume();
    puts++;
  });
  const socketPath = join(dir, "api.sock");
  api.listen(socketPath);
  await once(api, "listening");
  const stop = new AbortController();
  const warnings: string[] = [];
  const hold = holdSprite({
    runId: "run_1",
    socketPath,
    refreshMs: 60_000,
    signal: stop.signal,
    warn: (m) => warnings.push(m),
  });
  await vi.waitFor(() => expect(puts).toBe(1));
  const stopped = Date.now();
  stop.abort("SIGTERM");
  await expect(hold.ready).resolves.toBe(false);
  expect(Date.now() - stopped).toBeLessThan(250);
  expect(puts).toBe(1);
  expect(warnings.some((w) => /aborted/i.test(w))).toBe(false);
  // gone, so release's DELETE fails at once rather than stalling for its timeout
  api.closeAllConnections();
  api.close();
  api = undefined;
  await hold.release();
});
