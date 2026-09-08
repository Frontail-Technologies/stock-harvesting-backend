import { and, eq, isNull } from "drizzle-orm";
import { randomUUID } from "crypto";

import { db } from "../../db/client";
import { refreshTokens, users } from "../../db/schema";
import { USER_ROLE, type AuthPortal, type UserRole } from "../../shared/constants";
import { env } from "../../shared/env";
import { unauthorized } from "../../shared/errors";
import { getRefreshTokenTtlMs } from "../security/cookies";
import { createRefreshToken, hashRefreshToken, signAccessToken } from "../security/tokens";
import { toAuthUser } from "./auth.helpers";
import type { AuthUser } from "./auth.types";

function getAccessTokenTtlSeconds(portal: AuthPortal): number {
  return portal === "admin"
    ? env.ADMIN_ACCESS_TOKEN_TTL_SECONDS
    : env.USER_ACCESS_TOKEN_TTL_SECONDS;
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

export type PortalAccessResult =
  | { allowed: true }
  | {
      allowed: false;
      reason: "admin-account-on-user-portal" | "not-admin-on-admin-portal";
    };

export function evaluatePortalAccess(userRole: UserRole, portal: AuthPortal): PortalAccessResult {
  if (portal === "admin" && userRole !== USER_ROLE.admin) {
    return { allowed: false, reason: "not-admin-on-admin-portal" };
  }
  if (portal === "user" && userRole === USER_ROLE.admin) {
    return { allowed: false, reason: "admin-account-on-user-portal" };
  }
  return { allowed: true };
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

export async function rotateRefreshToken(rawRefreshToken: string, expectedPortal: AuthPortal) {
  const tokenHash = hashRefreshToken(rawRefreshToken);

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
          and(
            eq(refreshTokens.familyId, existingToken.familyId),
            isNull(refreshTokens.revokedAt),
          ),
        );
      throw unauthorized("Refresh token reuse detected");
    }

    if (existingToken.expiresAt.getTime() < Date.now()) {
      throw unauthorized("Refresh token expired");
    }

    const [user] = await tx
      .select()
      .from(users)
      .where(eq(users.id, existingToken.userId))
      .limit(1);
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
        getAccessTokenTtlSeconds(expectedPortal),
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
      and(
        eq(refreshTokens.tokenHash, hashRefreshToken(rawRefreshToken)),
        eq(refreshTokens.portal, portal),
      ),
    );
}

export async function getCurrentUser(userId: string) {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw unauthorized();
  return toAuthUser(user);
}
