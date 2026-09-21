import { describe, expect, it, vi } from "vitest";

vi.mock("../db/client", () => ({ db: {}, pool: { end: vi.fn() } }));

import { describeAvailability, indiaToday, parseArgs, shiftDate } from "./check-gdf-symbol-candles";

const NOW = new Date("2026-09-21T05:00:00.000Z"); // 10:30 IST

describe("parseArgs", () => {
  it("defaults to today (IST), BSE and a 10 day lookback", () => {
    expect(parseArgs(["utlsolar"], NOW)).toEqual({ symbol: "UTLSOLAR", date: "2026-09-21", exchange: "BSE", lookbackDays: 10, direct: false });
  });

  it("reads the options", () => {
    expect(parseArgs(["TCS", "--date", "2026-09-18", "--exchange", "bse_idx", "--days", "5", "--direct"], NOW)).toEqual({
      symbol: "TCS",
      date: "2026-09-18",
      exchange: "BSE_IDX",
      lookbackDays: 5,
      direct: true,
    });
  });

  it("rejects a missing symbol, a bad date and an unknown option", () => {
    expect(() => parseArgs([], NOW)).toThrow(/Usage/);
    expect(() => parseArgs(["TCS", "--date", "21-09-2026"], NOW)).toThrow(/YYYY-MM-DD/);
    expect(() => parseArgs(["TCS", "--bogus"], NOW)).toThrow(/Unknown argument/);
  });
});

describe("date helpers", () => {
  it("uses the India date, not UTC", () => {
    expect(indiaToday(new Date("2026-09-20T19:00:00.000Z"))).toBe("2026-09-21");
  });

  it("shifts dates across month ends", () => {
    expect(shiftDate("2026-09-21", -10)).toBe("2026-09-11");
    expect(shiftDate("2026-03-02", -5)).toBe("2026-02-25");
  });
});

describe("describeAvailability", () => {
  const base = { date: "2026-09-21", today: "2026-09-21", historyDates: [] as string[], snapshotDate: null as string | null, storedDates: [] as string[] | null };

  it("says available when GDF's daily history has the date", () => {
    const result = describeAvailability({ ...base, historyDates: ["2026-09-18", "2026-09-21"] });
    expect(result.inHistory).toBe(true);
    expect(result.verdict).toMatch(/^Available/);
  });

  it("explains that today only exists as a live snapshot until the daily candle is finalised", () => {
    const result = describeAvailability({ ...base, historyDates: ["2026-09-18"], snapshotDate: "2026-09-21" });
    expect(result.inHistory).toBe(false);
    expect(result.verdict).toMatch(/live snapshot only/);
  });

  it("says a past date without a candle is genuinely missing", () => {
    const result = describeAvailability({ ...base, date: "2026-09-16", historyDates: ["2026-09-15", "2026-09-17"] });
    expect(result.verdict).toMatch(/^Not available: GDF returned no daily candle for 2026-09-16/);
  });

  it("reports what our database holds, or that it is unknown", () => {
    expect(describeAvailability({ ...base, storedDates: ["2026-09-21"] }).lines.join("\n")).toMatch(/Stored in our database: YES/);
    expect(describeAvailability({ ...base, storedDates: null }).lines.join("\n")).toMatch(/unknown/);
  });
});
