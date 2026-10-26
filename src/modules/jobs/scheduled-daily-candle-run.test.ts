import { describe, expect, it } from "vitest";

import { getScheduledDailyCandleRun } from "./scheduled-daily-candle-run";

describe("scheduled daily candle run identity", () => {
  it("keeps Monday morning attached to Monday and the previous completed Friday", () => {
    const scheduledAt = new Date("2026-10-26T04:15:00.000Z");
    expect(getScheduledDailyCandleRun(
      `repeat:repeatable-daily-candle-sync-BSE-morning:${scheduledAt.getTime()}`,
      "BSE",
      new Date("2026-10-26T05:00:00.000Z"),
    )).toMatchObject({ tradingDate: "2026-10-26", coverageTradingDate: "2026-10-23", stale: false });
  });

  it("marks an old scheduled job stale rather than relabeling it as today", () => {
    const scheduledAt = new Date("2026-10-16T10:45:00.000Z");
    expect(getScheduledDailyCandleRun(
      `repeat:repeatable-daily-candle-sync-BSE-post-market:${scheduledAt.getTime()}`,
      "BSE",
      new Date("2026-10-26T05:00:00.000Z"),
    )).toMatchObject({ tradingDate: "2026-10-16", coverageTradingDate: "2026-10-16", stale: true });
  });

  it("does not treat manual jobs as scheduled runs", () => {
    expect(getScheduledDailyCandleRun("daily-candle-schedule-recovery-BSE-2026-10-26", "BSE")).toBeNull();
  });
});
