import { and, asc, count, desc, eq, gt, gte, ilike, inArray, lt, lte, not, or, sql } from "drizzle-orm";

import { db } from "../../db/client";
import { candles, instruments } from "../../db/schema";
import { getDefaultChartHistoryFromDate, getTodayDate } from "./market-data.dates";
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
import {
  getActiveProviderAccessToken,
  getEligibleProviderAdapter,
  getEodhdDataProviderAdapter,
} from "../data-provider/data-provider.service";
import {
  isProviderEnabled,
  recordProviderFailure,
  recordProviderSuccess,
} from "../data-provider/data-provider-settings.service";
import { NSE_INDEX_EXCHANGE } from "../data-provider/adapters/zerodha-data-provider.adapter";
import type { ProviderDailyCandle, ProviderExchange } from "../data-provider/data-provider.types";
import { aggregateMonthlyCandles, aggregateWeeklyCandles } from "./candle-aggregation";
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
  type InstrumentUpsertInput,
  type LatestInstrumentStat,
} from "./market-data.instruments";
import { syncProviderInstruments } from "./market-data.instrument-sync";
import {
  backfillDailyCandles,
  backfillIndexCandles,
  refreshAllLatestInstrumentPrices,
  runChartBackfillOnce,
  runLatestCandleRefreshOnce,
  safeProviderAction,
} from "./market-data.candle-sync";
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
  computeSymbolBreakoutBacktest,
  computeWeeklyStrongBacktestMembers,
  computeWeeklyStrongStocks,
  getSymbolWeeklyStrongSeriesInput,
  groupRelativeStrengthMetrics,
  pickTopRelativeStrengthRows,
  WEEKLY_STRONG_BACKTEST_DEFAULT_WEEKS,
  type GroupRelativeStrengthRow,
  type RelativeStrengthInstrumentInput,
  type RelativeStrengthMetricRow,
  type SymbolBreakoutBacktestStats,
  type SymbolWeeklyStrongSeriesInput,
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
import { getLatestExpectedTradingDay } from "./trading-calendar";
import type { MoveFilter } from "./market-data.schemas";

// Implementations now live in market-data.stocks.ts; re-exported here so
// existing imports (e.g. market-collections.service.ts, ai.service.ts,
// market-data.routes.ts) keep working.
export { NSE_NORMAL_EQUITY_SYMBOL_PATTERN };

export type { MetricCandle };

// Implementation lives in market-data.stocks.ts; re-exported here so
// existing imports (ai.service.ts, market-data.routes.ts) keep working.
export { listStocks };

// Watchlist/Charts stock-selection picker (BSE-only, candle-eligible
// only). Implementation lives in market-data.stocks.ts; re-exported here
// so existing imports (e.g. market-data.routes.ts) keep working.
export { searchChartEligibleBseStocks };

// Relative Strength / Weekly Strong analytical data preparation and
// orchestration - implementations live in market-data.metrics.ts;
// re-exported here so existing imports (dashboard-snapshots.service.ts,
// market-collections.service.ts, scanner.service.ts,
// weekly-strong-backtest.service.ts, market-data.55-day-change.test.ts)
// keep working.
export {
  calculate55DayChange,
  CHANGE_55D_LOOKBACK_BARS,
  computeAllRelativeStrengthMetrics,
  computeGroupRelativeStrength,
  computeRelativeStrengthMetrics,
  computeSymbolBreakoutBacktest,
  computeWeeklyStrongBacktestMembers,
  computeWeeklyStrongStocks,
  getSymbolWeeklyStrongSeriesInput,
  groupRelativeStrengthMetrics,
  pickTopRelativeStrengthRows,
  WEEKLY_STRONG_BACKTEST_DEFAULT_WEEKS,
  type GroupRelativeStrengthRow,
  type RelativeStrengthInstrumentInput,
  type RelativeStrengthMetricRow,
  type SymbolBreakoutBacktestStats,
  type SymbolWeeklyStrongSeriesInput,
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
  const range = await readCandleHistoryRange({
    symbol,
    exchange,
    timeframe: CANDLE_TIMEFRAME.day,
  });

  return {
    symbol,
    exchange,
    timeframe: CANDLE_TIMEFRAME.day,
    from: range?.from ?? null,
    to: range?.to ?? null,
  };
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
  const from = input.from ?? getDefaultChartHistoryFromDate();
  const to = input.to ?? getTodayDate();

  let dailyRows = await readChartCandles({
    symbol,
    timeframe: CANDLE_TIMEFRAME.day,
    from: input.from,
    to: input.to,
    exchange,
  });

  const freshnessAction = decideChartCandleFreshnessAction(dailyRows, from, input.from, exchange);

  if (freshnessAction === "backfill") {
    await safeProviderAction("market-data.chart-candle-backfill", () =>
      runChartBackfillOnce({
        symbol,
        from,
        to,
        exchange,
      })
    );
    dailyRows = await readChartCandles({
      symbol,
      timeframe: CANDLE_TIMEFRAME.day,
      from: input.from,
      to: input.to,
      exchange,
    });
  } else if (freshnessAction === "incremental-refresh") {
    // Only the latest row is out of date, so this does a targeted
    // incremental fetch (syncLatestDailyCandlesForSymbols, a ~14-day
    // window) instead of the full-range backfill above.
    await safeProviderAction("market-data.chart-candle-freshness-refresh", () =>
      runLatestCandleRefreshOnce({ symbol, exchange })
    );
    dailyRows = await readChartCandles({
      symbol,
      timeframe: CANDLE_TIMEFRAME.day,
      from: input.from,
      to: input.to,
      exchange,
    });
  }

  if (dailyRows.length > 0) {
    return deriveChartCandlesFromDailyRows(dailyRows, input.timeframe).map(
      toChartCandleResponse
    );
  }

  if (input.timeframe !== CANDLE_TIMEFRAME.day) {
    const legacyRows = await readChartCandles({
      symbol,
      timeframe: input.timeframe,
      from: input.from,
      to: input.to,
      exchange,
    });
    if (legacyRows.length > 0) return legacyRows.map(toChartCandleResponse);
  }

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

  return [];
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

  return aggregateRuntimeChartCandles(dailyRows, timeframe);
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
  const adapter = await getEligibleProviderAdapter({
    exchange: input.exchange,
    capability: "historical_daily_candles",
  });
  if (!adapter) return [];

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

  let daily: ProviderDailyCandle[];
  try {
    daily = await adapter.fetchDailyCandles({
      accessToken,
      instrumentToken,
      symbol: input.symbol,
      from: input.from,
      to: input.to,
      exchangeCode: input.exchange,
    });
    void recordProviderSuccess(adapter.providerKey);
  } catch (error) {
    void recordProviderFailure(adapter.providerKey, error);
    throw error;
  }

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

// Only meaningful when the caller explicitly requested more history than
// is currently stored (explicitFrom set) - a normal, unbounded default
// request has no "did we backfill far enough back" question to ask, and
// must fall through to the cheap isLatestDailyCandleStale check instead of
// triggering a full multi-year backfill on every open.
function shouldBackfillRequestedHistory(
  rows: Array<{ time: string }>,
  requestedFrom: string,
  explicitFrom?: string
) {
  if (!explicitFrom || rows.length === 0) return false;

  const oldest = rows[0]?.time;
  if (!oldest) return false;

  return oldest > requestedFrom;
}

export function isLatestDailyCandleStale(
  rows: Array<{ time: string }>,
  exchange: string,
  at: Date = new Date()
) {
  const latest = rows[rows.length - 1]?.time;
  if (!latest) return false;
  return latest < getLatestExpectedTradingDay(exchange, at);
}

export type ChartCandleFreshnessAction = "backfill" | "incremental-refresh" | "none";

// getChartCandles' freshness decision, pure and directly testable (see
// market-data.freshness.test.ts). Order matters: missing/discontinuous/
// incomplete-history conditions take priority over mere staleness, since a
// symbol with no usable history needs a full re-fetch, not just the latest
// few days.
export function decideChartCandleFreshnessAction(
  dailyRows: Array<{ time: string; close: string | number }>,
  from: string,
  requestedFrom: string | undefined,
  exchange: string
): ChartCandleFreshnessAction {
  if (
    dailyRows.length === 0 ||
    hasLikelySplitDiscontinuity(dailyRows) ||
    shouldBackfillRequestedHistory(dailyRows, from, requestedFrom)
  ) {
    return "backfill";
  }
  if (isLatestDailyCandleStale(dailyRows, exchange)) {
    return "incremental-refresh";
  }
  return "none";
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

// Implementation lives in market-data.instrument-sync.ts; re-exported here
// so existing imports (admin.service.ts, worker.ts) keep working.
export { syncProviderInstruments };

// The atomic core of a candle-range replacement: delete the existing
// exchange/symbol/date-range across all 3 timeframes, then upsert the fresh
// daily/weekly/monthly rows - all inside one transaction, so a failure at
// any step (including a duplicate-key error surfaced from upsertCandles)
// rolls back the delete too, instead of leaving the range empty. Exported
// so it can be exercised directly against a fake DbOrTx in tests, without
// needing to also fake the provider-fetch layer that backfillDailyCandles
// wraps around it. Implementation lives in market-data.candles.ts;
// re-exported here so existing imports from this file keep working.
export { replaceCandlesAtomically };

// backfillDailyCandles/backfillIndexCandles implementations live in
// market-data.candle-sync.ts; re-exported here so existing imports
// (admin.service.ts) keep working.
export { backfillDailyCandles, backfillIndexCandles };

// Global (not collection-scoped) ranking of one index exchange's indices
// against each other - reuses computeAllRelativeStrengthMetrics, each
// index as its own row (no grouping/averaging needed). Defaults to
// NSE_IDX; pass BSE_IDX for the BSE index box.
//
// Reads a persisted snapshot (scope "index_exchange", keyed by exchange
// code since indices aren't members of any market_collection) and derives
// the limited/sorted view from it - pure, no candle I/O. On a miss it
// computes once and persists before returning.
export async function getIndexRelativeStrength(
  limit: number,
  exchange: string = NSE_INDEX_EXCHANGE
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
      symbol: instruments.symbol,
      name: instruments.name,
      exchange: instruments.exchange,
    })
    .from(instruments)
    .where(and(eq(instruments.exchange, exchange), eq(instruments.active, true)));

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
// (Zerodha-only). Cached 24h since exchange metadata rarely changes;
// data-provider-settings.service.ts invalidates this cache prefix on every
// admin toggle, so disable/enable still takes effect immediately.
export async function listSupportedExchanges(): Promise<ProviderExchange[]> {
  return getOrSetCache("supportedExchanges", SUPPORTED_EXCHANGES_CACHE_TTL_MS, async () => {
    const eodhdAdapter = getEodhdDataProviderAdapter();
    const [nseEnabled, globalDatafeedsEnabled, eodhdEnabled] = await Promise.all([
      isProviderEnabled(DATA_PROVIDER_KEY.zerodha),
      isProviderEnabled(DATA_PROVIDER_KEY.globalDatafeeds),
      isProviderEnabled(eodhdAdapter.providerKey),
    ]);

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

    const fixedExchanges = [
      ...(nseEnabled ? [NSE_PROVIDER_EXCHANGE] : []),
      ...(globalDatafeedsEnabled ? GLOBAL_DATAFEEDS_PROVIDER_EXCHANGES : []),
    ];
    const fixedCodes = new Set(fixedExchanges.map((exchange) => exchange.code));

    return [
      ...fixedExchanges,
      ...eodhdExchanges.filter((exchange) => !fixedCodes.has(exchange.code)),
    ];
  });
}


// Implementations live in market-data.candle-sync.ts; re-exported here so
// existing imports (admin.service.ts, worker.ts) keep working.
export { refreshAllLatestInstrumentPrices };

// Implementations live in market-data.instruments.ts; re-exported here so
// existing imports from this file (including test files) keep working.
export {
  applyLatestInstrumentStats,
  dedupeInstrumentUpsertInputs,
  type InstrumentUpsertInput,
  type LatestInstrumentStat,
};

