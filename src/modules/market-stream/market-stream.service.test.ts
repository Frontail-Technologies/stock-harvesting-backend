import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const eodhdSubscribe = vi.hoisted(() => vi.fn());
const eodhdUnsubscribe = vi.hoisted(() => vi.fn());
const eodhdClose = vi.hoisted(() => vi.fn());
const gdfSubscribe = vi.hoisted(() => vi.fn());
const gdfUnsubscribe = vi.hoisted(() => vi.fn());
const gdfClose = vi.hoisted(() => vi.fn());
const isProviderEnabled = vi.hoisted(() => vi.fn());

vi.mock("../data-provider/data-provider-settings.service", () => ({
  isProviderEnabled,
}));

vi.mock("./providers/eodhd-market-stream.provider", () => ({
  EodhdMarketStreamProvider: class {
    subscribe = eodhdSubscribe;
    unsubscribe = eodhdUnsubscribe;
    close = eodhdClose;
  },
}));

vi.mock("./providers/global-datafeeds-market-stream.provider", () => ({
  GlobalDatafeedsMarketStreamProvider: class {
    subscribe = gdfSubscribe;
    unsubscribe = gdfUnsubscribe;
    close = gdfClose;
  },
}));

import {
  ensureMarketStreamSymbols,
  subscribeMarketStreamSymbols,
  unsubscribeMarketStreamSymbols,
} from "./market-stream.service";

describe("market stream service subscriptions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    isProviderEnabled.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("dedupes provider subscriptions across duplicate viewers and releases after the last unsubscribe", async () => {
    const symbol = { exchange: "BSE", symbol: `TCS${Date.now()}` };

    await subscribeMarketStreamSymbols([symbol]);
    await subscribeMarketStreamSymbols([symbol]);

    expect(gdfSubscribe).toHaveBeenCalledTimes(1);
    expect(gdfSubscribe).toHaveBeenCalledWith([symbol]);

    unsubscribeMarketStreamSymbols([symbol]);
    expect(gdfUnsubscribe).not.toHaveBeenCalled();

    unsubscribeMarketStreamSymbols([symbol]);
    expect(gdfUnsubscribe).toHaveBeenCalledTimes(1);
    expect(gdfUnsubscribe).toHaveBeenCalledWith([symbol]);
  });

  it("starts idle cleanup for an ensured symbol and unsubscribes after the timeout", async () => {
    vi.useFakeTimers();
    const symbol = { exchange: "BSE", symbol: `ENSURE${Date.now()}` };

    await ensureMarketStreamSymbols([symbol], 120_000);

    expect(gdfSubscribe).toHaveBeenCalledTimes(1);
    expect(gdfSubscribe).toHaveBeenCalledWith([symbol]);

    vi.advanceTimersByTime(119_999);
    expect(gdfUnsubscribe).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(gdfUnsubscribe).toHaveBeenCalledTimes(1);
    expect(gdfUnsubscribe).toHaveBeenCalledWith([symbol]);
  });

  it("reopening an ensured symbol before idle timeout cancels the previous cleanup", async () => {
    vi.useFakeTimers();
    const symbol = { exchange: "BSE", symbol: `REOPEN${Date.now()}` };

    await ensureMarketStreamSymbols([symbol], 120_000);
    vi.advanceTimersByTime(60_000);
    await ensureMarketStreamSymbols([symbol], 120_000);
    vi.advanceTimersByTime(60_000);

    expect(gdfUnsubscribe).not.toHaveBeenCalled();

    vi.advanceTimersByTime(60_000);
    expect(gdfUnsubscribe).toHaveBeenCalledTimes(1);
    expect(gdfUnsubscribe).toHaveBeenCalledWith([symbol]);
  });
});
