import { Router } from "express";

import { sendData } from "../../shared/http";
import { asyncHandler, requireAuth, validate } from "../../shared/middleware";
import {
  collectionCodeParamsSchema,
  collectionCodeWeekParamsSchema,
} from "./weekly-strong-backtest.schemas";
import {
  getWeeklyStrongBacktestStacked,
  getWeeklyStrongBacktestWeekDetail,
} from "./weekly-strong-backtest.service";

// Dashboard-facing reads only - always persisted data, never runs the
// evaluator on request (see weekly-strong-backtest.service.ts). Admin's
// generate/rebuild/status endpoints live under admin.routes.ts instead,
// same split as market-collections' own admin vs public routes.
export const weeklyStrongBacktestRouter = Router();

weeklyStrongBacktestRouter.use(requireAuth);

weeklyStrongBacktestRouter.get(
  "/:code",
  validate({ params: collectionCodeParamsSchema }),
  asyncHandler(async (req, res) => {
    const params = req.params as { code: string };
    sendData(res, await getWeeklyStrongBacktestStacked({ code: params.code }));
  })
);

weeklyStrongBacktestRouter.get(
  "/:code/:weekEnding",
  validate({ params: collectionCodeWeekParamsSchema }),
  asyncHandler(async (req, res) => {
    const params = req.params as { code: string; weekEnding: string };
    sendData(
      res,
      await getWeeklyStrongBacktestWeekDetail({ code: params.code, weekEnding: params.weekEnding })
    );
  })
);
