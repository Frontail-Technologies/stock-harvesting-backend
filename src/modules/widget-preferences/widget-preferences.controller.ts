import type { Request, Response } from "express";

import { sendData } from "../../shared/http";
import { getAuthUserId } from "../../shared/middleware";
import { clearWidgetPreferences, getWidgetPreferences, saveWidgetPreferences } from "./widget-preferences.service";
import type { WidgetPreferenceSource } from "../../db/schema";

export async function getWidgetPreferencesController(req: Request, res: Response) {
  sendData(res, await getWidgetPreferences(getAuthUserId(req)));
}

export async function saveWidgetPreferencesController(req: Request, res: Response) {
  const body = req.body as { sources: WidgetPreferenceSource[] };
  const result = await saveWidgetPreferences(getAuthUserId(req), body.sources);
  sendData(res, { hasSavedPreference: true, sources: result.sources });
}

export async function clearWidgetPreferencesController(req: Request, res: Response) {
  sendData(res, await clearWidgetPreferences(getAuthUserId(req)));
}
