import pino from "pino";

import { env } from "./env";

const REDACTED = "[redacted]";

const MAX_ERROR_TEXT_LENGTH = 2_000;

function truncateText(value: unknown) {
  return typeof value === "string" && value.length > MAX_ERROR_TEXT_LENGTH
    ? `${value.slice(0, MAX_ERROR_TEXT_LENGTH)}... [truncated ${value.length - MAX_ERROR_TEXT_LENGTH} chars]`
    : value;
}

// A failed query's message embeds the whole SQL text with every bound value (one lookup with ~5,900
// instrument ids produced 548 KB log lines), so the error message, stack and cause are capped.
export function serializeErrorForLog(error: unknown, depth = 0): unknown {
  const serialized = pino.stdSerializers.err(error as Error) as Record<string, unknown>;
  if (!serialized || typeof serialized !== "object") return serialized;
  serialized.message = truncateText(serialized.message);
  serialized.stack = truncateText(serialized.stack);
  // pino's serializer drops `cause`, which is where the driver's real error (code, message) lives.
  const cause = (error as { cause?: unknown } | null)?.cause;
  if (cause instanceof Error && depth < 3) {
    serialized.cause = serializeErrorForLog(cause, depth + 1);
  }
  return serialized;
}

export const logger = pino({
  level: env.NODE_ENV === "test" ? "silent" : "info",
  serializers: { err: serializeErrorForLog },
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
