import { Router } from "express";

import { AUTH_ROUTES } from "../../shared/constants";
import { unauthorized } from "../../shared/errors";
import { sendData } from "../../shared/http";
import { asyncHandler, getAuthUserId, rateLimit, requireAdmin, requireAdminAuth, validate } from "../../shared/middleware";
import { clearRefreshCookie, getRefreshCookie, setRefreshCookie } from "../security/cookies";
import { requireTurnstile } from "../security/turnstile";
import { passwordLoginBodySchema } from "./auth.schemas";
import { loginWithPassword } from "./password-auth.service";
import { getCurrentUser, revokeRefreshToken, rotateRefreshToken } from "./session.service";

// The ADMIN portal's own auth router (mounted at /api/admin-auth), mirroring auth.routes.ts's USER router on separate paths so neither portal's cookie/token can reach the other; Google login itself stays shared and hands off to google-auth.service.ts's completeGoogleLogin, which re-validates role against the starting portal.
export const adminAuthRouter = Router();

adminAuthRouter.post(
  AUTH_ROUTES.login,
  validate({ body: passwordLoginBodySchema }),
  rateLimit({ keyPrefix: "auth:admin-login", windowMs: 15 * 60 * 1000, max: 10 }),
  requireTurnstile("admin-password-login"),
  asyncHandler(async (req, res) => {
    const body = req.body as { email: string; password: string };
    const session = await loginWithPassword({
      email: body.email,
      password: body.password,
      portal: "admin",
    });
    setRefreshCookie(res, "admin", session.refreshToken);
    sendData(res, {
      accessToken: session.accessToken,
      user: session.user,
    });
  })
);

adminAuthRouter.post(AUTH_ROUTES.refresh, asyncHandler(async (req, res) => {
  const refreshToken = getRefreshCookie(req, "admin");
  if (!refreshToken) {
    throw unauthorized("Refresh token missing");
  }

  const session = await rotateRefreshToken(refreshToken, "admin");
  setRefreshCookie(res, "admin", session.refreshToken);
  sendData(res, {
    accessToken: session.accessToken,
    user: session.user,
  });
}));

// Both requireAdminAuth and requireAdmin are required (item 14) - defense in depth against an account's role changing after a session was issued but before its access token expires.
adminAuthRouter.get(
  AUTH_ROUTES.me,
  requireAdminAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const user = await getCurrentUser(getAuthUserId(req));
    sendData(res, { user });
  })
);

adminAuthRouter.post(AUTH_ROUTES.logout, asyncHandler(async (req, res) => {
  const refreshToken = getRefreshCookie(req, "admin");
  if (refreshToken) {
    await revokeRefreshToken(refreshToken, "admin");
  }
  clearRefreshCookie(res, "admin");
  sendData(res, { ok: true });
}));
