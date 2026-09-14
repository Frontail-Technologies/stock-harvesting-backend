import { describe, expect, it } from "vitest";
import {
  INCREMENTAL_OVERLAP_TRADING_DAYS,
  RECENT_REPAIR_WINDOW_CALENDAR_DAYS,
  planDailyCandleSync,
} from "./market-data.candle-sync-plan";

describe("planDailyCandleSync", () => {
  it("still plans the bounded recent repair range for a fresh symbol instead of no-op", () => {
    const plan = planDailyCandleSync({
      latestStoredDate: "2026-09-11",
      latestExpectedTradingDate: "2026-09-11",
    });

    expect(plan.kind).toBe("range");
    if (plan.kind !== "range") return;
    expect(plan.to).toBe("2026-09-11");
    expect(plan.from < plan.to).toBe(true);
    expect(plan.from).toBe("2026-08-07");
  });

  it("plans a bounded range when latest stored is one day stale", () => {
    const plan = planDailyCandleSync({
      latestStoredDate: "2026-09-10",
      latestExpectedTradingDate: "2026-09-11",
    });

    expect(plan.kind).toBe("range");
    if (plan.kind !== "range") return;
    expect(plan.to).toBe("2026-09-11");
    expect(plan.from).toBe("2026-08-07");
  });

  it("starts near latestStored minus overlap, not the repair window, when stored is much older", () => {
    const latestStoredDate = "2026-07-01";
    const latestExpectedTradingDate = "2026-09-11";
    const plan = planDailyCandleSync({ latestStoredDate, latestExpectedTradingDate });

    expect(plan.kind).toBe("range");
    if (plan.kind !== "range") return;
    const expectedIncrementalFrom = "2026-06-26";
    expect(plan.from).toBe(expectedIncrementalFrom);
    const repairFrom = "2026-08-07";
    expect(plan.from < repairFrom).toBe(true);
    expect(plan.repairTriggered).toBe(false);
  });

  it("reports bootstrap-required when there is no stored history", () => {
    const plan = planDailyCandleSync({
      latestStoredDate: null,
      latestExpectedTradingDate: "2026-09-11",
    });

    expect(plan).toEqual({ kind: "bootstrap-required" });
  });

  it("never plans a from date after the to date", () => {
    const plan = planDailyCandleSync({
      latestStoredDate: "2026-09-11",
      latestExpectedTradingDate: "2026-09-11",
    });

    expect(plan.kind).toBe("range");
    if (plan.kind !== "range") return;
    expect(plan.from <= plan.to).toBe(true);
  });

  it("handles a future/bad stored timestamp safely without a from date beyond to", () => {
    const plan = planDailyCandleSync({
      latestStoredDate: "2099-01-01",
      latestExpectedTradingDate: "2026-09-11",
    });

    expect(plan.kind).toBe("range");
    if (plan.kind !== "range") return;
    expect(plan.from <= plan.to).toBe(true);
    expect(plan.from).toBe("2026-08-07");
  });

  it("is deterministic across repeated calls with the same input", () => {
    const input = {
      latestStoredDate: "2026-08-20",
      latestExpectedTradingDate: "2026-09-11",
    };
    const first = planDailyCandleSync(input);
    const second = planDailyCandleSync(input);
    expect(first).toEqual(second);
  });

  it("marks repairTriggered true when the repair window starts earlier than the incremental window", () => {
    const plan = planDailyCandleSync({
      latestStoredDate: "2026-09-10",
      latestExpectedTradingDate: "2026-09-11",
    });
    expect(plan.kind).toBe("range");
    if (plan.kind !== "range") return;
    expect(plan.repairTriggered).toBe(true);
  });

  it("exposes the documented constants", () => {
    expect(INCREMENTAL_OVERLAP_TRADING_DAYS).toBe(5);
    expect(RECENT_REPAIR_WINDOW_CALENDAR_DAYS).toBe(35);
  });
});
