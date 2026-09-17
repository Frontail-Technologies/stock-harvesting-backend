import { Router } from "express";

import { asyncHandler, requireAuth, validate } from "../../shared/middleware";
import { getScannerBacktestController, getScannerResultsController } from "./scanner.controller";
import {
  scannerBacktestQuerySchema,
  scannerResultsQuerySchema,
  scannerSymbolParamsSchema,
} from "./scanner.schemas";

export const scannerRouter = Router();

scannerRouter.use(requireAuth);

scannerRouter.get(
  "/results/:symbol",
  validate({
    params: scannerSymbolParamsSchema,
    query: scannerResultsQuerySchema.omit({ symbol: true }),
  }),
  asyncHandler(getScannerResultsController)
);

scannerRouter.get(
  "/backtest/:symbol",
  validate({ params: scannerSymbolParamsSchema, query: scannerBacktestQuerySchema }),
  asyncHandler(getScannerBacktestController)
);
