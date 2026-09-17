import { Router } from "express";

import { asyncHandler } from "../../shared/middleware";
import { getPublicMonetizationConfigController } from "./monetization.controller";

export const monetizationRouter = Router();

monetizationRouter.get("/config", asyncHandler(getPublicMonetizationConfigController));
