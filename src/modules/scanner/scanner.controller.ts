import type { Request, Response } from "express";

import type { CandleTimeframe } from "../../shared/constants";
import { sendData } from "../../shared/http";
import { getScannerBacktest, listScannerResults } from "./scanner.service";
import type { ScannerLookbackMultiplier } from "./scanner.constants";

export async function getScannerResultsController(req: Request, res: Response) {
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
}

export async function getScannerBacktestController(req: Request, res: Response) {
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
}
