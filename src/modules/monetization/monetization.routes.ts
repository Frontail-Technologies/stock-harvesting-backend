import { Router } from "express";

import { sendData } from "../../shared/http";
import { asyncHandler } from "../../shared/middleware";
import { getPublicMonetizationConfig } from "./monetization.service";

// Deliberately public - no requireAuth. AdSense publisher/slot IDs are
// browser-visible values (they end up in rendered <ins> markup anyway), not
// credentials, and unauthenticated landing-page visitors need this to decide
// whether to render anything at all.
export const monetizationRouter = Router();

monetizationRouter.get(
  "/config",
  asyncHandler(async (_req, res) => {
    sendData(res, await getPublicMonetizationConfig());
  })
);
