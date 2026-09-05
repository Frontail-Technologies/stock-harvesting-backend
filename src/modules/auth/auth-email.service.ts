import { HTTP_STATUS } from "../../shared/constants";
import { env } from "../../shared/env";
import { AppError, ERROR_CODES } from "../../shared/errors";

type RegistrationOtpEmail = {
  email: string;
  name: string;
  code: string;
};

export async function sendRegistrationOtpEmail(input: RegistrationOtpEmail) {
  if (!env.AUTH_OTP_EMAIL_WEBHOOK_URL) {
    if (env.NODE_ENV === "production") {
      throw new AppError(
        HTTP_STATUS.internalServerError,
        ERROR_CODES.internalError,
        "OTP email delivery is not configured"
      );
    }
    return;
  }

  const response = await fetch(env.AUTH_OTP_EMAIL_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(env.AUTH_OTP_EMAIL_WEBHOOK_TOKEN
        ? { authorization: `Bearer ${env.AUTH_OTP_EMAIL_WEBHOOK_TOKEN}` }
        : {}),
    },
    body: JSON.stringify({
      to: input.email,
      subject: "Your Stock Harvesting verification code",
      text: `Hi ${input.name}, your Stock Harvesting verification code is ${input.code}. It expires in 10 minutes.`,
    }),
  });

  if (!response.ok) {
    throw new AppError(
      HTTP_STATUS.internalServerError,
      ERROR_CODES.internalError,
      "OTP email delivery failed"
    );
  }
}
