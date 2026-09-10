import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db/client", () => ({ db: { select: vi.fn() } }));

import * as dbClientModule from "../../db/client";
import { findSymbolsNeedingHistoryBackfill, readMetricCandles } from "./market-data.candles";

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

describe("findSymbolsNeedingHistoryBackfill", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns [] immediately for an empty symbol list, no query issued", async () => {
    const result = await findSymbolsNeedingHistoryBackfill({
      exchange: "BSE",
      symbols: [],
      requiredFromDate: "2016-09-01",
    });
    expect(result).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("excludes a symbol whose earliest stored candle already reaches the required date", async () => {
    db.select.mockReturnValueOnce(
      selectResult([
        { symbol: "RELIANCE", earliest: "2010-01-04" },
        { symbol: "NEWCO", earliest: "2025-06-01" },
      ])
    );

    const result = await findSymbolsNeedingHistoryBackfill({
      exchange: "BSE",
      symbols: ["RELIANCE", "NEWCO"],
      requiredFromDate: "2016-09-01",
    });

    expect(result).toEqual(["NEWCO"]);
  });

  it("includes a symbol with no stored candles at all", async () => {
    db.select.mockReturnValueOnce(selectResult([{ symbol: "RELIANCE", earliest: "2010-01-04" }]));

    const result = await findSymbolsNeedingHistoryBackfill({
      exchange: "BSE",
      symbols: ["RELIANCE", "NOHISTORY"],
      requiredFromDate: "2016-09-01",
    });

    expect(result).toEqual(["NOHISTORY"]);
  });

  it("splits a large symbol list into multiple sequential batch queries", async () => {
    const symbols = makeSymbols(130); // > 40 (CANDLE_COVERAGE_SYMBOL_BATCH_SIZE) -> ceil(130/40) = 4 batches
    // Every symbol already covered, so nothing is returned.
    db.select.mockImplementation(() =>
      selectResult(symbols.map((symbol) => ({ symbol, earliest: "2000-01-01" })))
    );

    const result = await findSymbolsNeedingHistoryBackfill({
      exchange: "BSE",
      symbols,
      requiredFromDate: "2016-09-01",
    });

    expect(db.select).toHaveBeenCalledTimes(4);
    expect(result).toEqual([]);
  });

  it("merges per-batch results and returns the deduplicated set needing backfill, in input order", async () => {
    const symbols = makeSymbols(90); // 3 batches of 40/40/10
    // Odd-indexed symbols have deep history; even-indexed ones are missing entirely.
    db.select.mockImplementation((() => {
      let call = 0;
      return () => {
        const batch = symbols.slice(call * 40, call * 40 + 40);
        call += 1;
        return selectResult(
          batch
            .filter((_, i) => i % 2 === 1)
            .map((symbol) => ({ symbol, earliest: "2001-01-01" }))
        );
      };
    })() as never);

    const result = await findSymbolsNeedingHistoryBackfill({
      exchange: "BSE",
      symbols,
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
    db.select
      .mockReturnValueOnce(selectResult(symbols.slice(0, 40).map((symbol) => ({ symbol, earliest: "2000-01-01" }))))
      .mockReturnValueOnce(selectRejection(new Error("canceling statement due to statement timeout")));

    await expect(
      findSymbolsNeedingHistoryBackfill({ exchange: "BSE", symbols, requiredFromDate: "2016-09-01" })
    ).rejects.toThrow(/statement timeout/);
  });
});

describe("readMetricCandles", () => {
  // mockReset (not just clear) so no once-queued return value from an
  // earlier describe block can leak into the first batch here.
  beforeEach(() => db.select.mockReset());

  it("returns [] and issues no query for an empty symbol list", async () => {
    const result = await readMetricCandles({ exchange: "BSE", symbols: [], timeframe: "1D", from: "2016-01-01" });
    expect(result).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
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
      exchange: "BSE",
      symbols,
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

    const result = await readMetricCandles({ exchange: "BSE", symbols, timeframe: "1D", from: "2016-01-01" });

    expect(new Set(result.map((row) => row.symbol))).toEqual(new Set(symbols));
    expect(result).toHaveLength(symbols.length);
  });

  it("bounds the query on both ends of time: keeps `time >= from` and adds `time <= to`", async () => {
    let captured: unknown;
    db.select.mockReturnValueOnce(selectResult([], (arg) => (captured = arg)));

    await readMetricCandles({
      exchange: "BSE",
      symbols: ["AAA"],
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

    await readMetricCandles({ exchange: "BSE", symbols: ["AAA"], timeframe: "1D", from: "2016-09-10" });

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
      readMetricCandles({ exchange: "BSE", symbols, timeframe: "1D", from: "2016-01-01" })
    ).rejects.toThrow(/Query read timeout/);
  });
});
