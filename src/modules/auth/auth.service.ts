import { and, eq, isNull } from "drizzle-orm";
import { randomUUID } from "crypto";

import { db } from "../../db/client";
import { authAccounts, refreshTokens, users } from "../../db/schema";
import {
  AUTH_PROVIDER,
  DEFAULT_USER_PLAN,
  DEFAULT_USER_ROLE,
  GOOGLE_CALLBACK_PATH,
  HTTP_STATUS,
  REFRESH_TOKEN_TTL_DAYS,
  type UserPlan,
  type UserRole,
} from "../../shared/constants";
import { env } from "../../shared/env";
import { AppError, ERROR_CODES, unauthorized } from "../../shared/errors";
import {
  createOpaqueState,
  createRefreshToken,
  hashRefreshToken,
  signAccessToken,
} from "../security/tokens";

type GoogleProfile = {
  sub: string;
  email: string;
  name: string;
  picture?: string;
};

type AuthUser = {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  role: UserRole;
  plan: UserPlan;
};

function ensureGoogleConfig() {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new AppError(
      HTTP_STATUS.internalServerError,
      ERROR_CODES.internalError,
      "Google OAuth is not configured"
    );
  }
}

function userToAuthPayload(user: AuthUser) {
  return {
    sub: user.id,
    email: user.email,
    role: user.role,
    plan: user.plan,
  };
}

function toAuthUser(user: typeof users.$inferSelect): AuthUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    role: user.role,
    plan: user.plan,
  };
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
      error instanceof Error ? { message: error.message } : undefined
    );
  }

  if (!response.ok) {
    throw new AppError(
      HTTP_STATUS.unauthorized,
      ERROR_CODES.unauthorized,
      "Google authentication failed",
      await readGoogleError(response)
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
      error instanceof Error ? { message: error.message } : undefined
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
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.email, profile.email))
    .limit(1);

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
      email: profile.email,
      name: profile.name || profile.email,
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

export async function completeGoogleLogin(code: string) {
  const googleAccessToken = await exchangeGoogleCode(code);
  const profile = await fetchGoogleProfile(googleAccessToken);
  const user = await findOrCreateUser(profile);
  const session = await createSession(user);

  return {
    user,
    ...session,
  };
}

export async function createSession(user: AuthUser) {
  const rawRefreshToken = createRefreshToken();
  const refreshTokenHash = hashRefreshToken(rawRefreshToken);
  const familyId = randomUUID();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

  await db.insert(refreshTokens).values({
    userId: user.id,
    tokenHash: refreshTokenHash,
    familyId,
    expiresAt,
  });

  return {
    accessToken: signAccessToken(userToAuthPayload(user)),
    refreshToken: rawRefreshToken,
  };
}

export async function rotateRefreshToken(rawRefreshToken: string) {
  const tokenHash = hashRefreshToken(rawRefreshToken);

  // Wrapped in a transaction with a row lock on the matched token: if two
  // requests ever present the same refresh token concurrently (e.g. a
  // multi-tab race the frontend's single-flight guard can't see across),
  // the second one blocks here until the first commits its rotation,
  // instead of both reading a pre-rotation row and racing to mutate it —
  // which previously could revoke the winner's brand-new token too.
  return db.transaction(async (tx) => {
    const [existingToken] = await tx
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, tokenHash))
      .for("update")
      .limit(1);

    if (!existingToken) {
      throw unauthorized("Invalid refresh token");
    }

    if (existingToken.revokedAt) {
      await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(eq(refreshTokens.familyId, existingToken.familyId), isNull(refreshTokens.revokedAt))
        );
      throw unauthorized("Refresh token reuse detected");
    }

    if (existingToken.expiresAt.getTime() < Date.now()) {
      throw unauthorized("Refresh token expired");
    }

    const [user] = await tx.select().from(users).where(eq(users.id, existingToken.userId)).limit(1);
    if (!user) {
      throw unauthorized("Refresh token user no longer exists");
    }

    const nextRawToken = createRefreshToken();
    const [nextToken] = await tx
      .insert(refreshTokens)
      .values({
        userId: user.id,
        tokenHash: hashRefreshToken(nextRawToken),
        familyId: existingToken.familyId,
        expiresAt: new Date(
          Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000
        ),
      })
      .returning();

    await tx
      .update(refreshTokens)
      .set({
        revokedAt: new Date(),
        replacedByTokenId: nextToken.id,
      })
      .where(eq(refreshTokens.id, existingToken.id));

    const authUser = toAuthUser(user);
    return {
      user: authUser,
      accessToken: signAccessToken(userToAuthPayload(authUser)),
      refreshToken: nextRawToken,
    };
  });
}

export async function revokeRefreshToken(rawRefreshToken: string) {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(eq(refreshTokens.tokenHash, hashRefreshToken(rawRefreshToken)));
}

export async function getCurrentUser(userId: string) {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw unauthorized();
  return toAuthUser(user);
}
