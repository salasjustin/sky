import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";

// request no handler answered; the setup file fails the test on any entry
export const leaks: string[] = [];

// the live Sprites GitHub gateway answers 400 to any path containing `..` (a compare URL,
// `main...branch`), so the fake does too, and records the request as a leak so the test fails even
// when the code under test swallows the 400. Only `..` inside a segment gets here: URL parsing
// collapses a whole `..` segment first. The guard is an initial handler, which `resetHandlers()`
// keeps, and `server.use` is wrapped to keep it ahead of the handlers a test adds.
const refuseTraversal = http.all(/\/gateway\/github\//, ({ request }) => {
  const { pathname } = new URL(request.url);
  const decoded = (() => {
    try {
      return decodeURIComponent(pathname);
    } catch {
      return pathname;
    }
  })();
  if (!decoded.includes("..")) return;
  leaks.push(`gateway refused ${request.method} ${request.url}`);
  return HttpResponse.json(
    { error: "invalid path: path traversal detected" },
    { status: 400 },
  );
});

export const server = setupServer(refuseTraversal);
const addHandlers = server.use.bind(server);
server.use = (...handlers) => addHandlers(refuseTraversal, ...handlers);

server.events.on("request:unhandled", ({ request }) => {
  leaks.push(`unhandled ${request.method} ${request.url}`);
});
server.events.on("response:bypass", ({ request }) => {
  leaks.push(`real network ${request.method} ${request.url}`);
});
server.events.on("unhandledException", ({ request, error }) => {
  leaks.push(`handler threw on ${request.method} ${request.url}: ${error}`);
});

/** Connections undici holds open, counted by the dispatcher `test/setup.ts` installs. */
export const connections = { open: 0 };

/**
 * Waits for every connection to close, and gives up after `timeoutMs` rather than hold a test on one
 * that is meant to stay open. An aborted request's mocked socket closes some ticks after the abort,
 * more of them under load, and a request the next test makes in that window can fail (a branch check
 * answered 502); undici's `disconnect` says the close has landed.
 */
export async function connectionsClosed(timeoutMs = 2_000) {
  const giveUp = Date.now() + timeoutMs;
  while (connections.open > 0 && Date.now() < giveUp) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
