import { Router } from "express";

import type { CandleTimeframe } from "../../shared/constants";
import { sendData } from "../../shared/http";
import { asyncHandler, requireAuth, validate } from "../../shared/middleware";
import {
  type ScannerLookbackMultiplier,
  scannerBacktestQuerySchema,
  scannerResultsQuerySchema,
  scannerSymbolParamsSchema,
} from "./scanner.schemas";
import { getScannerBacktest, listScannerResults } from "./scanner.service";

export const scannerRouter = Router();

scannerRouter.use(requireAuth);

scannerRouter.get("/results", validate({ query: scannerResultsQuerySchema }), asyncHandler(async (req, res) => {
  const query = req.query as unknown as {
    symbol?: string;
    timeframe: CandleTimeframe;
    rule?: string;
    limit: number;
    exchange: string;
    lookback: ScannerLookbackMultiplier;
  };
  const results = await listScannerResults(query);
  sendData(res, { results });
}));

scannerRouter.get(
  "/results/:symbol",
  validate({
    params: scannerSymbolParamsSchema,
    query: scannerResultsQuerySchema.omit({ symbol: true }),
  }),
  asyncHandler(async (req, res) => {
    const params = req.params as { symbol: string };
    const query = req.query as unknown as {
      timeframe: CandleTimeframe;
      rule?: string;
      limit: number;
      exchange: string;
      lookback: ScannerLookbackMultiplier;
    };
    const results = await listScannerResults({ ...query, symbol: params.symbol });
    sendData(res, { results });
  })
);

scannerRouter.get(
  "/backtest/:symbol",
  validate({ params: scannerSymbolParamsSchema, query: scannerBacktestQuerySchema }),
  asyncHandler(async (req, res) => {
    const params = req.params as { symbol: string };
    const query = req.query as unknown as {
      exchange: string;
      lookback: ScannerLookbackMultiplier;
    };
    const stats = await getScannerBacktest({
      symbol: params.symbol,
      exchange: query.exchange,
      lookback: query.lookback,
    });
    sendData(res, { stats });
  })
);
