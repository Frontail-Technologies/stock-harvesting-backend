export const GENERIC_LOGIN_ERROR = "Invalid email or password";
export const OTP_EXPIRY_MS = 10 * 60 * 1000;
export const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;

export const PASSWORD_RESET_TOKEN_EXPIRY_MS = 30 * 60 * 1000;
export const GENERIC_PASSWORD_RESET_REQUEST_MESSAGE =
  "If an account exists for this email, a password reset link has been sent.";
export const GENERIC_PASSWORD_RESET_TOKEN_ERROR = "This reset link is invalid or has expired";
export const ACCOUNT_EXISTS_WITH_PASSWORD_MESSAGE =
  "An account already exists with this email. Please sign in using your password.";
export const ACCOUNT_EXISTS_WITH_GOOGLE_MESSAGE =
  "An account already exists with this email. Please sign in using Google.";
