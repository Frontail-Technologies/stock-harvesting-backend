import { Router } from "express";

import { sendData } from "../../shared/http";
import { asyncHandler, getAuthUserId, requireAuth, validate } from "../../shared/middleware";
import { saveWidgetPreferencesBodySchema } from "./widget-preferences.schemas";
import { clearWidgetPreferences, getWidgetPreferences, saveWidgetPreferences } from "./widget-preferences.service";

export const widgetPreferencesRouter = Router();

widgetPreferencesRouter.use(requireAuth);

widgetPreferencesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    sendData(res, await getWidgetPreferences(getAuthUserId(req)));
  })
);

widgetPreferencesRouter.put(
  "/",
  validate({ body: saveWidgetPreferencesBodySchema }),
  asyncHandler(async (req, res) => {
    const body = req.body as { sources: Array<{ type: "segment" | "watchlist"; id: string }> };
    const result = await saveWidgetPreferences(getAuthUserId(req), body.sources);
    sendData(res, { hasSavedPreference: true, sources: result.sources });
  })
);

widgetPreferencesRouter.delete(
  "/",
  asyncHandler(async (req, res) => {
    sendData(res, await clearWidgetPreferences(getAuthUserId(req)));
  })
);
