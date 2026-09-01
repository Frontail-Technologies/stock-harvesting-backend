import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Covers the on-demand provider hydration ORCHESTRATION moved into this
 * module in Phase 8 (listStocks/listStocksUncached) - the 23 tests already
 * in market-data.stocks.test.ts cover the pure query/filter/sort/pagination
 * half (WHERE-clause construction, ordering, response mapping), not this.
 * listStocksUncached has no injectable dbClient param (it's a re-exported
 * public API, its signature can't change), and its own DB reads
 * (readStockRows/countStockRows/readUnpricedStockSymbols) are same-module
 * functions, not imported bindings, so they can't be vi.mock'd independently
 * of the function under test. Instead this mocks `db` itself (the shared
 * client both this module and its DB reads default to) plus the
 * cross-module provider/hydration functions, and drives orchestration
 * branching through a small in-memory "instruments table" - a genuine
 * behavior test of WHICH provider calls fire under which data conditions,
 * not a re-check of WHERE-clause correctness (already covered elsewhere)
 * and not an assertion that a function merely moved.
 */

vi.mock("../../db/client", () => ({ db: {} }));

vi.mock("./market-data.candle-sync", () => ({
  safeProviderAction: vi.fn(),
  syncLatestDailyCandlesForSymbols: vi.fn(),
}));

vi.mock("./market-data.instrument-sync", () => ({
  hydrateDefaultMarketInstruments: vi.fn(),
  syncProviderInstrumentSearch: vi.fn(),
}));

vi.mock("./market-data.instruments", () => ({
  refreshLatestInstrumentStats: vi.fn(),
}));

import { db } from "../../db/client";
import * as candleSyncModule from "./market-data.candle-sync";
import * as instrumentSyncModule from "./market-data.instrument-sync";
import * as instrumentsModule from "./market-data.instruments";
import { listStocks } from "./market-data.stocks";

const safeProviderAction = vi.mocked(candleSyncModule.safeProviderAction);
const syncLatestDailyCandlesForSymbols = vi.mocked(candleSyncModule.syncLatestDailyCandlesForSymbols);
const hydrateDefaultMarketInstruments = vi.mocked(instrumentSyncModule.hydrateDefaultMarketInstruments);
const syncProviderInstrumentSearch = vi.mocked(instrumentSyncModule.syncProviderInstrumentSearch);
const refreshLatestInstrumentStats = vi.mocked(instrumentsModule.refreshLatestInstrumentStats);

type FakeInstrumentRow = {
  symbol: string;
  name: string;
  exchange: string;
  close: string | null;
  open: string | null;
  volume: string | null;
  changePct: string | null;
};

// A minimal in-memory "instruments table" the fake db.select() reads from.
// Deliberately does NOT model the real WHERE-clause predicates (exchange/
// active/NSE-pattern/q/moveFilter/includeUnpriced) - buildStockFilters
// itself is already directly tested against real Drizzle conditions in
// market-data.stocks.test.ts. This fake only needs to hand back a
// consistent row set so listStocksUncached's own branching logic (based on
// row count, total count, and which rows are missing a price) can be
// exercised deterministically.
function installFakeDb(rows: FakeInstrumentRow[]) {
  const table = [...rows];

  function makeChain(selection: Record<string, unknown>) {
    const isCount = "total" in selection;
    const isSymbolOnly = !isCount && Object.keys(selection).length === 1 && "symbol" in selection;
    let limit: number | undefined;

    const resolve = () => {
      if (isCount) return [{ total: table.length }];
      if (isSymbolOnly) return table.filter((row) => row.close === null).map((row) => ({ symbol: row.symbol }));
      return limit === undefined ? table : table.slice(0, limit);
    };

    const chain = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: (n: number) => {
        limit = n;
        return chain;
      },
      offset: () => chain,
      then: (onFulfilled: (value: unknown[]) => unknown) => Promise.resolve(resolve()).then(onFulfilled),
    };

    return chain;
  }

  (db as unknown as { select: (selection: Record<string, unknown>) => unknown }).select = (selection) =>
    makeChain(selection);

  return table;
}

beforeEach(() => {
  vi.clearAllMocks();
  safeProviderAction.mockImplementation(async (_action: string, run: () => Promise<unknown>) => {
    try {
      return await run();
    } catch {
      return null;
    }
  });
});

describe("listStocks hydration orchestration", () => {
  it("A. a fully-hydrated, already-priced exchange does not trigger any provider hydration", async () => {
    const rows: FakeInstrumentRow[] = Array.from({ length: 1200 }, (_, i) => ({
      symbol: `SYM${i}`,
      name: `Company ${i}`,
      exchange: "NSE",
      close: "100",
      open: "99",
      volume: "1000",
      changePct: "1",
    }));
    installFakeDb(rows);

    const result = await listStocks({ page: 1, limit: 25, exchange: `NSE_A_${Date.now()}` });

    expect(result.stocks.length).toBeGreaterThan(0);
    expect(hydrateDefaultMarketInstruments).not.toHaveBeenCalled();
    expect(syncProviderInstrumentSearch).not.toHaveBeenCalled();
    expect(syncLatestDailyCandlesForSymbols).not.toHaveBeenCalled();
  });

  it("B. an under-hydrated exchange (below the full-market threshold) triggers default instrument hydration", async () => {
    installFakeDb([
      { symbol: "A", name: "A Co", exchange: "NSE", close: "10", open: "9", volume: "100", changePct: "1" },
    ]);
    hydrateDefaultMarketInstruments.mockResolvedValue({ count: 1 } as never);

    const exchange = `NSE_B_${Date.now()}`;
    await listStocks({ page: 1, limit: 25, exchange });

    expect(hydrateDefaultMarketInstruments).toHaveBeenCalledWith(exchange);
  });

  it("C. a search query with zero local matches triggers provider instrument search", async () => {
    installFakeDb([]);
    syncProviderInstrumentSearch.mockResolvedValue({ count: 0 } as never);

    const exchange = `NSE_C_${Date.now()}`;
    await listStocks({ page: 1, limit: 25, exchange, q: "ZZZNOTFOUND" });

    expect(syncProviderInstrumentSearch).toHaveBeenCalledWith("ZZZNOTFOUND", exchange);
  });

  it("D. a realtime-priced exchange (BSE) refreshes stats for rows missing a price instead of syncing candles directly", async () => {
    const rows: FakeInstrumentRow[] = Array.from({ length: 1200 }, (_, i) => ({
      symbol: `BSESYM${i}`,
      name: `BSE Co ${i}`,
      exchange: "BSE",
      close: i === 0 ? null : "50", // one row missing a price
      open: "49",
      volume: "500",
      changePct: "0.5",
    }));
    installFakeDb(rows);
    refreshLatestInstrumentStats.mockResolvedValue(undefined as never);

    await listStocks({ page: 1, limit: 1200, exchange: "BSE" });

    expect(refreshLatestInstrumentStats).toHaveBeenCalled();
    const [, syncedSymbols] = refreshLatestInstrumentStats.mock.calls[0] as [string, string[]];
    expect(syncedSymbols).toContain("BSESYM0");
    // BSE is realtime-priced: latest-price hydration goes through
    // refreshLatestInstrumentStats, not a provider candle sync.
    expect(syncLatestDailyCandlesForSymbols).not.toHaveBeenCalled();
  });

  it("E. a provider hydration failure is swallowed (via safeProviderAction) rather than failing the whole request", async () => {
    installFakeDb([
      { symbol: "A", name: "A Co", exchange: "NSE", close: "10", open: "9", volume: "100", changePct: "1" },
    ]);
    hydrateDefaultMarketInstruments.mockRejectedValue(new Error("provider unavailable"));

    const exchange = `NSE_E_${Date.now()}`;
    await expect(listStocks({ page: 1, limit: 25, exchange })).resolves.toBeDefined();
    expect(safeProviderAction).toHaveBeenCalled();
  });
});
