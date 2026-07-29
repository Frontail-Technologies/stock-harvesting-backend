import { Router } from "express";

import { AUTH_ROUTES } from "../../shared/constants";
import { env } from "../../shared/env";
import { unauthorized } from "../../shared/errors";
import { sendData } from "../../shared/http";
import { asyncHandler, getAuthUserId, requireAuth, validate } from "../../shared/middleware";
import { OAUTH_STATE_COOKIE_NAME, REFRESH_COOKIE_NAME } from "../../shared/constants";
import {
  clearOauthStateCookie,
  clearRefreshCookie,
  getCookie,
  setOauthStateCookie,
  setRefreshCookie,
} from "../security/cookies";
import { googleCallbackQuerySchema } from "./auth.schemas";
import {
  completeGoogleLogin,
  createGoogleAuthUrl,
  getCurrentUser,
  revokeRefreshToken,
  rotateRefreshToken,
} from "./auth.service";

export const authRouter = Router();

authRouter.get(AUTH_ROUTES.googleUrl, (_req, res) => {
  const { state, url } = createGoogleAuthUrl();
  setOauthStateCookie(res, state);
  sendData(res, { url });
});

authRouter.get(
  AUTH_ROUTES.googleCallback,
  validate({ query: googleCallbackQuerySchema }),
  asyncHandler(async (req, res) => {
    const query = req.query as { code?: string; state?: string; error?: string };
    const redirectToLogin = (reason: string) => {
      clearOauthStateCookie(res);
      return res.redirect(`${env.WEB_APP_URL}/login?auth=${encodeURIComponent(reason)}`);
    };

    if (query.error || !query.code || !query.state) {
      return redirectToLogin(query.error ?? "failed");
    }

    const expectedState = getCookie(req, OAUTH_STATE_COOKIE_NAME);
    if (!expectedState || expectedState !== query.state) {
      return redirectToLogin("state-mismatch");
    }

    try {
      const session = await completeGoogleLogin(query.code);
      setRefreshCookie(res, session.refreshToken);
      clearOauthStateCookie(res);
      return res.redirect(`${env.WEB_APP_URL}/scanner?auth=success`);
    } catch {
      return redirectToLogin("failed");
    }
  })
);

authRouter.post(AUTH_ROUTES.refresh, asyncHandler(async (req, res) => {
  const refreshToken = getCookie(req, REFRESH_COOKIE_NAME);
  if (!refreshToken) {
    throw unauthorized("Refresh token missing");
  }

  const session = await rotateRefreshToken(refreshToken);
  setRefreshCookie(res, session.refreshToken);
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
  const refreshToken = getCookie(req, REFRESH_COOKIE_NAME);
  if (refreshToken) {
    await revokeRefreshToken(refreshToken);
  }
  clearRefreshCookie(res);
  sendData(res, { ok: true });
}));
