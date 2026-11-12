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

// the 12-hour clock's edges: midnight, just before noon, noon, after it, late;
// 9 and 21 reset at 12:20pm and 12:20am
const hours = [0, 1, 9, 11, 12, 13, 21, 22, 23];

const H = 3_600_000;
const M = 60_000;

test.each(hours)(
  "at %i:05 UTC a 5-hour message reads back as the reset it names, ahead of now",
  (hour) => {
    const now = Date.UTC(2026, 10, 12, hour, 5);
    const limit = fiveHourLimit(now);
    const read = parseUsageLimit(limit.text, new Date(now));
    expect(read?.window).toBe("5-hour");
    expect(read?.resetsAt?.toISOString()).toBe(limit.at);
    expect(Date.parse(limit.at)).toBeGreaterThan(now);
    expect(Date.parse(limit.at) - now).toBeLessThanOrEqual(3 * H + 20 * M);
  },
);

test.each([
  [9, "12:20pm"],
  [21, "12:20am"],
])(
  "at %i:05 UTC a 5-hour message says %s and reads back through it",
  (hour, words) => {
    const now = Date.UTC(2026, 10, 12, hour, 5);
    const limit = fiveHourLimit(now);
    expect(limit.text).toContain(`resets ${words} (UTC)`);
    expect(
      parseUsageLimit(limit.text, new Date(now))?.resetsAt?.toISOString(),
    ).toBe(limit.at);
  },
);

test.each(hours)(
  "at %i:00:00.000 UTC a 5-hour reset is exactly 3h20m ahead",
  (hour) => {
    const now = Date.UTC(2026, 10, 12, hour, 0, 0, 0);
    const limit = fiveHourLimit(now);
    expect(Date.parse(limit.at) - now).toBe(3 * H + 20 * M);
    expect(
      parseUsageLimit(limit.text, new Date(now))?.resetsAt?.toISOString(),
    ).toBe(limit.at);
  },
);

test.each(hours)(
  "at %i:59:59.999 UTC a 5-hour reset is just over 2h20m ahead",
  (hour) => {
    const now = Date.UTC(2026, 10, 12, hour, 59, 59, 999);
    const limit = fiveHourLimit(now);
    expect(Date.parse(limit.at) - now).toBe(2 * H + 20 * M + 1);
    expect(
      parseUsageLimit(limit.text, new Date(now))?.resetsAt?.toISOString(),
    ).toBe(limit.at);
  },
);

// now -> the message -> the instant it names, worked by hand: the reset is 20 past the hour three
// hours on, and a time before now rolls to the next day, across month and year ends
test.each([
  ["2026-12-31T22:05:00Z", "1:20am", "2027-01-01T01:20:00.000Z"],
  ["2026-12-31T23:05:00Z", "2:20am", "2027-01-01T02:20:00.000Z"],
  ["2026-04-30T23:05:00Z", "2:20am", "2026-05-01T02:20:00.000Z"],
  ["2027-02-28T23:05:00Z", "2:20am", "2027-03-01T02:20:00.000Z"],
  ["2028-02-28T23:05:00Z", "2:20am", "2028-02-29T02:20:00.000Z"],
  ["2028-02-29T23:05:00Z", "2:20am", "2028-03-01T02:20:00.000Z"],
])("a 5-hour message at %s says %s and resets %s", (nowIso, words, at) => {
  const now = new Date(nowIso);
  const limit = fiveHourLimit(now.getTime());
  expect(limit).toEqual({
    text: `You've hit your 5-hour limit · resets ${words} (UTC)`,
    at,
  });
  expect(parseUsageLimit(limit.text, now)?.resetsAt?.toISOString()).toBe(at);
});

// the weekly text carries a date and no year: Dec 30 reads Jan 2 back in the next year
test.each([
  ["2026-12-30T08:00:00Z", "Jan 2", "2027-01-02T10:00:00.000Z"],
  ["2028-02-26T08:00:00Z", "Feb 29", "2028-02-29T10:00:00.000Z"],
  ["2027-02-26T08:00:00Z", "Mar 1", "2027-03-01T10:00:00.000Z"],
])("a weekly message at %s says %s and resets %s", (nowIso, date, at) => {
  const now = new Date(nowIso);
  const limit = weeklyLimit(3, 10, now.getTime());
  expect(limit).toEqual({
    text: `You've hit your weekly limit · resets ${date}, 10am (UTC)`,
    at,
  });
  const read = parseUsageLimit(limit.text, now);
  expect(read?.window).toBe("weekly");
  expect(read?.resetsAt?.toISOString()).toBe(at);
});

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
