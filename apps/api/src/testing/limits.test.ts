import { expect, test } from "vitest";
import { parseUsageLimit } from "../claude-credentials.js";
import { clock12, fiveHourLimit, weeklyLimit } from "./limits.js";

test.each([
  [0, 0, "12am"],
  [0, 20, "12:20am"],
  [1, 0, "1am"],
  [9, 5, "9:05am"],
  [11, 20, "11:20am"],
  [12, 0, "12pm"],
  [12, 20, "12:20pm"],
  [13, 0, "1pm"],
  [23, 20, "11:20pm"],
])("hour %i minute %i is worded %s", (hour, minute, words) => {
  expect(clock12(hour, minute)).toBe(words);
});

// the hours the fixtures once got wrong or could: midnight, just before noon, noon, after it, late
const hours = [0, 1, 11, 12, 13, 22, 23];

test.each(hours)(
  "at %i:05 UTC a 5-hour message reads back as the reset it names, ahead of now",
  (hour) => {
    const now = Date.UTC(2026, 10, 12, hour, 5);
    const limit = fiveHourLimit(now);
    const read = parseUsageLimit(limit.text, new Date(now));
    expect(read?.window).toBe("5-hour");
    expect(read?.resetsAt?.toISOString()).toBe(limit.at);
    expect(Date.parse(limit.at)).toBeGreaterThan(now);
    expect(Date.parse(limit.at) - now).toBeLessThanOrEqual(
      3 * 3_600_000 + 20 * 60_000,
    );
  },
);

test.each(hours)(
  "a weekly message for %i o'clock reads back as the reset it names",
  (hour) => {
    const now = Date.UTC(2026, 10, 12, 8, 0);
    const limit = weeklyLimit(3, hour, now);
    const read = parseUsageLimit(limit.text, new Date(now));
    expect(read?.window).toBe("weekly");
    expect(read?.resetsAt?.toISOString()).toBe(limit.at);
  },
);
