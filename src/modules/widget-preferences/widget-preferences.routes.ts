import { Router } from "express";

import { asyncHandler, requireAuth, validate } from "../../shared/middleware";
import {
  clearWidgetPreferencesController,
  getWidgetPreferencesController,
  saveWidgetPreferencesController,
} from "./widget-preferences.controller";
import { saveWidgetPreferencesBodySchema } from "./widget-preferences.schemas";

export const widgetPreferencesRouter = Router();

widgetPreferencesRouter.use(requireAuth);

widgetPreferencesRouter.get("/", asyncHandler(getWidgetPreferencesController));

widgetPreferencesRouter.put(
  "/",
  validate({ body: saveWidgetPreferencesBodySchema }),
  asyncHandler(saveWidgetPreferencesController)
);

widgetPreferencesRouter.delete("/", asyncHandler(clearWidgetPreferencesController));
