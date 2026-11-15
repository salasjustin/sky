/** At most `limit` holders at once; later ones wait their turn in the order they asked. */
export function createSemaphore(limit: number) {
  let held = 0;
  const waiting: (() => void)[] = [];
  return async function withSlot<T>(task: () => Promise<T>): Promise<T> {
    if (held >= limit) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    } else {
      held++;
    }
    try {
      return await task();
    } finally {
      // the slot passes straight to the next waiter, so `held` doesn't dip
      const next = waiting.shift();
      if (next) next();
      else held--;
    }
  };
}
