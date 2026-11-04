import { HttpResponse, http } from "msw";
import { expect, test } from "vitest";
import { leaks, server } from "./msw.js";

test("a handled request is answered by its handler", async () => {
  server.use(
    http.get("https://api.test/ping", () => HttpResponse.json({ ok: true })),
  );
  const res = await fetch("https://api.test/ping");
  expect(await res.json()).toEqual({ ok: true });
});

test("a request with no handler rejects and is recorded as a leak", async () => {
  await expect(fetch("https://api.test/unhandled")).rejects.toThrow();
  expect(leaks.splice(0)).toEqual(["unhandled GET https://api.test/unhandled"]);
});

const GATEWAY = "https://gateway.test/v1/gateway/github/conn_1/repos/acme/web";

test("the gateway fake refuses a path containing .. with the live gateway's 400", async () => {
  server.use(
    http.get(`${GATEWAY}/compare/*`, () => HttpResponse.json({ commits: [] })),
  );

  const res = await fetch(`${GATEWAY}/compare/main...fix/x?per_page=100`);

  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: "invalid path: path traversal detected",
  });
  // the refusal fails the test unless it is claimed, so a caller that swallows the 400 still fails
  expect(leaks.splice(0)).toEqual([
    `gateway refused GET ${GATEWAY}/compare/main...fix/x?per_page=100`,
  ]);
});

test("the guard stays ahead of handlers from a second server.use and refuses an encoded ..", async () => {
  server.use(http.get(`${GATEWAY}/a/*`, () => HttpResponse.json({ ok: 1 })));
  server.use(http.get(`${GATEWAY}/b/*`, () => HttpResponse.json({ ok: 1 })));

  const res = await fetch(`${GATEWAY}/a/x%2E%2E%2Ey`);

  expect(res.status).toBe(400);
  expect(leaks.splice(0)).toHaveLength(1);
});

test("a path with .. outside the gateway is left to its handler", async () => {
  server.use(
    http.get("https://api.test/files/*", () => HttpResponse.json({ ok: 1 })),
  );

  const res = await fetch("https://api.test/files/a...b");

  expect(await res.json()).toEqual({ ok: 1 });
});

test("the gateway fake answers a path without .. as the test's handler does", async () => {
  server.use(
    http.get(`${GATEWAY}/git/ref/heads/*`, () => HttpResponse.json({ ok: 1 })),
  );

  const res = await fetch(`${GATEWAY}/git/ref/heads/fix/a.b`);

  expect(await res.json()).toEqual({ ok: 1 });
});
