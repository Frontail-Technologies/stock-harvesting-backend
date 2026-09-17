import { beforeEach, describe, expect, it, vi } from "vitest";

const request = vi.hoisted(() => vi.fn());

vi.mock("./global-datafeeds.websocket-client", () => ({
  globalDatafeedsClient: {
    request: (...args: unknown[]) => request(...args),
  },
}));

import { GlobalDatafeedsDataProviderAdapter } from "./global-datafeeds.adapter";

function instrumentsResponse(rows: Array<{ Identifier: string; TradeSymbol: string; ISIN?: string }>) {
  return {
    MessageType: "InstrumentsResult",
    Result: rows.map((row) => ({ ISIN: "INE002A01018", Series: "A", ...row })),
  };
}

function snapshotResponse(
  rows: Array<{
    InstrumentIdentifier: string;
    LastTradeTime: number;
    Open: number;
    High: number;
    Low: number;
    Close: number;
    TradedQty?: number;
  }>
) {
  return { MessageType: "SnapshotResult", Result: rows };
}

beforeEach(() => {
  request.mockReset();
});

describe("GlobalDatafeedsDataProviderAdapter.fetchDelayedSnapshot", () => {
  it("resolves instrument tokens then requests GetSnapshot with Periodicity MINUTE/Period 1", async () => {
    request
      .mockResolvedValueOnce(instrumentsResponse([{ Identifier: "532540", TradeSymbol: "TCS" }]))
      .mockResolvedValueOnce(
        snapshotResponse([
          { InstrumentIdentifier: "532540", LastTradeTime: 1789552740, Open: 2274, High: 2275, Low: 2270, Close: 2274.5, TradedQty: 100 },
        ])
      );

    const adapter = new GlobalDatafeedsDataProviderAdapter();
    const rows = await adapter.fetchDelayedSnapshot({ symbols: ["TCS"], exchangeCode: "BSE" });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ symbol: "TCS", open: 2274, high: 2275, low: 2270, close: 2274.5, volume: 100 });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        MessageType: "GetSnapshot",
        Periodicity: "MINUTE",
        Period: 1,
      }),
      undefined
    );
  });

  it("preserves LastTradeTime as the provider's own timestamp, not the request time", async () => {
    request
      .mockResolvedValueOnce(instrumentsResponse([{ Identifier: "532540", TradeSymbol: "TCS" }]))
      .mockResolvedValueOnce(
        snapshotResponse([
          { InstrumentIdentifier: "532540", LastTradeTime: 1789552740, Open: 2274, High: 2275, Low: 2270, Close: 2274.5 },
        ])
      );

    const adapter = new GlobalDatafeedsDataProviderAdapter();
    const rows = await adapter.fetchDelayedSnapshot({ symbols: ["TCS"], exchangeCode: "BSE" });

    expect(rows[0]?.tradeTime).toBe(new Date(1789552740 * 1000).toISOString());
  });

  it("never sends more than 25 instrument identifiers in a single GetSnapshot request", async () => {
    const symbols = Array.from({ length: 30 }, (_, index) => `SYM${index}`);
    request.mockResolvedValueOnce(
      instrumentsResponse(symbols.map((symbol, index) => ({ Identifier: String(1000 + index), TradeSymbol: symbol })))
    );
    for (let i = 0; i < 2; i++) request.mockResolvedValueOnce(snapshotResponse([]));

    const adapter = new GlobalDatafeedsDataProviderAdapter();
    await adapter.fetchDelayedSnapshot({ symbols, exchangeCode: "BSE" });

    const snapshotCalls = request.mock.calls.filter(
      (call) => (call[0] as { MessageType?: string }).MessageType === "GetSnapshot"
    );
    expect(snapshotCalls).toHaveLength(2);
    for (const call of snapshotCalls) {
      const identifiers = (call[0] as { InstrumentIdentifiers?: unknown[] }).InstrumentIdentifiers ?? [];
      expect(identifiers.length).toBeLessThanOrEqual(25);
    }
  });
});
