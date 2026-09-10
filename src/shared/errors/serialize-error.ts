// Turns any thrown value into a plain, log-safe object.
//
// `logger.error({ error }, "...")` with a bare Error logs `"error": {}` because
// pino only special-cases the `err` key and an Error's own name/message/stack are
// non-enumerable. Log the result of this under any key, or pass the Error itself
// as `err`. Includes only name / message / code and a shallow cause - never a
// stack, never arbitrary enumerable props (which can carry request/credential
// context on some vendor error shapes).
const MAX_MESSAGE_LEN = 1_000;

export type SerializedError = {
  name: string;
  message: string;
  code?: string;
  cause?: { name?: string; message?: string; code?: string };
};

function readCode(value: unknown): string | undefined {
  const code = (value as { code?: unknown } | null)?.code;
  return typeof code === "string" || typeof code === "number" ? String(code) : undefined;
}

export function serializeError(error: unknown): SerializedError {
  if (!(error instanceof Error)) {
    return { name: "NonError", message: String(error).slice(0, MAX_MESSAGE_LEN) };
  }

  const serialized: SerializedError = {
    name: error.name || "Error",
    message: (error.message || "").slice(0, MAX_MESSAGE_LEN),
  };

  const code = readCode(error);
  if (code) serialized.code = code;

  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const causeCode = readCode(cause);
    serialized.cause = {
      ...(cause.name ? { name: cause.name } : {}),
      ...(cause.message ? { message: cause.message.slice(0, MAX_MESSAGE_LEN) } : {}),
      ...(causeCode ? { code: causeCode } : {}),
    };
  } else if (cause !== undefined && cause !== null) {
    serialized.cause = { message: String(cause).slice(0, MAX_MESSAGE_LEN) };
  }

  return serialized;
}
