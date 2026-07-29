import { Router } from "express";

import type { CandleTimeframe } from "../../shared/constants";
import { sendData } from "../../shared/http";
import { asyncHandler, getAuthUserId, requireAuth, validate } from "../../shared/middleware";
import {
  drawingIdParamsSchema,
  patchDrawingBodySchema,
  replaceDrawingsBodySchema,
  workspaceParamsSchema,
  workspaceQuerySchema,
} from "./drawings.schemas";
import {
  deleteDrawing,
  getWorkspaceDrawings,
  patchDrawing,
  replaceWorkspaceDrawings,
} from "./drawings.service";

export const drawingsRouter = Router();

drawingsRouter.use(requireAuth);

drawingsRouter.get(
  "/workspaces/:symbol/:timeframe",
  validate({ params: workspaceParamsSchema, query: workspaceQuerySchema }),
  asyncHandler(async (req, res) => {
    const params = req.params as { symbol: string; timeframe: CandleTimeframe };
    const query = req.query as unknown as { exchange: string };
    const drawings = await getWorkspaceDrawings({
      userId: getAuthUserId(req),
      ...params,
      exchange: query.exchange,
    });
    sendData(res, { drawings });
  })
);

drawingsRouter.put(
  "/workspaces/:symbol/:timeframe/drawings",
  validate({
    params: workspaceParamsSchema,
    query: workspaceQuerySchema,
    body: replaceDrawingsBodySchema,
  }),
  asyncHandler(async (req, res) => {
    const params = req.params as { symbol: string; timeframe: CandleTimeframe };
    const query = req.query as unknown as { exchange: string };
    const body = req.body as {
      drawings: {
        id?: string;
        drawingType: string;
        payload: Record<string, unknown>;
        locked: boolean;
        hidden: boolean;
      }[];
    };
    const drawings = await replaceWorkspaceDrawings({
      userId: getAuthUserId(req),
      ...params,
      exchange: query.exchange,
      drawings: body.drawings,
    });
    sendData(res, { drawings });
  })
);

drawingsRouter.patch(
  "/drawings/:id",
  validate({ params: drawingIdParamsSchema, body: patchDrawingBodySchema }),
  asyncHandler(async (req, res) => {
    const params = req.params as { id: string };
    const drawing = await patchDrawing({
      userId: getAuthUserId(req),
      id: params.id,
      patch: req.body,
    });
    sendData(res, { drawing });
  })
);

drawingsRouter.delete(
  "/drawings/:id",
  validate({ params: drawingIdParamsSchema }),
  asyncHandler(async (req, res) => {
    const params = req.params as { id: string };
    const result = await deleteDrawing({
      userId: getAuthUserId(req),
      id: params.id,
    });
    sendData(res, result);
  })
);
