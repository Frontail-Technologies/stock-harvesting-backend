import { describe, expect, it } from "vitest";

import { resolveLatestCompletedWeekEnding } from "../market-data/trading-calendar";
import {
  resolveLiveScannerSignalFromDailyCloses,
  resolveScannerSignalFromDailyCloses,
} from "./scanner-current-signal";

const EXCHANGE = "BSE";
const LOOKBACK_WEEKS = 50;

function shiftDays(date: string, days: number) {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

// One daily row per completed week (on its Friday), oldest first, ending at the
// latest completed Friday. `closeAt(index)` is the close of completed week `index`.
function completedWeeks(count: number, closeAt: (index: number) => number) {
  const lastFriday = resolveLatestCompletedWeekEnding(EXCHANGE);
  return Array.from({ length: count }, (_, index) => ({
    time: shiftDays(lastFriday, -7 * (count - 1 - index)),
    close: closeAt(index),
  }));
}

// A Wednesday of the week AFTER the latest completed one - the forming week.
function formingWeekRow(close: number) {
  return { time: shiftDays(resolveLatestCompletedWeekEnding(EXCHANGE), 5), close };
}

describe("resolveLiveScannerSignalFromDailyCloses", () => {
  it("counts a stock as matched as soon as the forming week qualifies, while the completed-only chain still does not", () => {
    // A high of 1000 inside the window, everything else 500 -> not near the high.
    const history = completedWeeks(55, (index) => (index === 30 ? 1000 : 500));
    const daily = [...history, formingWeekRow(950)];

    const live = resolveLiveScannerSignalFromDailyCloses(daily, EXCHANGE, LOOKBACK_WEEKS);
    const completedOnly = resolveScannerSignalFromDailyCloses(daily, EXCHANGE, LOOKBACK_WEEKS);

    expect(live.matched).toBe(true);
    expect(live.previousWeekMatched).toBe(false);
    expect(completedOnly.matched).toBe(false);
  });

  it("counts a stock as out as soon as the forming week drops away from its high", () => {
    const history = completedWeeks(55, (index) => (index === 30 || index === 54 ? 1000 : 500));
    const daily = [...history, formingWeekRow(500)];

    const live = resolveLiveScannerSignalFromDailyCloses(daily, EXCHANGE, LOOKBACK_WEEKS);

    expect(live.previousWeekMatched).toBe(true);
    expect(live.matched).toBe(false);
  });

  it("equals the completed-only result when no row exists yet for the forming week", () => {
    const daily = completedWeeks(55, (index) => (index === 30 ? 1000 : 900));

    expect(resolveLiveScannerSignalFromDailyCloses(daily, EXCHANGE, LOOKBACK_WEEKS)).toEqual(
      resolveScannerSignalFromDailyCloses(daily, EXCHANGE, LOOKBACK_WEEKS)
    );
  });

  it("still reports no signal for a stale symbol whose latest daily row is older than the last completed week", () => {
    const stale = completedWeeks(55, () => 900).map((row) => ({ ...row, time: shiftDays(row.time, -70) }));

    const live = resolveLiveScannerSignalFromDailyCloses(stale, EXCHANGE, LOOKBACK_WEEKS);

    expect(live.matched).toBe(false);
    expect(live.effectiveLookbackWeeks).toBeNull();
  });
});
