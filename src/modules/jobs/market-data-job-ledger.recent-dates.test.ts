import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../db/client", () => ({ db: {} }));

import { recentCandleDatesCondition, recentDatesLookbackStart } from "./market-data-job-ledger";

const dialect = new PgDialect();

describe("recent candle dates lookup (Market Data operations)", () => {
  it("looks back 14 days from the trading date", () => {
    expect(recentDatesLookbackStart("2026-09-18")).toBe("2026-09-04");
    expect(recentDatesLookbackStart("2026-03-05")).toBe("2026-02-19");
  });

  it("is bounded by time so only the newest hypertable chunks are read", () => {
    const { sql, params } = dialect.sqlToQuery(recentCandleDatesCondition("BSE", "2026-09-18"));

    expect(sql).toMatch(/"time" >= \$\d+/);
    expect(sql).toMatch(/"time" <= \$\d+/);
    expect(params).toEqual(expect.arrayContaining(["2026-09-04", "2026-09-18"]));
  });

  it("filters by exchange, not by a list of thousands of instrument ids", () => {
    const { sql, params } = dialect.sqlToQuery(recentCandleDatesCondition("BSE_IDX", "2026-09-18"));

    expect(sql).toMatch(/"exchange" = \$\d+/);
    expect(sql).not.toMatch(/ in \(/i);
    expect(params).toContain("BSE_IDX");
    expect(params.length).toBeLessThan(10);
  });
});
