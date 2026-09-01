import { Router } from "express";

import { sendData } from "../../shared/http";
import { asyncHandler, requireAuth, validate } from "../../shared/middleware";
import {
  collectionCodeParamsSchema,
  collectionMembersQuerySchema,
  collectionRelativeStrengthQuerySchema,
  listCollectionsQuerySchema,
} from "./market-collections.schemas";
import {
  getCollectionMembers,
  getCollectionRelativeStrength,
  getCollectionWeeklyStrongStocks,
  listCollections,
} from "./market-collections.service";

export const marketCollectionsRouter = Router();

marketCollectionsRouter.use(requireAuth);

marketCollectionsRouter.get(
  "/",
  validate({ query: listCollectionsQuerySchema }),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as { exchange?: string; countryCode?: string };
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
    const query = req.query as unknown as {
      limit: number;
      groupBy?: "sector" | "industry";
    };
    sendData(
      res,
      await getCollectionRelativeStrength({
        code: params.code,
        limit: query.limit,
        groupBy: query.groupBy,
      })
    );
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

// The old .../weekly-strong-stocks/backtest route (count-only, live-
// computed on every request) has been removed - see the new
// weekly-strong-backtest module for the persisted replacement.
