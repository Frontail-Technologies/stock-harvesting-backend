// Small, fully generic date helpers with zero domain coupling - neutral
// ownership so both market-data.service.ts (relative-strength/Weekly
// Strong composition, chart facade) and market-data.candle-sync.ts
// (provider-backed backfill/refresh orchestration) can depend on them
// without either importing the other.

const CHART_HISTORY_YEARS = 30;

export function getTodayDate() {
  return new Date().toISOString().slice(0, 10);
}

export function getDefaultChartHistoryFromDate() {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - CHART_HISTORY_YEARS);
  return date.toISOString().slice(0, 10);
}

export function getDateDaysAgo(days: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

export function getDateYearsAgo(years: number) {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - years);
  return date.toISOString().slice(0, 10);
}
