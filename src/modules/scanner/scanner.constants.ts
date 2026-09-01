export const SCANNER_RULE_KEY = {
  near250WeekHigh: "near_250_week_high",
} as const;

export const SCANNER_LOOKBACK_MULTIPLIERS = ["1x", "3x", "5x"] as const;
export type ScannerLookbackMultiplier = (typeof SCANNER_LOOKBACK_MULTIPLIERS)[number];

export const DEFAULT_SCANNER_LOOKBACK: ScannerLookbackMultiplier = "5x";

export const SCANNER_LOOKBACK_WEEKS: Record<ScannerLookbackMultiplier, number> = {
  "1x": 50,
  "3x": 150,
  "5x": 250,
};

export function getEffectiveScannerLookbackWeeks(
  requestedWeeks: number,
  availableWeeks: number
) {
  if (availableWeeks >= requestedWeeks) return requestedWeeks;

  const fallback = Object.values(SCANNER_LOOKBACK_WEEKS)
    .sort((a, b) => b - a)
    .find((weeks) => availableWeeks >= weeks);

  return fallback ?? null;
}
