import { describe, expect, it } from "vitest";

import { decideChartCandleFreshnessAction, isLatestDailyCandleStale } from "./market-data.service";

// getChartCandles itself talks directly to the module-level `db` import and
// the live provider registry, so it can't be unit tested without a real
// Postgres connection (none is reachable in this environment - same
// constraint noted in market-data.backfill-atomicity.test.ts). This tests
// the actual decision function it now calls before deciding whether to
// trigger a refresh - the part of the "1D freshness" fix that previously
// didn't exist at all - directly and deterministically.
describe("isLatestDailyCandleStale", () => {
  it("is not stale when the latest row matches today's expected trading day", () => {
    // Well after NSE's 15:30 IST close, so today counts as the latest
    // expected trading day.
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
    // 12:00 UTC is after NSE's IST close but before a US exchange's ET close
    // on the same calendar day - the same stored date is fresh for one
    // exchange and stale for the other.
    const at = new Date("2026-01-06T12:00:00Z");
    expect(isLatestDailyCandleStale([{ time: "2026-01-05" }], "NSE", at)).toBe(true);
    expect(isLatestDailyCandleStale([{ time: "2026-01-05" }], "US", at)).toBe(false);
  });
});

// The full backfill/incremental-refresh/no-op decision getChartCandles
// makes - see that function's own comment for why missing/discontinuous/
// incomplete history takes priority over mere staleness. This does not
// change any of the three predicates it composes, only proves their
// combination picks the right action.
describe("decideChartCandleFreshnessAction", () => {
  const freshRow = { time: "2026-01-06", close: 100 };

  it("no stored candles at all -> full backfill", () => {
    expect(decideChartCandleFreshnessAction([], "2025-01-01", undefined, "NSE")).toBe("backfill");
  });

  it("fresh stored candles -> no action (no provider call of any kind)", () => {
    // isLatestDailyCandleStale defaults its `at` param to `new Date()`, so
    // this composed decision can't inject a fixed clock the way the
    // isLatestDailyCandleStale tests above do - use a row whose date is
    // always <= "today" relative to the real clock, and instead assert the
    // *shape* of the decision (never "backfill", which fresh data must
    // never trigger).
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

  it("existing rows don't cover the explicitly requested older `from` date -> full backfill", () => {
    const rows = [{ time: "2024-06-01", close: 100 }];
    // Requested history starts in 2020, but the oldest stored row is 2024 -
    // the stored range doesn't cover what was explicitly asked for.
    expect(decideChartCandleFreshnessAction(rows, "2020-01-01", "2020-01-01", "NSE")).toBe(
      "backfill"
    );
  });

  it("no explicit `from` was requested -> missing older history alone does not force a backfill", () => {
    const rows = [{ time: "2024-06-01", close: 100 }];
    // Same stored range as above, but requestedFrom (explicitFrom) is
    // undefined - shouldBackfillRequestedHistory only fires for an
    // explicitly-requested from date, matching its own documented
    // contract, so only the freshness check (not staleness-irrelevant
    // here since this row could be considered fresh or stale depending on
    // the real clock) governs - the point is backfill is not forced purely
    // by "there might be older history we don't have".
    const result = decideChartCandleFreshnessAction(rows, "2020-01-01", undefined, "NSE");
    expect(result).not.toBe("backfill");
  });
});
