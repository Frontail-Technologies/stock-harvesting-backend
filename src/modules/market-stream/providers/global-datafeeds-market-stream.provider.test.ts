import { beforeEach, describe, expect, it, vi } from "vitest";

import * as instrumentsModule from "../../market-data/market-data.instruments";
import { GlobalDatafeedsMarketStreamProvider } from "./global-datafeeds-market-stream.provider";

vi.mock("../../market-data/market-data.instruments", () => ({
  resolveInstrumentsForSymbols: vi.fn(),
}));

const send = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const addDebugListener = vi.hoisted(() => vi.fn(() => () => {}));
const markProviderCapabilityUnavailable = vi.hoisted(() => vi.fn());
const isProviderCapabilityCoolingDown = vi.hoisted(() => vi.fn(() => false));

vi.mock("../../data-provider/adapters/global-datafeeds/global-datafeeds.websocket-client", () => ({
  globalDatafeedsClient: {
    addQuoteListener: vi.fn(() => () => {}),
    addDebugListener,
    addStatusListener: vi.fn(() => () => {}),
    send: (...args: unknown[]) => send(...args),
    close: vi.fn(),
  },
}));

vi.mock("../market-stream.capabilities", () => ({
  isFunctionNotEnabledMessage: (value: unknown) => typeof value === "string" && /function not enabled/i.test(value),
  isProviderCapabilityCoolingDown,
  markProviderCapabilityAvailable: vi.fn(),
  markProviderCapabilityUnavailable,
}));

vi.mock("../market-stream.hub", () => ({
  publishMarketStreamEvent: vi.fn(),
}));

const resolveInstrumentsForSymbols = vi.mocked(instrumentsModule.resolveInstrumentsForSymbols);

beforeEach(() => {
  vi.clearAllMocks();
  send.mockResolvedValue(undefined);
  isProviderCapabilityCoolingDown.mockReturnValue(false);
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

  it("subscribes via SubscribeSnapshot (delayed entitlement), not SubscribeRealtime", async () => {
    resolveInstrumentsForSymbols.mockResolvedValue(
      new Map([["BSE:TCS", { instrumentToken: "532540", provider: "global-datafeeds" } as never]])
    );

    const provider = new GlobalDatafeedsMarketStreamProvider();
    await provider.subscribe([{ exchange: "BSE", symbol: "TCS" }]);

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        MessageType: "SubscribeSnapshot",
        Periodicity: "MINUTE",
        Period: 1,
      })
    );
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ MessageType: "SubscribeRealtime" }));
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

  it("does not throw when instrument resolution rejects (e.g. a DB/network error) - it logs and returns instead of crashing the caller", async () => {
    resolveInstrumentsForSymbols.mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));

    const provider = new GlobalDatafeedsMarketStreamProvider();

    await expect(
      provider.subscribe([{ exchange: "BSE", symbol: "KOTAKBANK" }])
    ).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it("classifies Function not enabled as unavailable current-day capability", async () => {
    new GlobalDatafeedsMarketStreamProvider();
    const debugListener = (addDebugListener as unknown as { mock: { calls: Array<[(event: unknown) => void]> } }).mock.calls.at(-1)?.[0];
    expect(debugListener).toBeDefined();

    debugListener?.({
      stage: "response.unmatched",
      messageType: "RequestError",
      payload: { Message: "Function not enabled.", MessageType: "RequestError" },
    });

    expect(markProviderCapabilityUnavailable).toHaveBeenCalledWith({
      provider: "global-datafeeds",
      exchange: "BSE",
      reason: "Function not enabled.",
    });
  });

  it("skips provider subscribe while current-day capability is cooling down", async () => {
    isProviderCapabilityCoolingDown.mockReturnValue(true);
    resolveInstrumentsForSymbols.mockResolvedValue(new Map([["BSE:TCS", { instrumentToken: "532540" } as never]]));

    const provider = new GlobalDatafeedsMarketStreamProvider();
    await provider.subscribe([{ exchange: "BSE", symbol: "TCS" }]);

    expect(resolveInstrumentsForSymbols).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
