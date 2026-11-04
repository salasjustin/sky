import { Agent, setGlobalDispatcher } from "undici";
import { afterAll, afterEach, beforeAll, expect } from "vitest";
import { connections, connectionsClosed, leaks, server } from "./msw.js";

// MSW's mocked TLS sockets are closed under a kept-alive pool entry the next request reuses: fetch rejects with UND_ERR_SOCKET "closed". pipelining: 0 gives every request its own connection
const agent = new Agent({ pipelining: 0 });
agent.on("connect", () => connections.open++);
agent.on("disconnect", () => connections.open--);
setGlobalDispatcher(agent);

// 'error' rejects the fetch, which app code may catch and render as a fallback; the afterEach guard fails the test regardless
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(async () => {
  await connectionsClosed();
  server.resetHandlers();
  expect(leaks.splice(0), "requests no handler answered").toEqual([]);
});
afterAll(() => server.close());
