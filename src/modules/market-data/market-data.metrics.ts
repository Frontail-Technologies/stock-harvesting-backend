import { CANDLE_TIMEFRAME } from "../../shared/constants";
import { getErrorMessage } from "../../shared/errors";
import { logger } from "../../shared/logger";
import { normalizeSymbol } from "../../shared/normalize";
import { backfillDailyCandles, safeProviderAction } from "./market-data.candle-sync";
import {
  deriveWeeklyMetricCandlesFromDaily,
  filterMetricCandlesFrom,
  groupMetricCandlesBySymbol,
  readMetricCandles,
  type MetricCandle,
} from "./market-data.candles";
import { getDateDaysAgo, getDateYearsAgo, getDefaultChartHistoryFromDate, getTodayDate } from "./market-data.dates";
import {
  deriveScannerLookbackBars,
  evaluateWeeklyStrongLatest,
  evaluateWeeklyStrongSeries,
  excludeIncompleteTradingWeek,
  hasSufficientWeeklyStrongHistory,
  WEEKLY_STRONG_WEEKLY_LOOKBACK_BARS,
} from "./weekly-strong-evaluator";

// Analytical data preparation/orchestration for Relative Strength and
// Weekly Strong: fetches/prepares candle series, then composes them with
// the canonical decision logic in weekly-strong-evaluator.ts - never
// duplicates or inlines evaluator rules here, only calls them.

export type { MetricCandle };

const RELATIVE_STRENGTH_SEED_BACKFILL_LIMIT = 20;

// Fetches daily+weekly candles for a symbol pool, and if a collection has
// never been viewed before (no candles synced for any member yet) triggers a
// best-effort one-time seed backfill for the first N symbols so the page
// isn't permanently empty - the same fallback pattern relative-strength
// metrics already rely on.
export async function readDailyAndWeeklyMetricCandles(input: {
  exchange: string;
  symbols: string[];
  dailyFrom: string;
  weeklyFrom: string;
}) {
  const dailySourceFrom = input.dailyFrom < input.weeklyFrom ? input.dailyFrom : input.weeklyFrom;
  let sourceDailyCandles = await readMetricCandles({
    exchange: input.exchange,
    symbols: input.symbols,
    timeframe: CANDLE_TIMEFRAME.day,
    from: dailySourceFrom,
  });
  let dailyCandles = filterMetricCandlesFrom(sourceDailyCandles, input.dailyFrom);
  let weeklyCandles = deriveWeeklyMetricCandlesFromDaily(
    sourceDailyCandles,
    input.weeklyFrom
  );

  if (sourceDailyCandles.length === 0) {
    const legacyWeeklyCandles = await readMetricCandles({
      exchange: input.exchange,
      symbols: input.symbols,
      timeframe: CANDLE_TIMEFRAME.week,
      from: input.weeklyFrom,
    });

    if (legacyWeeklyCandles.length > 0) {
      return { dailyCandles, weeklyCandles: legacyWeeklyCandles };
    }

    const seedSymbols = input.symbols.slice(0, RELATIVE_STRENGTH_SEED_BACKFILL_LIMIT);
    await safeProviderAction("market-data.relative-strength-seed-backfill", async () => {
      let seeded = 0;
      for (const symbol of seedSymbols) {
        try {
          await backfillDailyCandles({
            symbol,
            exchange: input.exchange,
            from: getDateYearsAgo(5),
            to: getTodayDate(),
          });
          seeded++;
        } catch (error) {
          logger.warn(
            {
              exchange: input.exchange,
              symbol,
              message: getErrorMessage(error, "Seed backfill failed"),
            },
            "Relative strength seed backfill failed for symbol"
          );
        }
      }
      return { symbols: seeded };
    });

    sourceDailyCandles = await readMetricCandles({
      exchange: input.exchange,
      symbols: input.symbols,
      timeframe: CANDLE_TIMEFRAME.day,
      from: dailySourceFrom,
    });
    dailyCandles = filterMetricCandlesFrom(sourceDailyCandles, input.dailyFrom);
    weeklyCandles = deriveWeeklyMetricCandlesFromDaily(
      sourceDailyCandles,
      input.weeklyFrom
    );
  }

  return { dailyCandles, weeklyCandles };
}

// THE canonical 55-day change calculation - the only formula every
// relative-strength Dashboard widget ranks by. Compares the latest close
// to the close 54 trading sessions earlier (actual daily candles, not
// calendar days, so weekends/holidays don't skew the lookback).
export const CHANGE_55D_LOOKBACK_BARS = 54;

export function calculate55DayChange(dailyRows: MetricCandle[]): number {
  const latest = dailyRows[dailyRows.length - 1];
  const base = dailyRows[dailyRows.length - 1 - CHANGE_55D_LOOKBACK_BARS];

  if (!latest || !base || base.close === 0) return 0;
  return ((latest.close - base.close) * 100) / base.close;
}

export type RelativeStrengthMetricRow = {
  symbol: string;
  name: string;
  exchange: string;
  sector: string | null;
  industry: string | null;
  close: number;
  volume: number;
  // THE single metric every relative-strength Dashboard widget
  // (Index/Sector/Industry/Stock) ranks and averages by - see
  // calculate55DayChange below. No other factor is folded into it.
  change55dPct: number;
};

export type RelativeStrengthInstrumentInput = {
  symbol: string;
  name: string;
  exchange: string;
  sector?: string | null;
  industry?: string | null;
};

// Computes the 55-day change metric for every instrument in the pool with
// enough history - no top-N slicing (unlike computeRelativeStrengthMetrics
// below) and no other filtering, since computeGroupRelativeStrength needs
// every qualifying row to average per sector/industry.
//
// The expensive step (candle I/O per member) - exported so
// dashboard-snapshots.service.ts can call it once per invalidation cycle
// and persist the result, rather than every read recomputing it.
export async function computeAllRelativeStrengthMetrics(
  instrumentRows: RelativeStrengthInstrumentInput[],
  exchange: string
): Promise<RelativeStrengthMetricRow[]> {
  const symbols = instrumentRows.map((row) => row.symbol);
  if (symbols.length === 0) return [];

  // Only daily candles are needed for a 55-session change - no weekly
  // fetch (weeklyFrom === dailyFrom collapses readDailyAndWeeklyMetricCandles's
  // internal fetch window to just the last 140 days instead of 5 years).
  const dailyFrom = getDateDaysAgo(140);
  const { dailyCandles } = await readDailyAndWeeklyMetricCandles({
    exchange,
    symbols,
    dailyFrom,
    weeklyFrom: dailyFrom,
  });
  const dailyCandlesBySymbol = groupMetricCandlesBySymbol(dailyCandles);

  return instrumentRows
    .map((instrument): RelativeStrengthMetricRow | null => {
      const dailyRows = dailyCandlesBySymbol.get(instrument.symbol) ?? [];
      const latestDaily = dailyRows[dailyRows.length - 1];
      if (!latestDaily) return null;

      // A symbol with only a handful of candles (e.g. just synced
      // today's close, no real history yet) can't produce a genuine
      // 55-day reading - calculate55DayChange falls back to 0 when it
      // doesn't have enough bars, which would otherwise look identical to
      // a real "flat" score instead of "we don't have enough data yet".
      if (dailyRows.length <= 54) return null;

      const change55dPct = calculate55DayChange(dailyRows);

      return {
        symbol: instrument.symbol,
        name: instrument.name,
        exchange: instrument.exchange,
        sector: instrument.sector ?? null,
        industry: instrument.industry ?? null,
        close: latestDaily.close,
        volume: latestDaily.volume,
        change55dPct,
      };
    })
    .filter((row): row is RelativeStrengthMetricRow => Boolean(row));
}

// All 4 Dashboard cards rank by the same 55-day change %, so this is a
// single top-N selection. Pure/cheap (no candle I/O) - safe to call on
// read against a stored snapshot.
export function pickTopRelativeStrengthRows(
  rows: RelativeStrengthMetricRow[],
  limit: number
) {
  return [...rows].sort((a, b) => b.change55dPct - a.change55dPct).slice(0, limit);
}

export async function computeRelativeStrengthMetrics(
  instrumentRows: RelativeStrengthInstrumentInput[],
  exchange: string,
  limit: number
): Promise<RelativeStrengthMetricRow[]> {
  const allMetrics = await computeAllRelativeStrengthMetrics(instrumentRows, exchange);
  return pickTopRelativeStrengthRows(allMetrics, limit);
}

export type GroupRelativeStrengthRow = {
  label: string;
  score: number;
  memberCount: number;
};

// "Sector rotation" ranking: ranks sector/industry categories by the mean
// 55-day change % of their member stocks. A row with no classification for
// the requested groupBy is silently excluded, never lumped into a
// misleading "unclassified" group. Pure/cheap (no candle I/O).
export function groupRelativeStrengthMetrics(
  allMetrics: RelativeStrengthMetricRow[],
  groupBy: "sector" | "industry",
  limit: number
): GroupRelativeStrengthRow[] {
  const groups = new Map<string, { total: number; count: number }>();

  for (const metric of allMetrics) {
    const key = groupBy === "sector" ? metric.sector : metric.industry;
    if (!key) continue;

    const group = groups.get(key) ?? { total: 0, count: 0 };
    group.total += metric.change55dPct;
    group.count += 1;
    groups.set(key, group);
  }

  return [...groups.entries()]
    .map(([label, { total, count }]) => ({
      label,
      score: total / count,
      memberCount: count,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export async function computeGroupRelativeStrength(
  instrumentRows: RelativeStrengthInstrumentInput[],
  exchange: string,
  groupBy: "sector" | "industry",
  limit: number
): Promise<GroupRelativeStrengthRow[]> {
  const allMetrics = await computeAllRelativeStrengthMetrics(instrumentRows, exchange);
  return groupRelativeStrengthMetrics(allMetrics, groupBy, limit);
}

export type SectorIndustryTaxonomyRow = {
  sector: string;
  industries: string[];
};

// Full sector -> industries membership taxonomy, no ranking/scoring and no
// top-N slicing - every classified stock in the pool contributes, so a
// sector/industry with no strong movers still resolves correctly. Rows
// missing either classification are excluded, same convention as
// groupRelativeStrengthMetrics above. Pure/cheap (no candle I/O) - the
// caller already has allMetrics from a cached base computation.
export function deriveSectorIndustryTaxonomy(
  allMetrics: RelativeStrengthMetricRow[]
): SectorIndustryTaxonomyRow[] {
  const sectorToIndustries = new Map<string, Set<string>>();

  for (const metric of allMetrics) {
    if (!metric.sector || !metric.industry) continue;
    const industries = sectorToIndustries.get(metric.sector) ?? new Set<string>();
    industries.add(metric.industry);
    sectorToIndustries.set(metric.sector, industries);
  }

  return [...sectorToIndustries.entries()]
    .map(([sector, industries]) => ({ sector, industries: [...industries].sort() }))
    .sort((a, b) => a.sector.localeCompare(b.sector));
}

// The Weekly Strong breakout screen. Unlike the relative-strength metrics
// above (which rank everything), this filters down to only the stocks
// that pass the qualification rule. See weekly-strong-evaluator.ts for the
// actual decision logic and constants - not restated here.

export type WeeklyStrongStockRow = {
  symbol: string;
  name: string;
  exchange: string;
  close: number;
  changePct: number;
  volume: number;
  sector: string | null;
  industry: string | null;
};

export async function computeWeeklyStrongStocks(
  instrumentRows: Array<{
    symbol: string;
    name: string;
    exchange: string;
    sector?: string | null;
    industry?: string | null;
  }>,
  exchange: string
): Promise<WeeklyStrongStockRow[]> {
  const symbols = instrumentRows.map((row) => row.symbol);
  if (symbols.length === 0) return [];

  const { dailyCandles, weeklyCandles } = await readDailyAndWeeklyMetricCandles({
    exchange,
    symbols,
    dailyFrom: getDateYearsAgo(5),
    weeklyFrom: getDateYearsAgo(5),
  });
  const dailyCandlesBySymbol = groupMetricCandlesBySymbol(dailyCandles);
  const weeklyCandlesBySymbol = groupMetricCandlesBySymbol(weeklyCandles);

  const rows: WeeklyStrongStockRow[] = [];

  for (const instrument of instrumentRows) {
    const dailyRows = dailyCandlesBySymbol.get(instrument.symbol) ?? [];
    // Drops a trailing in-progress week before it can ever be evaluated as
    // "the latest completed week" - see excludeIncompleteTradingWeek. Only
    // the weekly leg needs this: a synced daily candle is complete the
    // moment it exists, but a weekly bucket keeps accumulating until its
    // own week ends.
    const weeklyRows = excludeIncompleteTradingWeek(
      weeklyCandlesBySymbol.get(instrument.symbol) ?? [],
      exchange
    );
    const latestDaily = dailyRows[dailyRows.length - 1];
    const latestWeekly = weeklyRows[weeklyRows.length - 1];
    if (!latestDaily || !latestWeekly) continue;

    // A near-empty window (e.g. just today's candle, no real history) has
    // its own "high" equal to roughly its own close, which trivially
    // passes a "near the high" check - that's a data gap, not a real
    // breakout. Skip symbols without a reasonably substantial sample.
    if (!hasSufficientWeeklyStrongHistory(dailyRows.length, weeklyRows.length)) continue;

    const decision = evaluateWeeklyStrongLatest(
      dailyRows.map((row) => row.close),
      weeklyRows.map((row) => row.close)
    );
    if (!decision.passes) continue;

    const previousDaily = dailyRows[dailyRows.length - 2];
    const changePct =
      previousDaily && previousDaily.close > 0
        ? ((latestDaily.close - previousDaily.close) * 100) / previousDaily.close
        : 0;

    rows.push({
      symbol: instrument.symbol,
      name: instrument.name,
      exchange: instrument.exchange,
      close: latestDaily.close,
      changePct,
      volume: latestDaily.volume,
      sector: instrument.sector ?? null,
      industry: instrument.industry ?? null,
    });
  }

  return rows.sort((a, b) => b.changePct - a.changePct);
}

// Re-runs the weekly-strong breakout check at every historical week
// (instead of just today) and counts how many pool members passed at each
// point - powers the persisted backtest backfill.
export const WEEKLY_STRONG_BACKTEST_DEFAULT_WEEKS = 250;
// 10 years comfortably covers both the oldest backtest week's own trailing
// evaluator lookback and the backtest range itself.
const WEEKLY_STRONG_BACKTEST_FETCH_YEARS = 10;

export type WeeklyStrongBacktestMemberRow = {
  symbol: string;
  name: string;
  exchange: string;
  sector: string | null;
  industry: string | null;
};

export type WeeklyStrongBacktestWeekMembers = {
  time: string;
  passing: WeeklyStrongBacktestMemberRow[];
};

// Fetches each pool member's full history once, then runs the evaluator's
// full-series pass per instrument, instead of fetching per week evaluated.
// The backfill job persists this output; nothing recomputes it on read.
export async function computeWeeklyStrongBacktestMembers(
  instrumentRows: Array<{
    symbol: string;
    name: string;
    exchange: string;
    sector?: string | null;
    industry?: string | null;
  }>,
  exchange: string,
  weeks: number = WEEKLY_STRONG_BACKTEST_DEFAULT_WEEKS
): Promise<WeeklyStrongBacktestWeekMembers[]> {
  const symbols = instrumentRows.map((row) => row.symbol);
  if (symbols.length === 0) return [];

  const { dailyCandles, weeklyCandles } = await readDailyAndWeeklyMetricCandles({
    exchange,
    symbols,
    dailyFrom: getDateYearsAgo(WEEKLY_STRONG_BACKTEST_FETCH_YEARS),
    weeklyFrom: getDateYearsAgo(WEEKLY_STRONG_BACKTEST_FETCH_YEARS),
  });
  const dailyCandlesBySymbol = groupMetricCandlesBySymbol(dailyCandles);
  const weeklyCandlesBySymbol = groupMetricCandlesBySymbol(weeklyCandles);

  const allWeeklyDates = new Set<string>();
  const membersByDate = new Map<string, WeeklyStrongBacktestMemberRow[]>();

  for (const instrument of instrumentRows) {
    const dailyRows = dailyCandlesBySymbol.get(instrument.symbol) ?? [];
    // Same completed-week trim as computeWeeklyStrongStocks - persisted
    // history must never include today's still-forming week.
    const weeklyRows = excludeIncompleteTradingWeek(
      weeklyCandlesBySymbol.get(instrument.symbol) ?? [],
      exchange
    );
    // Same data-gap guard as computeWeeklyStrongStocks: a symbol with
    // barely any history can't produce a meaningful "near its own close high"
    // reading at any point in the backtest either.
    if (!hasSufficientWeeklyStrongHistory(dailyRows.length, weeklyRows.length)) continue;

    // Evaluated over this symbol's full available series (not pre-sliced
    // to the last `weeks`) - the trailing-window max at any index only
    // ever looks backward, so slicing the OUTPUT to the last `weeks` below
    // is equivalent to (and simpler/safer than) starting the walk
    // partway through, just with a few extra early-history decisions
    // computed and discarded.
    const seriesPoints = evaluateWeeklyStrongSeries(dailyRows, weeklyRows);

    for (const point of seriesPoints.slice(-weeks)) {
      allWeeklyDates.add(point.time);
      if (!point.passes) continue;

      const existing = membersByDate.get(point.time) ?? [];
      existing.push({
        symbol: instrument.symbol,
        name: instrument.name,
        exchange: instrument.exchange,
        sector: instrument.sector ?? null,
        industry: instrument.industry ?? null,
      });
      membersByDate.set(point.time, existing);
    }
  }

  return [...allWeeklyDates]
    .sort()
    .slice(-weeks)
    .map((time) => ({ time, passing: membersByDate.get(time) ?? [] }));
}

export type SymbolBreakoutBacktestStats = {
  hitRatePct: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  profitFactor: number | null;
  signalsGenerated: number;
  avgHoldingDays: number;
  largestWinnerPct: number;
  largestLoserPct: number;
};

type BreakoutTrade = { entryIndex: number; exitIndex: number; returnPct: number };

export type SymbolWeeklyStrongSeriesInput = {
  dailyRows: MetricCandle[];
  weeklyRows: MetricCandle[];
};

// Shared fetch+gate step for any per-symbol Weekly Strong evaluation - the
// Scanner's live scan and this file's own backtest both need the same
// daily+weekly series, completed-week trim, and minimum-history gate, so
// they can't silently diverge on what data they evaluate.
export async function getSymbolWeeklyStrongSeriesInput(
  symbol: string,
  exchange: string
): Promise<SymbolWeeklyStrongSeriesInput | null> {
  const normalizedSymbol = normalizeSymbol(symbol);
  const { dailyCandles, weeklyCandles } = await readDailyAndWeeklyMetricCandles({
    exchange,
    symbols: [normalizedSymbol],
    dailyFrom: getDefaultChartHistoryFromDate(),
    weeklyFrom: getDefaultChartHistoryFromDate(),
  });

  const dailyRows = groupMetricCandlesBySymbol(dailyCandles).get(normalizedSymbol) ?? [];
  // Same completed-week trim used everywhere else in the Weekly Strong
  // pipeline - the series must stop at the latest COMPLETED week, never
  // include today's still-forming week, live or historical.
  const weeklyRows = excludeIncompleteTradingWeek(
    groupMetricCandlesBySymbol(weeklyCandles).get(normalizedSymbol) ?? [],
    exchange
  );

  if (!hasSufficientWeeklyStrongHistory(dailyRows.length, weeklyRows.length)) {
    return null;
  }

  return { dailyRows, weeklyRows };
}

// Trade-by-trade backtest of the same two-condition breakout rule as
// computeWeeklyStrongStocks, for one symbol over its full available
// history - powers the Scanner's backtest stats overlay.
export async function computeSymbolBreakoutBacktest(
  symbol: string,
  exchange: string,
  lookbackWeeks = WEEKLY_STRONG_WEEKLY_LOOKBACK_BARS
): Promise<SymbolBreakoutBacktestStats | null> {
  const seriesInput = await getSymbolWeeklyStrongSeriesInput(symbol, exchange);
  if (!seriesInput) return null;
  const { dailyRows, weeklyRows } = seriesInput;

  // lookbackWeeks is caller-chosen (Scanner's lookback multiplier), kept
  // separate from the fixed-window Weekly Strong screen elsewhere.
  const { dailyLookbackBars, weeklyLookbackBars } = deriveScannerLookbackBars(lookbackWeeks);
  const seriesPoints = evaluateWeeklyStrongSeries(dailyRows, weeklyRows, {
    dailyLookbackBars,
    weeklyLookbackBars,
  });
  // Re-aligned to weeklyRows by time - the evaluator can skip a leading
  // stretch of weeks with no daily data yet; those default to `false`.
  const passesByTime = new Map(seriesPoints.map((point) => [point.time, point.passes]));
  const matched: boolean[] = weeklyRows.map((row) => passesByTime.get(row.time) ?? false);

  const trades: BreakoutTrade[] = [];
  let entryIndex: number | null = null;

  for (let index = 0; index < weeklyRows.length; index++) {
    const isMatched = matched[index];
    const wasMatched = index > 0 && matched[index - 1];

    if (isMatched && !wasMatched) {
      entryIndex = index;
    } else if (!isMatched && wasMatched && entryIndex !== null) {
      trades.push(buildBreakoutTrade(entryIndex, index, weeklyRows));
      entryIndex = null;
    }
  }

  if (entryIndex !== null) {
    trades.push(buildBreakoutTrade(entryIndex, weeklyRows.length - 1, weeklyRows));
  }

  const signalsGenerated = trades.length;
  if (trades.length === 0) return null;

  const winners = trades.filter((trade) => trade.returnPct > 0);
  const losers = trades.filter((trade) => trade.returnPct <= 0);

  let equity = 100;
  let peak = 100;
  let maxDrawdownPct = 0;
  for (const trade of trades) {
    equity *= 1 + trade.returnPct / 100;
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - equity) / peak) * 100);
  }

  const grossProfit = winners.reduce((sum, trade) => sum + trade.returnPct, 0);
  const grossLoss = Math.abs(losers.reduce((sum, trade) => sum + trade.returnPct, 0));

  return {
    hitRatePct: (winners.length / trades.length) * 100,
    totalReturnPct: equity - 100,
    maxDrawdownPct,
    profitFactor: grossLoss === 0 ? null : grossProfit / grossLoss,
    signalsGenerated,
    avgHoldingDays:
      trades.reduce((sum, trade) => sum + (trade.exitIndex - trade.entryIndex) * 7, 0) / trades.length,
    largestWinnerPct: Math.max(...trades.map((trade) => trade.returnPct)),
    largestLoserPct: Math.min(...trades.map((trade) => trade.returnPct)),
  };
}

function buildBreakoutTrade(
  entryIndex: number,
  exitIndex: number,
  rows: MetricCandle[]
): BreakoutTrade {
  const entryClose = rows[entryIndex].close;
  const exitClose = rows[exitIndex].close;
  return {
    entryIndex,
    exitIndex,
    returnPct: ((exitClose - entryClose) / entryClose) * 100,
  };
}
