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

test("a call read in an earlier response stops being beaten for once the next begins, end hook or no", () => {
  const { beats, heartbeat } = setup();
  heartbeat.assistantMessage("m1", ["t1"]);
  heartbeat.started("t1", "ToolSearch");
  heartbeat.assistantMessage("m2", ["t2"]);
  vi.advanceTimersByTime(120_000);
  expect(beats).toEqual([]);
  heartbeat.started("t2", "Bash");
  vi.advanceTimersByTime(60_000);
  expect(beats).toEqual([
    { toolName: "Bash", toolUseId: "t2", elapsedMs: 60_000 },
  ]);
  heartbeat.stop();
});

test("parallel calls of one response stay tracked across its split messages", () => {
  const { beats, heartbeat } = setup();
  heartbeat.assistantMessage("m1", ["t1"]);
  heartbeat.started("t1", "Bash");
  heartbeat.assistantMessage("m1", ["t2"]);
  heartbeat.started("t2", "Read");
  vi.advanceTimersByTime(60_000);
  expect(beats).toEqual([
    { toolName: "Bash", toolUseId: "t1", elapsedMs: 60_000 },
  ]);
  heartbeat.stop();
});

test("a call started before the session reads the response that made it survives the turn changes ahead of it", () => {
  const { beats, heartbeat } = setup();
  // the hooks ran while the session's loop was still behind, before it had read m1
  heartbeat.started("t1", "Read");
  heartbeat.ended("t1");
  heartbeat.started("t2", "Bash");
  heartbeat.assistantMessage("m1", ["t1"]);
  heartbeat.assistantMessage("m2", ["t2"]);
  vi.advanceTimersByTime(60_000);
  expect(beats).toEqual([
    { toolName: "Bash", toolUseId: "t2", elapsedMs: 60_000 },
  ]);
  heartbeat.assistantMessage("m3", []);
  vi.advanceTimersByTime(60_000);
  expect(beats).toHaveLength(1);
  heartbeat.stop();
});

test("an agent's new response drops only that agent's earlier calls", () => {
  const { beats, heartbeat } = setup();
  heartbeat.assistantMessage("s1", ["t2"], "sub_1");
  heartbeat.started("t2", "ToolSearch");
  vi.advanceTimersByTime(1_000);
  heartbeat.assistantMessage("m1", ["t1"]);
  heartbeat.started("t1", "Bash");
  // the subagent's next response: its own ToolSearch has ended, the main thread's Bash hasn't
  heartbeat.assistantMessage("s2", ["t3"], "sub_1");
  vi.advanceTimersByTime(59_000);
  expect(beats).toEqual([
    { toolName: "Bash", toolUseId: "t1", elapsedMs: 59_000 },
  ]);
  heartbeat.started("t3", "Read");
  heartbeat.assistantMessage("m2", []);
  vi.advanceTimersByTime(60_000);
  expect(beats.at(-1)).toEqual({
    toolName: "Read",
    toolUseId: "t3",
    elapsedMs: 60_000,
  });
  heartbeat.stop();
});

test("a background task survives a new turn and is beaten for under its own name, behind any call in flight", () => {
  const { beats, heartbeat } = setup();
  heartbeat.setBackground([{ taskId: "b1", taskType: "local_bash" }]);
  heartbeat.assistantMessage("m1", []);
  vi.advanceTimersByTime(60_000);
  heartbeat.started("t1", "Read");
  vi.advanceTimersByTime(60_000);
  heartbeat.ended("t1");
  heartbeat.setBackground([]);
  vi.advanceTimersByTime(120_000);
  expect(beats.map((b) => b.toolName)).toEqual(["Bash (background)", "Read"]);
  heartbeat.stop();
});
