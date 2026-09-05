import { Router } from "express";

import { sendCreated, sendData } from "../../shared/http";
import { asyncHandler, getAuthUserId, requireAuth, validate } from "../../shared/middleware";
import {
  addWatchlistItemBodySchema,
  createWatchlistBodySchema,
  updateWatchlistBodySchema,
  watchlistIdParamsSchema,
  watchlistItemParamsSchema,
  watchlistRelativeStrengthQuerySchema,
} from "./watchlists.schemas";
import {
  addWatchlistItem,
  createWatchlist,
  deleteWatchlist,
  getWatchlist,
  getWatchlistRelativeStrength,
  listWatchlists,
  removeWatchlistItem,
  renameWatchlist,
} from "./watchlists.service";

export const watchlistsRouter = Router();

watchlistsRouter.use(requireAuth);

watchlistsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const watchlistsList = await listWatchlists({ userId: getAuthUserId(req) });
    sendData(res, { watchlists: watchlistsList });
  })
);

watchlistsRouter.post(
  "/",
  validate({ body: createWatchlistBodySchema }),
  asyncHandler(async (req, res) => {
    const watchlist = await createWatchlist({ userId: getAuthUserId(req), ...req.body });
    sendCreated(res, { watchlist });
  })
);

watchlistsRouter.get(
  "/:id",
  validate({ params: watchlistIdParamsSchema }),
  asyncHandler(async (req, res) => {
    const params = req.params as { id: string };
    const watchlist = await getWatchlist({ userId: getAuthUserId(req), id: params.id });
    sendData(res, { watchlist });
  })
);

watchlistsRouter.get(
  "/:id/relative-strength",
  validate({ params: watchlistIdParamsSchema, query: watchlistRelativeStrengthQuerySchema }),
  asyncHandler(async (req, res) => {
    const params = req.params as { id: string };
    const query = req.query as unknown as { limit: number };
    sendData(
      res,
      await getWatchlistRelativeStrength({
        userId: getAuthUserId(req),
        id: params.id,
        limit: query.limit,
      })
    );
  })
);

watchlistsRouter.patch(
  "/:id",
  validate({ params: watchlistIdParamsSchema, body: updateWatchlistBodySchema }),
  asyncHandler(async (req, res) => {
    const params = req.params as { id: string };
    const watchlist = await renameWatchlist({
      userId: getAuthUserId(req),
      id: params.id,
      ...req.body,
    });
    sendData(res, { watchlist });
  })
);

watchlistsRouter.delete(
  "/:id",
  validate({ params: watchlistIdParamsSchema }),
  asyncHandler(async (req, res) => {
    const params = req.params as { id: string };
    sendData(res, await deleteWatchlist({ userId: getAuthUserId(req), id: params.id }));
  })
);

watchlistsRouter.post(
  "/:id/items",
  validate({ params: watchlistIdParamsSchema, body: addWatchlistItemBodySchema }),
  asyncHandler(async (req, res) => {
    const params = req.params as { id: string };
    const item = await addWatchlistItem({
      userId: getAuthUserId(req),
      watchlistId: params.id,
      ...req.body,
    });
    sendCreated(res, { item });
  })
);

watchlistsRouter.delete(
  "/:id/items/:itemId",
  validate({ params: watchlistItemParamsSchema }),
  asyncHandler(async (req, res) => {
    const params = req.params as { id: string; itemId: string };
    sendData(
      res,
      await removeWatchlistItem({
        userId: getAuthUserId(req),
        watchlistId: params.id,
        itemId: params.itemId,
      })
    );
  })
);
