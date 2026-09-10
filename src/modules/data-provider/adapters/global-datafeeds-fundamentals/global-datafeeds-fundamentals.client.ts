import { HTTP_STATUS } from "../../../../shared/constants";
import {
  AppError,
  ERROR_CODES,
  ERROR_MESSAGES,
  providerError,
} from "../../../../shared/errors";
import { env } from "../../../../shared/env";
import { logger } from "../../../../shared/logger";

export type GlobalDatafeedsSector = {
  code: string;
  name: string;
};

export type GlobalDatafeedsClassificationRow = {
  Symbol?: string;
  CompanyName?: string;
  SectCode?: string;
  Sector?: string;
  IndustryCode?: string;
  Industry?: string;
  BasicIndustryCode?: string;
  BasicIndustry?: string;
  ISIN?: string;
};

// Descriptive label only - there is no dataProviderConnections row for the
// Fundamentals sub-product; this just tags logs and the client-safe error
// `details` so an admin can tell which upstream failed.
const FUNDAMENTALS_PROVIDER_LABEL = "global-datafeeds-fundamentals";

// The Fundamentals REST host is an old Kestrel/.NET service with two quirks
// this client has to absorb:
//
//  1. Transport: it has been seen to drop the TCP connection with no HTTP
//     response at all (undici surfaces this as `TypeError: fetch failed` ->
//     `SocketError: other side closed`), e.g. on a transient network blip.
//     Without handling, that raw TypeError escaped as an unhandled 500.
//
//  2. Auth handshake: the FIRST request against a cold server-side session
//     can come back as `HTTP 408` with the exact body
//     "Authentication request received. Try request data in next moment." -
//     the provider is telling us to reissue the SAME request a moment later.
//     This is a documented-by-behaviour handshake state, not a real failure.
//
// Retries for the two are counted SEPARATELY and the loop is capped by an
// additive total (see FUNDAMENTALS_MAX_TOTAL_ATTEMPTS) so they can never
// multiply into a retry storm. Everything else - 400 "Key Expired",
// 401/403, an unrelated 408, any other 4xx/5xx - is final on the first
// response, never retried.
const FUNDAMENTALS_REQUEST_TIMEOUT_MS = 15_000;
const FUNDAMENTALS_MAX_NETWORK_RETRIES = 2;
const FUNDAMENTALS_NETWORK_RETRY_BASE_DELAY_MS = 400;
const FUNDAMENTALS_MAX_HANDSHAKE_RETRIES = 2;
const FUNDAMENTALS_HANDSHAKE_RETRY_DELAY_MS = 800;
// 1 initial attempt + every network retry + every handshake retry. Additive,
// not multiplicative: worst case is 1 + 2 + 2 = 5 HTTP attempts.
const FUNDAMENTALS_MAX_TOTAL_ATTEMPTS =
  1 + FUNDAMENTALS_MAX_NETWORK_RETRIES + FUNDAMENTALS_MAX_HANDSHAKE_RETRIES;

// The provider's auth-handshake holding response. Matched on both stable
// fragments (case-insensitive) so a generic gateway/proxy 408 - which never
// carries this text - is NOT mistaken for the handshake and is failed
// immediately.
const AUTH_HANDSHAKE_BODY_FRAGMENTS = [
  "authentication request received",
  "try request data",
];

function isAuthHandshakePendingBody(bodyText: string): boolean {
  const normalized = bodyText.toLowerCase();
  return AUTH_HANDSHAKE_BODY_FRAGMENTS.every((fragment) => normalized.includes(fragment));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// undici network error codes (some on `error`, most on `error.cause`).
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);
const FATAL_NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPROTO",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
]);
const RETRYABLE_NETWORK_MESSAGE_HINTS = [
  "other side closed",
  "socket hang up",
  "terminated",
];

type NetworkErrorInfo = { isNetwork: boolean; retryable: boolean; safeMessage: string };

function inspectNetworkError(error: unknown): NetworkErrorInfo {
  const notNetwork: NetworkErrorInfo = {
    isNetwork: false,
    retryable: false,
    safeMessage: "",
  };
  if (!(error instanceof Error)) return notNetwork;

  const codes: string[] = [];
  const messages = [error.message];
  const topCode = (error as { code?: unknown }).code;
  if (typeof topCode === "string") codes.push(topCode);

  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    messages.push(cause.message);
    const causeCode = (cause as { code?: unknown }).code;
    if (typeof causeCode === "string") codes.push(causeCode);
  }

  const blob = messages.join(" | ").toLowerCase();
  const isAbort = error.name === "AbortError" || error.name === "TimeoutError";
  const messageLooksNetwork =
    blob.includes("fetch failed") ||
    RETRYABLE_NETWORK_MESSAGE_HINTS.some((hint) => blob.includes(hint));
  const codeLooksNetwork = codes.some(
    (code) => RETRYABLE_NETWORK_CODES.has(code) || FATAL_NETWORK_CODES.has(code)
  );

  if (!isAbort && !messageLooksNetwork && !codeLooksNetwork) return notNetwork;

  const retryable =
    isAbort ||
    codes.some((code) => RETRYABLE_NETWORK_CODES.has(code)) ||
    (RETRYABLE_NETWORK_MESSAGE_HINTS.some((hint) => blob.includes(hint)) &&
      !codes.some((code) => FATAL_NETWORK_CODES.has(code)));

  const firstCode = codes[0];
  const safeMessage = isAbort
    ? "request timed out"
    : firstCode
      ? `network error (${firstCode})`
      : "network error";

  return { isNetwork: true, retryable, safeMessage };
}

function isConfigured() {
  return Boolean(
    env.GLOBAL_DATAFEEDS_FUNDAMENTALS_ENABLED &&
    env.GLOBAL_DATAFEEDS_FUNDAMENTALS_ACCESS_KEY,
  );
}

function requireConfig() {
  if (!isConfigured()) {
    throw new AppError(
      HTTP_STATUS.internalServerError,
      ERROR_CODES.internalError,
      ERROR_MESSAGES.providerNotConfigured,
    );
  }
}

function buildUrl(path: string, params: Record<string, string>) {
  const url = new URL(path, env.GLOBAL_DATAFEEDS_FUNDAMENTALS_BASE_URL);
  url.searchParams.set(
    "accessKey",
    env.GLOBAL_DATAFEEDS_FUNDAMENTALS_ACCESS_KEY ?? "",
  );
  url.searchParams.set("exchange", env.GLOBAL_DATAFEEDS_FUNDAMENTALS_EXCHANGE);
  url.searchParams.set("format", "Json");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url;
}

const NETWORK_FAILURE_MESSAGE =
  "GlobalDataFeeds Fundamentals is currently unreachable. Verify the Fundamentals base URL (scheme/host/port) and network access, then retry.";
const HANDSHAKE_FAILURE_MESSAGE =
  "GlobalDataFeeds Fundamentals did not complete its authentication handshake after several attempts. Retry the sync shortly.";

async function requestValue<T>(
  path: string,
  params: Record<string, string>,
): Promise<T[]> {
  requireConfig();

  const url = buildUrl(path, params);

  // Two independent budgets, drained by two unrelated conditions. Total HTTP
  // attempts can never exceed FUNDAMENTALS_MAX_TOTAL_ATTEMPTS regardless of
  // how they interleave.
  let networkRetriesLeft = FUNDAMENTALS_MAX_NETWORK_RETRIES;
  let handshakeRetriesLeft = FUNDAMENTALS_MAX_HANDSHAKE_RETRIES;

  for (let attempt = 1; attempt <= FUNDAMENTALS_MAX_TOTAL_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(FUNDAMENTALS_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const net = inspectNetworkError(error);
      // A non-transport error here is a real bug on our side - don't mask it.
      if (!net.isNetwork) throw error;

      logger.warn(
        { provider: FUNDAMENTALS_PROVIDER_LABEL, path, attempt, reason: net.safeMessage },
        "GlobalDataFeeds Fundamentals transport error",
      );

      if (net.retryable && networkRetriesLeft > 0) {
        networkRetriesLeft -= 1;
        await sleep(FUNDAMENTALS_NETWORK_RETRY_BASE_DELAY_MS * attempt);
        continue;
      }
      throw providerError(NETWORK_FAILURE_MESSAGE, {
        provider: FUNDAMENTALS_PROVIDER_LABEL,
        reason: "network",
      });
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");

      // The one provider-specific state we retry: a cold-session auth
      // handshake. ONLY an HTTP 408 whose body carries the exact holding
      // message qualifies - any other 408 (a gateway timeout, say) is a
      // normal failure.
      const isAuthHandshake =
        response.status === HTTP_STATUS.requestTimeout &&
        isAuthHandshakePendingBody(bodyText);

      if (isAuthHandshake && handshakeRetriesLeft > 0) {
        handshakeRetriesLeft -= 1;
        logger.info(
          { provider: FUNDAMENTALS_PROVIDER_LABEL, path, attempt },
          "GlobalDataFeeds Fundamentals auth handshake pending - reissuing the request",
        );
        await sleep(FUNDAMENTALS_HANDSHAKE_RETRY_DELAY_MS);
        continue;
      }

      if (isAuthHandshake) {
        // Handshake budget exhausted - deterministic, clearly-labelled error.
        throw providerError(HANDSHAKE_FAILURE_MESSAGE, {
          provider: FUNDAMENTALS_PROVIDER_LABEL,
          status: response.status,
          reason: "auth-handshake",
        });
      }

      // Any other HTTP error (400 "Key Expired", 401/403, unrelated 408,
      // 5xx, ...) - surfaced as-is, never retried.
      throw providerError(
        `Global Datafeeds Fundamentals request failed (${response.status}): ${bodyText.slice(0, 300)}`,
        { provider: FUNDAMENTALS_PROVIDER_LABEL, status: response.status },
      );
    }

    try {
      const body = (await response.json()) as { Value?: T[] };
      return Array.isArray(body.Value) ? body.Value : [];
    } catch {
      throw providerError(
        "GlobalDataFeeds Fundamentals returned a response that was not valid JSON.",
        { provider: FUNDAMENTALS_PROVIDER_LABEL, status: response.status },
      );
    }
  }

  // Unreachable: every attempt above either returns or throws once both
  // retry budgets are spent. Kept so the bound stays enforced if the
  // constants ever change.
  throw providerError(NETWORK_FAILURE_MESSAGE, {
    provider: FUNDAMENTALS_PROVIDER_LABEL,
    reason: "network",
  });
}

export async function fetchSectors(): Promise<GlobalDatafeedsSector[]> {
  const rows = await requestValue<{ Code?: string; Name?: string }>(
    "/GetSectors",
    {},
  );
  return rows
    .filter((row) => row.Name)
    .map((row) => ({ code: row.Code ?? "", name: row.Name ?? "" }));
}

export async function fetchSectoralClassificationBySector(
  sectorName: string,
): Promise<GlobalDatafeedsClassificationRow[]> {
  return requestValue<GlobalDatafeedsClassificationRow>(
    "/GetSectoralClassification",
    {
      sector: sectorName,
    },
  );
}

export function isGlobalDatafeedsFundamentalsConfigured() {
  return isConfigured();
}
