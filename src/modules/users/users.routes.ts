import { Router } from "express";

import { sendData } from "../../shared/http";
import { asyncHandler, getAuthUserId, requireAuth } from "../../shared/middleware";
import { getUserProfile } from "./users.service";

export const usersRouter = Router();

usersRouter.use(requireAuth);

usersRouter.get("/me", asyncHandler(async (req, res) => {
  const profile = await getUserProfile(getAuthUserId(req));
  sendData(res, profile);
}));
