import { Router } from "express";

import type { CandleTimeframe } from "../../shared/constants";
import { sendData } from "../../shared/http";
import { asyncHandler, requireAuth, validate } from "../../shared/middleware";
import {
  candleParamsSchema,
  candleQuerySchema,
  chartEligibleStockSearchQuerySchema,
  historyRangeQuerySchema,
  indexRelativeStrengthQuerySchema,
  stockListQuerySchema,
  type MoveFilter,
} from "./market-data.schemas";
import {
  getChartCandles,
  getChartHistoryRange,
  getIndexRelativeStrength,
  listExchangeRates,
  listStocks,
  listSupportedExchanges,
  searchChartEligibleBseStocks,
} from "./market-data.service";

export const marketDataRouter = Router();

// Public: the global stock search (navbar, landing hero, Ctrl+K command
// panel) must work for signed-out visitors on the public marketing site,
// not just inside the authenticated app. This is a pure read of public
// market data (symbol/name/exchange/price) - no user-specific data, no
// mutation - so it's safe to expose without a session. Registered before
// the router-wide requireAuth below so only this one route is public;
// every other market-data route (including the near-identical /stocks
// list) stays authenticated exactly as before.
marketDataRouter.get(
  "/stocks/search",
  validate({ query: stockListQuerySchema }),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as {
      q?: string;
      page: number;
      limit: number;
      sortBy: "symbol" | "name" | "close" | "changePct" | "volume";
      sortDirection: "asc" | "desc";
      exchange: string;
      moveFilter: MoveFilter;
      minVolume?: number;
      includeUnpriced?: boolean;
    };
    sendData(res, await listStocks(query));
  })
);

// Public for the same reason /stocks/search above is: the landing hero's
// exchange selector (and every other exchange picker built on
// MarketSelector) needs this list before a visitor has ever signed in -
// it's public exchange metadata (code/name/currency/country), not
// user-specific data. Previously sat after the router-wide requireAuth
// below, which meant every logged-out visitor's dropdown silently got an
// empty list and rendered "No exchanges found" even though real options
// existed.
marketDataRouter.get("/exchanges", asyncHandler(async (_req, res) => {
  sendData(res, { exchanges: await listSupportedExchanges() });
}));

marketDataRouter.use(requireAuth);

marketDataRouter.get("/exchange-rates", asyncHandler(async (_req, res) => {
  sendData(res, await listExchangeRates());
}));

// Watchlist/Charts stock-selection picker only - see
// searchChartEligibleBseStocks for why this is a separate, deliberately
// narrower endpoint than /stocks/search rather than a mode of it.
marketDataRouter.get(
  "/stocks/search/chart-eligible",
  validate({ query: chartEligibleStockSearchQuerySchema }),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as { q: string; limit: number };
    sendData(res, { stocks: await searchChartEligibleBseStocks(query) });
  })
);

marketDataRouter.get(
  "/index-relative-strength",
  validate({ query: indexRelativeStrengthQuerySchema }),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as { limit: number; exchange: string };
    sendData(res, await getIndexRelativeStrength(query.limit, query.exchange));
  })
);

marketDataRouter.get("/stocks", validate({ query: stockListQuerySchema }), asyncHandler(async (req, res) => {
  const query = req.query as unknown as {
    q?: string;
    page: number;
    limit: number;
    sortBy: "symbol" | "name" | "close" | "changePct" | "volume";
    sortDirection: "asc" | "desc";
    exchange: string;
    moveFilter: MoveFilter;
    minVolume?: number;
    includeUnpriced?: boolean;
  };
  sendData(res, await listStocks(query));
}));

marketDataRouter.get(
  "/history-range",
  validate({ query: historyRangeQuerySchema }),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as {
      symbol: string;
      timeframe: CandleTimeframe;
      exchange: string;
    };

    sendData(res, await getChartHistoryRange(query));
  })
);

marketDataRouter.get(
  "/charts/:symbol/candles",
  validate({ params: candleParamsSchema, query: candleQuerySchema }),
  asyncHandler(async (req, res) => {
    const params = req.params as { symbol: string };
    const query = req.query as unknown as {
      timeframe: CandleTimeframe;
      from?: string;
      to?: string;
      exchange: string;
    };
    const candleRows = await getChartCandles({
      symbol: params.symbol,
      timeframe: query.timeframe,
      from: query.from,
      to: query.to,
      exchange: query.exchange,
    });

    sendData(res, { candles: candleRows });
  })
);
