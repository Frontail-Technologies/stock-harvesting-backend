import pino from "pino";

import { env } from "./env";

const REDACTED = "[redacted]";

export const logger = pino({
  level: env.NODE_ENV === "test" ? "silent" : "info",
  redact: {
    censor: REDACTED,
    paths: [
      "authorization",
      "cookie",
      "headers.authorization",
      "headers.cookie",
      "req.headers",
      "req.raw.headers",
      "request.headers",
      "*.authorization",
      "*.cookie",
      "*.accessToken",
      "*.refreshToken",
      "*.access_token",
      "*.refresh_token",
      "*.apiToken",
      "*.api_token",
      "*.apiKey",
      "*.api_key",
      "*.encryptedApiKey",
      "*.encrypted_api_key",
      "*.ciphertext",
      "*.iv",
      "*.authTag",
      "err.params",
      "*.password",
      "*.secret",
      "*.token",
    ],
  },
});
