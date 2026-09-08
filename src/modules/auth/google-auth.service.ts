import { eq } from "drizzle-orm";

import { db } from "../../db/client";
import { authAccounts, users } from "../../db/schema";
import {
  AUTH_PROVIDER,
  DEFAULT_USER_PLAN,
  DEFAULT_USER_ROLE,
  GOOGLE_CALLBACK_PATH,
  HTTP_STATUS,
  type AuthPortal,
} from "../../shared/constants";
import { env } from "../../shared/env";
import { AppError, ERROR_CODES, unauthorized } from "../../shared/errors";
import { normalizeEmail } from "../security/passwords";
import { createOpaqueState } from "../security/tokens";
import { toAuthUser } from "./auth.helpers";
import type { AuthUser } from "./auth.types";
import { createSession, evaluatePortalAccess } from "./session.service";

type GoogleProfile = {
  sub: string;
  email: string;
  name: string;
  picture?: string;
};

function ensureGoogleConfig() {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new AppError(
      HTTP_STATUS.internalServerError,
      ERROR_CODES.internalError,
      "Google OAuth is not configured",
    );
  }
}

export function createGoogleAuthUrl() {
  ensureGoogleConfig();
  const state = createOpaqueState();
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID ?? "",
    redirect_uri: `${env.API_BASE_URL}${GOOGLE_CALLBACK_PATH}`,
    response_type: "code",
    scope: "openid email profile",
    access_type: "offline",
    prompt: "select_account",
    state,
  });

  return {
    state,
    url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
  };
}

export function resolveAuthPortal(oauthPortalCookieValue: string | undefined): AuthPortal {
  return oauthPortalCookieValue === "admin" ? "admin" : "user";
}

export function resolveOauthDestination(
  portal: string | undefined,
  config: { webAppUrl: string; adminWebAppUrl?: string },
): { origin: string; successPath: string } {
  if (portal === "admin") {
    return {
      origin: config.adminWebAppUrl ?? config.webAppUrl,
      successPath: "/login",
    };
  }

  return { origin: config.webAppUrl, successPath: "/dashboard" };
}

async function exchangeGoogleCode(code: string) {
  ensureGoogleConfig();

  let response: Response;
  try {
    response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID ?? "",
        client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
        redirect_uri: `${env.API_BASE_URL}${GOOGLE_CALLBACK_PATH}`,
        grant_type: "authorization_code",
      }),
    });
  } catch (error) {
    throw new AppError(
      HTTP_STATUS.unauthorized,
      ERROR_CODES.unauthorized,
      "Unable to reach Google OAuth service",
      error instanceof Error ? { message: error.message } : undefined,
    );
  }

  if (!response.ok) {
    throw new AppError(
      HTTP_STATUS.unauthorized,
      ERROR_CODES.unauthorized,
      "Google authentication failed",
      await readGoogleError(response),
    );
  }

  const tokenData = (await response.json()) as { access_token?: string };
  if (!tokenData.access_token) {
    throw unauthorized("Google access token missing");
  }

  return tokenData.access_token;
}

async function fetchGoogleProfile(accessToken: string): Promise<GoogleProfile> {
  let response: Response;
  try {
    response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    });
  } catch (error) {
    throw new AppError(
      HTTP_STATUS.unauthorized,
      ERROR_CODES.unauthorized,
      "Unable to load Google profile",
      error instanceof Error ? { message: error.message } : undefined,
    );
  }

  if (!response.ok) {
    throw unauthorized("Unable to load Google profile");
  }

  const profile = (await response.json()) as GoogleProfile;
  if (!profile.sub || !profile.email) {
    throw unauthorized("Google profile is incomplete");
  }
  return profile;
}

async function readGoogleError(response: Response) {
  try {
    return await response.json();
  } catch {
    try {
      return { message: await response.text() };
    } catch {
      return { status: response.status };
    }
  }
}

async function findOrCreateUser(profile: GoogleProfile): Promise<AuthUser> {
  const email = normalizeEmail(profile.email);
  const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);

  if (existing) {
    await db
      .update(users)
      .set({
        name: profile.name || existing.name,
        avatarUrl: profile.picture ?? existing.avatarUrl,
        updatedAt: new Date(),
      })
      .where(eq(users.id, existing.id));

    await db
      .insert(authAccounts)
      .values({
        userId: existing.id,
        provider: AUTH_PROVIDER.google,
        providerAccountId: profile.sub,
      })
      .onConflictDoNothing();

    return toAuthUser({
      ...existing,
      name: profile.name || existing.name,
      avatarUrl: profile.picture ?? existing.avatarUrl,
    });
  }

  const [created] = await db
    .insert(users)
    .values({
      email,
      name: profile.name || email,
      avatarUrl: profile.picture,
      role: DEFAULT_USER_ROLE,
      plan: DEFAULT_USER_PLAN,
    })
    .returning();

  await db.insert(authAccounts).values({
    userId: created.id,
    provider: AUTH_PROVIDER.google,
    providerAccountId: profile.sub,
  });

  return toAuthUser(created);
}

export type CompleteGoogleLoginResult =
  | { ok: true; user: AuthUser; accessToken: string; refreshToken: string }
  | {
      ok: false;
      reason: "admin-account-on-user-portal" | "not-admin-on-admin-portal";
    };

export async function completeGoogleLogin(
  code: string,
  portal: AuthPortal,
): Promise<CompleteGoogleLoginResult> {
  const googleAccessToken = await exchangeGoogleCode(code);
  const profile = await fetchGoogleProfile(googleAccessToken);
  const user = await findOrCreateUser(profile);

  const access = evaluatePortalAccess(user.role, portal);
  if (!access.allowed) {
    return { ok: false, reason: access.reason };
  }

  const session = await createSession(user, portal);
  return { ok: true, user, ...session };
}
