import { Router } from "express";

import { AUTH_ROUTES } from "../../shared/constants";
import { unauthorized } from "../../shared/errors";
import { sendData } from "../../shared/http";
import { asyncHandler, getAuthUserId, rateLimit, requireAdmin, requireAdminAuth, validate } from "../../shared/middleware";
import { clearRefreshCookie, getRefreshCookie, setRefreshCookie } from "../security/cookies";
import { requireTurnstile } from "../security/turnstile";
import { passwordLoginBodySchema } from "./auth.schemas";
import { getCurrentUser, loginWithPassword, revokeRefreshToken, rotateRefreshToken } from "./auth.service";

// The ADMIN portal's own auth router (mounted at /api/admin-auth) - the
// mirror of auth.routes.ts's USER router, on entirely separate paths so
// neither can be reached by presenting the other portal's cookie/token by
// accident (item 10). Google login itself (/api/auth/google/url,
// /api/auth/google/callback) stays shared - it never creates a session on
// its own, it only ever hands off to auth.service.ts's completeGoogleLogin,
// which independently re-validates the resolved account's role against
// the portal that started the flow before creating anything.
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

// Both requireAdminAuth (valid ADMIN-portal access token) AND requireAdmin
// (role === "admin") are required (item 14) - defense in depth against the
// narrow window where an account's role changes after a session was
// already issued but before its short-lived access token expires.
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
