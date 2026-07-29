import type { MarketStreamSymbol } from "./market-stream.types";

export function normalizeStreamSymbol(input: MarketStreamSymbol): MarketStreamSymbol | null {
  const exchange = input.exchange?.trim().toUpperCase();
  const symbol = input.symbol?.trim().toUpperCase();

  if (!exchange || !symbol) return null;
  if (exchange.length > 32 || symbol.length > 64) return null;

  return { exchange, symbol };
}

export function streamSymbolKey(input: MarketStreamSymbol) {
  return `${input.exchange}:${input.symbol}`;
}
