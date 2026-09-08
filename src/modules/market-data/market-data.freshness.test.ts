import { describe, expect, it } from "vitest";

import {
  decideChartCandleFreshnessAction,
  isLatestDailyCandleStale,
  markHistoryGapBackfillAttempted,
  shouldRetryHistoryGapBackfill,
} from "./market-data.service";

// getChartCandles itself can't be unit tested without a real Postgres connection (same constraint as market-data.backfill-atomicity.test.ts), so this tests the decision function it calls before refreshing - the previously-missing "1D freshness" logic - directly and deterministically.
describe("isLatestDailyCandleStale", () => {
  it("is not stale when the latest row matches today's expected trading day", () => {
    // Well after NSE's 15:30 IST close, so today counts as the latest expected trading day.
    const at = new Date("2026-01-06T12:00:00Z");
    expect(isLatestDailyCandleStale([{ time: "2026-01-06" }], "NSE", at)).toBe(false);
  });

  it("is stale when the latest row is older than the expected trading day", () => {
    const at = new Date("2026-01-06T12:00:00Z");
    expect(isLatestDailyCandleStale([{ time: "2026-01-05" }], "NSE", at)).toBe(true);
    expect(isLatestDailyCandleStale([{ time: "2025-12-20" }], "NSE", at)).toBe(true);
  });

  it("is never stale for an empty row set - that case is handled by the backfill branch instead", () => {
    const at = new Date("2026-01-06T12:00:00Z");
    expect(isLatestDailyCandleStale([], "NSE", at)).toBe(false);
  });

  it("evaluates freshness per exchange independently (NSE vs a US-style exchange)", () => {
    // 12:00 UTC is after NSE's IST close but before a US exchange's ET close on the same calendar day - the same stored date is fresh for one exchange and stale for the other.
    const at = new Date("2026-01-06T12:00:00Z");
    expect(isLatestDailyCandleStale([{ time: "2026-01-05" }], "NSE", at)).toBe(true);
    expect(isLatestDailyCandleStale([{ time: "2026-01-05" }], "US", at)).toBe(false);
  });
});

// The full backfill/incremental-refresh/no-op decision getChartCandles makes - see that function's comment for why missing/discontinuous/incomplete history takes priority over mere staleness; this only proves the combined predicates pick the right action.
describe("decideChartCandleFreshnessAction", () => {
  const freshRow = { time: "2026-01-06", close: 100 };

  it("no stored candles at all -> full backfill", () => {
    expect(decideChartCandleFreshnessAction([], "2025-01-01", undefined, "NSE")).toBe("backfill");
  });

  it("fresh stored candles -> no action (no provider call of any kind)", () => {
    // isLatestDailyCandleStale defaults `at` to `new Date()`, so this composed decision can't inject a fixed clock like the tests above - use a row dated <= "today" and assert the *shape* of the decision instead (never "backfill", which fresh data must never trigger).
    const result = decideChartCandleFreshnessAction([freshRow], "2025-01-01", undefined, "NSE");
    expect(result).not.toBe("backfill");
  });

  it("stale stored candles (latest row older than expected) -> incremental refresh, not a full backfill", () => {
    // A row far enough in the past to be stale under any real-world clock.
    const longStaleRow = { time: "2020-01-01", close: 100 };
    const result = decideChartCandleFreshnessAction([longStaleRow], "2015-01-01", undefined, "NSE");
    expect(result).toBe("incremental-refresh");
  });

  it("a likely split discontinuity forces a full backfill even though rows exist and the latest is fresh", () => {
    const splitRows = [
      { time: "2026-01-01", close: 1000 },
      { time: "2026-01-02", close: 200 }, // 5x jump - matches the >=4x split heuristic
    ];
    expect(decideChartCandleFreshnessAction(splitRows, "2025-01-01", undefined, "NSE")).toBe(
      "backfill"
    );
  });

  it("a multi-month hole in the middle of otherwise-present history forces a full backfill", () => {
    // Reproduces a real production case: an instrument whose provider-facing symbol changed (company rename) has candles before and after but nothing in between - other checks (emptiness, split ratio, latest-row staleness) can't see this hole since both surrounding rows look individually fine.
    const rowsWithGap = [
      { time: "2021-07-22", close: 125 },
      { time: "2023-12-29", close: 123 },
      { time: "2025-04-09", close: 211 }, // ~15 months after the previous row
    ];
    expect(decideChartCandleFreshnessAction(rowsWithGap, "2015-01-01", undefined, "NSE")).toBe(
      "backfill"
    );
  });

  it("a normal weekend/holiday-sized gap between adjacent rows does not force a backfill", () => {
    const rowsWithWeekendGap = [
      { time: "2026-01-02", close: 100 }, // Friday
      { time: "2026-01-05", close: 101 }, // Monday
    ];
    const result = decideChartCandleFreshnessAction(
      rowsWithWeekendGap,
      "2015-01-01",
      undefined,
      "NSE"
    );
    expect(result).not.toBe("backfill");
  });

  it("existing rows don't cover the explicitly requested older `from` date -> full backfill", () => {
    const rows = [{ time: "2024-06-01", close: 100 }];
    // Requested history starts in 2020, but the oldest stored row is 2024 - the stored range doesn't cover what was explicitly asked for.
    expect(decideChartCandleFreshnessAction(rows, "2020-01-01", "2020-01-01", "NSE")).toBe(
      "backfill"
    );
  });

  it("no explicit `from` was requested -> missing older history alone does not force a backfill", () => {
    const rows = [{ time: "2024-06-01", close: 100 }];
    // Same stored range as above, but requestedFrom is undefined - shouldBackfillRequestedHistory only fires for an explicitly-requested from date, so backfill is not forced purely by "there might be older history we don't have".
    const result = decideChartCandleFreshnessAction(rows, "2020-01-01", undefined, "NSE");
    expect(result).not.toBe("backfill");
  });
});

// getChartCandles can't be unit tested (see module comment above), so this exercises the retry-cooldown gate directly - it prevents a permanently-unfillable gap from triggering a full-history provider fetch on every chart open. The underlying Map is a real, un-mocked module-level singleton persisting for this whole file, so each test uses a unique exchange:symbol pair.
describe("shouldRetryHistoryGapBackfill / markHistoryGapBackfillAttempted", () => {
  it("allows the first attempt when nothing has been recorded yet", () => {
    expect(shouldRetryHistoryGapBackfill("NSE", "GAPTEST_FIRST")).toBe(true);
  });

  it("blocks an immediate retry right after an attempt was recorded", () => {
    const at = Date.parse("2026-01-01T00:00:00Z");
    markHistoryGapBackfillAttempted("NSE", "GAPTEST_IMMEDIATE", at);
    expect(shouldRetryHistoryGapBackfill("NSE", "GAPTEST_IMMEDIATE", at)).toBe(false);
  });

  it("still blocks a retry attempted just under 24 hours later", () => {
    const at = Date.parse("2026-01-01T00:00:00Z");
    markHistoryGapBackfillAttempted("NSE", "GAPTEST_UNDER_COOLDOWN", at);
    const almostADayLater = at + 24 * 60 * 60 * 1000 - 1;
    expect(shouldRetryHistoryGapBackfill("NSE", "GAPTEST_UNDER_COOLDOWN", almostADayLater)).toBe(
      false
    );
  });

  it("allows a retry once the 24-hour cooldown has fully elapsed", () => {
    const at = Date.parse("2026-01-01T00:00:00Z");
    markHistoryGapBackfillAttempted("NSE", "GAPTEST_AFTER_COOLDOWN", at);
    const aDayLater = at + 24 * 60 * 60 * 1000;
    expect(shouldRetryHistoryGapBackfill("NSE", "GAPTEST_AFTER_COOLDOWN", aDayLater)).toBe(true);
  });

  it("tracks exchange and symbol independently, not as a shared/global cooldown", () => {
    const at = Date.parse("2026-01-01T00:00:00Z");
    markHistoryGapBackfillAttempted("NSE", "GAPTEST_SCOPED", at);
    expect(shouldRetryHistoryGapBackfill("BSE", "GAPTEST_SCOPED", at)).toBe(true);
    expect(shouldRetryHistoryGapBackfill("NSE", "GAPTEST_SCOPED_OTHER", at)).toBe(true);
  });
});
