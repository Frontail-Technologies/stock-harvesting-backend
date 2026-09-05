import { and, eq, isNull } from "drizzle-orm";
import { randomUUID } from "crypto";

import { db } from "../../db/client";
import { authAccounts, refreshTokens, registrationVerifications, users } from "../../db/schema";
import {
  AUTH_PROVIDER,
  DEFAULT_USER_PLAN,
  DEFAULT_USER_ROLE,
  GOOGLE_CALLBACK_PATH,
  HTTP_STATUS,
  USER_ROLE,
  type AuthPortal,
  type UserPlan,
  type UserRole,
} from "../../shared/constants";
import { env } from "../../shared/env";
import { AppError, badRequest, conflict, ERROR_CODES, unauthorized } from "../../shared/errors";
import { getRefreshTokenTtlMs } from "../security/cookies";
import { createOtpCode, hashOtpCode, hashPassword, normalizeEmail, verifyPassword } from "../security/passwords";
import {
  createOpaqueState,
  createRefreshToken,
  hashRefreshToken,
  signAccessToken,
} from "../security/tokens";
import { sendRegistrationOtpEmail } from "./auth-email.service";

const GENERIC_LOGIN_ERROR = "Invalid email or password";
const OTP_EXPIRY_MS = 10 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;

function getAccessTokenTtlSeconds(portal: AuthPortal): number {
  return portal === "admin" ? env.ADMIN_ACCESS_TOKEN_TTL_SECONDS : env.USER_ACCESS_TOKEN_TTL_SECONDS;
}

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

function userToAuthPayload(user: AuthUser, portal: AuthPortal) {
  return {
    sub: user.id,
    email: user.email,
    role: user.role,
    plan: user.plan,
    portal,
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

// Pure - maps the short-lived OAUTH_PORTAL_COOKIE_NAME value (set right
// before the Google redirect, read back on the callback) to the strict
// AuthPortal type completeGoogleLogin/createSession/rotateRefreshToken all
// key on. This mapping alone never authorizes anything - an unrecognized
// or missing value always resolves to "user", the least-privileged
// portal, so a tampered/missing cookie can only ever be treated as a
// user-portal attempt, never accidentally elevated to admin.
export function resolveAuthPortal(oauthPortalCookieValue: string | undefined): AuthPortal {
  return oauthPortalCookieValue === "admin" ? "admin" : "user";
}

// Pure so it's directly unit-testable without a real OAuth round-trip -
// this is the one place that decides which frontend origin (and which
// path) a Google login bounces back to. An admin-portal login must never
// land on the main site's /charts, and a main-site login must never
// require ADMIN_WEB_APP_URL to be configured at all.
export function resolveOauthDestination(
  portal: string | undefined,
  config: { webAppUrl: string; adminWebAppUrl?: string }
): { origin: string; successPath: string } {
  if (portal === "admin") {
    return {
      origin: config.adminWebAppUrl ?? config.webAppUrl,
      // Never /admin (or /charts) - the admin login page itself re-checks
      // the real session and role before entering the dashboard.
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
  const email = normalizeEmail(profile.email);
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
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

export async function loginWithPassword(input: {
  email: string;
  password: string;
  portal: AuthPortal;
}) {
  const email = normalizeEmail(input.email);
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

  if (!user) {
    throw unauthorized(GENERIC_LOGIN_ERROR);
  }

  const validPassword = await verifyPassword(input.password, user.passwordHash);
  if (!validPassword) {
    throw unauthorized(GENERIC_LOGIN_ERROR);
  }

  const access = evaluatePortalAccess(user.role, input.portal);
  if (!access.allowed) {
    throw unauthorized(GENERIC_LOGIN_ERROR);
  }

  const authUser = toAuthUser(user);
  const session = await createSession(authUser, input.portal);
  return { user: authUser, ...session };
}

export async function requestUserRegistration(input: {
  name: string;
  email: string;
  password: string;
}) {
  const email = normalizeEmail(input.email);
  const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);

  if (existing?.passwordHash || existing?.role === USER_ROLE.admin) {
    throw conflict("Unable to register this account");
  }

  const now = new Date();
  const code = createOtpCode();
  const passwordHash = await hashPassword(input.password);
  const expiresAt = new Date(now.getTime() + OTP_EXPIRY_MS);
  const resendAvailableAt = new Date(now.getTime() + OTP_RESEND_COOLDOWN_MS);

  const [verification] = await db.transaction(async (tx) => {
    await tx
      .update(registrationVerifications)
      .set({ consumedAt: now, updatedAt: now })
      .where(and(eq(registrationVerifications.email, email), isNull(registrationVerifications.consumedAt)));

    return tx
      .insert(registrationVerifications)
      .values({
        email,
        name: input.name,
        passwordHash,
        otpHash: hashOtpCode(code),
        expiresAt,
        resendAvailableAt,
      })
      .returning();
  });

  await sendRegistrationOtpEmail({ email, name: input.name, code });

  return {
    verificationId: verification.id,
    expiresAt: verification.expiresAt,
    resendAvailableAt: verification.resendAvailableAt,
  };
}

export async function resendUserRegistrationOtp(verificationId: string) {
  const now = new Date();
  const code = createOtpCode();
  const expiresAt = new Date(now.getTime() + OTP_EXPIRY_MS);
  const resendAvailableAt = new Date(now.getTime() + OTP_RESEND_COOLDOWN_MS);

  const [verification] = await db
    .select()
    .from(registrationVerifications)
    .where(eq(registrationVerifications.id, verificationId))
    .limit(1);

  if (!verification || verification.consumedAt || verification.expiresAt.getTime() <= now.getTime()) {
    throw badRequest("Verification code expired");
  }

  if (verification.resendAvailableAt.getTime() > now.getTime()) {
    throw badRequest("Please wait before requesting another code");
  }

  const [updated] = await db
    .update(registrationVerifications)
    .set({
      otpHash: hashOtpCode(code),
      attemptCount: 0,
      expiresAt,
      resendAvailableAt,
      updatedAt: now,
    })
    .where(eq(registrationVerifications.id, verificationId))
    .returning();

  await sendRegistrationOtpEmail({ email: updated.email, name: updated.name, code });

  return {
    verificationId: updated.id,
    expiresAt: updated.expiresAt,
    resendAvailableAt: updated.resendAvailableAt,
  };
}

export async function verifyUserRegistrationOtp(input: {
  verificationId: string;
  code: string;
}) {
  const now = new Date();
  const user = await db.transaction(async (tx) => {
    const [verification] = await tx
      .select()
      .from(registrationVerifications)
      .where(eq(registrationVerifications.id, input.verificationId))
      .for("update")
      .limit(1);

    if (!verification || verification.consumedAt) {
      throw badRequest("Invalid verification code");
    }

    if (verification.expiresAt.getTime() <= now.getTime()) {
      await tx
        .update(registrationVerifications)
        .set({ consumedAt: now, updatedAt: now })
        .where(eq(registrationVerifications.id, verification.id));
      throw badRequest("Verification code expired");
    }

    if (verification.attemptCount >= OTP_MAX_ATTEMPTS) {
      throw badRequest("Too many verification attempts");
    }

    if (hashOtpCode(input.code) !== verification.otpHash) {
      await tx
        .update(registrationVerifications)
        .set({ attemptCount: verification.attemptCount + 1, updatedAt: now })
        .where(eq(registrationVerifications.id, verification.id));
      throw badRequest("Invalid verification code");
    }

    const [existing] = await tx.select().from(users).where(eq(users.email, verification.email)).limit(1);
    if (existing?.passwordHash || existing?.role === USER_ROLE.admin) {
      throw conflict("Unable to register this account");
    }

    const [savedUser] = existing
      ? await tx
          .update(users)
          .set({
            name: verification.name,
            passwordHash: verification.passwordHash,
            emailVerifiedAt: now,
            updatedAt: now,
          })
          .where(eq(users.id, existing.id))
          .returning()
      : await tx
          .insert(users)
          .values({
            email: verification.email,
            name: verification.name,
            passwordHash: verification.passwordHash,
            emailVerifiedAt: now,
            role: DEFAULT_USER_ROLE,
            plan: DEFAULT_USER_PLAN,
          })
          .returning();

    await tx
      .update(registrationVerifications)
      .set({ consumedAt: now, updatedAt: now })
      .where(eq(registrationVerifications.id, verification.id));

    return toAuthUser(savedUser);
  });

  const session = await createSession(user, "user");
  return { user, ...session };
}

export type PortalAccessResult =
  | { allowed: true }
  | { allowed: false; reason: "admin-account-on-user-portal" | "not-admin-on-admin-portal" };

// Pure so it's directly unit-testable without a real OAuth/DB round-trip -
// THE decision behind strict portal separation (items 2-5): a resolved
// account's role must match the portal that started the login. Kept
// separate from completeGoogleLogin's I/O (Google token exchange, DB user
// upsert) specifically so this rule can be tested in isolation.
export function evaluatePortalAccess(userRole: UserRole, portal: AuthPortal): PortalAccessResult {
  if (portal === "admin" && userRole !== USER_ROLE.admin) {
    return { allowed: false, reason: "not-admin-on-admin-portal" };
  }
  if (portal === "user" && userRole === USER_ROLE.admin) {
    return { allowed: false, reason: "admin-account-on-user-portal" };
  }
  return { allowed: true };
}

export type CompleteGoogleLoginResult =
  | { ok: true; user: AuthUser; accessToken: string; refreshToken: string }
  | { ok: false; reason: "admin-account-on-user-portal" | "not-admin-on-admin-portal" };

// The resolved Google account's role must match the portal that started
// this login BEFORE any session is created (see evaluatePortalAccess).
// Neither rejection branch below calls createSession - no refresh-token DB
// row, no access token, no cookie ever gets set for a rejected login. This
// is the ONE place that decides whether a login is even allowed to
// proceed, independent of (and before) anything the success-path redirect
// logic in auth.routes.ts does.
export async function completeGoogleLogin(
  code: string,
  portal: AuthPortal
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

export async function createSession(user: AuthUser, portal: AuthPortal) {
  const rawRefreshToken = createRefreshToken();
  const refreshTokenHash = hashRefreshToken(rawRefreshToken);
  const familyId = randomUUID();
  const expiresAt = new Date(Date.now() + getRefreshTokenTtlMs(portal));

  await db.insert(refreshTokens).values({
    userId: user.id,
    tokenHash: refreshTokenHash,
    familyId,
    portal,
    expiresAt,
  });

  return {
    accessToken: signAccessToken(userToAuthPayload(user, portal), getAccessTokenTtlSeconds(portal)),
    refreshToken: rawRefreshToken,
  };
}

// expectedPortal is REQUIRED and validated against the stored token row
// (item 7/10): a refresh token issued to one portal must never rotate into
// a session for the other portal, no matter which endpoint/cookie
// presented it - a mismatch is treated identically to "token not found"
// so it leaks no information about which portal the token actually
// belongs to.
export async function rotateRefreshToken(rawRefreshToken: string, expectedPortal: AuthPortal) {
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

    if (!existingToken || existingToken.portal !== expectedPortal) {
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
        portal: expectedPortal,
        expiresAt: new Date(Date.now() + getRefreshTokenTtlMs(expectedPortal)),
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
      accessToken: signAccessToken(
        userToAuthPayload(authUser, expectedPortal),
        getAccessTokenTtlSeconds(expectedPortal)
      ),
      refreshToken: nextRawToken,
    };
  });
}

export async function revokeRefreshToken(rawRefreshToken: string, portal: AuthPortal) {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(refreshTokens.tokenHash, hashRefreshToken(rawRefreshToken)), eq(refreshTokens.portal, portal))
    );
}

export async function getCurrentUser(userId: string) {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw unauthorized();
  return toAuthUser(user);
}
