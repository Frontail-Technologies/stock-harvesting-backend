import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db/client", () => ({ db: {} }));

import type { DbOrTx } from "../../db/client";
import { buildLatestCandleStatsQuery, refreshLatestInstrumentStats } from "./market-data.instruments";

const dialect = new PgDialect();

function render(query: unknown) {
  return dialect.sqlToQuery(query as Parameters<PgDialect["sqlToQuery"]>[0]);
}

type ExecuteCall = { text: string; params: unknown[] };

// A fake DbOrTx that records every statement and answers the stats SELECT with `candlesBySymbol`
// (newest first, as the real query returns them) - everything else (the UPDATE) gets an empty result.
function fakeDb(candlesBySymbol: Record<string, Array<{ close: string; open: string; volume: string; time: string }>>) {
  const calls: ExecuteCall[] = [];
  const execute = vi.fn(async (query: unknown) => {
    const rendered = render(query);
    calls.push({ text: rendered.sql, params: rendered.params });
    if (!/^\s*SELECT/i.test(rendered.sql)) return { rows: [] };

    const requested = rendered.params.filter((param): param is string => typeof param === "string");
    const rows = Object.entries(candlesBySymbol)
      .filter(([symbol]) => requested.includes(symbol))
      .flatMap(([symbol, list]) => list.map((row) => ({ symbol, ...row })));
    return { rows };
  });
  return { db: { execute } as unknown as DbOrTx, calls };
}

const TCS_CANDLES = [
  { close: "110.0000", open: "105.0000", volume: "5000", time: "2026-09-18" },
  { close: "100.0000", open: "98.0000", volume: "4000", time: "2026-09-17" },
];

const selects = (calls: ExecuteCall[]) => calls.filter((call) => /^\s*SELECT/i.test(call.text));
const updates = (calls: ExecuteCall[]) => calls.filter((call) => /^\s*UPDATE/i.test(call.text));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildLatestCandleStatsQuery - single symbol", () => {
  it("is a direct indexed lookup by instrument_id, not unnest + LATERAL", () => {
    const { sql, params } = render(buildLatestCandleStatsQuery(["TCS"], "BSE"));

    expect(sql).not.toMatch(/unnest/i);
    expect(sql).not.toMatch(/lateral/i);
    expect(sql).toMatch(/c\.instrument_id = \(\s*SELECT i\.id FROM instruments i WHERE i\.exchange = \$\d+ AND i\.symbol = \$\d+\s*\)/);
    expect(sql).toMatch(/ORDER BY c\.time DESC\s+LIMIT 2/);
    expect(params).toEqual(expect.arrayContaining(["TCS", "BSE", "1D"]));
  });

  it("never filters candles by their exchange/symbol columns (no index has served those since migration 0020)", () => {
    for (const symbols of [["TCS"], ["TCS", "INFY", "RELIANCE"]]) {
      const { sql } = render(buildLatestCandleStatsQuery(symbols, "BSE"));
      expect(sql).not.toMatch(/c\.exchange/);
      expect(sql).not.toMatch(/c\.symbol/);
      expect(sql).not.toMatch(/candles\.(exchange|symbol)/);
    }
  });

  it("targets BSE_IDX the same way as BSE - only the exchange parameter differs", () => {
    const bse = render(buildLatestCandleStatsQuery(["1000EQ"], "BSE"));
    const idx = render(buildLatestCandleStatsQuery(["1000EQ"], "BSE_IDX"));

    expect(idx.sql).toBe(bse.sql);
    expect(bse.params).toContain("BSE");
    expect(idx.params).toContain("BSE_IDX");
    expect(idx.params).not.toContain("BSE");
  });
});

describe("buildLatestCandleStatsQuery - batch", () => {
  it("uses one LATERAL per instrument over the (instrument_id, timeframe, time) index", () => {
    const { sql, params } = render(buildLatestCandleStatsQuery(["TCS", "INFY", "RELIANCE"], "BSE"));

    expect(sql).toMatch(/CROSS JOIN LATERAL/);
    expect(sql).toMatch(/WHERE c\.instrument_id = i\.id/);
    expect(sql).toMatch(/AND c\.timeframe = \$\d+/);
    expect(sql).toMatch(/i\.symbol = ANY\(ARRAY\[/);
    expect(sql).toMatch(/ORDER BY c\.time DESC\s+LIMIT 2/);
    expect(params).toEqual(expect.arrayContaining(["TCS", "INFY", "RELIANCE", "BSE", "1D"]));
  });

  it("is read-only", () => {
    for (const symbols of [["TCS"], ["TCS", "INFY"]]) {
      const { sql } = render(buildLatestCandleStatsQuery(symbols, "BSE"));
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
    }
  });
});

describe("buildLatestCandleStatsQuery - time bound", () => {
  const since = new Date("2026-08-01T00:00:00.000Z");

  it.each([[["TCS"]], [["TCS", "INFY"]]])("bounds the candle scan by time when `since` is given (%j)", (symbols) => {
    const bounded = render(buildLatestCandleStatsQuery(symbols, "BSE", since));
    const unbounded = render(buildLatestCandleStatsQuery(symbols, "BSE"));

    expect(bounded.sql).toMatch(/AND c\.time >= \$\d+/);
    expect(unbounded.sql).not.toMatch(/c\.time >=/);
    expect(bounded.params.some((param) => param instanceof Date && param.getTime() === since.getTime())).toBe(true);
  });
});

describe("refreshLatestInstrumentStats", () => {
  it("BSE single symbol: latest two candles produce close, open, volume and change%", async () => {
    const { db, calls } = fakeDb({ TCS: TCS_CANDLES });

    await refreshLatestInstrumentStats("BSE", ["tcs"], db);

    expect(selects(calls)).toHaveLength(1);
    const [update] = updates(calls);
    expect(update.params).toEqual(expect.arrayContaining(["TCS", 110, 105, 5000, 10, "2026-09-18", "BSE"]));
  });

  it("BSE_IDX single symbol goes through the same path with the BSE_IDX exchange", async () => {
    const { db, calls } = fakeDb({ "1000EQ": TCS_CANDLES });

    await refreshLatestInstrumentStats("BSE_IDX", ["1000EQ"], db);

    expect(selects(calls)[0].params).toContain("BSE_IDX");
    expect(updates(calls)[0].params).toContain("BSE_IDX");
  });

  it("no candles: runs the read and writes nothing", async () => {
    const { db, calls } = fakeDb({});

    await refreshLatestInstrumentStats("BSE_IDX", ["1000EQ"], db);

    // time-bounded read, then one unbounded retry for the symbol with no recent candles
    expect(selects(calls)).toHaveLength(2);
    expect(updates(calls)).toHaveLength(0);
  });

  it("a symbol with a single candle gets a null change%", async () => {
    const { db, calls } = fakeDb({ TCS: [TCS_CANDLES[0]] });

    await refreshLatestInstrumentStats("BSE", ["TCS"], db);

    expect(updates(calls)[0].params).toContain(null);
  });

  it("batch: one stats read for the whole batch, never one query per symbol", async () => {
    const symbols = Array.from({ length: 250 }, (_, index) => `SYM${index}`);
    const { db, calls } = fakeDb(Object.fromEntries(symbols.map((symbol) => [symbol, TCS_CANDLES])));

    await refreshLatestInstrumentStats("BSE", symbols, db);

    expect(selects(calls)).toHaveLength(1);
    expect(selects(calls)[0].params).toEqual(expect.arrayContaining(symbols));
    // writes stay chunked bulk UPDATEs, not one per symbol
    expect(updates(calls).length).toBeLessThan(symbols.length / 10);
  });

  it("batch with some symbols lacking candles updates only the ones that have them", async () => {
    const { db, calls } = fakeDb({ TCS: TCS_CANDLES });

    await refreshLatestInstrumentStats("BSE", ["TCS", "NOCANDLES"], db);

    expect(selects(calls)).toHaveLength(2);
    expect(selects(calls)[1].params).toContain("NOCANDLES");
    expect(selects(calls)[1].params).not.toContain("TCS");
    const updateParams = updates(calls)[0].params;
    expect(updateParams).toContain("TCS");
    expect(updateParams).not.toContain("NOCANDLES");
  });

  it("de-duplicates and normalizes symbols before querying", async () => {
    const { db, calls } = fakeDb({ TCS: TCS_CANDLES });

    await refreshLatestInstrumentStats("BSE", ["tcs", "TCS", " tcs "], db);

    // collapses to a single symbol -> the direct single-symbol query
    expect(selects(calls)[0].text).not.toMatch(/LATERAL/i);
  });

  it("does nothing at all for an empty symbol list", async () => {
    const { db, calls } = fakeDb({});

    await refreshLatestInstrumentStats("BSE", [], db);

    expect(calls).toHaveLength(0);
  });
});
