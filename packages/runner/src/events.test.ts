import { HttpResponse, http } from "msw";
import { expect, test, vi } from "vitest";
import { server } from "../../../test/msw.js";
import { createPoster, RunEndedError, warningReporter } from "./events.js";

const url = "https://api.test/internal/events";
const options = {
  apiBaseUrl: "https://api.test",
  agentToken: "agent-secret",
  sleep: async () => {},
};

/** A sleep that only advances a virtual clock, so a two-minute retry budget runs at once. */
function virtualClock() {
  const clock = {
    time: 0,
    slept: [] as number[],
    now: () => clock.time,
    sleep: async (ms: number) => {
      clock.slept.push(ms);
      clock.time += ms;
    },
  };
  return clock;
}

/** The poster's clock options, driven by `clock`; a fixed jitter keeps its sums whole. */
const timing = (clock: ReturnType<typeof virtualClock>) => ({
  sleep: clock.sleep,
  now: clock.now,
  random: () => 0.5,
});

test("posts the event with the agent bearer token", async () => {
  const sent: unknown[] = [];
  server.use(
    http.post(url, async ({ request }) => {
      sent.push({
        auth: request.headers.get("authorization"),
        body: await request.json(),
      });
      return new HttpResponse(null, { status: 204 });
    }),
  );
  const post = createPoster({ ...options, warn: () => {} });
  await post({
    runId: "run_1",
    type: "run.started",
    payload: { sessionId: "s" },
  });
  expect(sent).toEqual([
    {
      auth: "Bearer agent-secret",
      body: {
        runId: "run_1",
        type: "run.started",
        payload: { sessionId: "s" },
      },
    },
  ]);
});

test("retries a failed post", async () => {
  let calls = 0;
  server.use(
    http.post(url, () => {
      calls++;
      if (calls === 1) return HttpResponse.error();
      if (calls === 2) return new HttpResponse(null, { status: 503 });
      return new HttpResponse(null, { status: 204 });
    }),
  );
  const warnings: string[] = [];
  const post = createPoster({ ...options, warn: (m) => warnings.push(m) });
  await post({
    runId: "run_1",
    type: "claude.Message",
    payload: { text: "hi" },
  });
  expect(calls).toBe(3);
  expect(warnings).toEqual([]);
});

test("gives up after its attempts without throwing, and says so on the warn channel", async () => {
  let calls = 0;
  server.use(
    http.post(url, () => {
      calls++;
      return new HttpResponse("nope", { status: 500 });
    }),
  );
  const warnings: string[] = [];
  const post = createPoster({ ...options, warn: (m) => warnings.push(m) });
  await expect(
    post({ runId: "run_1", type: "claude.Message", payload: { text: "hi" } }),
  ).resolves.toBeUndefined();
  expect(calls).toBe(3);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toMatch(/claude\.Message.*500/);
  expect(warnings[0]).not.toMatch(/agent-secret/);
});

test("refuses an event the shared schema rejects before sending it", async () => {
  const post = createPoster({ ...options, warn: () => {} });
  await expect(
    post({ runId: "run_1", type: "run.started", payload: {} } as never),
  ).rejects.toThrow();
});

test("a retried waiting post answered request_open landed the first time, so it stops without a warning", async () => {
  let calls = 0;
  server.use(
    http.post(url, () => {
      calls++;
      // the first post was stored, but its response never arrived
      if (calls === 1) return HttpResponse.error();
      return HttpResponse.json(
        { error: { code: "request_open", message: "open" } },
        { status: 409 },
      );
    }),
  );
  const warnings: string[] = [];
  const post = createPoster({ ...options, warn: (m) => warnings.push(m) });
  await post({
    runId: "run_1",
    type: "run.waiting",
    payload: {
      request: { kind: "question", requestId: "req_1", prompt: "which?" },
    },
  });
  expect(calls).toBe(2);
  expect(warnings).toEqual([]);
});

test.each(["run.waiting", "run.finished", "run.failed"] as const)(
  "%s outlasts a minute-long API outage",
  async (type) => {
    const clock = virtualClock();
    const landedAt: number[] = [];
    server.use(
      http.post(url, () => {
        if (clock.time < 60_000) return HttpResponse.error();
        landedAt.push(clock.time);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const warnings: string[] = [];
    const post = createPoster({
      ...options,
      ...timing(clock),
      warn: (m) => warnings.push(m),
    });
    await post(endingEvent(type));
    expect(warnings).toEqual([]);
    expect(landedAt).toHaveLength(1);
  },
);

test("an ending event gives up after about two minutes of retries, with one warning", async () => {
  const clock = virtualClock();
  server.use(http.post(url, () => new HttpResponse(null, { status: 503 })));
  const warnings: string[] = [];
  const post = createPoster({
    ...options,
    ...timing(clock),
    warn: (m) => warnings.push(m),
  });
  await post(endingEvent("run.finished"));
  expect(clock.time).toBeGreaterThanOrEqual(90_000);
  expect(clock.time).toBeLessThanOrEqual(150_000);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toMatch(/run\.finished.*503/);
});

test("progress keeps the short budget through an outage", async () => {
  const clock = virtualClock();
  let calls = 0;
  server.use(
    http.post(url, () => {
      calls++;
      return HttpResponse.error();
    }),
  );
  const post = createPoster({ ...options, ...timing(clock), warn: () => {} });
  await post({
    runId: "run_1",
    type: "claude.Message",
    payload: { text: "hi" },
  });
  expect(calls).toBe(3);
  expect(clock.slept).toEqual([250, 500]);
});

test("a post given one attempt makes only that one, then drops the event with one warning", async () => {
  const clock = virtualClock();
  let calls = 0;
  server.use(
    http.post(url, () => {
      calls++;
      return new HttpResponse(null, { status: 503 });
    }),
  );
  const warnings: string[] = [];
  const post = createPoster({
    ...options,
    ...timing(clock),
    warn: (m) => warnings.push(m),
  });
  await post(
    {
      runId: "run_1",
      type: "runner.heartbeat",
      payload: { toolName: "Bash", toolUseId: "t1", elapsedMs: 1 },
    },
    { maxAttempts: 1 },
  );
  expect(calls).toBe(1);
  expect(clock.slept).toEqual([]);
  expect(warnings).toEqual([
    expect.stringMatching(/runner\.heartbeat after 1 attempts: HTTP 503/),
  ]);
});

test("claude.PreToolUse rides out a minute-long API restart instead of being dropped", async () => {
  const clock = virtualClock();
  const landedAt: number[] = [];
  server.use(
    http.post(url, () => {
      if (clock.time < 60_000)
        return clock.time % 2
          ? HttpResponse.error()
          : new HttpResponse(null, { status: 502 });
      landedAt.push(clock.time);
      return new HttpResponse(null, { status: 204 });
    }),
  );
  const warnings: string[] = [];
  const post = createPoster({
    ...options,
    ...timing(clock),
    warn: (m) => warnings.push(m),
  });
  await post({
    runId: "run_1",
    type: "claude.PreToolUse",
    payload: { toolName: "Bash", toolUseId: "t1", input: "{}" },
  });
  expect(warnings).toEqual([]);
  expect(landedAt).toHaveLength(1);
});

test("claude.PreToolUse is still dropped with one warning once its two minutes run out", async () => {
  const clock = virtualClock();
  server.use(http.post(url, () => new HttpResponse(null, { status: 503 })));
  const warnings: string[] = [];
  const post = createPoster({
    ...options,
    ...timing(clock),
    warn: (m) => warnings.push(m),
  });
  await expect(
    post({
      runId: "run_1",
      type: "claude.PreToolUse",
      payload: { toolName: "Bash", toolUseId: "t1", input: "{}" },
    }),
  ).resolves.toBeUndefined();
  expect(clock.time).toBe(120_000);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toMatch(/claude\.PreToolUse.*503/);
});

test("a run.waiting that can't land by its deadline rejects instead of being dropped", async () => {
  const clock = virtualClock();
  const bodies: unknown[] = [];
  server.use(
    http.post(url, async ({ request }) => {
      bodies.push(await request.json());
      return new HttpResponse(null, { status: 503 });
    }),
  );
  const post = createPoster({ ...options, ...timing(clock), warn: () => {} });
  await expect(
    post(endingEvent("run.waiting"), { deadline: 45_000 }),
  ).rejects.toThrow(/run\.waiting.*req_1.*HTTP 503/);
  expect(clock.time).toBe(45_000);
  // every attempt opens the same request: the API can tell a retry from a second request
  expect(bodies.length).toBeGreaterThan(3);
  expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
});

test("a run.waiting answered request_open on its first attempt rejects: some other request is open", async () => {
  server.use(
    http.post(url, () =>
      HttpResponse.json(
        { error: { code: "request_open", message: "open" } },
        { status: 409 },
      ),
    ),
  );
  const post = createPoster({ ...options, warn: () => {} });
  await expect(
    post(endingEvent("run.waiting"), { deadline: Date.now() + 60_000 }),
  ).rejects.toThrow(/HTTP 409/);
});

test("a run.waiting the API refuses for good rejects at once", async () => {
  let calls = 0;
  server.use(
    http.post(url, () => {
      calls++;
      return HttpResponse.json(
        { error: { code: "unauthorized", message: "bad token" } },
        { status: 401 },
      );
    }),
  );
  const post = createPoster({ ...options, warn: () => {} });
  await expect(
    post(endingEvent("run.waiting"), { deadline: Date.now() + 60_000 }),
  ).rejects.toThrow(/HTTP 401/);
  expect(calls).toBe(1);
});

test("a run.waiting for a run the API already ended rejects with RunEndedError at once", async () => {
  let calls = 0;
  server.use(
    http.post(url, () => {
      calls++;
      return HttpResponse.json(
        { error: { code: "run_ended", message: "the run has ended" } },
        { status: 401 },
      );
    }),
  );
  const post = createPoster({ ...options, warn: () => {} });
  await expect(
    post(endingEvent("run.waiting"), { deadline: Date.now() + 60_000 }),
  ).rejects.toBeInstanceOf(RunEndedError);
  expect(calls).toBe(1);
});

test("retries back off exponentially with full jitter, capped at 30 s", async () => {
  const clock = virtualClock();
  server.use(http.post(url, () => new HttpResponse(null, { status: 503 })));
  const post = createPoster({ ...options, ...timing(clock), warn: () => {} });
  await post(endingEvent("run.failed"));
  // half of 500 · 2^n, the ceiling 30 s halved too; the last pause is cut short at the deadline
  expect(clock.slept).toEqual([
    250, 500, 1000, 2000, 4000, 8000, 15_000, 15_000, 15_000, 15_000, 15_000,
    15_000, 14_250,
  ]);
});

test("a stop during a backoff pause rejects a run.waiting with the stop's reason at once", async () => {
  server.use(http.post(url, () => new HttpResponse(null, { status: 503 })));
  const controller = new AbortController();
  const post = createPoster({
    ...options,
    // a pause that only a stop ends
    sleep: (_ms: number, signal?: AbortSignal) =>
      new Promise<void>((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason));
        controller.abort(new Error("stopped"));
      }),
    warn: () => {},
  });
  await expect(
    post(endingEvent("run.waiting"), {
      deadline: Date.now() + 60_000,
      signal: controller.signal,
    }),
  ).rejects.toThrow("stopped");
});

test("a stop during a run.waiting post the API never answers rejects with the stop's reason at once", async () => {
  server.use(http.post(url, () => new Promise<never>(() => {})));
  const controller = new AbortController();
  const post = createPoster({ ...options, warn: () => {} });
  const posting = post(endingEvent("run.waiting"), {
    deadline: Date.now() + 60_000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(new Error("stopped")), 10);
  await expect(posting).rejects.toThrow("stopped");
});

test.each([408, 429])(
  "a run.waiting answered %i is retried and lands",
  async (code) => {
    const clock = virtualClock();
    let calls = 0;
    server.use(
      http.post(url, () => {
        calls++;
        return new HttpResponse(null, { status: calls === 1 ? code : 204 });
      }),
    );
    const post = createPoster({ ...options, ...timing(clock), warn: () => {} });
    await expect(
      post(endingEvent("run.waiting"), { deadline: 60_000 }),
    ).resolves.toBeUndefined();
    expect(calls).toBe(2);
    expect(clock.slept).toEqual([250]);
  },
);

test("a refusal the API won't change its mind on ends the retries at once", async () => {
  let calls = 0;
  server.use(
    http.post(url, () => {
      calls++;
      return HttpResponse.json(
        { error: { code: "run_ended", message: "the run has ended" } },
        { status: 401 },
      );
    }),
  );
  const warnings: string[] = [];
  const post = createPoster({ ...options, warn: (m) => warnings.push(m) });
  await post(endingEvent("run.failed"));
  expect(calls).toBe(1);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toMatch(/run\.failed.*401/);
});

function endingEvent(
  type: "run.waiting" | "run.finished" | "run.failed",
): Parameters<ReturnType<typeof createPoster>>[0] {
  const runId = "run_1";
  switch (type) {
    case "run.waiting":
      return {
        runId,
        type,
        payload: {
          request: { kind: "question", requestId: "req_1", prompt: "which?" },
        },
      };
    case "run.finished":
      return {
        runId,
        type,
        payload: {
          summary: "done",
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            costUsd: 0,
            turns: 1,
            durationMs: 1,
          },
        },
      };
    case "run.failed":
      return { runId, type, payload: { error: "boom" } };
  }
}

test("warningReporter posts the message as the run's runner.warning, and swallows a post that fails", async () => {
  const sent: unknown[] = [];
  const report = warningReporter(async (event) => {
    sent.push(event);
  }, "run_1");
  report("runner: sprite task PUT failed: HTTP 503");
  expect(sent).toEqual([
    {
      runId: "run_1",
      type: "runner.warning",
      payload: { message: "runner: sprite task PUT failed: HTTP 503" },
    },
  ]);

  const failing = warningReporter(async () => {
    throw new Error("down");
  }, "run_1");
  expect(() => failing("again")).not.toThrow();
  // the rejection was caught, not left unhandled
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("a runner.warning reaches the API as an ordinary event post", async () => {
  const sent: unknown[] = [];
  server.use(
    http.post(url, async ({ request }) => {
      sent.push(await request.json());
      return new HttpResponse(null, { status: 204 });
    }),
  );
  const post = createPoster({ ...options, warn: () => {} });
  warningReporter(post, "run_1")("runner: sprite not held");
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]).toEqual({
    runId: "run_1",
    type: "runner.warning",
    payload: { message: "runner: sprite not held" },
  });
});
