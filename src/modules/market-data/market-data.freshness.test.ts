import { describe, expect, it } from "vitest";

import { isLatestDailyCandleStale } from "./market-data.service";

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
