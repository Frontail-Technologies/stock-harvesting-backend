import { and, asc, count, desc, eq, gt, gte, ilike, inArray, lt, lte, not, or, sql } from "drizzle-orm";

import { db, type DbOrTx } from "../../db/client";
import { candles, instruments } from "../../db/schema";
import { getOrSetCache } from "../../shared/cache";
import { logger } from "../../shared/logger";
import { AppError } from "../../shared/errors";
import {
  CANDLE_SOURCE,
  CANDLE_TIMEFRAME,
  DATA_PROVIDER_KEY,
  DEFAULT_EXCHANGE,
  type CandleTimeframe,
} from "../../shared/constants";
import { normalizeSymbol } from "../../shared/normalize";
import {
  getActiveProviderAccessToken,
  getDataProviderAdapterForExchange,
  getEodhdDataProviderAdapter,
  markProviderConnectionExpired,
} from "../data-provider/data-provider.service";
import { NSE_INDEX_EXCHANGE } from "../data-provider/adapters/zerodha-data-provider.adapter";
import type {
  ProviderDailyCandle,
  ProviderExchange,
  ProviderSymbolDailyCandle,
} from "../data-provider/data-provider.types";
import { aggregateMonthlyCandles, aggregateWeeklyCandles } from "./candle-aggregation";
import type { MoveFilter } from "./market-data.schemas";

const CHART_HISTORY_YEARS = 30;
const DEFAULT_MARKET_SYMBOLS_BY_EXCHANGE: Record<string, readonly string[]> = {
  US: ["AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "TSLA", "JPM", "V", "UNH", "XOM", "AVGO"],
  NSE: [
    "RELIANCE",
    "TCS",
    "INFY",
    "HDFCBANK",
    "ICICIBANK",
    "SBIN",
    "BHARTIARTL",
    "ITC",
    "LT",
    "HINDUNILVR",
    "KOTAKBANK",
    "AXISBANK",
  ],
};
const FAILED_LATEST_CANDLE_SYNC_COOLDOWN_MS = 10 * 60 * 1000;
const CANDLE_UPSERT_CHUNK_SIZE = 500;
const INSTRUMENT_UPSERT_CHUNK_SIZE = 500;
const MIN_FULL_MARKET_INSTRUMENTS = 1_000;
const RELATIVE_STRENGTH_SEED_BACKFILL_LIMIT = 20;
const LIST_STOCKS_CACHE_TTL_MS = 20_000;
export const NSE_NORMAL_EQUITY_SYMBOL_PATTERN = "^[A-Z][A-Z0-9&-]*$";
// Bond/NCD "New" series tickers (e.g. "AAFS27A-N0", "826TN25-N3") all end in
// -N<digits> regardless of what precedes it — the previous pattern required
// the symbol to also start with a digit, so letter-prefixed debt series
// tickers slipped through the exclusion entirely.
const NSE_DEBT_SERIES_SYMBOL_PATTERN = "-N[0-9]+$";
const NSE_NON_EQ_SERIES_SYMBOL_PATTERN = "-(BE|BZ|SM|ST|SZ|E[0-9]+)$";
const failedLatestCandleSyncAtBySymbol = new Map<string, number>();
const chartBackfillPromises = new Map<string, Promise<unknown>>();
const completedChartBackfillAtByKey = new Map<string, number>();
const COMPLETED_CHART_BACKFILL_COOLDOWN_MS = 24 * 60 * 60 * 1000;

type StockSortField = "symbol" | "name" | "close" | "changePct" | "volume";
type StockSortDirection = "asc" | "desc";

function isRealtimePricedStockListExchange(exchange: string) {
  return exchange === "BSE" || exchange === "BSE_IDX";
}

function isPriceSortField(sortBy?: StockSortField) {
  return sortBy === "close" || sortBy === "changePct" || sortBy === "volume";
}

export type RelativeStrengthMetricRow = {
  symbol: string;
  name: string;
  exchange: string;
  sector: string | null;
  industry: string | null;
  close: number;
  volume: number;
  change55dPct: number;
  monthlyPct: number;
  weeklyMacdPct: number;
  weeklyMacdHistogramPct: number;
  // Sum of the 4 metrics above — the Index box and the per-stock ranking
  // functions rank by this single combined score; the Sector/Industry
  // group-ranking averages it across each category's member stocks.
  combinedScore: number;
};

type MetricCandle = {
  symbol: string;
  time: string;
  close: number;
  high: number;
  volume: number;
};

export async function listStocks(input: {
  q?: string;
  page: number;
  limit: number;
  sortBy?: StockSortField;
  sortDirection?: StockSortDirection;
  exchange?: string;
  moveFilter?: MoveFilter;
  minVolume?: number;
  includeUnpriced?: boolean;
}) {
  const exchange = input.exchange ?? DEFAULT_EXCHANGE;
  const cacheKey = [
    "listStocks",
    exchange,
    input.q ?? "",
    input.page,
    input.limit,
    input.sortBy ?? "",
    input.sortDirection ?? "",
    input.moveFilter ?? "",
    input.minVolume ?? "",
    input.includeUnpriced ? "includeUnpriced" : "",
  ].join(":");

  return getOrSetCache(cacheKey, LIST_STOCKS_CACHE_TTL_MS, () =>
    listStocksUncached({ ...input, exchange })
  );
}

async function listStocksUncached(input: {
  q?: string;
  page: number;
  limit: number;
  sortBy?: StockSortField;
  sortDirection?: StockSortDirection;
  exchange: string;
  moveFilter?: MoveFilter;
  minVolume?: number;
  includeUnpriced?: boolean;
}) {
  const exchange = input.exchange;
  const realtimePricedList = isRealtimePricedStockListExchange(exchange);
  const queryInput = realtimePricedList
    ? {
        ...input,
        exchange,
        includeUnpriced: true,
        moveFilter: undefined,
        minVolume: undefined,
        sortBy: isPriceSortField(input.sortBy) ? "symbol" : input.sortBy,
      }
    : { ...input, exchange };
  let rows = await readStockRows(queryInput);
  let total = await countStockRows(queryInput);

  const hydratedTotal = input.q?.trim()
    ? total
    : await countStockRows({ ...queryInput, includeUnpriced: true });

  if (!input.q?.trim() && hydratedTotal < MIN_FULL_MARKET_INSTRUMENTS) {
    await safeProviderAction("market-data.full-instrument-hydration", () =>
      hydrateDefaultMarketInstruments(exchange)
    );
    rows = await readStockRows(queryInput);
    total = await countStockRows(queryInput);
  }

  if (rows.length === 0) {
    if (input.q?.trim()) {
      await safeProviderAction("market-data.instrument-search", () =>
        syncProviderInstrumentSearch(input.q ?? "", exchange)
      );
      if (!queryInput.includeUnpriced && !realtimePricedList) {
        await safeProviderAction("market-data.search-price-hydration", async () => {
          const unpricedSymbols = await readUnpricedStockSymbols(
            queryInput,
            Math.min(input.limit, 12)
          );

          if (unpricedSymbols.length > 0) {
            await syncLatestDailyCandlesForSymbols(unpricedSymbols, exchange);
          }
        });
      }
    } else {
      await safeProviderAction("market-data.default-instrument-hydration", () =>
        hydrateDefaultMarketInstruments(exchange)
      );
    }
    rows = await readStockRows(queryInput);
    total = await countStockRows(queryInput);
  }

  if (
    !queryInput.includeUnpriced &&
    !realtimePricedList &&
    hydratedTotal > total &&
    total <= input.page * input.limit
  ) {
    const unpricedSymbols = await readUnpricedStockSymbols(queryInput, input.limit);

    if (unpricedSymbols.length > 0) {
      await safeProviderAction("market-data.next-page-price-hydration", () =>
        syncLatestDailyCandlesForSymbols(unpricedSymbols, exchange)
      );
      rows = await readStockRows(queryInput);
      total = await countStockRows(queryInput);
    }
  }

  const rowsMissingPrices = rows.filter((row) => row.close === null);
  if (realtimePricedList && rowsMissingPrices.length > 0) {
    await refreshLatestInstrumentStats(
      exchange,
      rowsMissingPrices.map((row) => row.symbol)
    );
    rows = await readStockRows(queryInput);
  }

  if (!queryInput.includeUnpriced && !realtimePricedList && rowsMissingPrices.length > 0) {
    await safeProviderAction("market-data.latest-candle-sync", () =>
      syncLatestDailyCandlesForSymbols(
        rowsMissingPrices.map((row) => row.symbol),
        exchange
      )
    );
    rows = await readStockRows(queryInput);
  }

  if (queryInput.includeUnpriced && !realtimePricedList && rowsMissingPrices.length > 0) {
    void safeProviderAction("market-data.visible-price-hydration", () =>
      syncLatestDailyCandlesForSymbols(
        rowsMissingPrices.slice(0, 8).map((row) => row.symbol),
        exchange
      )
    );
  }

  return {
    stocks: rows.map((row) => ({
      symbol: row.symbol,
      name: row.name,
      exchange: row.exchange,
      close: row.close === null ? undefined : Number(row.close),
      changePct: row.changePct === null ? undefined : Number(row.changePct),
      volume: row.volume === null ? undefined : Number(row.volume),
      open: row.open === null ? undefined : Number(row.open),
    })),
    pagination: {
      page: input.page,
      limit: input.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / input.limit)),
    },
  };
}

type RelativeStrengthInstrumentInput = {
  symbol: string;
  name: string;
  exchange: string;
  sector?: string | null;
  industry?: string | null;
};

// Computes the same 4 relative-strength metrics (55-day change, 19-day
// "monthly" change, weekly MACD line %, weekly MACD histogram %, all as %
// of price) over an arbitrary instrument pool, for every instrument that has
// enough history — no top-N slicing here, unlike computeRelativeStrengthMetrics
// below. computeGroupRelativeStrength needs every qualifying row (to average
// per sector/industry), not just the global top N.
async function computeAllRelativeStrengthMetrics(
  instrumentRows: RelativeStrengthInstrumentInput[],
  exchange: string
): Promise<RelativeStrengthMetricRow[]> {
  const symbols = instrumentRows.map((row) => row.symbol);
  if (symbols.length === 0) return [];

  const { dailyCandles, weeklyCandles } = await readDailyAndWeeklyMetricCandles({
    exchange,
    symbols,
    dailyFrom: getDateDaysAgo(140),
    weeklyFrom: getDateYearsAgo(5),
  });
  const dailyCandlesBySymbol = groupMetricCandlesBySymbol(dailyCandles);
  const weeklyCandlesBySymbol = groupMetricCandlesBySymbol(weeklyCandles);

  return instrumentRows
    .map((instrument): RelativeStrengthMetricRow | null => {
      const dailyRows = dailyCandlesBySymbol.get(instrument.symbol) ?? [];
      const weeklyRows = weeklyCandlesBySymbol.get(instrument.symbol) ?? [];
      const latestDaily = dailyRows[dailyRows.length - 1];
      if (!latestDaily) return null;

      // A symbol with only a handful of candles (e.g. just synced
      // today's close, no real history yet) can't produce a genuine
      // 55-day/monthly/MACD reading — calculateLookbackChangePct and
      // calculateMacdPercent both fall back to 0 when they don't have
      // enough bars, which would otherwise look identical to a real
      // "flat" score instead of "we don't have enough data yet".
      if (dailyRows.length <= 54 || weeklyRows.length < 35) return null;

      // Same near-250-week-high condition as the scanner page's
      // near_250_week_high scan band and computeWeeklyStrongStocks below —
      // weekly close must be within 15% of its trailing 250-week high.
      const weeklyWindow = weeklyRows.slice(-WEEKLY_STRONG_WEEKLY_LOOKBACK_BARS);
      const weeklyCloseHigh = Math.max(...weeklyWindow.map((row) => row.close));
      const latestWeekly = weeklyRows[weeklyRows.length - 1];
      if (latestWeekly.close <= weeklyCloseHigh * WEEKLY_STRONG_NEAR_HIGH_RATIO) return null;

      const macd = calculateMacdPercent(weeklyRows);
      const change55dPct = calculateLookbackChangePct(dailyRows, 54);
      const monthlyPct = calculateLookbackChangePct(dailyRows, 19);

      return {
        symbol: instrument.symbol,
        name: instrument.name,
        exchange: instrument.exchange,
        sector: instrument.sector ?? null,
        industry: instrument.industry ?? null,
        close: latestDaily.close,
        volume: latestDaily.volume,
        change55dPct,
        monthlyPct,
        weeklyMacdPct: macd.linePct,
        weeklyMacdHistogramPct: macd.histogramPct,
        // Only the 55-day change condition is enabled for now — monthlyPct
        // and the weekly MACD terms are still computed above (and returned)
        // so they're one-line to add back into the sum later.
        combinedScore: change55dPct,
      };
    })
    .filter((row): row is RelativeStrengthMetricRow => Boolean(row));
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

// "Sector rotation" style ranking: instead of ranking individual stocks, rank
// the sector/industry categories themselves by the mean combinedScore of
// their member stocks within this instrument pool. Requires instrumentRows
// to carry real sector/industry classification (from the sector-classification
// sync) — instruments with no classification yet are silently excluded
// rather than lumped into a misleading "unclassified" group.
export async function computeGroupRelativeStrength(
  instrumentRows: RelativeStrengthInstrumentInput[],
  exchange: string,
  groupBy: "sector" | "industry",
  limit: number
): Promise<GroupRelativeStrengthRow[]> {
  const allMetrics = await computeAllRelativeStrengthMetrics(instrumentRows, exchange);
  const groups = new Map<string, { total: number; count: number }>();

  for (const metric of allMetrics) {
    const key = groupBy === "sector" ? metric.sector : metric.industry;
    if (!key) continue;

    const group = groups.get(key) ?? { total: 0, count: 0 };
    group.total += metric.combinedScore;
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

// ChartInk-style "near multi-year close" breakout screen: a stock passes only
// if its latest weekly close is within 15% of its own 250-week closing high AND its
// latest daily close is within 15% of its own 1252-day (~5yr) closing high. Unlike
// the relative-strength metrics above (which rank everything), this filters
// down to only the stocks that pass both conditions.
const WEEKLY_STRONG_WEEKLY_LOOKBACK_BARS = 250;
const WEEKLY_STRONG_DAILY_LOOKBACK_BARS = 1252;
const WEEKLY_STRONG_NEAR_HIGH_RATIO = 0.85;
// Floor below the full lookback windows above — enough of a sample that a
// symbol's own trailing close isn't trivially just its own recent close.
const MIN_WEEKLY_STRONG_DAILY_BARS = 50;
const MIN_WEEKLY_STRONG_WEEKLY_BARS = 20;

export type WeeklyStrongStockRow = {
  symbol: string;
  name: string;
  exchange: string;
  close: number;
  changePct: number;
  volume: number;
};

export async function computeWeeklyStrongStocks(
  instrumentRows: Array<{ symbol: string; name: string; exchange: string }>,
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
    const weeklyRows = weeklyCandlesBySymbol.get(instrument.symbol) ?? [];
    const latestDaily = dailyRows[dailyRows.length - 1];
    const latestWeekly = weeklyRows[weeklyRows.length - 1];
    if (!latestDaily || !latestWeekly) continue;

    // A near-empty window (e.g. just today's candle, no real history) has
    // its own "high" equal to roughly its own close, which trivially
    // passes a "near the high" check — that's a data gap, not a real
    // breakout. Skip symbols without a reasonably substantial sample.
    if (dailyRows.length < MIN_WEEKLY_STRONG_DAILY_BARS || weeklyRows.length < MIN_WEEKLY_STRONG_WEEKLY_BARS) {
      continue;
    }

    const dailyWindow = dailyRows.slice(-WEEKLY_STRONG_DAILY_LOOKBACK_BARS);
    const weeklyWindow = weeklyRows.slice(-WEEKLY_STRONG_WEEKLY_LOOKBACK_BARS);
    const dailyCloseHigh = Math.max(...dailyWindow.map((row) => row.close));
    const weeklyCloseHigh = Math.max(...weeklyWindow.map((row) => row.close));

    const passesDaily = latestDaily.close > dailyCloseHigh * WEEKLY_STRONG_NEAR_HIGH_RATIO;
    const passesWeekly = latestWeekly.close > weeklyCloseHigh * WEEKLY_STRONG_NEAR_HIGH_RATIO;
    if (!passesDaily || !passesWeekly) continue;

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
    });
  }

  return rows.sort((a, b) => b.changePct - a.changePct);
}

// Re-runs the same weekly-strong breakout check at every historical week
// over the backtest window, instead of just today, and counts how many pool
// members passed at each point — powers the "Backtest History" bar chart.
const WEEKLY_STRONG_BACKTEST_DEFAULT_WEEKS = 156;
// Fetch window needs to cover the oldest backtest week's own trailing
// lookback (250 weeks / 1252 days) *plus* the backtest range itself.
const WEEKLY_STRONG_BACKTEST_FETCH_YEARS = 9;

export type WeeklyStrongBacktestPoint = {
  date: string;
  passCount: number;
};

export async function computeWeeklyStrongStocksBacktest(
  instrumentRows: Array<{ symbol: string; name: string; exchange: string }>,
  exchange: string,
  weeks: number = WEEKLY_STRONG_BACKTEST_DEFAULT_WEEKS
): Promise<WeeklyStrongBacktestPoint[]> {
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
  const passCountByDate = new Map<string, number>();

  for (const instrument of instrumentRows) {
    const dailyRows = dailyCandlesBySymbol.get(instrument.symbol) ?? [];
    const weeklyRows = weeklyCandlesBySymbol.get(instrument.symbol) ?? [];
    // Same data-gap guard as computeWeeklyStrongStocks: a symbol with
    // barely any history can't produce a meaningful "near its own close high"
    // reading at any point in the backtest either.
    if (dailyRows.length < MIN_WEEKLY_STRONG_DAILY_BARS || weeklyRows.length < MIN_WEEKLY_STRONG_WEEKLY_BARS) {
      continue;
    }

    const dailyMaxArr = rollingMax(dailyRows.map((row) => row.close), WEEKLY_STRONG_DAILY_LOOKBACK_BARS);
    const weeklyMaxArr = rollingMax(
      weeklyRows.map((row) => row.close),
      WEEKLY_STRONG_WEEKLY_LOOKBACK_BARS
    );

    let dailyIndex = 0;
    const startIndex = Math.max(0, weeklyRows.length - weeks);

    for (let weeklyIndex = startIndex; weeklyIndex < weeklyRows.length; weeklyIndex++) {
      const weeklyRow = weeklyRows[weeklyIndex];

      while (dailyIndex + 1 < dailyRows.length && dailyRows[dailyIndex + 1].time <= weeklyRow.time) {
        dailyIndex++;
      }
      if (dailyRows[dailyIndex].time > weeklyRow.time) continue;

      const passesWeekly = weeklyRow.close > weeklyMaxArr[weeklyIndex] * WEEKLY_STRONG_NEAR_HIGH_RATIO;
      const passesDaily =
        dailyRows[dailyIndex].close > dailyMaxArr[dailyIndex] * WEEKLY_STRONG_NEAR_HIGH_RATIO;

      allWeeklyDates.add(weeklyRow.time);
      if (passesWeekly && passesDaily) {
        passCountByDate.set(weeklyRow.time, (passCountByDate.get(weeklyRow.time) ?? 0) + 1);
      }
    }
  }

  return [...allWeeklyDates]
    .sort()
    .slice(-weeks)
    .map((date) => ({ date, passCount: passCountByDate.get(date) ?? 0 }));
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

// Trade-by-trade backtest of the SAME two-condition breakout rule as
// computeWeeklyStrongStocks above, for one symbol over its full available
// history — this is what the Scanner's backtest stats overlay should be
// showing. It previously used a weekly-only simplification (see
// scanner/rules/near-250-week-high.ts) that silently dropped the daily
// confirmation condition, which is why its numbers didn't match "our logic".
export async function computeSymbolBreakoutBacktest(
  symbol: string,
  exchange: string,
  lookbackWeeks = WEEKLY_STRONG_WEEKLY_LOOKBACK_BARS
): Promise<SymbolBreakoutBacktestStats | null> {
  const normalizedSymbol = normalizeSymbol(symbol);
  const { dailyCandles, weeklyCandles } = await readDailyAndWeeklyMetricCandles({
    exchange,
    symbols: [normalizedSymbol],
    dailyFrom: getDefaultChartHistoryFromDate(),
    weeklyFrom: getDefaultChartHistoryFromDate(),
  });

  const dailyRows = groupMetricCandlesBySymbol(dailyCandles).get(normalizedSymbol) ?? [];
  const weeklyRows = groupMetricCandlesBySymbol(weeklyCandles).get(normalizedSymbol) ?? [];

  if (dailyRows.length < MIN_WEEKLY_STRONG_DAILY_BARS || weeklyRows.length < MIN_WEEKLY_STRONG_WEEKLY_BARS) {
    return null;
  }

  const weeklyLookbackBars = Math.max(1, Math.round(lookbackWeeks));
  const dailyLookbackBars = Math.max(1, Math.round(lookbackWeeks * 5));
  const dailyMaxArr = rollingMax(dailyRows.map((row) => row.close), dailyLookbackBars);
  const weeklyMaxArr = rollingMax(weeklyRows.map((row) => row.close), weeklyLookbackBars);

  const matched: boolean[] = new Array(weeklyRows.length).fill(false);
  let dailyIndex = 0;

  for (let weeklyIndex = 0; weeklyIndex < weeklyRows.length; weeklyIndex++) {
    const weeklyRow = weeklyRows[weeklyIndex];

    while (dailyIndex + 1 < dailyRows.length && dailyRows[dailyIndex + 1].time <= weeklyRow.time) {
      dailyIndex++;
    }
    if (dailyRows[dailyIndex].time > weeklyRow.time) continue;

    const passesWeekly = weeklyRow.close > weeklyMaxArr[weeklyIndex] * WEEKLY_STRONG_NEAR_HIGH_RATIO;
    const passesDaily = dailyRows[dailyIndex].close > dailyMaxArr[dailyIndex] * WEEKLY_STRONG_NEAR_HIGH_RATIO;
    matched[weeklyIndex] = passesWeekly && passesDaily;
  }

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

// Sliding-window maximum: result[i] = max(values[i - windowSize + 1 .. i]).
function rollingMax(values: number[], windowSize: number): number[] {
  const result = new Array<number>(values.length);
  const deque: number[] = [];

  for (let i = 0; i < values.length; i++) {
    while (deque.length > 0 && values[deque[deque.length - 1]] <= values[i]) {
      deque.pop();
    }
    deque.push(i);

    const windowStart = i - windowSize + 1;
    while (deque[0] < windowStart) {
      deque.shift();
    }

    result[i] = values[deque[0]];
  }

  return result;
}

function buildStockFilters(input: {
  q?: string;
  exchange: string;
  moveFilter?: MoveFilter;
  minVolume?: number;
  includeUnpriced?: boolean;
}) {
  const filters = [
    eq(instruments.exchange, input.exchange),
    eq(instruments.active, true),
    // Excludes Morningstar-style fund identifiers (e.g. "0P0001Y872") that
    // the provider's instrument search occasionally returns alongside real
    // tradeable tickers — no genuine stock symbol starts with a digit.
    not(ilike(instruments.symbol, "0%")),
    input.includeUnpriced ? undefined : gt(instruments.latestClose, "0"),
    input.exchange === "NSE"
      ? eq(instruments.provider, DATA_PROVIDER_KEY.zerodha)
      : undefined,
    input.exchange === "NSE"
      ? sql`${instruments.symbol} ~ ${NSE_NORMAL_EQUITY_SYMBOL_PATTERN}`
      : undefined,
    input.exchange === "NSE"
      ? not(sql`${instruments.symbol} ~ ${NSE_DEBT_SERIES_SYMBOL_PATTERN}`)
      : undefined,
    input.exchange === "NSE"
      ? not(sql`${instruments.symbol} ~ ${NSE_NON_EQ_SERIES_SYMBOL_PATTERN}`)
      : undefined,
    input.q
      ? or(
          ilike(instruments.symbol, `%${normalizeSymbol(input.q)}%`),
          ilike(instruments.name, `%${input.q.trim()}%`)
        )
      : undefined,
    // NULL latestChangePct (not yet computed) naturally falls out of all
    // three comparisons below, so a stock without complete data is never
    // miscategorized as a gainer/decliner/unchanged.
    input.moveFilter === "gainers" ? gt(instruments.latestChangePct, "0") : undefined,
    input.moveFilter === "decliners" ? lt(instruments.latestChangePct, "0") : undefined,
    input.moveFilter === "unchanged" ? eq(instruments.latestChangePct, "0") : undefined,
    input.minVolume !== undefined
      ? gte(instruments.latestVolume, String(input.minVolume))
      : undefined,
  ].filter(Boolean);

  return and(...filters);
}

// All 4 dashboard cards rank by the same combined score now (see
// RelativeStrengthMetricRow.combinedScore), so this is a single top-N
// selection rather than a union across 4 separately-ranked metrics.
function pickTopRelativeStrengthRows(
  rows: RelativeStrengthMetricRow[],
  limit: number
) {
  return [...rows].sort((a, b) => b.combinedScore - a.combinedScore).slice(0, limit);
}

async function countStockRows(input: {
  q?: string;
  exchange: string;
  moveFilter?: MoveFilter;
  minVolume?: number;
  includeUnpriced?: boolean;
}) {
  const [result] = await db
    .select({ total: count() })
    .from(instruments)
    .where(buildStockFilters(input));

  return result?.total ?? 0;
}

function buildStockOrderBy(sortBy: StockSortField = "name", sortDirection: StockSortDirection = "asc") {
  const direction = sortDirection === "desc" ? desc : asc;
  const primaryColumn =
    sortBy === "symbol"
      ? instruments.symbol
      : sortBy === "name"
        ? instruments.name
        : sortBy === "close"
          ? instruments.latestClose
          : sortBy === "changePct"
            ? instruments.latestChangePct
            : instruments.latestVolume;
  const tiebreakerColumn = instruments.symbol;

  return [direction(primaryColumn), asc(tiebreakerColumn)];
}

async function readStockRows(input: {
  q?: string;
  page: number;
  limit: number;
  sortBy?: StockSortField;
  sortDirection?: StockSortDirection;
  exchange: string;
  moveFilter?: MoveFilter;
  minVolume?: number;
  includeUnpriced?: boolean;
}) {
  const offset = (input.page - 1) * input.limit;

  const rows = await db
    .select({
      symbol: instruments.symbol,
      name: instruments.name,
      exchange: instruments.exchange,
      close: instruments.latestClose,
      open: instruments.latestOpen,
      volume: instruments.latestVolume,
      changePct: instruments.latestChangePct,
    })
    .from(instruments)
    .where(buildStockFilters(input))
    .orderBy(...buildStockOrderBy(input.sortBy, input.sortDirection))
    .limit(input.limit)
    .offset(offset);

  return rows;
}

async function readUnpricedStockSymbols(
  input: {
    q?: string;
    exchange: string;
    moveFilter?: MoveFilter;
    minVolume?: number;
  },
  limit: number
) {
  const rows = await db
    .select({ symbol: instruments.symbol })
    .from(instruments)
    .where(
      and(
        buildStockFilters({ ...input, includeUnpriced: true }),
        or(
          sql`${instruments.latestClose} IS NULL`,
          lte(instruments.latestClose, "0")
        )
      )
    )
    .orderBy(asc(instruments.symbol))
    .limit(limit);

  return rows.map((row) => row.symbol);
}

export async function getChartCandles(input: {
  symbol: string;
  timeframe: CandleTimeframe;
  from?: string;
  to?: string;
  exchange?: string;
}) {
  const symbol = normalizeSymbol(input.symbol);
  const exchange = input.exchange ?? DEFAULT_EXCHANGE;
  let rows = await readChartCandles({
    ...input,
    symbol,
    exchange,
  });

  const from = input.from ?? getDefaultChartHistoryFromDate();
  const to = input.to ?? getTodayDate();
  if (rows.length === 0 && input.timeframe !== CANDLE_TIMEFRAME.day) {
    await deriveStoredCandlesForTimeframe({
      symbol,
      timeframe: input.timeframe,
      from,
      to,
      exchange,
    });
    rows = await readChartCandles({
      ...input,
      symbol,
      exchange,
    });
  }

  if (
    rows.length === 0 ||
    hasLikelySplitDiscontinuity(rows) ||
    shouldBackfillRequestedHistory(rows, from, input.from)
  ) {
    await safeProviderAction("market-data.chart-candle-backfill", () =>
      runChartBackfillOnce({
        symbol,
        from,
        to,
        exchange,
      })
    );
    rows = await readChartCandles({
      ...input,
      symbol,
      exchange,
    });
  }

  if (rows.length === 0) {
    const runtimeRows = await safeProviderAction("market-data.chart-candle-runtime-fetch", () =>
      fetchRuntimeChartCandles({
        symbol,
        timeframe: input.timeframe,
        from,
        to,
        exchange,
      })
    );
    if (runtimeRows?.length) return runtimeRows;
  }

  return rows.map(toChartCandleResponse);
}

function toChartCandleResponse(row: {
  time: string;
  open: string | number;
  high: string | number;
  low: string | number;
  close: string | number;
  volume: string | number;
}) {
  return {
    time: row.time,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
  };
}

async function fetchRuntimeChartCandles(input: {
  symbol: string;
  timeframe: CandleTimeframe;
  from: string;
  to: string;
  exchange: string;
}) {
  const adapter = getDataProviderAdapterForExchange(input.exchange);
  const accessToken = await getActiveProviderAccessToken(adapter.providerKey);
  const [instrument] = await db
    .select({
      instrumentToken: instruments.instrumentToken,
    })
    .from(instruments)
    .where(
      and(
        eq(instruments.exchange, input.exchange),
        eq(instruments.symbol, input.symbol)
      )
    )
    .limit(1);
  const instrumentToken =
    instrument?.instrumentToken ??
    (adapter.getInstrumentToken
      ? await adapter.getInstrumentToken(input.symbol, input.exchange)
      : input.symbol);

  const daily = await adapter.fetchDailyCandles({
    accessToken,
    instrumentToken,
    symbol: input.symbol,
    from: input.from,
    to: input.to,
    exchangeCode: input.exchange,
  });

  const chartRows = aggregateRuntimeChartCandles(daily, input.timeframe);
  return chartRows.map(toChartCandleResponse);
}

function aggregateRuntimeChartCandles(
  daily: ProviderDailyCandle[],
  timeframe: CandleTimeframe
) {
  if (timeframe === CANDLE_TIMEFRAME.day) return daily;
  if (timeframe === CANDLE_TIMEFRAME.week) return aggregateWeeklyCandles(daily);
  if (timeframe === CANDLE_TIMEFRAME.month) return aggregateMonthlyCandles(daily);

  return daily;
}

function hasLikelySplitDiscontinuity(
  rows: Array<{ close: string | number }>
) {
  for (let index = 1; index < rows.length; index++) {
    const previousClose = Number(rows[index - 1]?.close);
    const close = Number(rows[index]?.close);
    if (!Number.isFinite(previousClose) || !Number.isFinite(close)) continue;
    if (previousClose <= 0 || close <= 0) continue;

    const ratio = Math.max(previousClose, close) / Math.min(previousClose, close);
    if (ratio >= 4) return true;
  }

  return false;
}

function shouldBackfillRequestedHistory(
  rows: Array<{ time: string }>,
  requestedFrom: string,
  explicitFrom?: string
) {
  if (explicitFrom || rows.length === 0) return false;

  const oldest = rows[0]?.time;
  if (!oldest) return false;

  return oldest > requestedFrom;
}

function runChartBackfillOnce(input: {
  symbol: string;
  from: string;
  to: string;
  exchange: string;
}) {
  const key = `${input.exchange}:${input.symbol}:${input.from}:${input.to}`;
  const completedAt = completedChartBackfillAtByKey.get(key);
  if (
    completedAt !== undefined &&
    Date.now() - completedAt < COMPLETED_CHART_BACKFILL_COOLDOWN_MS
  ) {
    return Promise.resolve({ skipped: true });
  }

  const existing = chartBackfillPromises.get(key);
  if (existing) return existing;

  const promise = backfillDailyCandles(input)
    .then((result) => {
      completedChartBackfillAtByKey.set(key, Date.now());
      return result;
    })
    .finally(() => {
      chartBackfillPromises.delete(key);
    });
  chartBackfillPromises.set(key, promise);
  return promise;
}

async function readChartCandles(input: {
  symbol: string;
  timeframe: CandleTimeframe;
  from?: string;
  to?: string;
  exchange: string;
}) {
  const filters = [
    eq(candles.exchange, input.exchange),
    eq(candles.symbol, input.symbol),
    eq(candles.timeframe, input.timeframe),
    input.from ? gte(candles.time, input.from) : undefined,
    input.to ? lte(candles.time, input.to) : undefined,
  ].filter(Boolean);

  const rows = await db
    .select()
    .from(candles)
    .where(and(...filters))
    .orderBy(asc(candles.time));

  return rows;
}

async function deriveStoredCandlesForTimeframe(input: {
  symbol: string;
  timeframe: CandleTimeframe;
  from: string;
  to: string;
  exchange: string;
}) {
  const dailyRows = await readChartCandles({
    symbol: input.symbol,
    timeframe: CANDLE_TIMEFRAME.day,
    from: input.from,
    to: input.to,
    exchange: input.exchange,
  });

  const firstDailyRow = dailyRows[0];
  if (!firstDailyRow?.instrumentId) return { inserted: 0 };
  const instrumentId = firstDailyRow.instrumentId;

  const sourceRows = dailyRows.map((row) => ({
    time: row.time,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
  }));
  const aggregateRows =
    input.timeframe === CANDLE_TIMEFRAME.week
      ? aggregateWeeklyCandles(sourceRows)
      : input.timeframe === CANDLE_TIMEFRAME.month
        ? aggregateMonthlyCandles(sourceRows)
        : [];

  await upsertCandles(
    aggregateRows.map((candle) => ({
      instrumentId,
      exchange: input.exchange,
      symbol: input.symbol,
      timeframe: input.timeframe,
      source: CANDLE_SOURCE.derived,
      ...candle,
    }))
  );

  return { inserted: aggregateRows.length };
}

async function readMetricCandles(input: {
  exchange: string;
  symbols: string[];
  timeframe: CandleTimeframe;
  from: string;
}) {
  const rows = await db
    .select({
      symbol: candles.symbol,
      time: candles.time,
      close: candles.close,
      high: candles.high,
      volume: candles.volume,
    })
    .from(candles)
    .where(
      and(
        eq(candles.exchange, input.exchange),
        eq(candles.timeframe, input.timeframe),
        gte(candles.time, input.from),
        inArray(candles.symbol, input.symbols)
      )
    )
    .orderBy(asc(candles.symbol), asc(candles.time));

  return rows.map((row) => ({
    symbol: row.symbol,
    time: row.time,
    close: Number(row.close),
    high: Number(row.high),
    volume: Number(row.volume),
  }));
}

// Fetches daily+weekly candles for a symbol pool, and if a collection has
// never been viewed before (no candles synced for any member yet) triggers a
// best-effort one-time seed backfill for the first N symbols so the page
// isn't permanently empty — the same fallback pattern relative-strength
// metrics already rely on.
async function readDailyAndWeeklyMetricCandles(input: {
  exchange: string;
  symbols: string[];
  dailyFrom: string;
  weeklyFrom: string;
}) {
  let [dailyCandles, weeklyCandles] = await Promise.all([
    readMetricCandles({
      exchange: input.exchange,
      symbols: input.symbols,
      timeframe: CANDLE_TIMEFRAME.day,
      from: input.dailyFrom,
    }),
    readMetricCandles({
      exchange: input.exchange,
      symbols: input.symbols,
      timeframe: CANDLE_TIMEFRAME.week,
      from: input.weeklyFrom,
    }),
  ]);

  if (dailyCandles.length === 0 && weeklyCandles.length === 0) {
    const seedSymbols = input.symbols.slice(0, RELATIVE_STRENGTH_SEED_BACKFILL_LIMIT);
    await safeProviderAction("market-data.relative-strength-seed-backfill", async () => {
      let seeded = 0;
      // One bad symbol shouldn't stop the rest of the batch from seeding —
      // same failure mode fixed in backfillIndexCandles above.
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
              message: error instanceof Error ? error.message : "Seed backfill failed",
            },
            "Relative strength seed backfill failed for symbol"
          );
        }
      }
      return { symbols: seeded };
    });

    [dailyCandles, weeklyCandles] = await Promise.all([
      readMetricCandles({
        exchange: input.exchange,
        symbols: input.symbols,
        timeframe: CANDLE_TIMEFRAME.day,
        from: input.dailyFrom,
      }),
      readMetricCandles({
        exchange: input.exchange,
        symbols: input.symbols,
        timeframe: CANDLE_TIMEFRAME.week,
        from: input.weeklyFrom,
      }),
    ]);
  }

  return { dailyCandles, weeklyCandles };
}

function groupMetricCandlesBySymbol(rows: MetricCandle[]) {
  const candlesBySymbol = new Map<string, MetricCandle[]>();

  for (const row of rows) {
    const currentRows = candlesBySymbol.get(row.symbol) ?? [];
    currentRows.push(row);
    candlesBySymbol.set(row.symbol, currentRows);
  }

  return candlesBySymbol;
}

function calculateLookbackChangePct(rows: MetricCandle[], barsAgo: number) {
  const latest = rows[rows.length - 1];
  const previous = rows[rows.length - 1 - barsAgo];

  if (!latest || !previous || previous.close === 0) return 0;
  return ((latest.close - previous.close) * 100) / previous.close;
}

function calculateMacdPercent(rows: MetricCandle[]) {
  if (rows.length < 35) {
    return {
      linePct: 0,
      histogramPct: 0,
    };
  }

  const closes = rows.map((row) => row.close);
  const ema12 = calculateEma(closes, 12);
  const ema26 = calculateEma(closes, 26);
  const macdLine = closes.map((_, index) => ema12[index] - ema26[index]);
  const signalLine = calculateEma(macdLine, 9);
  const latestClose = closes[closes.length - 1];
  const latestMacd = macdLine[macdLine.length - 1] ?? 0;
  const latestSignal = signalLine[signalLine.length - 1] ?? 0;

  if (!latestClose) {
    return {
      linePct: 0,
      histogramPct: 0,
    };
  }

  return {
    linePct: (latestMacd * 100) / latestClose,
    histogramPct: ((latestMacd - latestSignal) * 100) / latestClose,
  };
}

function calculateEma(values: number[], period: number) {
  if (values.length === 0) return [];

  const multiplier = 2 / (period + 1);
  const ema: number[] = [values[0] ?? 0];

  for (let index = 1; index < values.length; index++) {
    const previous = ema[index - 1] ?? values[index] ?? 0;
    const current = values[index] ?? previous;
    ema.push((current - previous) * multiplier + previous);
  }

  return ema;
}

export async function syncProviderInstruments(exchange: string = DEFAULT_EXCHANGE) {
  const adapter = getDataProviderAdapterForExchange(exchange);
  const accessToken = await getActiveProviderAccessToken(adapter.providerKey);
  const providerInstruments = await adapter.fetchInstruments({
    accessToken,
    exchangeCode: exchange,
  });

  await upsertInstruments(providerInstruments, adapter.providerKey);

  return { count: providerInstruments.length };
}

export async function backfillDailyCandles(
  input: {
    symbol: string;
    from: string;
    to: string;
    exchange?: string;
  },
  dbClient: DbOrTx = db
) {
  const symbol = normalizeSymbol(input.symbol);
  const exchange = input.exchange ?? DEFAULT_EXCHANGE;
  const instrument = await getOrCreateInstrument(symbol, exchange, dbClient);

  if (!instrument) {
    return { insertedDaily: 0, insertedWeekly: 0, insertedMonthly: 0 };
  }

  // Everything that can fail for reasons outside our control (network,
  // vendor errors, rate limits) happens before we touch existing rows —
  // deleteCandlesForRefresh only runs once we already have validated
  // replacement data in hand, inside the transaction below.
  const adapter = getDataProviderAdapterForExchange(exchange);
  const accessToken = await getActiveProviderAccessToken(adapter.providerKey);
  const daily = await adapter.fetchDailyCandles({
    accessToken,
    instrumentToken: instrument.instrumentToken,
    symbol,
    from: input.from,
    to: input.to,
    exchangeCode: exchange,
  });

  const weekly = aggregateWeeklyCandles(daily);
  const monthly = aggregateMonthlyCandles(daily);

  await replaceCandlesAtomically(dbClient, {
    instrumentId: instrument.id,
    exchange,
    symbol,
    from: input.from,
    to: input.to,
    daily,
    weekly,
    monthly,
  });

  // A denormalized read-cache refresh, not part of the replacement
  // invariant above — runs after commit so it reads the now-durable rows.
  // If this step fails, the candles are still correctly replaced; only the
  // instruments.latest* cache stays stale until the next sync.
  await refreshLatestInstrumentStats(exchange, [symbol], dbClient);

  return {
    insertedDaily: daily.length,
    insertedWeekly: weekly.length,
    insertedMonthly: monthly.length,
  };
}

// The atomic core of a candle-range replacement: delete the existing
// exchange/symbol/date-range across all 3 timeframes, then upsert the fresh
// daily/weekly/monthly rows — all inside one transaction, so a failure at
// any step (including a duplicate-key error surfaced from upsertCandles)
// rolls back the delete too, instead of leaving the range empty. Exported
// so it can be exercised directly against a fake DbOrTx in tests, without
// needing to also fake the provider-fetch layer that backfillDailyCandles
// wraps around it.
export async function replaceCandlesAtomically(
  dbClient: DbOrTx,
  input: {
    instrumentId: string;
    exchange: string;
    symbol: string;
    from: string;
    to: string;
    daily: ProviderDailyCandle[];
    weekly: ProviderDailyCandle[];
    monthly: ProviderDailyCandle[];
  }
) {
  await dbClient.transaction(async (tx) => {
    await deleteCandlesForRefresh(
      {
        symbol: input.symbol,
        from: input.from,
        to: input.to,
        exchange: input.exchange,
      },
      tx
    );

    await upsertCandles(
      input.daily.map((candle) => ({
        instrumentId: input.instrumentId,
        exchange: input.exchange,
        symbol: input.symbol,
        timeframe: CANDLE_TIMEFRAME.day,
        source: CANDLE_SOURCE.provider,
        ...candle,
      })),
      tx
    );
    await upsertCandles(
      input.weekly.map((candle) => ({
        instrumentId: input.instrumentId,
        exchange: input.exchange,
        symbol: input.symbol,
        timeframe: CANDLE_TIMEFRAME.week,
        source: CANDLE_SOURCE.derived,
        ...candle,
      })),
      tx
    );
    await upsertCandles(
      input.monthly.map((candle) => ({
        instrumentId: input.instrumentId,
        exchange: input.exchange,
        symbol: input.symbol,
        timeframe: CANDLE_TIMEFRAME.month,
        source: CANDLE_SOURCE.derived,
        ...candle,
      })),
      tx
    );
  });
}

// Backfills full price history for the small (~120), explicitly synced set
// of index instruments on one index exchange (NSE_IDX or BSE_IDX) — a
// deliberate, bounded admin action, not proactive bulk backfill for the
// whole market. Reuses backfillDailyCandles unchanged; it's already
// exchange-generic. Defaults to NSE_IDX to preserve existing callers.
export async function backfillIndexCandles(exchange: string = NSE_INDEX_EXCHANGE) {
  const indexInstruments = await db
    .select({ symbol: instruments.symbol })
    .from(instruments)
    .where(and(eq(instruments.exchange, exchange), eq(instruments.active, true)));

  const from = getDefaultChartHistoryFromDate();
  const to = new Date().toISOString().slice(0, 10);
  let backfilled = 0;
  const failedSymbols: string[] = [];

  // One slow/unhistoried index shouldn't sink backfill for the rest —
  // continue past a per-symbol failure and report it instead of aborting.
  for (const row of indexInstruments) {
    try {
      await backfillDailyCandles({ symbol: row.symbol, from, to, exchange });
      backfilled++;
    } catch (error) {
      failedSymbols.push(row.symbol);
      logger.warn(
        {
          exchange,
          symbol: row.symbol,
          message: error instanceof Error ? error.message : "Backfill failed",
        },
        "Index candle backfill failed for symbol"
      );
    }
  }

  return { indexCount: indexInstruments.length, backfilled, failedSymbols };
}

// Global (not collection-scoped) ranking of one index exchange's indices
// against each other — reuses computeRelativeStrengthMetrics unchanged,
// since ranking an index pool by the same combined score is exactly the
// same computation shape as ranking a stock pool; each index is just its
// own single row here, no grouping/averaging needed (unlike
// computeGroupRelativeStrength). Defaults to NSE_IDX to preserve existing
// callers; pass BSE_IDX for the BSE index box.
export async function getIndexRelativeStrength(
  limit: number,
  exchange: string = NSE_INDEX_EXCHANGE
) {
  const indexInstruments = await db
    .select({
      symbol: instruments.symbol,
      name: instruments.name,
      exchange: instruments.exchange,
    })
    .from(instruments)
    .where(and(eq(instruments.exchange, exchange), eq(instruments.active, true)));

  return computeRelativeStrengthMetrics(indexInstruments, exchange, limit);
}

const SUPPORTED_EXCHANGES_CACHE_TTL_MS = 24 * 60 * 60_000;
const NSE_PROVIDER_EXCHANGE: ProviderExchange = {
  code: "NSE",
  name: "India (NSE)",
  currency: "INR",
  country: "India",
};
const GLOBAL_DATAFEEDS_PROVIDER_EXCHANGES: ProviderExchange[] = [
  {
    code: "BSE",
    name: "India (BSE)",
    currency: "INR",
    country: "India",
  },
  {
    code: "BSE_IDX",
    name: "India (BSE Indices)",
    currency: "INR",
    country: "India",
  },
];

// EODHD's exchange list is the source of truth for everything except NSE
// (Zerodha-only, not covered by EODHD at all — confirmed live). Cached for
// 24h since this essentially never changes.
export async function listSupportedExchanges(): Promise<ProviderExchange[]> {
  return getOrSetCache("supportedExchanges", SUPPORTED_EXCHANGES_CACHE_TTL_MS, async () => {
    const eodhdAdapter = getEodhdDataProviderAdapter();
    let eodhdExchanges: ProviderExchange[] = [];

    try {
      eodhdExchanges = (await eodhdAdapter.fetchExchanges?.()) ?? [];
    } catch (error) {
      logger.warn(
        { message: error instanceof Error ? error.message : "Unknown provider error" },
        "Unable to fetch EODHD exchanges list"
      );
    }

    const fixedExchanges = [NSE_PROVIDER_EXCHANGE, ...GLOBAL_DATAFEEDS_PROVIDER_EXCHANGES];
    const fixedCodes = new Set(fixedExchanges.map((exchange) => exchange.code));

    return [
      ...fixedExchanges,
      ...eodhdExchanges.filter((exchange) => !fixedCodes.has(exchange.code)),
    ];
  });
}

const FOREX_EXCHANGE = "FOREX";
const EXCHANGE_RATES_CACHE_TTL_MS = 15 * 60_000;

async function getLatestForexClose(pairSymbol: string): Promise<number | null> {
  const [row] = await db
    .select({ close: instruments.latestClose })
    .from(instruments)
    .where(and(eq(instruments.exchange, FOREX_EXCHANGE), eq(instruments.symbol, pairSymbol)))
    .limit(1);

  if (!row || row.close === null) return null;
  return Number(row.close);
}

// FOREX pairs are just regular instruments on the "FOREX" exchange (same
// pipeline as every other exchange) — no dedicated rates table. A pair with
// no candles yet gets a background sync kicked off and a neutral 1:1 rate
// for this request; the next call picks up the real rate once it lands.
async function ensureForexPairSyncing(pairSymbol: string) {
  void safeProviderAction("market-data.forex-pair-sync", () =>
    backfillDailyCandles({
      symbol: pairSymbol,
      exchange: FOREX_EXCHANGE,
      from: getDateDaysAgo(14),
      to: getTodayDate(),
    })
  );
}

export async function getUsdRate(currency: string): Promise<number> {
  const normalizedCurrency = currency.trim().toUpperCase();
  if (!normalizedCurrency || normalizedCurrency === "USD") return 1;

  const directPair = `${normalizedCurrency}USD`;
  const directClose = await getLatestForexClose(directPair);
  if (directClose !== null) return directClose;

  const inversePair = `USD${normalizedCurrency}`;
  const inverseClose = await getLatestForexClose(inversePair);
  if (inverseClose !== null && inverseClose > 0) return 1 / inverseClose;

  await ensureForexPairSyncing(directPair);
  return 1;
}

export async function convertAmount(
  amount: number,
  fromCurrency: string,
  toCurrency: string
): Promise<number> {
  const from = fromCurrency.trim().toUpperCase();
  const to = toCurrency.trim().toUpperCase();
  if (!from || !to || from === to) return amount;

  const [fromRate, toRate] = await Promise.all([getUsdRate(from), getUsdRate(to)]);
  if (toRate === 0) return amount;

  return (amount * fromRate) / toRate;
}

export async function listExchangeRates(): Promise<{ rates: Record<string, number>; base: "USD" }> {
  return getOrSetCache("exchangeRates", EXCHANGE_RATES_CACHE_TTL_MS, async () => {
    const exchanges = await listSupportedExchanges();
    const currencies = [
      ...new Set(exchanges.map((exchange) => exchange.currency.trim().toUpperCase()).filter(Boolean)),
    ];
    const rates: Record<string, number> = { USD: 1 };

    await Promise.all(
      currencies
        .filter((currency) => currency !== "USD")
        .map(async (currency) => {
          rates[currency] = await getUsdRate(currency);
        })
    );

    return { rates, base: "USD" as const };
  });
}

async function deleteCandlesForRefresh(
  input: {
    symbol: string;
    from: string;
    to: string;
    exchange: string;
  },
  dbClient: DbOrTx = db
) {
  await dbClient
    .delete(candles)
    .where(
      and(
        eq(candles.exchange, input.exchange),
        eq(candles.symbol, input.symbol),
        inArray(candles.timeframe, [
          CANDLE_TIMEFRAME.day,
          CANDLE_TIMEFRAME.week,
          CANDLE_TIMEFRAME.month,
        ]),
        gte(candles.time, input.from),
        lte(candles.time, input.to)
      )
    );
}

async function syncLatestDailyCandlesForSymbols(
  symbols: string[],
  exchange: string = DEFAULT_EXCHANGE
) {
  const uniqueSymbols = [...new Set(symbols.map(normalizeSymbol))].filter(Boolean);
  const symbolsToSync = uniqueSymbols.filter(shouldRetryLatestCandleSync);
  if (symbolsToSync.length === 0) return { insertedDaily: 0 };

  const adapter = getDataProviderAdapterForExchange(exchange);
  if (!adapter.fetchLatestDailyCandles) return { insertedDaily: 0 };

  await ensureInstrumentsForSymbols(symbolsToSync, exchange);
  const instrumentsBySymbol = await getInstrumentsBySymbol(symbolsToSync, exchange);
  const accessToken = await getActiveProviderAccessToken(adapter.providerKey);
  const latestCandles =
    adapter.providerKey === DATA_PROVIDER_KEY.zerodha
      ? await fetchLatestDailyCandlesFromStoredInstruments({
          accessToken,
          exchange,
          symbols: symbolsToSync,
          instrumentsBySymbol,
        })
      : await adapter.fetchLatestDailyCandles({
          accessToken,
          symbols: symbolsToSync,
          exchangeCode: exchange,
        });

  const candlesToUpsert: CandleUpsertInput[] = [];
  for (const candle of latestCandles) {
    const symbol = normalizeSymbol(candle.symbol);
    const instrument =
      instrumentsBySymbol.get(symbol) ?? (await getOrCreateInstrument(symbol, exchange));
    if (!instrument) continue;

    candlesToUpsert.push({
      instrumentId: instrument.id,
      exchange,
      symbol,
      timeframe: CANDLE_TIMEFRAME.day,
      source: CANDLE_SOURCE.provider,
      time: candle.time,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
    });
  }

  await upsertCandles(candlesToUpsert);

  const syncedSymbols = new Set(latestCandles.map((candle) => normalizeSymbol(candle.symbol)));
  await refreshLatestInstrumentStats(exchange, [...syncedSymbols]);
  for (const symbol of symbolsToSync) {
    if (!syncedSymbols.has(symbol)) markLatestCandleSyncFailed(symbol);
  }

  return { insertedDaily: candlesToUpsert.length };
}

async function fetchLatestDailyCandlesFromStoredInstruments(input: {
  accessToken?: string;
  exchange: string;
  symbols: string[];
  instrumentsBySymbol: Map<string, typeof instruments.$inferSelect>;
}) {
  const adapter = getDataProviderAdapterForExchange(input.exchange);
  const from = getDateDaysAgo(14);
  const to = getTodayDate();
  const latestCandles: ProviderSymbolDailyCandle[] = [];

  await runWithConcurrency(input.symbols, 8, async (symbol) => {
    const instrument = input.instrumentsBySymbol.get(symbol);
    if (!instrument?.instrumentToken) return;

    try {
      const dailyCandles = await adapter.fetchDailyCandles({
        accessToken: input.accessToken,
        instrumentToken: instrument.instrumentToken,
        symbol,
        from,
        to,
        exchangeCode: input.exchange,
      });
      const latest = dailyCandles[dailyCandles.length - 1];
      if (latest) latestCandles.push({ ...latest, symbol });
    } catch (error) {
      logger.debug(
        {
          exchange: input.exchange,
          symbol,
          message: error instanceof Error ? error.message : "Unknown provider error",
        },
        "Latest candle sync skipped symbol"
      );
    }
  });

  return latestCandles;
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  run: (item: T) => Promise<void>
) {
  let index = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (index < items.length) {
        const item = items[index];
        index += 1;
        if (item !== undefined) await run(item);
      }
    })
  );
}

const FULL_PRICE_REFRESH_CHUNK_SIZE = 200;

// Unlike listStocks' lazy per-page hydration (which only ever touches
// symbols someone happened to request), this walks every active instrument
// for the exchange so gainers/decliners filtering and displayed prices stay
// complete table-wide, not just for pages a user has actually visited.
export async function refreshAllLatestInstrumentPrices(exchange: string = DEFAULT_EXCHANGE) {
  const rows = await db
    .select({ symbol: instruments.symbol })
    .from(instruments)
    .where(and(eq(instruments.exchange, exchange), eq(instruments.active, true)));

  const symbols = rows.map((row) => row.symbol);
  let refreshed = 0;

  for (let index = 0; index < symbols.length; index += FULL_PRICE_REFRESH_CHUNK_SIZE) {
    const chunk = symbols.slice(index, index + FULL_PRICE_REFRESH_CHUNK_SIZE);
    const result = await safeProviderAction("market-data.full-price-refresh", () =>
      syncLatestDailyCandlesForSymbols(chunk, exchange)
    );
    refreshed += result?.insertedDaily ?? 0;
  }

  return { symbolCount: symbols.length, refreshed };
}

function shouldRetryLatestCandleSync(symbol: string) {
  const lastFailedAt = failedLatestCandleSyncAtBySymbol.get(normalizeSymbol(symbol));
  return (
    lastFailedAt === undefined ||
    Date.now() - lastFailedAt > FAILED_LATEST_CANDLE_SYNC_COOLDOWN_MS
  );
}

function markLatestCandleSyncFailed(symbol: string) {
  failedLatestCandleSyncAtBySymbol.set(normalizeSymbol(symbol), Date.now());
}

async function ensureInstrumentsForSymbols(
  symbols: string[],
  exchange: string = DEFAULT_EXCHANGE
) {
  const existing = await getInstrumentsBySymbol(symbols, exchange);
  const missingSymbols = symbols.filter((symbol) => !existing.has(symbol));

  if (missingSymbols.length === 0) return;

  for (const symbol of missingSymbols) {
    await syncProviderInstrumentSearch(symbol, exchange);
  }

  const synced = await getInstrumentsBySymbol(missingSymbols, exchange);
  const stillMissingSymbols = missingSymbols.filter((symbol) => !synced.has(symbol));
  if (!canCreateFallbackInstrument(exchange)) return;

  for (const symbol of stillMissingSymbols) {
    await createFallbackInstrument(symbol, exchange);
  }
}

async function syncProviderInstrumentSearch(
  query: string,
  exchange: string = DEFAULT_EXCHANGE
) {
  const adapter = getDataProviderAdapterForExchange(exchange);
  const searchQuery = normalizeSymbol(query);

  if (!adapter.searchInstruments) {
    await syncProviderInstruments(exchange);
    return { count: 0 };
  }

  const providerInstruments = await adapter.searchInstruments(searchQuery, exchange);

  if (providerInstruments.length === 0) {
    if (!canCreateFallbackInstrument(exchange)) return { count: 0 };
    await createFallbackInstrument(searchQuery, exchange);
    return { count: 1 };
  }

  await upsertInstruments(providerInstruments, adapter.providerKey);

  return { count: providerInstruments.length };
}

async function hydrateDefaultFallbackInstruments(exchange: string = DEFAULT_EXCHANGE) {
  if (!canCreateFallbackInstrument(exchange)) return { count: 0 };

  // Only a curated list for this exact exchange is safe to seed — falling
  // back to DEFAULT_EXCHANGE's list here would silently seed US tickers
  // (AAPL, MSFT, ...) onto an unrelated exchange. The primary path (a full
  // syncProviderInstruments pull) already handles real seeding for any
  // exchange without needing a curated list at all; this fallback only
  // exists for the handful of exchanges with a hand-picked list.
  const defaultSymbols = DEFAULT_MARKET_SYMBOLS_BY_EXCHANGE[exchange];
  if (!defaultSymbols) return { count: 0 };

  let count = 0;

  for (const symbol of defaultSymbols) {
    try {
      const result = await syncProviderInstrumentSearch(symbol, exchange);
      count += result.count;
    } catch {
      await createFallbackInstrument(symbol, exchange);
      count++;
    }
  }

  return { count };
}

function canCreateFallbackInstrument(exchange: string) {
  return Boolean(getDataProviderAdapterForExchange(exchange).getInstrumentToken);
}

async function hydrateDefaultMarketInstruments(exchange: string = DEFAULT_EXCHANGE) {
  try {
    const result = await syncProviderInstruments(exchange);
    if (result.count > 0) return result;
  } catch {
    return hydrateDefaultFallbackInstruments(exchange);
  }

  return hydrateDefaultFallbackInstruments(exchange);
}

async function safeProviderAction<T>(
  action: string,
  run: () => Promise<T>
): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    const safeMessage = getSafeProviderErrorMessage(error);
    logger.warn(
      {
        action,
        message: safeMessage,
        details: error instanceof AppError ? error.details : undefined,
      },
      "Market data provider action failed"
    );

    // A 401/403 from the provider means the stored token itself was
    // rejected (expired/revoked), not just this one request failing — the
    // connection's "connected" status would otherwise stay stale forever,
    // since nothing else ever re-checks it after the initial OAuth login.
    const details = error instanceof AppError ? (error.details as
      | { provider?: string; status?: number; message?: string }
      | undefined) : undefined;
    if (details?.provider && (details.status === 401 || details.status === 403)) {
      void markProviderConnectionExpired(details.provider, details.message).catch(() => {});
    }

    return null;
  }
}

function getSafeProviderErrorMessage(error: unknown) {
  if (!(error instanceof Error)) return "Unknown provider error";

  const cause = (error as { cause?: unknown }).cause;
  if (typeof cause === "object" && cause !== null) {
    const databaseCause = cause as {
      code?: unknown;
      detail?: unknown;
      hint?: unknown;
      message?: unknown;
    };
    const parts = [
      typeof databaseCause.message === "string" ? databaseCause.message : null,
      typeof databaseCause.code === "string" ? `code=${databaseCause.code}` : null,
      typeof databaseCause.detail === "string" ? databaseCause.detail : null,
      typeof databaseCause.hint === "string" ? databaseCause.hint : null,
    ].filter(Boolean);

    if (parts.length > 0) return parts.join(" | ");
  }

  const message = error.message.trim();
  if (!message) return error.name || "Unknown provider error";

  const firstLine = message.split(/\r?\n/, 1)[0] ?? message;
  const sqlLikeMessage =
    message.includes("params:") ||
    message.includes("insert into") ||
    message.includes("on conflict") ||
    message.length > 500;

  if (!sqlLikeMessage) return message;

  return firstLine.length > 300 ? `${firstLine.slice(0, 300)}...` : firstLine;
}

async function getOrCreateInstrument(
  symbol: string,
  exchange: string = DEFAULT_EXCHANGE,
  dbClient: DbOrTx = db
) {
  const [instrument] = await dbClient
    .select()
    .from(instruments)
    .where(
      and(
        eq(instruments.exchange, exchange),
        eq(instruments.symbol, normalizeSymbol(symbol))
      )
    )
    .limit(1);

  if (instrument) return instrument;

  await ensureInstrumentsForSymbols([symbol], exchange);
  const [created] = await dbClient
    .select()
    .from(instruments)
    .where(
      and(
        eq(instruments.exchange, exchange),
        eq(instruments.symbol, normalizeSymbol(symbol))
      )
    )
    .limit(1);

  return created;
}

async function getInstrumentsBySymbol(symbols: string[], exchange: string = DEFAULT_EXCHANGE) {
  const uniqueSymbols = [...new Set(symbols.map(normalizeSymbol))].filter(Boolean);
  if (uniqueSymbols.length === 0) return new Map<string, typeof instruments.$inferSelect>();

  const rows = await db
    .select()
    .from(instruments)
    .where(
      and(
        eq(instruments.exchange, exchange),
        inArray(instruments.symbol, uniqueSymbols)
      )
    );

  return new Map(rows.map((row) => [row.symbol, row]));
}

async function createFallbackInstrument(symbol: string, exchange: string = DEFAULT_EXCHANGE) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const adapter = getDataProviderAdapterForExchange(exchange);
  const instrumentToken = adapter.getInstrumentToken
    ? await adapter.getInstrumentToken(normalizedSymbol, exchange)
    : normalizedSymbol;
  const [instrument] = await db
    .insert(instruments)
    .values({
      provider: adapter.providerKey,
      exchange,
      symbol: normalizedSymbol,
      name: normalizedSymbol,
      instrumentToken,
      active: true,
    })
    .onConflictDoUpdate({
      target: [instruments.exchange, instruments.symbol],
      set: {
        provider: adapter.providerKey,
        active: true,
        updatedAt: new Date(),
      },
    })
    .returning();

  return instrument;
}

async function upsertInstrument(instrument: {
  exchange: string;
  symbol: string;
  name: string;
  instrumentToken: string;
  segment?: string;
}) {
  const adapter = getDataProviderAdapterForExchange(instrument.exchange);
  await upsertInstruments([instrument], adapter.providerKey);
}

export type InstrumentUpsertInput = {
  exchange: string;
  symbol: string;
  name: string;
  instrumentToken: string;
  segment?: string;
};

// `instruments` enforces two unique constraints — (exchange, symbol) and
// (provider, instrument_token) — but onConflictDoUpdate below can only
// target one of them. A batch containing two rows that collide on *either*
// key fails the whole INSERT with "ON CONFLICT DO UPDATE command cannot
// affect row a second time" (exchange+symbol) or a duplicate-key violation
// (instrument_token), even though only one row actually collides. This
// applies both dedup passes before the insert ever runs.
//
// Conflict resolution is deterministic: the later row in `inputs` wins,
// matching dedupeCandleUpsertInputs' existing "last write wins" rule.
// Symbol-level duplicates are resolved first (using the exchange+symbol
// identity the ON CONFLICT target relies on), then token-level duplicates
// are resolved among those survivors — so a genuine vendor anomaly (two
// different symbols claiming the same instrument token) drops the earlier
// symbol's row from *this* sync rather than failing the batch; it picks up
// on the next successful sync once the vendor data is consistent again.
export function dedupeInstrumentUpsertInputs(inputs: InstrumentUpsertInput[]) {
  const bySymbolKey = new Map<string, InstrumentUpsertInput>();
  for (const row of inputs) {
    bySymbolKey.set(`${row.exchange}:${normalizeSymbol(row.symbol)}`, row);
  }

  const byToken = new Map<string, InstrumentUpsertInput>();
  for (const row of bySymbolKey.values()) {
    byToken.set(row.instrumentToken, row);
  }

  const deduped = [...byToken.values()];
  const droppedCount = inputs.length - deduped.length;
  if (droppedCount > 0) {
    logger.warn(
      { inputCount: inputs.length, dedupedCount: deduped.length, droppedCount },
      "Dropped duplicate instrument rows within a single sync batch"
    );
  }

  return deduped;
}

// dedupeInstrumentUpsertInputs above only catches collisions within *this*
// batch. A row can still collide with a *different* (exchange, symbol) row
// already sitting in the DB from an earlier sync — e.g. a provider reusing
// an instrument_token across two segments — which the ON CONFLICT target
// (exchange, symbol) doesn't cover, since it never matches an existing row
// for a brand-new symbol and falls through to a plain INSERT that then
// fails the separate (provider, instrument_token) unique constraint. Drop
// those here rather than letting a handful of vendor-anomaly rows abort an
// entire sync batch.
async function dropCrossBatchTokenCollisions(
  inputs: InstrumentUpsertInput[],
  provider: string,
  dbClient: DbOrTx
) {
  if (inputs.length === 0) return inputs;

  const tokens = inputs.map((row) => row.instrumentToken);
  const existingRows = await dbClient
    .select({
      exchange: instruments.exchange,
      symbol: instruments.symbol,
      instrumentToken: instruments.instrumentToken,
    })
    .from(instruments)
    .where(and(eq(instruments.provider, provider), inArray(instruments.instrumentToken, tokens)));

  const existingByToken = new Map(existingRows.map((row) => [row.instrumentToken, row]));
  const kept: InstrumentUpsertInput[] = [];
  let droppedCount = 0;

  for (const row of inputs) {
    const existing = existingByToken.get(row.instrumentToken);
    const isSameIdentity =
      existing && existing.exchange === row.exchange && existing.symbol === normalizeSymbol(row.symbol);
    if (existing && !isSameIdentity) {
      droppedCount++;
      continue;
    }
    kept.push(row);
  }

  if (droppedCount > 0) {
    logger.warn(
      { provider, droppedCount },
      "Dropped instrument rows whose token already belongs to a different symbol in the DB"
    );
  }

  return kept;
}

async function upsertInstruments(
  input: InstrumentUpsertInput[],
  provider: string,
  dbClient: DbOrTx = db
) {
  const dedupedInput = await dropCrossBatchTokenCollisions(
    dedupeInstrumentUpsertInputs(input),
    provider,
    dbClient
  );

  for (let index = 0; index < dedupedInput.length; index += INSTRUMENT_UPSERT_CHUNK_SIZE) {
    const chunk = dedupedInput.slice(index, index + INSTRUMENT_UPSERT_CHUNK_SIZE);
    if (chunk.length === 0) continue;

    await dbClient
      .insert(instruments)
      .values(
        chunk.map((instrument) => ({
          provider,
          exchange: instrument.exchange,
          symbol: normalizeSymbol(instrument.symbol),
          name: instrument.name,
          instrumentToken: instrument.instrumentToken,
          segment: instrument.segment,
          active: true,
        }))
      )
      .onConflictDoUpdate({
        target: [instruments.exchange, instruments.symbol],
        set: {
          provider,
          name: sql`excluded.name`,
          instrumentToken: sql`excluded.instrument_token`,
          segment: sql`excluded.segment`,
          active: true,
          updatedAt: new Date(),
        },
      });
  }
}

function getTodayDate() {
  return new Date().toISOString().slice(0, 10);
}

function getDefaultChartHistoryFromDate() {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - CHART_HISTORY_YEARS);
  return date.toISOString().slice(0, 10);
}

function getDateDaysAgo(days: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function getDateYearsAgo(years: number) {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - years);
  return date.toISOString().slice(0, 10);
}

type LatestStockStatsRow = {
  symbol: string;
  open: string;
  close: string;
  volume: string;
  time: string;
};

// Old query (kept here only as the EXPLAIN comparison baseline — no longer
// called): `SELECT ... FROM candles WHERE exchange=? AND timeframe='1D' AND
// symbol IN (...) ORDER BY symbol, time DESC` with no LIMIT — Postgres has
// no way to know only 2 rows per symbol are wanted, so it returns every
// matching daily candle ever stored for every requested symbol.
//   EXPLAIN (ANALYZE, BUFFERS)
//   SELECT symbol, open, close, volume, time FROM candles
//   WHERE exchange = 'NSE' AND timeframe = '1D' AND symbol = ANY(ARRAY['RELIANCE','TCS'])
//   ORDER BY symbol, time DESC;
//   -- healthy-looking plan, but "rows" here is every historical row per
//   -- symbol (thousands for a multi-year backfill), not the 2 actually used:
//   --   Index Scan using candles_exchange_symbol_timeframe_time_unique on candles
//   --     Index Cond: (exchange = 'NSE' AND symbol = ANY(...) AND timeframe = '1D')
//
// New query below asks Postgres for exactly the top-2-per-symbol instead,
// via a window function filtered in an outer query (row_number() can't be
// filtered directly in WHERE):
//   EXPLAIN (ANALYZE, BUFFERS)
//   SELECT symbol, open, close, volume, time FROM (
//     SELECT symbol, open, close, volume, time,
//            row_number() OVER (PARTITION BY symbol ORDER BY time DESC) AS rn
//     FROM candles
//     WHERE exchange = 'NSE' AND timeframe = '1D' AND symbol = ANY(ARRAY['RELIANCE','TCS'])
//   ) ranked WHERE rn <= 2 ORDER BY symbol, time DESC;
//   -- same Index Scan for the inner scan, but WindowAgg + an rn<=2 filter
//   -- caps actual rows returned to the client at 2 per symbol instead of
//   -- the symbol's entire stored history.
// (Both plans reference the existing composite unique index — this is a
// query-shape fix, not an indexing fix. EXPLAIN not run live: no reachable
// Postgres instance in this environment: see docs/DATABASE.md.)
async function getLatestStockStats(
  symbols: string[],
  exchange: string = DEFAULT_EXCHANGE,
  dbClient: DbOrTx = db
) {
  const uniqueSymbols = [...new Set(symbols.map(normalizeSymbol))].filter(Boolean);
  const stats = new Map<
    string,
    { close: number; open: number; volume: number; changePct: number | null; time: string }
  >();

  if (uniqueSymbols.length === 0) return stats;

  const startedAt = Date.now();
  const result = await dbClient.execute<LatestStockStatsRow>(sql`
    SELECT symbol, open, close, volume, time::text AS time FROM (
      SELECT
        symbol, open, close, volume, time,
        row_number() OVER (PARTITION BY symbol ORDER BY time DESC) AS rn
      FROM candles
      WHERE exchange = ${exchange}
        AND timeframe = ${CANDLE_TIMEFRAME.day}
        AND symbol = ANY(ARRAY[${sql.join(uniqueSymbols.map((symbol) => sql`${symbol}`), sql`, `)}]::text[])
    ) ranked
    WHERE rn <= 2
    ORDER BY symbol, time DESC
  `);
  logger.debug(
    {
      exchange,
      symbolCount: uniqueSymbols.length,
      rowCount: result.rows.length,
      durationMs: Date.now() - startedAt,
    },
    "getLatestStockStats query"
  );

  const recentRowsBySymbol = new Map<string, LatestStockStatsRow[]>();
  for (const row of result.rows) {
    const currentRows = recentRowsBySymbol.get(row.symbol) ?? [];
    currentRows.push(row);
    recentRowsBySymbol.set(row.symbol, currentRows);
  }

  for (const [symbol, recentRows] of recentRowsBySymbol.entries()) {
    const latest = recentRows[0];
    const previous = recentRows[1];
    if (!latest) continue;

    const close = Number(latest.close);
    const previousClose = previous ? Number(previous.close) : null;
    const changePct =
      previousClose && previousClose !== 0
        ? ((close - previousClose) / previousClose) * 100
        : null;

    stats.set(symbol, {
      close,
      open: Number(latest.open),
      volume: Number(latest.volume),
      changePct,
      time: latest.time,
    });
  }

  return stats;
}

// Persists the per-request stats computed above onto `instruments` so the
// stocks list can filter/sort/read prices directly off the instruments
// table (fast, works across the whole table) instead of recomputing a
// 2-row candles lookback per symbol on every read.
async function refreshLatestInstrumentStats(
  exchange: string,
  symbols: string[],
  dbClient: DbOrTx = db
) {
  const uniqueSymbols = [...new Set(symbols.map(normalizeSymbol))].filter(Boolean);
  if (uniqueSymbols.length === 0) return;

  const stats = await getLatestStockStats(uniqueSymbols, exchange, dbClient);

  for (const [symbol, stat] of stats.entries()) {
    await dbClient
      .update(instruments)
      .set({
        latestClose: String(stat.close),
        latestOpen: String(stat.open),
        latestVolume: String(stat.volume),
        latestChangePct: stat.changePct === null ? null : String(stat.changePct),
        latestPriceAt: stat.time,
        updatedAt: new Date(),
      })
      .where(and(eq(instruments.exchange, exchange), eq(instruments.symbol, symbol)));
  }
}

type CandleUpsertInput = {
  instrumentId: string;
  exchange: string;
  symbol: string;
  timeframe: CandleTimeframe;
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  source: string;
};

async function upsertCandles(inputs: CandleUpsertInput[], dbClient: DbOrTx = db) {
  const dedupedInputs = dedupeCandleUpsertInputs(inputs);
  if (dedupedInputs.length === 0) return;

  const startedAt = Date.now();
  let insertedCount = 0;
  let updatedCount = 0;

  for (let index = 0; index < dedupedInputs.length; index += CANDLE_UPSERT_CHUNK_SIZE) {
    const chunk = dedupedInputs.slice(index, index + CANDLE_UPSERT_CHUNK_SIZE);
    if (chunk.length === 0) continue;

    // `xmax = 0` is a well-known Postgres idiom for distinguishing an
    // INSERT from an UPDATE inside a single ON CONFLICT statement: a freshly
    // inserted row has no prior transaction ID recorded in xmax, an updated
    // row does. Used only to report accurate insert/update counts below —
    // never part of application logic.
    const results = await dbClient
      .insert(candles)
      .values(
        chunk.map((input) => ({
          instrumentId: input.instrumentId,
          exchange: input.exchange,
          symbol: input.symbol,
          timeframe: input.timeframe,
          time: input.time,
          open: String(input.open),
          high: String(input.high),
          low: String(input.low),
          close: String(input.close),
          volume: String(input.volume),
          source: input.source,
        }))
      )
      .onConflictDoUpdate({
        target: [candles.exchange, candles.symbol, candles.timeframe, candles.time],
        set: {
          open: sql`excluded.open`,
          high: sql`excluded.high`,
          low: sql`excluded.low`,
          close: sql`excluded.close`,
          volume: sql`excluded.volume`,
          source: sql`excluded.source`,
          updatedAt: new Date(),
        },
      })
      .returning({ wasInsert: sql<boolean>`(xmax = 0)` });

    for (const row of results) {
      if (row.wasInsert) insertedCount++;
      else updatedCount++;
    }
  }

  logger.debug(
    {
      inputCount: inputs.length,
      dedupedCount: dedupedInputs.length,
      insertedCount,
      updatedCount,
      durationMs: Date.now() - startedAt,
    },
    "upsertCandles complete"
  );
}

function dedupeCandleUpsertInputs(inputs: CandleUpsertInput[]) {
  const candlesByKey = new Map<string, CandleUpsertInput>();

  for (const input of inputs) {
    candlesByKey.set(
      `${input.exchange}:${input.symbol}:${input.timeframe}:${input.time}`,
      input
    );
  }

  const deduped = Array.from(candlesByKey.values());
  const droppedCount = inputs.length - deduped.length;
  if (droppedCount > 0) {
    logger.warn(
      { inputCount: inputs.length, dedupedCount: deduped.length, droppedCount },
      "Dropped duplicate candle rows within a single upsert batch"
    );
  }

  return deduped;
}
