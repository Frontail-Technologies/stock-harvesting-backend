import { beforeEach, describe, expect, it, vi } from "vitest";

// backfillIndexCandles is the canonical BSE index (BSE_IDX) daily-history
// backfill path - the one Dashboard "Index Harvest" ultimately depends on for
// >54 1D candles per index. These lock in: it only touches the requested index
// exchange's active instruments, isolates a per-symbol failure, and runs with
// bounded concurrency (never one giant sequential loop, never unbounded).

const selectMock = vi.hoisted(() => vi.fn());

vi.mock("../../db/client", () => ({
  db: { select: selectMock },
}));

// Keep module load cheap and side-effect free - none of these run in the test
// (the backfill fn is injected via the deps seam).
vi.mock("./market-data.candles", () => ({
  replaceCandlesAtomically: vi.fn(),
  upsertCandles: vi.fn(),
}));
vi.mock("./market-data.instruments", () => ({
  getInstrumentsBySymbol: vi.fn(),
  refreshLatestInstrumentStats: vi.fn(),
}));
vi.mock("./market-data.instrument-sync", () => ({
  ensureInstrumentsForSymbols: vi.fn(),
  getOrCreateInstrument: vi.fn(),
}));
vi.mock("../data-provider/data-provider.service", () => ({
  getActiveProviderAccessToken: vi.fn(),
  getEligibleProviderAdapter: vi.fn(),
  markProviderConnectionExpired: vi.fn(),
}));
vi.mock("../data-provider/data-provider-settings.service", () => ({
  recordProviderFailure: vi.fn(),
  recordProviderSuccess: vi.fn(),
}));
vi.mock("./dashboard-snapshot-store", () => ({
  deleteDashboardSnapshots: vi.fn(),
}));

import { deleteDashboardSnapshots } from "./dashboard-snapshot-store";
import { backfillIndexCandles } from "./market-data.candle-sync";

const deleteDashboardSnapshotsMock = vi.mocked(deleteDashboardSnapshots);

function mockActiveInstruments(symbols: string[]) {
  // db.select({symbol}).from(instruments).where(...)
  const rows = symbols.map((symbol) => ({ symbol }));
  const chain = {
    from: () => chain,
    where: () => Promise.resolve(rows),
  };
  selectMock.mockReturnValue(chain);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("backfillIndexCandles", () => {
  it("backfills every active instrument of the requested index exchange, passing that exchange through", async () => {
    mockActiveInstruments(["SENSEX", "BANKEX", "AUTO"]);
    const backfill = vi.fn().mockResolvedValue({ insertedDaily: 100 });

    const result = await backfillIndexCandles("BSE_IDX", { backfill, concurrency: 2 });

    expect(result).toEqual({ indexCount: 3, backfilled: 3, failedSymbols: [] });
    expect(backfill).toHaveBeenCalledTimes(3);
    for (const call of backfill.mock.calls) {
      expect(call[0]).toMatchObject({ exchange: "BSE_IDX", symbol: expect.any(String) });
    }
    // The index Relative Strength snapshot ("Index Harvest") is invalidated so
    // the next read recomputes against the freshly-backfilled candles.
    expect(deleteDashboardSnapshotsMock).toHaveBeenCalledWith("index_exchange", "BSE_IDX");
  });

  it("isolates a per-symbol failure - the rest still backfill and the failure is reported", async () => {
    mockActiveInstruments(["SENSEX", "BROKEN", "BANKEX", "AUTO"]);
    const backfill = vi.fn(async ({ symbol }: { symbol: string }) => {
      if (symbol === "BROKEN") throw new Error("GetHistory timed out");
      return { insertedDaily: 10 };
    });

    const result = await backfillIndexCandles("BSE_IDX", { backfill, concurrency: 2 });

    expect(result.indexCount).toBe(4);
    expect(result.backfilled).toBe(3);
    expect(result.failedSymbols).toEqual(["BROKEN"]);
  });

  it("respects the concurrency bound (never more than N backfills in flight)", async () => {
    mockActiveInstruments(Array.from({ length: 12 }, (_, i) => `IDX${i}`));

    let inFlight = 0;
    let maxInFlight = 0;
    const backfill = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { insertedDaily: 1 };
    });

    const result = await backfillIndexCandles("BSE_IDX", { backfill, concurrency: 4 });

    expect(result.backfilled).toBe(12);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBeGreaterThan(1); // actually parallel, not sequential
  });

  it("returns a clean zero result when the index exchange has no active instruments", async () => {
    mockActiveInstruments([]);
    const backfill = vi.fn();

    const result = await backfillIndexCandles("BSE_IDX", { backfill });

    expect(result).toEqual({ indexCount: 0, backfilled: 0, failedSymbols: [] });
    expect(backfill).not.toHaveBeenCalled();
    expect(deleteDashboardSnapshotsMock).not.toHaveBeenCalled();
  });
});
