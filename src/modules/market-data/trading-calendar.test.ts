import { describe, expect, it } from "vitest";

import { getLatestExpectedTradingDay, isCompletedTradingWeek } from "./trading-calendar";

// NSE/BSE close at 15:30 IST (Asia/Kolkata, UTC+5:30) = 10:00 UTC.
describe("getLatestExpectedTradingDay - India exchanges (NSE)", () => {
  it("returns today once the market close has passed on a weekday", () => {
    // 2026-01-06 is a Tuesday. 10:05 UTC = 15:35 IST.
    const at = new Date("2026-01-06T10:05:00Z");
    expect(getLatestExpectedTradingDay("NSE", at)).toBe("2026-01-06");
  });

  it("returns the previous weekday while the market is still open", () => {
    // 09:00 UTC = 14:30 IST, before the 15:30 close.
    const at = new Date("2026-01-06T09:00:00Z");
    expect(getLatestExpectedTradingDay("NSE", at)).toBe("2026-01-05");
  });

  it("skips the weekend when the previous day would be a Sunday/Saturday", () => {
    // Monday 2026-01-05, before close - the prior trading day is Friday
    // 2026-01-02, not Sunday 2026-01-04.
    const at = new Date("2026-01-05T09:00:00Z");
    expect(getLatestExpectedTradingDay("NSE", at)).toBe("2026-01-02");
  });

  it("resolves to Friday when evaluated on a Saturday", () => {
    const at = new Date("2026-01-10T12:00:00Z");
    expect(getLatestExpectedTradingDay("NSE", at)).toBe("2026-01-09");
  });

  it("resolves to Friday when evaluated on a Sunday", () => {
    const at = new Date("2026-01-11T03:00:00Z");
    expect(getLatestExpectedTradingDay("NSE", at)).toBe("2026-01-09");
  });
});

// US-style exchanges close at 16:00 America/New_York (UTC-5 in January) = 21:00 UTC.
describe("getLatestExpectedTradingDay - non-India exchanges (US)", () => {
  it("returns today once the market close has passed on a weekday", () => {
    const at = new Date("2026-01-06T21:05:00Z");
    expect(getLatestExpectedTradingDay("US", at)).toBe("2026-01-06");
  });

  it("returns the previous weekday while the market is still open", () => {
    const at = new Date("2026-01-06T20:00:00Z");
    expect(getLatestExpectedTradingDay("US", at)).toBe("2026-01-05");
  });
});

// The week of Mon 2026-01-05 .. Sun 2026-01-11 - a weekly candle's own
// `time` is the first trading day of its ISO week (see
// aggregateWeeklyCandles), so "2026-01-05" stands in for that whole week
// throughout these cases.
describe("isCompletedTradingWeek", () => {
  it("is not complete while still inside the same ISO week (mid-week)", () => {
    const at = new Date("2026-01-06T10:05:00Z"); // Tuesday, after NSE close
    expect(isCompletedTradingWeek("2026-01-05", "NSE", at)).toBe(false);
  });

  it("is not complete on the week's own last trading day, even after close", () => {
    const at = new Date("2026-01-09T10:05:00Z"); // Friday, after NSE close
    expect(isCompletedTradingWeek("2026-01-05", "NSE", at)).toBe(false);
  });

  it("is not complete over the trailing weekend of the same week", () => {
    // Deliberate design choice (see the Phase C1.5 report): a week only
    // becomes "complete" once evaluation has moved into the FOLLOWING ISO
    // week, not merely once its last trading day's close has passed - a
    // delayed/corrective EOD sync over the weekend could still touch
    // Friday's candle, so this stays conservative rather than assuming
    // Friday's close is final the moment it lands.
    const at = new Date("2026-01-11T03:00:00Z"); // Sunday
    expect(isCompletedTradingWeek("2026-01-05", "NSE", at)).toBe(false);
  });

  it("is complete once evaluated from the following week", () => {
    const at = new Date("2026-01-12T10:05:00Z"); // Monday of the next week
    expect(isCompletedTradingWeek("2026-01-05", "NSE", at)).toBe(true);
  });

  it("is complete for any week further in the past", () => {
    const at = new Date("2026-03-01T10:05:00Z");
    expect(isCompletedTradingWeek("2026-01-05", "NSE", at)).toBe(true);
  });

  it("applies the same rule for non-India exchanges, in their own timezone", () => {
    const midWeek = new Date("2026-01-06T21:05:00Z"); // Tuesday, after US close
    const nextWeek = new Date("2026-01-12T21:05:00Z"); // Monday of the next week
    expect(isCompletedTradingWeek("2026-01-05", "US", midWeek)).toBe(false);
    expect(isCompletedTradingWeek("2026-01-05", "US", nextWeek)).toBe(true);
  });
});
