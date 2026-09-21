import { beforeEach, describe, expect, it, vi } from "vitest";

// A GDF RequestError (refused call) must never look like "the provider has no candles for this
// symbol": that reading recorded thousands of symbols as confirmed no-history and exempted them.

const request = vi.hoisted(() => vi.fn());

vi.mock("./global-datafeeds.websocket-client", () => ({
  globalDatafeedsClient: { request: (...args: unknown[]) => request(...args) },
}));

import { ProviderRateLimitedError } from "../../../../shared/errors";
import { GlobalDatafeedsDataProviderAdapter, GlobalDatafeedsRequestError } from "./global-datafeeds.adapter";

const HISTORY_INPUT = { instrumentToken: "UTLSOLAR", symbol: "UTLSOLAR", from: "2026-08-01", to: "2026-09-21", exchangeCode: "BSE" };
const requestError = (Message: string) => ({ MessageType: "RequestError", Message, PaketID: 16, RequestRefState: null });

// Every test sets its own mock behaviour; only the call history needs clearing.
beforeEach(() => {
  request.mockClear();
});

describe("fetchDailyCandles", () => {
  it("throws when GDF refuses the request, instead of returning an empty list", async () => {
    request.mockResolvedValue(requestError("Selected periodicity or period disabled."));

    const adapter = new GlobalDatafeedsDataProviderAdapter();

    await expect(adapter.fetchDailyCandles(HISTORY_INPUT)).rejects.toThrow(GlobalDatafeedsRequestError);
    await expect(adapter.fetchDailyCandles(HISTORY_INPUT)).rejects.toThrow(/Selected periodicity or period disabled/);
  });

  it("does not retry a refused request (a retry only spends another call)", async () => {
    request.mockResolvedValue(requestError("Selected periodicity or period disabled."));

    await new GlobalDatafeedsDataProviderAdapter().fetchDailyCandles(HISTORY_INPUT).catch(() => undefined);

    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not retry when the call limit is hit", async () => {
    request.mockImplementation(() => Promise.reject(new ProviderRateLimitedError("Global Datafeeds", 300_000)));

    let caught: unknown;
    try {
      await new GlobalDatafeedsDataProviderAdapter().fetchDailyCandles(HISTORY_INPUT);
    } catch (error) {
      caught = error;
    }

    expect(caught instanceof ProviderRateLimitedError).toBe(true);
    expect(request.mock.calls.length).toBe(1);
  });

  it("still returns [] for a genuine empty result (a real no-history instrument)", async () => {
    request.mockResolvedValue({ MessageType: "HistoryResult", Result: [] });

    await expect(new GlobalDatafeedsDataProviderAdapter().fetchDailyCandles(HISTORY_INPUT)).resolves.toEqual([]);
  });

  it("returns mapped candles for a normal result", async () => {
    request.mockResolvedValue({
      MessageType: "HistoryResult",
      Result: [{ LastTradeTime: 1789689600, Open: 410, High: 420, Low: 405, Close: 417.25, TradedQty: 1000 }],
    });

    const candles = await new GlobalDatafeedsDataProviderAdapter().fetchDailyCandles(HISTORY_INPUT);

    expect(candles).toHaveLength(1);
    expect(candles[0]).toMatchObject({ open: 410, close: 417.25, volume: 1000 });
  });
});

describe("fetchIntradayCandles", () => {
  it("requests the complete BSE session as 15-minute history", async () => {
    request.mockResolvedValue({
      MessageType: "HistoryOHLCResult",
      Result: [
        { LastTradeTime: 1790000100, Open: 416.75, High: 423.8, Low: 413.05, Close: 422, TradedQty: 12398 },
      ],
    });

    const rows = await new GlobalDatafeedsDataProviderAdapter().fetchIntradayCandles({
      instrumentToken: "UTLSOLAR",
      symbol: "UTLSOLAR",
      date: "2026-09-21",
      exchangeCode: "BSE",
    });

    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      MessageType: "GetHistory",
      Exchange: "BSE",
      InstrumentIdentifier: "UTLSOLAR",
      Periodicity: "MINUTE",
      Period: 15,
      From: 1789962300,
      To: 1789984800,
    }), 9000);
    expect(rows[0]).toMatchObject({ open: 416.75, close: 422, volume: 12398 });
  });
});
