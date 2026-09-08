import { and, eq, isNull } from "drizzle-orm";

import { db } from "../../db/client";
import { registrationVerifications, users } from "../../db/schema";
import { DEFAULT_USER_PLAN, DEFAULT_USER_ROLE, USER_ROLE } from "../../shared/constants";
import { badRequest, conflict } from "../../shared/errors";
import { createOtpCode, hashOtpCode, hashPassword, normalizeEmail } from "../security/passwords";
import { sendRegistrationOtpEmail } from "./auth-email.service";
import { OTP_EXPIRY_MS, OTP_MAX_ATTEMPTS, OTP_RESEND_COOLDOWN_MS } from "./auth.constants";
import { toAuthUser } from "./auth.helpers";
import { createSession } from "./session.service";

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
      .where(
        and(
          eq(registrationVerifications.email, email),
          isNull(registrationVerifications.consumedAt),
        ),
      );

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

  if (
    !verification ||
    verification.consumedAt ||
    verification.expiresAt.getTime() <= now.getTime()
  ) {
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

  await sendRegistrationOtpEmail({
    email: updated.email,
    name: updated.name,
    code,
  });

  return {
    verificationId: updated.id,
    expiresAt: updated.expiresAt,
    resendAvailableAt: updated.resendAvailableAt,
  };
}

export async function verifyUserRegistrationOtp(input: { verificationId: string; code: string }) {
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

    const [existing] = await tx
      .select()
      .from(users)
      .where(eq(users.email, verification.email))
      .limit(1);
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
