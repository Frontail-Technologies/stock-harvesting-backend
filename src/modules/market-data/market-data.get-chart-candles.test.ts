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

describe("getChartCandles - 1W timestamp is the week-ending Friday", () => {
  it("relabels a 1D-derived weekly candle's Monday bucket to that week's Friday", async () => {
    getInstrumentsBySymbol.mockResolvedValue(new Map([["TCS", { id: "i-1" } as never]]));
    // Mon 07 Sep 2026 -> Fri 11 Sep 2026, one ISO week of daily bars.
    readChartCandles.mockResolvedValue([
      { time: "2026-09-07", open: 10, high: 12, low: 9, close: 11, volume: 100 },
      { time: "2026-09-08", open: 11, high: 13, low: 10, close: 12, volume: 100 },
      { time: "2026-09-09", open: 12, high: 14, low: 11, close: 13, volume: 100 },
      { time: "2026-09-10", open: 13, high: 15, low: 12, close: 14, volume: 100 },
      { time: "2026-09-11", open: 14, high: 16, low: 13, close: 15, volume: 100 },
    ] as never);

    const result = await getChartCandles({ symbol: "TCS", timeframe: "1W" as never, exchange: "BSE" });

    expect(result).toHaveLength(1);
    expect(result[0].time).toBe("2026-09-11");
    // OHLC/volume untouched by the display-timestamp relabel.
    expect(result[0].open).toBe(10);
    expect(result[0].high).toBe(16);
    expect(result[0].low).toBe(9);
    expect(result[0].close).toBe(15);
    expect(result[0].volume).toBe(500);
  });

  it("relabels the legacy stored-1W fallback the same way, so both paths agree", async () => {
    getInstrumentsBySymbol.mockResolvedValue(new Map([["OLDCO", { id: "i-2" } as never]]));
    readChartCandles.mockImplementation(async (input: { timeframe: string }) => {
      if (input.timeframe === "1D") return [] as never;
      // Legacy row stored under its bucket's Monday, as older provider syncs did.
      return [{ time: "2026-09-07", open: 1, high: 2, low: 0.5, close: 1.5, volume: 200 }] as never;
    });

    const result = await getChartCandles({ symbol: "OLDCO", timeframe: "1W" as never, exchange: "BSE" });

    expect(result).toHaveLength(1);
    expect(result[0].time).toBe("2026-09-11");
  });

  it("leaves 1D timestamps as actual trading dates", async () => {
    getInstrumentsBySymbol.mockResolvedValue(new Map([["TCS", { id: "i-1" } as never]]));
    readChartCandles.mockResolvedValue([
      { time: "2026-09-09", open: 1, high: 2, low: 0, close: 1, volume: 10 },
    ] as never);

    const result = await getChartCandles({ symbol: "TCS", timeframe: "1D" as never, exchange: "BSE" });

    expect(result[0].time).toBe("2026-09-09");
  });
});
