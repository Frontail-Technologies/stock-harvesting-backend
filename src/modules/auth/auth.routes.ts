import { Router } from "express";

import { AUTH_ROUTES, OAUTH_PORTAL_COOKIE_NAME, OAUTH_STATE_COOKIE_NAME } from "../../shared/constants";
import { env } from "../../shared/env";
import { unauthorized } from "../../shared/errors";
import { sendData } from "../../shared/http";
import { logger } from "../../shared/logger";
import { asyncHandler, getAuthUserId, requireAuth, validate } from "../../shared/middleware";
import {
  clearOauthPortalCookie,
  clearOauthStateCookie,
  clearRefreshCookie,
  getCookie,
  getRefreshCookie,
  setOauthPortalCookie,
  setOauthStateCookie,
  setRefreshCookie,
} from "../security/cookies";
import { googleAuthUrlQuerySchema, googleCallbackQuerySchema } from "./auth.schemas";
import {
  completeGoogleLogin,
  createGoogleAuthUrl,
  getCurrentUser,
  resolveAuthPortal,
  resolveOauthDestination,
  revokeRefreshToken,
  rotateRefreshToken,
} from "./auth.service";

// The USER portal's auth router (mounted at /api/auth) - main app login,
// refresh, session check, logout. Strict portal separation (see
// admin-auth.routes.ts for the ADMIN portal's mirror): every refresh/me/
// logout call here is hardcoded to the "user" portal, so this router can
// never read, rotate, or clear an admin session's cookie/token, and vice
// versa - there is no shared "portal" parameter trusted from the request.
export const authRouter = Router();

authRouter.get(
  AUTH_ROUTES.googleUrl,
  validate({ query: googleAuthUrlQuerySchema }),
  (req, res) => {
    const portal = (req.query as { portal?: "admin" }).portal ?? "main";
    const { state, url } = createGoogleAuthUrl();
    setOauthStateCookie(res, state);
    setOauthPortalCookie(res, portal);
    sendData(res, { url });
  }
);

authRouter.get(
  AUTH_ROUTES.googleCallback,
  validate({ query: googleCallbackQuerySchema }),
  asyncHandler(async (req, res) => {
    const query = req.query as { code?: string; state?: string; error?: string };
    // Admin-portal logins round-trip back to the admin origin instead of
    // the main site - falls back to WEB_APP_URL if no admin host is
    // configured, so an unset ADMIN_WEB_APP_URL behaves exactly like this
    // feature doesn't exist.
    const portalCookie = getCookie(req, OAUTH_PORTAL_COOKIE_NAME);
    const destination = resolveOauthDestination(portalCookie, {
      webAppUrl: env.WEB_APP_URL,
      adminWebAppUrl: env.ADMIN_WEB_APP_URL,
    });
    // Only ever picks which cookie/session-type completeGoogleLogin is
    // ALLOWED to create if the resolved account's role matches - the
    // portal cookie itself never authorizes anything on its own (see
    // completeGoogleLogin's own role check).
    const authPortal = resolveAuthPortal(portalCookie);

    const redirectToLogin = (reason: string) => {
      clearOauthStateCookie(res);
      clearOauthPortalCookie(res);
      return res.redirect(`${destination.origin}/login?auth=${encodeURIComponent(reason)}`);
    };

    if (query.error || !query.code || !query.state) {
      return redirectToLogin(query.error ?? "failed");
    }

    const expectedState = getCookie(req, OAUTH_STATE_COOKIE_NAME);
    if (!expectedState || expectedState !== query.state) {
      return redirectToLogin("state-mismatch");
    }

    try {
      const result = await completeGoogleLogin(query.code, authPortal);
      clearOauthStateCookie(res);
      clearOauthPortalCookie(res);

      if (!result.ok) {
        // No session of either kind was created - completeGoogleLogin
        // rejected the login before ever touching the refresh-token table
        // or setting a cookie. redirectToLogin bounces back to THIS
        // portal's own /login (never the other portal's origin), where
        // the reason code drives the "This account uses the Admin
        // Portal." / "You do not have access to the Admin Portal."
        // messaging.
        return redirectToLogin(result.reason);
      }

      setRefreshCookie(res, authPortal, result.refreshToken);
      return res.redirect(`${destination.origin}${destination.successPath}?auth=success`);
    } catch (error) {
      // Previously swallowed silently - every Google login failure landed
      // on /login?auth=failed with zero trace of why (code exchange
      // rejected, profile fetch failed, DB error on user upsert, etc).
      logger.error(
        {
          message: error instanceof Error ? error.message : "Unknown error",
          stack: error instanceof Error ? error.stack : undefined,
        },
        "Google OAuth callback failed"
      );
      return redirectToLogin("failed");
    }
  })
);

authRouter.post(AUTH_ROUTES.refresh, asyncHandler(async (req, res) => {
  const refreshToken = getRefreshCookie(req, "user");
  if (!refreshToken) {
    throw unauthorized("Refresh token missing");
  }

  const session = await rotateRefreshToken(refreshToken, "user");
  setRefreshCookie(res, "user", session.refreshToken);
  sendData(res, {
    accessToken: session.accessToken,
    user: session.user,
  });
}));

authRouter.get(AUTH_ROUTES.me, requireAuth, asyncHandler(async (req, res) => {
  const user = await getCurrentUser(getAuthUserId(req));
  sendData(res, { user });
}));

authRouter.post(AUTH_ROUTES.logout, asyncHandler(async (req, res) => {
  const refreshToken = getRefreshCookie(req, "user");
  if (refreshToken) {
    await revokeRefreshToken(refreshToken, "user");
  }
  clearRefreshCookie(res, "user");
  sendData(res, { ok: true });
}));
