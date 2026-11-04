import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";

export const server = setupServer();

// the live Sprites GitHub gateway refuses any path containing `..` (a compare URL, `main...branch`),
// so the fake does too; the guard sits ahead of every handler a test adds, and falls through otherwise
const refuseTraversal = http.all("*", ({ request }) => {
  const { pathname } = new URL(request.url);
  if (!pathname.includes("/gateway/github/")) return;
  const decoded = (() => {
    try {
      return decodeURIComponent(pathname);
    } catch {
      return pathname;
    }
  })();
  if (decoded.includes("..") || pathname.includes("..")) {
    return HttpResponse.json(
      { error: "invalid path: path traversal detected" },
      { status: 400 },
    );
  }
});
const addHandlers = server.use.bind(server);
server.use = (...handlers) => addHandlers(refuseTraversal, ...handlers);

// request no handler answered; the setup file fails the test on any entry
export const leaks: string[] = [];

server.events.on("request:unhandled", ({ request }) => {
  leaks.push(`unhandled ${request.method} ${request.url}`);
});
server.events.on("response:bypass", ({ request }) => {
  leaks.push(`real network ${request.method} ${request.url}`);
});
server.events.on("unhandledException", ({ request, error }) => {
  leaks.push(`handler threw on ${request.method} ${request.url}: ${error}`);
});
