import { beforeEach, describe, expect, it, vi } from "vitest";

import * as instrumentsModule from "../../market-data/market-data.instruments";
import { KiteMarketStreamProvider } from "./kite-market-stream.provider";

vi.mock("../../market-data/market-data.instruments", () => ({
  resolveInstrumentsForSymbols: vi.fn(),
}));

vi.mock("../../data-provider/data-provider.service", () => ({
  getActiveProviderAccessToken: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../market-stream.hub", () => ({
  publishMarketStreamEvent: vi.fn(),
}));

const resolveInstrumentsForSymbols = vi.mocked(instrumentsModule.resolveInstrumentsForSymbols);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("KiteMarketStreamProvider.subscribe", () => {
  it("resolves every requested NSE symbol through a single batched lookup, not one per symbol", async () => {
    resolveInstrumentsForSymbols.mockResolvedValue(
      new Map([
        ["NSE:RELIANCE", { instrumentToken: "128083204" } as never],
        ["NSE:TCS", { instrumentToken: "2953217" } as never],
      ])
    );

    const provider = new KiteMarketStreamProvider();
    // No ZERODHA_API_KEY in the test env, so connect() no-ops - this only
    // exercises resolution, not the WebSocket connection itself.
    await provider.subscribe([
      { exchange: "NSE", symbol: "RELIANCE" },
      { exchange: "NSE", symbol: "TCS" },
    ]);

    expect(resolveInstrumentsForSymbols).toHaveBeenCalledTimes(1);
    expect(resolveInstrumentsForSymbols).toHaveBeenCalledWith([
      { exchange: "NSE", symbol: "RELIANCE" },
      { exchange: "NSE", symbol: "TCS" },
    ]);
  });

  it("skips a symbol with no resolvable instrument token instead of failing the whole batch", async () => {
    resolveInstrumentsForSymbols.mockResolvedValue(
      new Map([["NSE:RELIANCE", { instrumentToken: "128083204" } as never]])
    );

    const provider = new KiteMarketStreamProvider();
    await provider.subscribe([
      { exchange: "NSE", symbol: "RELIANCE" },
      { exchange: "NSE", symbol: "UNKNOWNCO" },
    ]);

    expect(resolveInstrumentsForSymbols).toHaveBeenCalledTimes(1);
  });

  it("ignores non-NSE symbols without calling the resolver at all", async () => {
    const provider = new KiteMarketStreamProvider();
    await provider.subscribe([{ exchange: "BSE", symbol: "RELIANCE" }]);

    expect(resolveInstrumentsForSymbols).not.toHaveBeenCalled();
  });
});
