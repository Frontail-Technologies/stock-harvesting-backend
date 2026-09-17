import { Router } from "express";

import { asyncHandler, requireAuth, validate } from "../../shared/middleware";
import {
  deleteDrawingController,
  getWorkspaceDrawingsController,
  patchDrawingController,
  replaceWorkspaceDrawingsController,
} from "./drawings.controller";
import {
  drawingIdParamsSchema,
  patchDrawingBodySchema,
  replaceDrawingsBodySchema,
  workspaceParamsSchema,
  workspaceQuerySchema,
} from "./drawings.schemas";

export const drawingsRouter = Router();

drawingsRouter.use(requireAuth);

drawingsRouter.get(
  "/workspaces/:symbol/:timeframe",
  validate({ params: workspaceParamsSchema, query: workspaceQuerySchema }),
  asyncHandler(getWorkspaceDrawingsController)
);

drawingsRouter.put(
  "/workspaces/:symbol/:timeframe/drawings",
  validate({
    params: workspaceParamsSchema,
    query: workspaceQuerySchema,
    body: replaceDrawingsBodySchema,
  }),
  asyncHandler(replaceWorkspaceDrawingsController)
);

drawingsRouter.patch(
  "/drawings/:id",
  validate({ params: drawingIdParamsSchema, body: patchDrawingBodySchema }),
  asyncHandler(patchDrawingController)
);

drawingsRouter.delete(
  "/drawings/:id",
  validate({ params: drawingIdParamsSchema }),
  asyncHandler(deleteDrawingController)
);
