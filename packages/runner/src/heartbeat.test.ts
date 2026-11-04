import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createHeartbeat } from "./heartbeat.js";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const setup = () => {
  const beats: { toolName: string; toolUseId: string; elapsedMs: number }[] =
    [];
  const heartbeat = createHeartbeat({
    beat: (b) => beats.push(b),
    intervalMs: 60_000,
  });
  return { beats, heartbeat };
};

test("beats every interval for a call in flight, with how long it has run", () => {
  const { beats, heartbeat } = setup();
  heartbeat.started("t1", "Bash");
  vi.advanceTimersByTime(59_000);
  expect(beats).toEqual([]);
  vi.advanceTimersByTime(1_000);
  vi.advanceTimersByTime(60_000);
  expect(beats).toEqual([
    { toolName: "Bash", toolUseId: "t1", elapsedMs: 60_000 },
    { toolName: "Bash", toolUseId: "t1", elapsedMs: 120_000 },
  ]);
  heartbeat.stop();
});

test("is silent once the last call returns, and starts again for the next", () => {
  const { beats, heartbeat } = setup();
  heartbeat.started("t1", "Bash");
  vi.advanceTimersByTime(60_000);
  heartbeat.ended("t1");
  vi.advanceTimersByTime(300_000);
  expect(beats).toHaveLength(1);
  heartbeat.started("t2", "Task");
  vi.advanceTimersByTime(60_000);
  expect(beats.at(-1)).toEqual({
    toolName: "Task",
    toolUseId: "t2",
    elapsedMs: 60_000,
  });
  heartbeat.stop();
});

test("names the longest-running call while several are in flight", () => {
  const { beats, heartbeat } = setup();
  heartbeat.started("t1", "Bash");
  vi.advanceTimersByTime(30_000);
  heartbeat.started("t2", "Read");
  vi.advanceTimersByTime(30_000);
  expect(beats).toEqual([
    { toolName: "Bash", toolUseId: "t1", elapsedMs: 60_000 },
  ]);
  heartbeat.ended("t1");
  vi.advanceTimersByTime(60_000);
  expect(beats.at(-1)).toMatchObject({ toolUseId: "t2" });
  heartbeat.stop();
});

test("a beat that throws doesn't stop the next, and stop silences everything", () => {
  let calls = 0;
  const heartbeat = createHeartbeat({
    beat: () => {
      calls++;
      throw new Error("post failed");
    },
    intervalMs: 1_000,
  });
  heartbeat.started("t1", "Bash");
  vi.advanceTimersByTime(3_000);
  expect(calls).toBe(3);
  heartbeat.stop();
  vi.advanceTimersByTime(5_000);
  expect(calls).toBe(3);
});
