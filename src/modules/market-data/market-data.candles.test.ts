import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db/client", () => ({ db: { select: vi.fn(), selectDistinct: vi.fn() } }));

import * as dbClientModule from "../../db/client";
import {
  deleteCandlesForRefresh,
  findSymbolsNeedingHistoryBackfill,
  readCandleHistoryRange,
  readChartCandles,
  readMetricCandles,
  readScannerDailyCloses,
  upsertCandles,
} from "./market-data.candles";

const db = vi.mocked(dbClientModule.db);

function selectResult(rows: unknown[], onWhere?: (arg: unknown) => void) {
  const chain = {
    from: () => chain,
    where: (arg: unknown) => {
      onWhere?.(arg);
      return chain;
    },
    groupBy: () => chain,
    orderBy: () => chain,
    then: (resolve: (value: unknown[]) => void, reject: (reason?: unknown) => void) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return chain as never;
}

// Flattens a Drizzle SQL condition tree into its raw text so a test can
// assert which operators/columns a WHERE clause contains.
function whereClauseText(arg: unknown): string {
  const parts: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
    if (Array.isArray(chunks)) {
      for (const chunk of chunks) {
        if (chunk && typeof chunk === "object" && "value" in chunk && Array.isArray((chunk as { value: unknown }).value)) {
          parts.push((chunk as { value: string[] }).value.join(""));
        } else {
          walk(chunk);
        }
      }
    }
    if ("name" in (node as Record<string, unknown>)) parts.push(String((node as { name: unknown }).name));
  };
  walk(arg);
  return parts.join(" ");
}

function whereClauseParamValues(arg: unknown): unknown[] {
  const values: unknown[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
    if (!Array.isArray(chunks)) return;
    for (const chunk of chunks) {
      if (chunk && typeof chunk === "object" && "queryChunks" in chunk) {
        walk(chunk);
      } else if (
        chunk &&
        typeof chunk === "object" &&
        "value" in chunk &&
        !Array.isArray((chunk as { value: unknown }).value)
      ) {
        values.push((chunk as { value: unknown }).value);
      }
    }
  };
  walk(arg);
  return values;
}

function selectRejection(error: unknown) {
  const chain = {
    from: () => chain,
    where: () => chain,
    groupBy: () => chain,
    orderBy: () => chain,
    then: (_resolve: unknown, reject: (reason?: unknown) => void) => Promise.reject(error).catch(reject),
  };
  return chain as never;
}

function makeSymbols(count: number, prefix = "SYM") {
  return Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(4, "0")}`);
}

// instrumentId = symbol for these tests: fixture symbols are already unique
// per test, so reusing the string keeps fixtures readable without inventing
// separate ids the assertions never need to distinguish.
function toInstruments(symbols: string[]) {
  return symbols.map((symbol) => ({ instrumentId: symbol, symbol }));
}

describe("findSymbolsNeedingHistoryBackfill", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns [] immediately for an empty instrument list, no query issued", async () => {
    const result = await findSymbolsNeedingHistoryBackfill({
      instruments: [],
      requiredFromDate: "2016-09-01",
    });
    expect(result).toEqual([]);
    expect(db.selectDistinct).not.toHaveBeenCalled();
  });

  it("excludes a symbol whose earliest stored candle already reaches the required date", async () => {
    // Bounded query only returns instruments with a row at/before requiredFromDate.
    db.selectDistinct.mockReturnValueOnce(selectResult([{ instrumentId: "RELIANCE" }]));

    const result = await findSymbolsNeedingHistoryBackfill({
      instruments: toInstruments(["RELIANCE", "NEWCO"]),
      requiredFromDate: "2016-09-01",
    });

    expect(result).toEqual(["NEWCO"]);
  });

  it("includes a symbol with no stored candles at all", async () => {
    db.selectDistinct.mockReturnValueOnce(selectResult([{ instrumentId: "RELIANCE" }]));

    const result = await findSymbolsNeedingHistoryBackfill({
      instruments: toInstruments(["RELIANCE", "NOHISTORY"]),
      requiredFromDate: "2016-09-01",
    });

    expect(result).toEqual(["NOHISTORY"]);
  });

  it("checks candle coverage by instrument_id, not exchange/symbol, bounded to time <= requiredFromDate", async () => {
    let captured: unknown;
    db.selectDistinct.mockReturnValueOnce(selectResult([], (arg) => (captured = arg)));

    await findSymbolsNeedingHistoryBackfill({
      instruments: toInstruments(["RELIANCE"]),
      requiredFromDate: "2016-09-01",
    });

    const text = whereClauseText(captured);
    expect(text).toContain("instrument_id");
    expect(text).not.toContain("exchange");
    expect(whereClauseParamValues(captured)).toContain("2016-09-01");
  });

  it("splits a large instrument list into multiple sequential batch queries", async () => {
    const symbols = makeSymbols(130); // > 40 (CANDLE_COVERAGE_SYMBOL_BATCH_SIZE) -> ceil(130/40) = 4 batches
    // Every symbol already covered, so nothing is returned.
    db.selectDistinct.mockImplementation(() => selectResult(symbols.map((symbol) => ({ instrumentId: symbol }))));

    const result = await findSymbolsNeedingHistoryBackfill({
      instruments: toInstruments(symbols),
      requiredFromDate: "2016-09-01",
    });

    expect(db.selectDistinct).toHaveBeenCalledTimes(4);
    expect(result).toEqual([]);
  });

  it("merges per-batch results and returns the deduplicated set needing backfill, in input order", async () => {
    const symbols = makeSymbols(90); // 3 batches of 40/40/10
    // Odd-indexed symbols have deep history; even-indexed ones are missing entirely.
    db.selectDistinct.mockImplementation((() => {
      let call = 0;
      return () => {
        const batch = symbols.slice(call * 40, call * 40 + 40);
        call += 1;
        return selectResult(batch.filter((_, i) => i % 2 === 1).map((symbol) => ({ instrumentId: symbol })));
      };
    })() as never);

    const result = await findSymbolsNeedingHistoryBackfill({
      instruments: toInstruments(symbols),
      requiredFromDate: "2016-09-01",
    });

    const expected = symbols.filter((_, i) => i % 2 === 0);
    expect(result).toEqual(expected);
    expect(new Set(result).size).toBe(result.length); // no duplicates
  });

  it("fails closed: one failed batch aborts the whole call and it never resolves to a partial answer", async () => {
    const symbols = makeSymbols(90);
    // Batch 1 succeeds, batch 2 rejects - the loop aborts before batch 3, so
    // only queue exactly what gets consumed (a dangling mockReturnValueOnce
    // would leak into the next test).
    db.selectDistinct
      .mockReturnValueOnce(selectResult(symbols.slice(0, 40).map((symbol) => ({ instrumentId: symbol }))))
      .mockReturnValueOnce(selectRejection(new Error("canceling statement due to statement timeout")));

    await expect(
      findSymbolsNeedingHistoryBackfill({ instruments: toInstruments(symbols), requiredFromDate: "2016-09-01" })
    ).rejects.toThrow(/statement timeout/);
  });
});

describe("readMetricCandles", () => {
  // mockReset (not just clear) so no once-queued return value from an
  // earlier describe block can leak into the first batch here.
  beforeEach(() => db.select.mockReset());

  it("returns [] and issues no query for an empty instrument list", async () => {
    const result = await readMetricCandles({ instruments: [], timeframe: "1D", from: "2016-01-01" });
    expect(result).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("filters candles by instrument_id, not exchange/symbol", async () => {
    let captured: unknown;
    db.select.mockReturnValueOnce(selectResult([], (arg) => (captured = arg)));

    await readMetricCandles({ instruments: toInstruments(["AAA"]), timeframe: "1D", from: "2016-01-01" });

    const text = whereClauseText(captured);
    expect(text).toContain("instrument_id");
    expect(text).not.toContain("exchange");
  });

  it("two instruments sharing equivalent symbol metadata remain independent", async () => {
    let captured: unknown;
    db.select.mockReturnValueOnce(selectResult([], (arg) => (captured = arg)));

    // inst-1 and inst-2 both carry the symbol "DUPLICATE" (the exact
    // production fragmentation shape) - only inst-1 is requested, and the
    // filter this issues is an instrument_id list, never a symbol match, so
    // inst-2's rows can never be pulled in just because the symbol matches.
    await readMetricCandles({
      instruments: [{ instrumentId: "inst-1", symbol: "DUPLICATE" }],
      timeframe: "1D",
      from: "2016-01-01",
    });

    expect(db.select).toHaveBeenCalledTimes(1);
    const text = whereClauseText(captured);
    expect(text).toContain("instrument_id");
    expect(text).not.toContain("symbol");
  });

  it("a symbol metadata change on the candle row does not break the read - lookup is by instrument_id only", async () => {
    // The stored candle row still carries the OLD symbol string (candles
    // are never rewritten on a rename - see Phase 2A), but the row is still
    // returned because the query never filters on symbol.
    db.select.mockReturnValueOnce(
      selectResult([
        { symbol: "OLD_SYMBOL", time: "2020-01-01", open: "1", high: "1", low: "1", close: "1", volume: "1" },
      ])
    );

    const result = await readMetricCandles({
      instruments: [{ instrumentId: "inst-1", symbol: "NEW_SYMBOL" }],
      timeframe: "1D",
      from: "2016-01-01",
    });

    expect(result).toHaveLength(1);
  });

  it("reads a large symbol list in sequential batches and merges to a single globally (symbol, time)-sorted list", async () => {
    const symbols = makeSymbols(150); // ceil(150/60) = 3 batches
    db.select.mockImplementation((() => {
      let call = 0;
      return () => {
        const batch = symbols.slice(call * 60, call * 60 + 60);
        call += 1;
        // Return rows deliberately out of global order (reverse symbol order within the batch).
        const rows = [...batch].reverse().flatMap((symbol) => [
          { symbol, time: "2020-01-02", open: "2", high: "2", low: "2", close: "2", volume: "20" },
          { symbol, time: "2020-01-01", open: "1", high: "1", low: "1", close: "1", volume: "10" },
        ]);
        return selectResult(rows);
      };
    })() as never);

    const result = await readMetricCandles({
      instruments: toInstruments(symbols),
      timeframe: "1D",
      from: "2016-01-01",
      to: "2025-01-01",
    });

    expect(db.select).toHaveBeenCalledTimes(3);
    // Exactly two rows per symbol, none lost or duplicated.
    expect(result).toHaveLength(symbols.length * 2);
    // Globally sorted by (symbol asc, time asc) - identical to the single-query ORDER BY.
    const sorted = [...result].sort((a, b) =>
      a.symbol === b.symbol ? a.time.localeCompare(b.time) : a.symbol.localeCompare(b.symbol)
    );
    expect(result).toEqual(sorted);
    // Numeric coercion preserved.
    expect(result[0]).toMatchObject({ open: 1, high: 1, low: 1, close: 1, volume: 10 });
  });

  it("does not lose or duplicate any symbol across batch boundaries", async () => {
    const symbols = makeSymbols(125);
    db.select.mockImplementation((() => {
      let call = 0;
      return () => {
        const batch = symbols.slice(call * 60, call * 60 + 60);
        call += 1;
        return selectResult(
          batch.map((symbol) => ({
            symbol,
            time: "2021-06-01",
            open: "5",
            high: "5",
            low: "5",
            close: "5",
            volume: "1",
          }))
        );
      };
    })() as never);

    const result = await readMetricCandles({ instruments: toInstruments(symbols), timeframe: "1D", from: "2016-01-01" });

    expect(new Set(result.map((row) => row.symbol))).toEqual(new Set(symbols));
    expect(result).toHaveLength(symbols.length);
  });

  it("bounds the query on both ends of time: keeps `time >= from` and adds `time <= to`", async () => {
    let captured: unknown;
    db.select.mockReturnValueOnce(selectResult([], (arg) => (captured = arg)));

    await readMetricCandles({
      instruments: toInstruments(["AAA"]),
      timeframe: "1D",
      from: "2016-09-10",
      to: "2026-09-10",
    });

    const text = whereClauseText(captured);
    // Both a lower and an upper bound on `time` are present.
    expect(text).toMatch(/time.*>=|>=.*time/);
    expect(text).toMatch(/time.*<=|<=.*time/);
  });

  it("still applies an upper bound (defaulting to today) when `to` is omitted", async () => {
    let captured: unknown;
    db.select.mockReturnValueOnce(selectResult([], (arg) => (captured = arg)));

    await readMetricCandles({ instruments: toInstruments(["AAA"]), timeframe: "1D", from: "2016-09-10" });

    expect(whereClauseText(captured)).toMatch(/time.*<=|<=.*time/);
  });

  it("propagates a batch failure instead of returning a partial candle set", async () => {
    const symbols = makeSymbols(90);
    db.select
      .mockReturnValueOnce(
        selectResult(
          symbols.slice(0, 60).map((symbol) => ({
            symbol,
            time: "2021-01-01",
            open: "1",
            high: "1",
            low: "1",
            close: "1",
            volume: "1",
          }))
        )
      )
      .mockReturnValueOnce(selectRejection(new Error("Query read timeout")));

    await expect(
      readMetricCandles({ instruments: toInstruments(symbols), timeframe: "1D", from: "2016-01-01" })
    ).rejects.toThrow(/Query read timeout/);
  });
});

describe("readChartCandles / readCandleHistoryRange - instrument_id identity", () => {
  beforeEach(() => db.select.mockReset());

  it("readChartCandles filters by instrument_id, never by exchange/symbol", async () => {
    let captured: unknown;
    db.select.mockReturnValueOnce(
      selectResult(
        [{ instrumentId: "inst-1", time: "2026-01-01", open: "1", high: "1", low: "1", close: "1", volume: "1" }],
        (arg) => (captured = arg)
      )
    );

    const rows = await readChartCandles({ instrumentId: "inst-1", timeframe: "1D" });

    expect(rows).toHaveLength(1);
    const text = whereClauseText(captured);
    expect(text).toContain("instrument_id");
    expect(text).not.toContain("exchange");
    expect(text).not.toContain("symbol");
  });

  it("readCandleHistoryRange filters by instrument_id and timeframe only", async () => {
    let captured: unknown;
    db.select.mockReturnValueOnce(
      selectResult([{ from: "2020-01-01", to: "2026-01-01" }], (arg) => (captured = arg))
    );

    const range = await readCandleHistoryRange({ instrumentId: "inst-1", timeframe: "1D" });

    expect(range).toEqual({ from: "2020-01-01", to: "2026-01-01" });
    expect(whereClauseText(captured)).toContain("instrument_id");
  });

  it("a renamed instrument's historical candles stay readable through the stable instrument_id", async () => {
    db.select.mockReturnValueOnce(
      selectResult([
        { instrumentId: "inst-1", time: "2020-06-01", open: "10", high: "11", low: "9", close: "10.5", volume: "500" },
      ])
    );

    const rows = await readChartCandles({ instrumentId: "inst-1", timeframe: "1D" });

    expect(rows).toHaveLength(1);
    expect(rows[0].instrumentId).toBe("inst-1");
  });

  it("issues no provider/network call - only db.select", async () => {
    db.select.mockReturnValueOnce(selectResult([]));

    await readChartCandles({ instrumentId: "inst-1", timeframe: "1D" });

    expect(db.select).toHaveBeenCalledTimes(1);
  });
});

describe("readScannerDailyCloses", () => {
  beforeEach(() => db.select.mockReset());

  it("selects only time and close, no other OHLCV columns", async () => {
    db.select.mockReturnValueOnce(selectResult([{ time: "2026-01-01", close: "100.50" }]));

    await readScannerDailyCloses({ instrumentId: "inst-1" });

    const selectedFields = db.select.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(selectedFields).sort()).toEqual(["close", "time"]);
  });

  it("filters by instrument_id and timeframe = 1D, never 1W", async () => {
    let captured: unknown;
    db.select.mockReturnValueOnce(selectResult([], (arg) => (captured = arg)));

    await readScannerDailyCloses({ instrumentId: "inst-1" });

    const text = whereClauseText(captured);
    expect(text).toContain("instrument_id");
    const values = whereClauseParamValues(captured);
    expect(values).toContain("1D");
    expect(values).not.toContain("1W");
  });

  it("issues no lower date bound when `from` is omitted - the instrument's full stored history is read", async () => {
    let captured: unknown;
    db.select.mockReturnValueOnce(selectResult([], (arg) => (captured = arg)));

    await readScannerDailyCloses({ instrumentId: "inst-1" });

    const text = whereClauseText(captured);
    expect(text).not.toMatch(/>=/);
  });

  it("converts numeric-as-string close values to numbers", async () => {
    db.select.mockReturnValueOnce(
      selectResult([
        { time: "2026-01-01", close: "100.50" },
        { time: "2026-01-02", close: "101.25" },
      ])
    );

    const rows = await readScannerDailyCloses({ instrumentId: "inst-1" });

    expect(rows).toEqual([
      { time: "2026-01-01", close: 100.5 },
      { time: "2026-01-02", close: 101.25 },
    ]);
  });
});

type FakeInsertCall = { values: Record<string, unknown>[]; target: unknown[] };

function fakeCandleWriteClient() {
  const inserts: FakeInsertCall[] = [];
  const deletes: { where: unknown }[] = [];

  const dbClient = {
    insert: () => ({
      values: (values: Record<string, unknown>[]) => ({
        onConflictDoUpdate: (options: { target: unknown[] }) => ({
          returning: async () => {
            inserts.push({ values, target: options.target });
            return values.map(() => ({ wasInsert: true }));
          },
        }),
      }),
    }),
    delete: () => ({
      where: async (condition: unknown) => {
        deletes.push({ where: condition });
      },
    }),
  };

  return { dbClient, inserts, deletes };
}

function candleInput(overrides: Partial<Parameters<typeof upsertCandles>[0][number]>) {
  return {
    instrumentId: "inst-1",
    exchange: "BSE",
    symbol: "ABC",
    timeframe: "1D" as const,
    time: "2026-01-01",
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume: 1,
    source: "provider",
    ...overrides,
  };
}

describe("upsertCandles - instrument_id identity", () => {
  it("same instrument + same timeframe + same time updates the existing candle, latest write wins", async () => {
    const { dbClient, inserts } = fakeCandleWriteClient();

    await upsertCandles(
      [
        candleInput({ symbol: "OLD", close: 1 }),
        candleInput({ symbol: "NEW", close: 2 }),
      ],
      dbClient as never
    );

    expect(inserts).toHaveLength(1);
    expect(inserts[0].values).toHaveLength(1);
    expect(inserts[0].values[0]).toMatchObject({ instrumentId: "inst-1", symbol: "NEW", close: "2" });
  });

  it("the same symbol string on two different instruments does not collide", async () => {
    const { dbClient, inserts } = fakeCandleWriteClient();

    await upsertCandles(
      [
        candleInput({ instrumentId: "inst-1", symbol: "DUPLICATE" }),
        candleInput({ instrumentId: "inst-2", symbol: "DUPLICATE" }),
      ],
      dbClient as never
    );

    expect(inserts[0].values).toHaveLength(2);
  });

  it("existing 1D/1W/1M timeframe behaviour is unchanged - same instrument+time never collide across timeframes", async () => {
    const { dbClient, inserts } = fakeCandleWriteClient();

    await upsertCandles(
      [
        candleInput({ timeframe: "1D" }),
        candleInput({ timeframe: "1W" }),
        candleInput({ timeframe: "1M" }),
      ],
      dbClient as never
    );

    expect(inserts[0].values).toHaveLength(3);
  });
});

describe("deleteCandlesForRefresh - instrument_id identity", () => {
  it("targets instrument_id, never exchange/symbol", async () => {
    const { dbClient, deletes } = fakeCandleWriteClient();

    await deleteCandlesForRefresh(
      { instrumentId: "inst-1", from: "2026-01-01", to: "2026-01-31" },
      dbClient as never
    );

    expect(deletes).toHaveLength(1);
    const text = whereClauseText(deletes[0].where);
    expect(text).toContain("instrument_id");
    expect(text).not.toContain("exchange");
  });
});
