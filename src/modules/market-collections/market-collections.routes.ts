import { Router } from "express";

import { sendData } from "../../shared/http";
import { asyncHandler, requireAuth, validate } from "../../shared/middleware";
import {
  collectionCodeParamsSchema,
  collectionMembersQuerySchema,
  collectionRelativeStrengthQuerySchema,
  collectionWeeklyStrongBacktestQuerySchema,
  listCollectionsQuerySchema,
} from "./market-collections.schemas";
import {
  getCollectionMembers,
  getCollectionRelativeStrength,
  getCollectionWeeklyStrongStocks,
  getCollectionWeeklyStrongStocksBacktest,
  listCollections,
} from "./market-collections.service";

export const marketCollectionsRouter = Router();

marketCollectionsRouter.use(requireAuth);

marketCollectionsRouter.get(
  "/",
  validate({ query: listCollectionsQuerySchema }),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as { exchange?: string };
    sendData(res, { collections: await listCollections(query) });
  })
);

marketCollectionsRouter.get(
  "/:code/members",
  validate({ params: collectionCodeParamsSchema, query: collectionMembersQuerySchema }),
  asyncHandler(async (req, res) => {
    const params = req.params as { code: string };
    const query = req.query as unknown as {
      page: number;
      limit: number;
      q?: string;
      sortBy: "symbol" | "name";
      sortDirection: "asc" | "desc";
    };
    sendData(res, await getCollectionMembers({ code: params.code, ...query }));
  })
);

marketCollectionsRouter.get(
  "/:code/relative-strength",
  validate({ params: collectionCodeParamsSchema, query: collectionRelativeStrengthQuerySchema }),
  asyncHandler(async (req, res) => {
    const params = req.params as { code: string };
    const query = req.query as unknown as { limit: number };
    sendData(res, await getCollectionRelativeStrength({ code: params.code, limit: query.limit }));
  })
);

marketCollectionsRouter.get(
  "/:code/weekly-strong-stocks",
  validate({ params: collectionCodeParamsSchema }),
  asyncHandler(async (req, res) => {
    const params = req.params as { code: string };
    sendData(res, await getCollectionWeeklyStrongStocks({ code: params.code }));
  })
);

marketCollectionsRouter.get(
  "/:code/weekly-strong-stocks/backtest",
  validate({ params: collectionCodeParamsSchema, query: collectionWeeklyStrongBacktestQuerySchema }),
  asyncHandler(async (req, res) => {
    const params = req.params as { code: string };
    const query = req.query as unknown as { weeks: number };
    sendData(
      res,
      await getCollectionWeeklyStrongStocksBacktest({ code: params.code, weeks: query.weeks })
    );
  })
);
