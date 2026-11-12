const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** A time of day as Claude words it on a 12-hour clock: 12:20am is hour 0, 12:20pm is hour 12, 1:20pm is hour 13. */
export function clock12(hour: number, minute = 0): string {
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  const time =
    minute === 0 ? `${hour12}` : `${hour12}:${String(minute).padStart(2, "0")}`;
  return `${time}${hour < 12 ? "am" : "pm"}`;
}

/** A limit message and the instant it says the limit lifts. */
export type LimitFixture = { text: string; at: string };

/**
 * A weekly-limit message whose reset is `hour` o'clock (UTC) on the calendar day `days` after
 * `now`'s, so between `days - 1` and `days + 1` days ahead of it, whatever day the suite runs. Keep
 * `days` within 1..6: below that the reset can fall at or before `now` and read as no reset, above
 * it can pass the 7-day cap `markLimited` holds a reset to.
 */
export function weeklyLimit(
  days = 3,
  hour = 10,
  now: number = Date.now(),
): LimitFixture {
  const at = new Date(now + days * 86_400_000);
  at.setUTCHours(hour, 0, 0, 0);
  return {
    text: `You've hit your weekly limit · resets ${MONTH_NAMES[at.getUTCMonth()]} ${at.getUTCDate()}, ${clock12(hour)} (UTC)`,
    at: at.toISOString(),
  };
}

/**
 * A 5-hour-limit message whose reset is 20 past an hour, more than 2h20m after `now` (at hh:59:59.999)
 * and at most 3h20m (at hh:00:00.000): ahead of the test whatever time of day it runs, midnight
 * included.
 */
export function fiveHourLimit(now: number = Date.now()): LimitFixture {
  const at = new Date(now);
  at.setUTCMinutes(20, 0, 0);
  at.setUTCHours(at.getUTCHours() + 3);
  return {
    text: `You've hit your 5-hour limit · resets ${clock12(at.getUTCHours(), 20)} (UTC)`,
    at: at.toISOString(),
  };
}
