import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";

// request no handler answered; the setup file fails the test on any entry
export const leaks: string[] = [];

// the live Sprites GitHub gateway refuses any path containing `..` (a compare URL, `main...branch`)
// with a 400, so the fake does too and records the request as a leak, which fails the test even when
// the code under test swallows the 400. Only `..` inside a path segment reaches it: URL parsing
// collapses a whole `..` segment first. It is an initial handler, which `server.use` always leaves
// behind the handlers a test adds, so `use` is wrapped to put it ahead of them again.
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
