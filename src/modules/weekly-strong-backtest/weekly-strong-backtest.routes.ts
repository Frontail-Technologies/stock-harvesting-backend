import { Router } from "express";

import { sendData } from "../../shared/http";
import { asyncHandler, requireAuth, validate } from "../../shared/middleware";
import {
  collectionCodeParamsSchema,
  collectionCodeWeekParamsSchema,
  membershipChangesQuerySchema,
} from "./weekly-strong-backtest.schemas";
import {
  getWeeklyStrongBacktestMembershipChanges,
  getWeeklyStrongBacktestStacked,
  getWeeklyStrongBacktestWeekDetail,
} from "./weekly-strong-backtest.queries";

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
  "/:code/membership-changes",
  validate({ params: collectionCodeParamsSchema, query: membershipChangesQuerySchema }),
  asyncHandler(async (req, res) => {
    const params = req.params as { code: string };
    const query = req.query as unknown as { weekEnding: string };
    sendData(
      res,
      await getWeeklyStrongBacktestMembershipChanges({ code: params.code, weekEnding: query.weekEnding })
    );
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
