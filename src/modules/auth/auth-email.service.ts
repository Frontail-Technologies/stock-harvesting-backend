import { createTransport, type Transporter } from "nodemailer";

import { HTTP_STATUS } from "../../shared/constants";
import { env } from "../../shared/env";
import { AppError, ERROR_CODES, getErrorMessage } from "../../shared/errors";
import { logger } from "../../shared/logger";

let transporter: Transporter | null = null;

function getTransporter() {
  if (!env.SMTP_USER || !env.SMTP_PASSWORD) return null;
  if (!transporter) {
    transporter = createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
    });
  }
  return transporter;
}

async function sendEmail(input: { to: string; subject: string; text: string }) {
  const client = getTransporter();
  if (!client) {
    if (env.NODE_ENV === "production") {
      throw new AppError(
        HTTP_STATUS.internalServerError,
        ERROR_CODES.internalError,
        "Email delivery is not configured"
      );
    }
    return;
  }

  try {
    await client.sendMail({
      from: env.SMTP_FROM ?? env.SMTP_USER,
      to: input.to,
      subject: input.subject,
      text: input.text,
    });
  } catch (error) {
    logger.error(
      { to: input.to, message: getErrorMessage(error, "Unknown SMTP error") },
      "SMTP email delivery failed"
    );
    throw new AppError(
      HTTP_STATUS.internalServerError,
      ERROR_CODES.internalError,
      "Email delivery failed",
      error instanceof Error ? { message: error.message } : undefined
    );
  }
}

type RegistrationOtpEmail = {
  email: string;
  name: string;
  code: string;
};

export async function sendRegistrationOtpEmail(input: RegistrationOtpEmail) {
  await sendEmail({
    to: input.email,
    subject: "Your Stock Harvesting verification code",
    text: `Hi ${input.name}, your Stock Harvesting verification code is ${input.code}. It expires in 10 minutes.`,
  });
}

type PasswordResetEmail = {
  email: string;
  name: string;
  resetUrl: string;
};

export async function sendPasswordResetEmail(input: PasswordResetEmail) {
  await sendEmail({
    to: input.email,
    subject: "Reset your Stock Harvesting password",
    text: `Hi ${input.name}, use this link to reset your Stock Harvesting password: ${input.resetUrl}. It expires in 30 minutes. If you didn't request this, you can ignore this email.`,
  });
}
