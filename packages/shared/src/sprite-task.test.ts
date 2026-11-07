import { expect, test } from "vitest";
import { spriteTaskNameFor } from "./sprite-task.js";

test("the task name is the lowercase hex hash both the API and the runner PUT under", () => {
  expect(spriteTaskNameFor("run_abc123")).toMatch(/^sky-run-[0-9a-f]{24}$/);
  expect(spriteTaskNameFor("run_abc123")).toBe(spriteTaskNameFor("run_abc123"));
  expect(spriteTaskNameFor("run_abc123")).not.toBe(
    spriteTaskNameFor("run_abc124"),
  );
});
