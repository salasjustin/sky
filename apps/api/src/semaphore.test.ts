import { expect, test, vi } from "vitest";
import { createSemaphore } from "./semaphore.js";

const gate = () => {
  let open = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
};

test("no more than the limit run at once, and each waiting task starts when a slot frees, in order", async () => {
  const withSlot = createSemaphore(2);
  const started: number[] = [];
  const gates = [gate(), gate(), gate(), gate()];
  const runs = gates.map((g, i) =>
    withSlot(async () => {
      started.push(i);
      await g.wait;
      return i;
    }),
  );
  // a free slot runs its task synchronously, so only the first two have started
  expect(started).toEqual([0, 1]);

  gates[1]?.open();
  await runs[1];
  await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));

  gates[0]?.open();
  await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3]));
  gates[2]?.open();
  gates[3]?.open();
  expect(await Promise.all(runs)).toEqual([0, 1, 2, 3]);
  expect(started).toEqual([0, 1, 2, 3]);
});

test("a task that throws frees its slot", async () => {
  const withSlot = createSemaphore(1);
  await expect(
    withSlot(async () => {
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  expect(await withSlot(async () => "next")).toBe("next");
});
