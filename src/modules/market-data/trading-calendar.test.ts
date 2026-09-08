import { describe, expect, it } from "vitest";

import {
  getIsoWeekRange,
  getLatestExpectedTradingDay,
  getWeekEndingFriday,
  isCompletedTradingWeek,
  resolveCompletedWeekEndingFromTradingDay,
  resolveLatestCompletedWeekEnding,
} from "./trading-calendar";

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
    // Monday 2026-01-05, before close - the prior trading day is Friday 2026-01-02, not Sunday 2026-01-04.
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

// The week of Mon 2026-01-05 .. Sun 2026-01-11 - a weekly candle's own `time` is the first trading day of its ISO week (see aggregateWeeklyCandles), so "2026-01-05" stands in for that whole week throughout these cases.
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
    // Deliberate design choice: a week only becomes "complete" once evaluation moves into the FOLLOWING ISO week, not merely once its last trading day's close has passed - a delayed/corrective EOD sync over the weekend could still touch Friday's candle.
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

describe("getIsoWeekRange", () => {
  it("resolves a mid-week date to that week's Monday-Sunday bounds", () => {
    // 2026-09-03 is a Thursday.
    expect(getIsoWeekRange("2026-09-03")).toEqual({ start: "2026-08-31", end: "2026-09-06" });
  });

  it("a Monday input is already the start of its own range", () => {
    expect(getIsoWeekRange("2026-08-31")).toEqual({ start: "2026-08-31", end: "2026-09-06" });
  });

  it("a Sunday input belongs to the week that started the previous Monday", () => {
    expect(getIsoWeekRange("2026-09-06")).toEqual({ start: "2026-08-31", end: "2026-09-06" });
  });

  it("handles a year boundary correctly", () => {
    // 2025-12-31 is a Wednesday.
    expect(getIsoWeekRange("2025-12-31")).toEqual({ start: "2025-12-29", end: "2026-01-04" });
  });
});

describe("getWeekEndingFriday", () => {
  it("converts a Monday (the aggregateWeeklyCandles convention) to that week's Friday", () => {
    expect(getWeekEndingFriday("2026-08-17")).toBe("2026-08-21");
  });

  it("converts a Tuesday - the first trading day of a week whose Monday was a holiday - to the same Friday a Monday-anchored week would use", () => {
    expect(getWeekEndingFriday("2026-08-18")).toBe("2026-08-21");
  });

  it("a Friday input is already its own week-ending label", () => {
    expect(getWeekEndingFriday("2026-08-21")).toBe("2026-08-21");
  });

  it("a Sunday input belongs to the week that just ended, not the upcoming one", () => {
    expect(getWeekEndingFriday("2026-08-23")).toBe("2026-08-21");
  });
});

// A. normal Mon-Fri week -> weekEnding = Friday. B. Saturday/Sunday -> latest completed week = previous Friday (per isCompletedTradingWeek above). C. Monday-Thursday before the current weekly candle completes -> previous completed Friday. D. covered by isCompletedTradingWeek's holiday-blind-but-consistent behavior - no separate holiday model exists to test against.
describe("resolveLatestCompletedWeekEnding", () => {
  it("A: a normal Tuesday mid-week -> the completed week is last week's Friday", () => {
    // 2026-01-06 is a Tuesday in the week of Jan 5-9.
    const at = new Date("2026-01-06T10:05:00Z");
    expect(resolveLatestCompletedWeekEnding("NSE", at)).toBe("2026-01-02");
  });

  it("B: Saturday -> still last week's Friday, not the Friday that just closed", () => {
    // 2026-01-10 is the Saturday right after the week-of-Jan-5's own Friday (Jan 9) closed - isCompletedTradingWeek doesn't consider that week done yet, so the completed week remains the one before it.
    const at = new Date("2026-01-10T12:00:00Z");
    expect(resolveLatestCompletedWeekEnding("NSE", at)).toBe("2026-01-02");
  });

  it("B: Sunday -> same as Saturday", () => {
    const at = new Date("2026-01-11T03:00:00Z");
    expect(resolveLatestCompletedWeekEnding("NSE", at)).toBe("2026-01-02");
  });

  it("C: Monday of the following week -> the week that just ended is now complete", () => {
    const at = new Date("2026-01-12T10:05:00Z");
    expect(resolveLatestCompletedWeekEnding("NSE", at)).toBe("2026-01-09");
  });

  it("evaluates independently per exchange, in that exchange's own timezone", () => {
    const at = new Date("2026-01-06T10:05:00Z");
    expect(resolveLatestCompletedWeekEnding("NSE", at)).toBe(resolveLatestCompletedWeekEnding("US", at));
  });
});

describe("resolveCompletedWeekEndingFromTradingDay", () => {
  it("is a pure function of the trading day - reapplying it to an already-stored value reproduces the original result", () => {
    const at = new Date("2026-01-06T10:05:00Z");
    const freshTradingDay = getLatestExpectedTradingDay("NSE", at);
    const freshResult = resolveLatestCompletedWeekEnding("NSE", at);

    // Simulates reading back a persisted asOfDate value at a much later time and re-deriving the SAME week the original computation used, rather than whatever "latest" week is current at read time.
    expect(resolveCompletedWeekEndingFromTradingDay(freshTradingDay)).toBe(freshResult);
  });
});
