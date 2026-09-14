import { beforeEach, describe, expect, it, vi } from "vitest";

// getChartCandles must stay a pure DB read (RULES.md #16, Phase 4A/4B) -
// never a provider call triggered by opening a chart. On-demand repair is
// ensureFreshDailyCandles's job, called separately by the frontend.

vi.mock("../data-provider/data-provider.service", () => ({
  getEligibleProviderAdapter: vi.fn(),
  getActiveProviderAccessToken: vi.fn(),
}));

vi.mock("./market-data.instruments", () => ({
  getInstrumentsBySymbol: vi.fn(),
}));

vi.mock("./market-data.candles", () => ({
  readChartCandles: vi.fn(),
  readCandleHistoryRange: vi.fn(),
  replaceCandlesAtomically: vi.fn(),
  upsertCandles: vi.fn(),
}));

import * as providerServiceModule from "../data-provider/data-provider.service";
import * as instrumentsModule from "./market-data.instruments";
import * as candlesModule from "./market-data.candles";
import { getChartCandles } from "./market-data.service";

const getEligibleProviderAdapter = vi.mocked(providerServiceModule.getEligibleProviderAdapter);
const getActiveProviderAccessToken = vi.mocked(providerServiceModule.getActiveProviderAccessToken);
const getInstrumentsBySymbol = vi.mocked(instrumentsModule.getInstrumentsBySymbol);
const readChartCandles = vi.mocked(candlesModule.readChartCandles);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getChartCandles - DB-only read path", () => {
  it("returns stored daily rows without ever touching the provider adapter", async () => {
    getInstrumentsBySymbol.mockResolvedValue(new Map([["TCS", { id: "i-1" } as never]]));
    readChartCandles.mockResolvedValue([
      { time: "2026-09-10", open: 1, high: 2, low: 0, close: 1, volume: 10 },
      { time: "2026-09-11", open: 1, high: 2, low: 0, close: 1, volume: 10 },
    ] as never);

    const result = await getChartCandles({ symbol: "TCS", timeframe: "1D" as never, exchange: "BSE" });

    expect(result).toHaveLength(2);
    expect(getEligibleProviderAdapter).not.toHaveBeenCalled();
    expect(getActiveProviderAccessToken).not.toHaveBeenCalled();
  });

  it("returns an empty array without calling the provider when no candles are stored yet", async () => {
    getInstrumentsBySymbol.mockResolvedValue(new Map());
    readChartCandles.mockResolvedValue([] as never);

    const result = await getChartCandles({ symbol: "NEWSYMBOL", timeframe: "1D" as never, exchange: "BSE" });

    expect(result).toEqual([]);
    expect(getEligibleProviderAdapter).not.toHaveBeenCalled();
    expect(getActiveProviderAccessToken).not.toHaveBeenCalled();
  });
});
