import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { holdSprite } from "./keepalive.js";

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
    firstAttempts: 3,
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

test("a missing sprite socket means no sprite: logged once, never reported to the API", async () => {
  const reports: string[] = [];
  const warnings: string[] = [];
  const hold = holdSprite({
    runId: "run_1",
    socketPath: join(dir, "absent.sock"),
    refreshMs: 10,
    warn: (m) => warnings.push(m),
    report: (m) => reports.push(m),
  });
  await expect(hold.ready).resolves.toBe(false);
  await sleep(50);
  await hold.release();
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toMatch(/absent\.sock/);
  expect(reports).toEqual([]);
});

test("a report that throws never breaks the hold", async () => {
  const { socketPath } = await spriteApi(500);
  const hold = holdSprite({
    runId: "run_1",
    socketPath,
    firstRetryMs: 5,
    firstAttempts: 2,
    warn: () => {},
    report: () => {
      throw new Error("post failed");
    },
  });
  await expect(hold.ready).resolves.toBe(false);
  await hold.release();
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
    firstAttempts: 2,
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
