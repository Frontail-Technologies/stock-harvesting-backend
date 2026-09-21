import type { ProviderDailyCandle, ProviderIntradayCandle } from "../data-provider/data-provider.types";

const BSE_SESSION_START_UTC_MINUTES = 3 * 60 + 45;
const BSE_SESSION_BAR_COUNT = 25;
const BSE_BAR_MINUTES = 15;

export function aggregateBseIntradayCandles(
  bars: ProviderIntradayCandle[],
  date: string,
  requireComplete: boolean
): ProviderDailyCandle | null {
  const bySlot = new Map<number, ProviderIntradayCandle>();
  for (const bar of bars) {
    const timestamp = Date.parse(bar.time);
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date) continue;
    const value = new Date(timestamp);
    const minutes = value.getUTCHours() * 60 + value.getUTCMinutes();
    const offset = minutes - BSE_SESSION_START_UTC_MINUTES;
    if (offset < 0 || offset % BSE_BAR_MINUTES !== 0 || offset / BSE_BAR_MINUTES >= BSE_SESSION_BAR_COUNT) continue;
    if (![bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite)) continue;
    bySlot.set(offset / BSE_BAR_MINUTES, bar);
  }

  if (bySlot.size === 0 || (requireComplete && bySlot.size !== BSE_SESSION_BAR_COUNT)) return null;
  const ordered = [...bySlot.entries()].sort(([a], [b]) => a - b).map(([, bar]) => bar);
  return {
    time: date,
    open: ordered[0]!.open,
    high: Math.max(...ordered.map((bar) => bar.high)),
    low: Math.min(...ordered.map((bar) => bar.low)),
    close: ordered.at(-1)!.close,
    volume: ordered.reduce((sum, bar) => sum + bar.volume, 0),
  };
}
