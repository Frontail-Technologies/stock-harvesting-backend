import { and, eq, isNull } from "drizzle-orm";

import { db } from "../../db/client";
import { passwordResetTokens, refreshTokens, users } from "../../db/schema";
import { env } from "../../shared/env";
import { badRequest } from "../../shared/errors";
import {
  createPasswordResetToken,
  hashPassword,
  hashPasswordResetToken,
  normalizeEmail,
} from "../security/passwords";
import {
  GENERIC_PASSWORD_RESET_REQUEST_MESSAGE,
  GENERIC_PASSWORD_RESET_TOKEN_ERROR,
  PASSWORD_RESET_TOKEN_EXPIRY_MS,
} from "./auth.constants";
import { sendPasswordResetEmail } from "./auth-email.service";

export async function requestPasswordReset(input: { email: string }) {
  const email = normalizeEmail(input.email);
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

  if (user?.passwordHash) {
    const now = new Date();
    const rawToken = createPasswordResetToken();
    const expiresAt = new Date(now.getTime() + PASSWORD_RESET_TOKEN_EXPIRY_MS);

    await db.insert(passwordResetTokens).values({
      userId: user.id,
      tokenHash: hashPasswordResetToken(rawToken),
      expiresAt,
    });

    const resetUrl = `${env.WEB_APP_URL}/reset-password?token=${rawToken}`;
    await sendPasswordResetEmail({ email: user.email, name: user.name, resetUrl });
  }

  return { message: GENERIC_PASSWORD_RESET_REQUEST_MESSAGE };
}

export async function resetPassword(input: { token: string; password: string }) {
  const tokenHash = hashPasswordResetToken(input.token);
  const passwordHash = await hashPassword(input.password);
  const now = new Date();

  await db.transaction(async (tx) => {
    const [resetToken] = await tx
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.tokenHash, tokenHash))
      .for("update")
      .limit(1);

    if (!resetToken || resetToken.consumedAt || resetToken.expiresAt.getTime() <= now.getTime()) {
      throw badRequest(GENERIC_PASSWORD_RESET_TOKEN_ERROR);
    }

    await tx
      .update(users)
      .set({ passwordHash, updatedAt: now })
      .where(eq(users.id, resetToken.userId));

    await tx
      .update(passwordResetTokens)
      .set({ consumedAt: now })
      .where(eq(passwordResetTokens.id, resetToken.id));

    await tx
      .update(refreshTokens)
      .set({ revokedAt: now })
      .where(and(eq(refreshTokens.userId, resetToken.userId), isNull(refreshTokens.revokedAt)));
  });

  return { ok: true };
}
