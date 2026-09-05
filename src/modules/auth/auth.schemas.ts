import { z } from "zod";

const emailSchema = z.string().trim().email().max(255);
const loginPasswordSchema = z.string().min(1).max(256);
const registrationPasswordSchema = z.string().min(8).max(128);
const turnstileTokenSchema = z.string().min(1).optional();

export const googleAuthUrlQuerySchema = z
  .object({
    portal: z.enum(["admin"]).optional(),
  })
  .strict();

export const googleCallbackQuerySchema = z
  .object({
    code: z.string().min(1).optional(),
    state: z.string().min(1).optional(),
    error: z.string().min(1).optional(),
  })
  .passthrough();

export const passwordLoginBodySchema = z
  .object({
    email: emailSchema,
    password: loginPasswordSchema,
    turnstileToken: turnstileTokenSchema,
  })
  .strict();

export const registrationRequestBodySchema = z
  .object({
    name: z.string().trim().min(2).max(255),
    email: emailSchema,
    password: registrationPasswordSchema,
    turnstileToken: turnstileTokenSchema,
  })
  .strict();

export const registrationVerifyBodySchema = z
  .object({
    verificationId: z.string().uuid(),
    code: z.string().trim().regex(/^\d{6}$/),
  })
  .strict();

export const registrationResendBodySchema = z
  .object({
    verificationId: z.string().uuid(),
  })
  .strict();
