export const SCANNER_RULE_KEY = {
  near250WeekCloseHigh: "near_250_week_high",
} as const;

export const SCANNER_LOOKBACK_MULTIPLIERS = ["1x", "3x", "5x"] as const;
export type ScannerLookbackMultiplier = (typeof SCANNER_LOOKBACK_MULTIPLIERS)[number];

export const DEFAULT_SCANNER_LOOKBACK: ScannerLookbackMultiplier = "5x";

export const SCANNER_LOOKBACK_WEEKS: Record<ScannerLookbackMultiplier, number> = {
  "1x": 50,
  "3x": 150,
  "5x": 250,
};

// strict=true (the Scanner's own on-demand 1x/3x/5x chart lookback) never
// falls back to a smaller tier: a symbol without 250 weeks of history
// requesting 5x shows no scan result for that tier, not one silently
// computed over a shorter window and presented as if it were a real 5x/3x
// answer - that made 1x/3x/5x indistinguishable for every recently-listed
// symbol. strict=false (the default - Dashboard Weekly Strong harvest
// matching, and anything else already depending on the old behavior) keeps
// falling back, so a recently-listed stock can still match/appear there on
// whatever history it actually has, unchanged.
export function getEffectiveScannerLookbackWeeks(
  requestedWeeks: number,
  availableWeeks: number,
  options: { strict?: boolean } = {}
) {
  if (availableWeeks >= requestedWeeks) return requestedWeeks;
  if (options.strict) return null;

  const fallback = Object.values(SCANNER_LOOKBACK_WEEKS)
    .sort((a, b) => b - a)
    .find((weeks) => availableWeeks >= weeks);

  return fallback ?? null;
}
