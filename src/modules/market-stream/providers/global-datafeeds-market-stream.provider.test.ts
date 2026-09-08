import { beforeEach, describe, expect, it, vi } from "vitest";

import * as instrumentsModule from "../../market-data/market-data.instruments";
import { GlobalDatafeedsMarketStreamProvider } from "./global-datafeeds-market-stream.provider";

vi.mock("../../market-data/market-data.instruments", () => ({
  resolveInstrumentsForSymbols: vi.fn(),
}));

const send = vi.fn().mockResolvedValue(undefined);

vi.mock("../../data-provider/adapters/global-datafeeds/global-datafeeds.websocket-client", () => ({
  globalDatafeedsClient: {
    addQuoteListener: vi.fn(() => () => {}),
    addDebugListener: vi.fn(() => () => {}),
    addStatusListener: vi.fn(() => () => {}),
    send: (...args: unknown[]) => send(...args),
    close: vi.fn(),
  },
}));

vi.mock("../market-stream.hub", () => ({
  publishMarketStreamEvent: vi.fn(),
}));

const resolveInstrumentsForSymbols = vi.mocked(instrumentsModule.resolveInstrumentsForSymbols);

beforeEach(() => {
  vi.clearAllMocks();
  send.mockResolvedValue(undefined);
});

describe("GlobalDatafeedsMarketStreamProvider.subscribe", () => {
  it("resolves every requested symbol through a single batched lookup, not one per symbol", async () => {
    resolveInstrumentsForSymbols.mockResolvedValue(
      new Map([
        ["BSE:RELIANCE", { instrumentToken: "500325", provider: "global-datafeeds" } as never],
        ["BSE:TCS", { instrumentToken: "532540", provider: "global-datafeeds" } as never],
      ])
    );

    const provider = new GlobalDatafeedsMarketStreamProvider();
    await provider.subscribe([
      { exchange: "BSE", symbol: "RELIANCE" },
      { exchange: "BSE", symbol: "TCS" },
    ]);

    expect(resolveInstrumentsForSymbols).toHaveBeenCalledTimes(1);
    expect(resolveInstrumentsForSymbols).toHaveBeenCalledWith([
      { exchange: "BSE", symbol: "RELIANCE" },
      { exchange: "BSE", symbol: "TCS" },
    ]);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("preserves the existing fallback of subscribing with the raw symbol when no instrument row is found", async () => {
    resolveInstrumentsForSymbols.mockResolvedValue(new Map());

    const provider = new GlobalDatafeedsMarketStreamProvider();
    await provider.subscribe([{ exchange: "BSE", symbol: "UNKNOWNCO" }]);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ InstrumentIdentifier: "UNKNOWNCO" })
    );
  });

  it("resolves a mixed BSE/BSE_IDX request in one call, keeping both exchanges' identity distinct", async () => {
    resolveInstrumentsForSymbols.mockResolvedValue(
      new Map([
        ["BSE:RELIANCE", { instrumentToken: "500325" } as never],
        ["BSE_IDX:SENSEX", { instrumentToken: "1", provider: "global-datafeeds" } as never],
      ])
    );

    const provider = new GlobalDatafeedsMarketStreamProvider();
    await provider.subscribe([
      { exchange: "BSE", symbol: "RELIANCE" },
      { exchange: "BSE_IDX", symbol: "SENSEX" },
    ]);

    expect(resolveInstrumentsForSymbols).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ Exchange: "BSE", InstrumentIdentifier: "500325" }));
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ Exchange: "BSE_IDX", InstrumentIdentifier: "1" })
    );
  });
});
