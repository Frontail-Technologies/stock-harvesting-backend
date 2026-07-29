export function normalizeSymbol(symbol: string) {
  return symbol.trim().toUpperCase();
}

export function parsePositiveInt(value: unknown, fallback: number, max: number) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}
