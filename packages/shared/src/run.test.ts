import { expect, test } from "vitest";
import { canTransition, Run, RunStatus, runTransitions } from "./run.js";

const usage = {
  inputTokens: 1200,
  outputTokens: 340,
  costUsd: 0.042,
  turns: 3,
  durationMs: 18_500,
};

test("accepts a finished run with summary and usage", () => {
  const run = {
    id: "run_1",
    agentId: "agt_1",
    status: "finished",
    summary: "added tests",
    usage,
  };
  expect(Run.parse(run)).toEqual(run);
});

test("accepts a starting run with no summary or usage yet", () => {
  const run = {
    id: "run_1",
    agentId: "agt_1",
    status: "starting",
    summary: null,
    usage: null,
  };
  expect(Run.parse(run)).toEqual(run);
});

test("rejects an unknown status and negative usage", () => {
  const base = { id: "run_1", agentId: "agt_1", summary: null, usage: null };
  expect(Run.safeParse({ ...base, status: "done" }).success).toBe(false);
  expect(
    Run.safeParse({
      ...base,
      status: "finished",
      usage: { ...usage, turns: -1 },
    }).success,
  ).toBe(false);
});

test("transition table matches the run lifecycle", () => {
  expect(runTransitions).toEqual({
    starting: ["running", "failed", "stopped"],
    running: ["waiting", "finished", "failed", "stopped"],
    waiting: ["running", "failed", "stopped"],
    queued: ["starting", "failed", "stopped"],
    finished: [],
    failed: [],
    stopped: [],
  });
  expect(Object.keys(runTransitions).sort()).toEqual(
    [...RunStatus.options].sort(),
  );
});

test("canTransition allows only table edges", () => {
  expect(canTransition("waiting", "running")).toBe(true);
  expect(canTransition("starting", "waiting")).toBe(false);
  expect(canTransition("finished", "running")).toBe(false);
});
