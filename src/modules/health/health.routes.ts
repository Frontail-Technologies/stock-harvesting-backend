import { Router } from "express";

import { asyncHandler } from "../../shared/middleware";
import { getHealthController } from "./health.controller";

export const healthRouter = Router();

healthRouter.get("/", asyncHandler(getHealthController));
