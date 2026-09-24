import { and, asc, count, desc, eq, gt, gte, ilike, inArray, lt, lte, not, or, sql } from "drizzle-orm";

import { db } from "../../db/client";
import { candles, instruments } from "../../db/schema";
import { SUPPORTED_EXCHANGES_CACHE_TTL_MS } from "./market-data.constants";
import { getOrSetCache } from "../../shared/cache";
import { logger } from "../../shared/logger";
import { getErrorMessage } from "../../shared/errors";
import {
  CANDLE_SOURCE,
  CANDLE_TIMEFRAME,
  DATA_PROVIDER_KEY,
  DEFAULT_EXCHANGE,
  type CandleTimeframe,
} from "../../shared/constants";
import { normalizeSymbol } from "../../shared/normalize";
import { getEodhdDataProviderAdapter } from "../data-provider/data-provider.service";
import { isProviderEnabled } from "../data-provider/data-provider-settings.service";
import { RETIRED_EXCHANGE_CODES } from "../data-provider/data-provider.registry";
import { activeUniverseFilter } from "./market-data.universe";
import { GLOBAL_DATAFEEDS_INDEX_EXCHANGE } from "../data-provider/adapters/global-datafeeds/global-datafeeds.constants";
import type { ProviderDailyCandle, ProviderExchange } from "../data-provider/data-provider.types";
import { aggregateMonthlyCandles, aggregateWeeklyCandles } from "./candle-aggregation";
import { getWeekEndingFriday, isCompletedTradingWeek } from "./trading-calendar";
import {
  readCandleHistoryRange,
  readChartCandles,
  replaceCandlesAtomically,
  upsertCandles,
  type MetricCandle,
} from "./market-data.candles";
import {
  applyLatestInstrumentStats,
  dedupeInstrumentUpsertInputs,
  getInstrumentsBySymbol,
  hasActiveInstruments,
  type InstrumentUpsertInput,
  type LatestInstrumentStat,
} from "./market-data.instruments";
import { syncProviderInstruments } from "./market-data.instrument-sync";
import {
  backfillDailyCandles,
  backfillIndexCandles,
  refreshAllLatestInstrumentPrices,
  refreshDailyCandles,
  syncDailyCandlesForActiveInstruments,
} from "./market-data.candle-sync";
import { ensureFreshDailyCandles } from "./market-data.chart-ensure-fresh";
import {
  listStocks,
  NSE_NORMAL_EQUITY_SYMBOL_PATTERN,
  searchChartEligibleBseStocks,
} from "./market-data.stocks";
import {
  calculate55DayChange,
  CHANGE_55D_LOOKBACK_BARS,
  computeAllRelativeStrengthMetrics,
  computeGroupRelativeStrength,
  computeRelativeStrengthMetrics,
  computeWeeklyStrongBacktestMembers,
  computeWeeklyStrongStocks,
  deriveSectorIndustryTaxonomy,
  groupRelativeStrengthMetrics,
  pickTopRelativeStrengthRows,
  WEEKLY_STRONG_BACKTEST_DEFAULT_WEEKS,
  type GroupRelativeStrengthRow,
  type RelativeStrengthInstrumentInput,
  type RelativeStrengthMetricRow,
  type SectorIndustryTaxonomyRow,
  type WeeklyStrongBacktestMemberRow,
  type WeeklyStrongBacktestWeekMembers,
  type WeeklyStrongStockRow,
} from "./market-data.metrics";
import {
  deleteDashboardSnapshots,
  readDashboardSnapshotWithMeta,
  RELATIVE_STRENGTH_SNAPSHOT_VERSION,
  writeDashboardSnapshot,
} from "./dashboard-snapshot-store";
import type { MoveFilter } from "./market-data.schemas";

// Implementations now live in market-data.stocks.ts; re-exported here so existing imports (e.g. market-collections.service.ts, ai.service.ts, market-data.routes.ts) keep working.
export { NSE_NORMAL_EQUITY_SYMBOL_PATTERN };

export type { MetricCandle };

// Implementation lives in market-data.stocks.ts; re-exported here so existing imports (ai.service.ts, market-data.routes.ts) keep working.
export { listStocks };

// Watchlist/Charts stock-selection picker (BSE-only, candle-eligible only); implementation lives in market-data.stocks.ts, re-exported here so existing imports keep working.
export { searchChartEligibleBseStocks };

// Relative Strength / Weekly Strong analytical data preparation and orchestration - implementations live in market-data.metrics.ts, re-exported here so existing imports keep working.
export {
  calculate55DayChange,
  CHANGE_55D_LOOKBACK_BARS,
  computeAllRelativeStrengthMetrics,
  computeGroupRelativeStrength,
  computeRelativeStrengthMetrics,
  computeWeeklyStrongBacktestMembers,
  computeWeeklyStrongStocks,
  deriveSectorIndustryTaxonomy,
  groupRelativeStrengthMetrics,
  pickTopRelativeStrengthRows,
  WEEKLY_STRONG_BACKTEST_DEFAULT_WEEKS,
  type GroupRelativeStrengthRow,
  type RelativeStrengthInstrumentInput,
  type RelativeStrengthMetricRow,
  type SectorIndustryTaxonomyRow,
  type WeeklyStrongBacktestMemberRow,
  type WeeklyStrongBacktestWeekMembers,
  type WeeklyStrongStockRow,
};

export async function getChartHistoryRange(input: {
  symbol: string;
  timeframe: CandleTimeframe;
  exchange?: string;
}) {
  const symbol = normalizeSymbol(input.symbol);
  const exchange = input.exchange ?? DEFAULT_EXCHANGE;
  const instrument = (await getInstrumentsBySymbol([symbol], exchange)).get(symbol);
  const range = instrument
    ? await readCandleHistoryRange({
        instrumentId: instrument.id,
        timeframe: CANDLE_TIMEFRAME.day,
      })
    : null;

  return {
    symbol,
    exchange,
    timeframe: CANDLE_TIMEFRAME.day,
    from: range?.from ?? null,
    to: range?.to ?? null,
  };
}

// DB-only read path (RULES.md #16): opening a chart never triggers a provider
// call. Candle freshness/gap repair is the daily sync job's job
// (syncDailyCandlesForActiveInstruments / refreshDailyCandles in
// market-data.candle-sync.ts), not this read.
export type ChartCandlesResult = {
  candles: ReturnType<typeof toChartCandleResponse>[];
  dataThrough: string | null;
  nextBefore?: string | null;
  hasMore?: boolean;
};

// dataThrough is always the latest ACTUAL underlying 1D trading-day candle
// date - never a weekly/monthly bucket label (see toChartCandleResponse's
// Friday relabeling for 1W). For 1D it's the last daily row itself; for
// 1W/1M it's still the last DAILY row, not the aggregated candle's own
// timestamp, since the weekly/monthly bucket can legitimately be labeled
// at a future-within-its-own-week date (the week-ending Friday) before
// that date's own trading day has actually completed.
export async function getChartCandles(input: {
  symbol: string;
  timeframe: CandleTimeframe;
  from?: string;
  to?: string;
  before?: string;
  limit?: number;
  exchange?: string;
  includeIncompleteWeekly?: boolean;
}): Promise<ChartCandlesResult> {
  const symbol = normalizeSymbol(input.symbol);
  const exchange = input.exchange ?? DEFAULT_EXCHANGE;

  const instrument = (await getInstrumentsBySymbol([symbol], exchange)).get(symbol);
  const sourceLimit = input.limit
    ? input.limit * (input.timeframe === CANDLE_TIMEFRAME.day ? 1 : input.timeframe === CANDLE_TIMEFRAME.week ? 6 : 23)
    : undefined;
  const dailyRows = instrument
    ? await readChartCandles({
        instrumentId: instrument.id,
        timeframe: CANDLE_TIMEFRAME.day,
        from: input.from,
        to: input.to,
        before: input.before,
        limit: sourceLimit,
      })
    : [];

  if (dailyRows.length > 0) {
    const candles = deriveChartCandlesFromDailyRows(dailyRows, input.timeframe).map((row) =>
      toChartCandleResponse(row, input.timeframe)
    );
    const visibleCandles = input.includeIncompleteWeekly
      ? candles
      : excludeIncompleteWeeklyCandle(candles, input.timeframe, exchange);
    const pageCandles = input.limit ? visibleCandles.slice(-input.limit) : visibleCandles;
    return {
      candles: pageCandles,
      dataThrough: dailyRows[dailyRows.length - 1].time,
      ...(input.limit
        ? {
            nextBefore:
              pageCandles.length > 0
                ? getCandlePageCursor(pageCandles[0].time, input.timeframe)
                : dailyRows[0].time,
            hasMore: dailyRows.length === sourceLimit,
          }
        : {}),
    };
  }

  if (input.timeframe !== CANDLE_TIMEFRAME.day && instrument) {
    const legacyRows = await readChartCandles({
      instrumentId: instrument.id,
      timeframe: input.timeframe,
      from: input.from,
      to: input.to,
    });
    if (legacyRows.length > 0) {
      const candles = legacyRows.map((row) => toChartCandleResponse(row, input.timeframe));
      return {
        candles: input.includeIncompleteWeekly
          ? candles
          : excludeIncompleteWeeklyCandle(candles, input.timeframe, exchange),
        dataThrough: null,
      };
    }
  }

  return { candles: [], dataThrough: null };
}

function getCandlePageCursor(time: string, timeframe: CandleTimeframe) {
  const date = new Date(`${time}T00:00:00.000Z`);
  if (timeframe === CANDLE_TIMEFRAME.week) {
    date.setUTCDate(date.getUTCDate() - 4);
    return date.toISOString().slice(0, 10);
  }
  if (timeframe === CANDLE_TIMEFRAME.month) {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-01`;
  }
  return time;
}

// Analytical callers remain completed-week-only by default. The chart
// route explicitly opts into the forming weekly candle for display; that
// candle is derived from stored daily rows and is never persisted as a
// completed weekly result. 1D and 1M are untouched.
function excludeIncompleteWeeklyCandle<T extends { time: string }>(
  candlesList: T[],
  timeframe: CandleTimeframe,
  exchange: string
): T[] {
  if (timeframe !== CANDLE_TIMEFRAME.week) return candlesList;
  return candlesList.filter((candle) => isCompletedTradingWeek(candle.time, exchange));
}

function deriveChartCandlesFromDailyRows(
  rows: Array<{
    time: string;
    open: string | number;
    high: string | number;
    low: string | number;
    close: string | number;
    volume: string | number;
  }>,
  timeframe: CandleTimeframe
) {
  const dailyRows = rows.map((row) => ({
    time: row.time,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
  }));

  return aggregateChartCandlesForTimeframe(dailyRows, timeframe);
}

// The 1W chart's user-facing timestamp is the canonical week-ending Friday
// (see trading-calendar.ts's getWeekEndingFriday), never the internal Monday
// bucket identity used for grouping/aggregation - applied uniformly to both
// getChartCandles paths (1D-derived and the legacy stored-1W fallback) so
// neither one can show a different day than the other. OHLC/volume values
// are untouched; only the label on an already-computed weekly bar changes.
// 1D timestamps stay actual trading dates; 1M semantics are untouched.
function toChartCandleResponse(
  row: {
    time: string;
    open: string | number;
    high: string | number;
    low: string | number;
    close: string | number;
    volume: string | number;
  },
  timeframe: CandleTimeframe
) {
  return {
    time: timeframe === CANDLE_TIMEFRAME.week ? getWeekEndingFriday(row.time) : row.time,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
  };
}

function aggregateChartCandlesForTimeframe(
  daily: ProviderDailyCandle[],
  timeframe: CandleTimeframe
) {
  if (timeframe === CANDLE_TIMEFRAME.day) return daily;
  if (timeframe === CANDLE_TIMEFRAME.week) return aggregateWeeklyCandles(daily);
  if (timeframe === CANDLE_TIMEFRAME.month) return aggregateMonthlyCandles(daily);

  return daily;
}

async function deriveStoredCandlesForTimeframe(input: {
  instrumentId: string;
  exchange: string;
  symbol: string;
  timeframe: CandleTimeframe;
  from: string;
  to: string;
}) {
  const dailyRows = await readChartCandles({
    instrumentId: input.instrumentId,
    timeframe: CANDLE_TIMEFRAME.day,
    from: input.from,
    to: input.to,
  });

  if (dailyRows.length === 0) return { inserted: 0 };
  const instrumentId = input.instrumentId;

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

// Implementation lives in market-data.instrument-sync.ts; re-exported here so existing imports (admin.service.ts, worker.ts) keep working.
export { syncProviderInstruments };

// The atomic core of a candle-range replacement: delete the existing range across all 3 timeframes then upsert fresh rows in one transaction, so any failure rolls back the delete too. Exported so it can be tested against a fake DbOrTx without faking the provider-fetch layer. Implementation lives in market-data.candles.ts; re-exported here so existing imports from this file keep working.
export { replaceCandlesAtomically };

// backfillDailyCandles/backfillIndexCandles implementations live in market-data.candle-sync.ts; re-exported here so existing imports (admin.service.ts) keep working.
export {
  backfillDailyCandles,
  backfillIndexCandles,
  ensureFreshDailyCandles,
  refreshDailyCandles,
  syncDailyCandlesForActiveInstruments,
};

// Global (not collection-scoped) ranking of one index exchange's indices against each other - reuses computeAllRelativeStrengthMetrics, each index as its own row. Defaults to BSE_IDX. Reads a persisted snapshot (scope "index_exchange", keyed by exchange code since indices aren't members of any market_collection) and derives the limited/sorted view from it; on a miss it computes once and persists.
export async function getIndexRelativeStrength(
  limit: number,
  exchange: string = GLOBAL_DATAFEEDS_INDEX_EXCHANGE
): Promise<{ metrics: RelativeStrengthMetricRow[]; asOfDate: string }> {
  const cached = await readDashboardSnapshotWithMeta<RelativeStrengthMetricRow[]>(
    "index_exchange",
    exchange,
    "relative_strength"
  );
  if (cached && cached.evaluatorVersion === RELATIVE_STRENGTH_SNAPSHOT_VERSION) {
    return { metrics: pickTopRelativeStrengthRows(cached.payload, limit), asOfDate: cached.asOfDate };
  }

  const indexInstruments = await db
    .select({
      instrumentId: instruments.id,
      symbol: instruments.symbol,
      name: instruments.name,
      exchange: instruments.exchange,
    })
    .from(instruments)
    .where(activeUniverseFilter(exchange));

  const allMetrics = await computeAllRelativeStrengthMetrics(indexInstruments, exchange);
  const { asOfDate } = await writeDashboardSnapshot({
    scopeType: "index_exchange",
    scopeKey: exchange,
    metricType: "relative_strength",
    exchange,
    evaluatorVersion: RELATIVE_STRENGTH_SNAPSHOT_VERSION,
    payload: allMetrics,
  });
  return { metrics: pickTopRelativeStrengthRows(allMetrics, limit), asOfDate };
}

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

// NSE was Zerodha-only; that integration is retired, so NSE (and its index
// exchange) is never advertised - not even if EODHD's own exchange list
// happens to include it (see RETIRED_EXCHANGE_CODES).
// GlobalDataFeeds owns BSE/BSE_IDX; EODHD's exchange list is the source of truth for everything else. Cached 24h since exchange metadata rarely changes; data-provider-settings.service.ts invalidates this cache prefix on every admin toggle, so disable/enable still takes effect immediately.
export async function listSupportedExchanges(): Promise<ProviderExchange[]> {
  return getOrSetCache("supportedExchanges", SUPPORTED_EXCHANGES_CACHE_TTL_MS, async () => {
    const eodhdAdapter = getEodhdDataProviderAdapter();
    const [globalDatafeedsEnabled, eodhdEnabled] = await Promise.all([
      isProviderEnabled(DATA_PROVIDER_KEY.globalDatafeeds),
      isProviderEnabled(eodhdAdapter.providerKey),
    ]);

    // An exchange is only genuinely usable - and only then advertised -
    // when it's enabled AND has at least one real active instrument.
    // Enabled-but-empty must never be offered: a caller who then searches
    // that exchange would get nothing back.
    const bseAvailable = globalDatafeedsEnabled
      ? await hasActiveInstruments("BSE", DATA_PROVIDER_KEY.globalDatafeeds)
      : false;

    let eodhdExchanges: ProviderExchange[] = [];
    if (eodhdEnabled) {
      try {
        eodhdExchanges = (await eodhdAdapter.fetchExchanges?.()) ?? [];
      } catch (error) {
        logger.warn(
          { message: getErrorMessage(error, "Unknown provider error") },
          "Unable to fetch EODHD exchanges list"
        );
      }
    }

    const fixedExchanges = globalDatafeedsEnabled
      ? GLOBAL_DATAFEEDS_PROVIDER_EXCHANGES.filter((exchange) => exchange.code !== "BSE" || bseAvailable)
      : [];
    const fixedCodes = new Set(fixedExchanges.map((exchange) => exchange.code));

    return [
      ...fixedExchanges,
      ...eodhdExchanges.filter(
        (exchange) => !fixedCodes.has(exchange.code) && !RETIRED_EXCHANGE_CODES.has(exchange.code)
      ),
    ];
  });
}

// Implementations live in market-data.candle-sync.ts; re-exported here so existing imports (admin.service.ts, worker.ts) keep working.
export { refreshAllLatestInstrumentPrices };

// Implementations live in market-data.instruments.ts; re-exported here so existing imports from this file (including test files) keep working.
export {
  applyLatestInstrumentStats,
  dedupeInstrumentUpsertInputs,
  type InstrumentUpsertInput,
  type LatestInstrumentStat,
};

