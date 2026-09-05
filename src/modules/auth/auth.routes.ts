import { Router } from "express";

import {
  AUTH_ROUTES,
  OAUTH_PORTAL_COOKIE_NAME,
  OAUTH_STATE_COOKIE_NAME,
} from "../../shared/constants";
import { env } from "../../shared/env";
import { badRequest, getErrorMessage, unauthorized } from "../../shared/errors";
import { sendData } from "../../shared/http";
import { logger } from "../../shared/logger";
import { requireTurnstile } from "../security/turnstile";
import {
  asyncHandler,
  getAuthUserId,
  rateLimit,
  requireAuth,
  validate,
} from "../../shared/middleware";
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
import {
  googleAuthUrlQuerySchema,
  googleCallbackQuerySchema,
  passwordLoginBodySchema,
  registrationRequestBodySchema,
  registrationResendBodySchema,
  registrationVerifyBodySchema,
} from "./auth.schemas";
import {
  completeGoogleLogin,
  createGoogleAuthUrl,
  getCurrentUser,
  loginWithPassword,
  resolveAuthPortal,
  resolveOauthDestination,
  revokeRefreshToken,
  rotateRefreshToken,
  requestUserRegistration,
  resendUserRegistrationOtp,
  verifyUserRegistrationOtp,
} from "./auth.service";

export const authRouter = Router();

authRouter.get(
  AUTH_ROUTES.googleUrl,
  validate({ query: googleAuthUrlQuerySchema }),
  requireTurnstile((req) =>
    (req.query as { portal?: "admin" }).portal === "admin"
      ? "admin-google-login"
      : "user-google-login",
  ),
  (req, res) => {
    const portal = (req.query as { portal?: "admin" }).portal ?? "main";
    if (portal === "admin") {
      throw badRequest("Admin Google login is disabled");
    }
    const { state, url } = createGoogleAuthUrl();
    setOauthStateCookie(res, state);
    setOauthPortalCookie(res, portal);
    sendData(res, { url });
  },
);

authRouter.get(
  AUTH_ROUTES.googleCallback,
  validate({ query: googleCallbackQuerySchema }),
  asyncHandler(async (req, res) => {
    const query = req.query as {
      code?: string;
      state?: string;
      error?: string;
    };
    const portalCookie = getCookie(req, OAUTH_PORTAL_COOKIE_NAME);
    const destination = resolveOauthDestination(portalCookie, {
      webAppUrl: env.WEB_APP_URL,
      adminWebAppUrl: env.ADMIN_WEB_APP_URL,
    });
    const authPortal = resolveAuthPortal(portalCookie);

    const redirectToLogin = (reason: string) => {
      clearOauthStateCookie(res);
      clearOauthPortalCookie(res);
      return res.redirect(
        `${destination.origin}/login?auth=${encodeURIComponent(reason)}`,
      );
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
        logger.info(
          { portal: authPortal, reason: result.reason },
          "Google login rejected by portal access check",
        );
        return redirectToLogin("invalid-credentials");
      }

      setRefreshCookie(res, authPortal, result.refreshToken);
      return res.redirect(
        `${destination.origin}${destination.successPath}?auth=success`,
      );
    } catch (error) {
      logger.error(
        {
          message: getErrorMessage(error, "Unknown error"),
          stack: error instanceof Error ? error.stack : undefined,
        },
        "Google OAuth callback failed",
      );
      return redirectToLogin("failed");
    }
  }),
);

authRouter.post(
  AUTH_ROUTES.login,
  validate({ body: passwordLoginBodySchema }),
  rateLimit({ keyPrefix: "auth:user-login", windowMs: 15 * 60 * 1000, max: 10 }),
  requireTurnstile("user-password-login"),
  asyncHandler(async (req, res) => {
    const body = req.body as { email: string; password: string };
    const session = await loginWithPassword({
      email: body.email,
      password: body.password,
      portal: "user",
    });
    setRefreshCookie(res, "user", session.refreshToken);
    sendData(res, {
      accessToken: session.accessToken,
      user: session.user,
    });
  }),
);

authRouter.post(
  AUTH_ROUTES.register,
  validate({ body: registrationRequestBodySchema }),
  rateLimit({ keyPrefix: "auth:user-register", windowMs: 60 * 60 * 1000, max: 5 }),
  requireTurnstile("user-register"),
  asyncHandler(async (req, res) => {
    const body = req.body as { name: string; email: string; password: string };
    const verification = await requestUserRegistration(body);
    sendData(res, verification);
  }),
);

authRouter.post(
  AUTH_ROUTES.registerResend,
  validate({ body: registrationResendBodySchema }),
  rateLimit({ keyPrefix: "auth:user-register-resend", windowMs: 15 * 60 * 1000, max: 5 }),
  asyncHandler(async (req, res) => {
    const body = req.body as { verificationId: string };
    const verification = await resendUserRegistrationOtp(body.verificationId);
    sendData(res, verification);
  }),
);

authRouter.post(
  AUTH_ROUTES.registerVerify,
  validate({ body: registrationVerifyBodySchema }),
  rateLimit({ keyPrefix: "auth:user-register-verify", windowMs: 15 * 60 * 1000, max: 10 }),
  asyncHandler(async (req, res) => {
    const body = req.body as { verificationId: string; code: string };
    const session = await verifyUserRegistrationOtp(body);
    setRefreshCookie(res, "user", session.refreshToken);
    sendData(res, {
      accessToken: session.accessToken,
      user: session.user,
    });
  }),
);

authRouter.post(
  AUTH_ROUTES.refresh,
  asyncHandler(async (req, res) => {
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
  }),
);

authRouter.get(
  AUTH_ROUTES.me,
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await getCurrentUser(getAuthUserId(req));
    sendData(res, { user });
  }),
);

authRouter.post(
  AUTH_ROUTES.logout,
  asyncHandler(async (req, res) => {
    const refreshToken = getRefreshCookie(req, "user");
    if (refreshToken) {
      await revokeRefreshToken(refreshToken, "user");
    }
    clearRefreshCookie(res, "user");
    sendData(res, { ok: true });
  }),
);
