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

// The Fundamentals REST host is an old Kestrel/.NET service. It has been seen
// to drop the TCP connection with no HTTP response at all (undici surfaces
// this as `TypeError: fetch failed` -> `SocketError: other side closed`),
// e.g. when the configured base URL scheme/port don't match what the server
// actually speaks, or on a transient network blip. Without handling, that
// raw TypeError escaped as an unhandled 500. These bounds turn every
// transport-level failure into a normal PROVIDER_ERROR (502) with a
// credential-free message, and give a genuinely transient socket error a
// small bounded retry - never a 4xx like "Key Expired", which is returned
// as-is.
const FUNDAMENTALS_REQUEST_TIMEOUT_MS = 15_000;
const FUNDAMENTALS_NETWORK_ATTEMPTS = 3; // 1 initial try + 2 retries
const FUNDAMENTALS_NETWORK_RETRY_BASE_DELAY_MS = 400;

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

async function requestValue<T>(
  path: string,
  params: Record<string, string>,
): Promise<T[]> {
  requireConfig();

  const url = buildUrl(path, params);

  for (let attempt = 1; attempt <= FUNDAMENTALS_NETWORK_ATTEMPTS; attempt++) {
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

      if (net.retryable && attempt < FUNDAMENTALS_NETWORK_ATTEMPTS) {
        await sleep(FUNDAMENTALS_NETWORK_RETRY_BASE_DELAY_MS * attempt);
        continue;
      }
      throw providerError(NETWORK_FAILURE_MESSAGE, {
        provider: FUNDAMENTALS_PROVIDER_LABEL,
        reason: "network",
      });
    }

    if (!response.ok) {
      // A real HTTP response from the provider (e.g. 400 "Key Expired") -
      // surfaced as-is, never retried.
      const bodyText = await response.text().catch(() => "");
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

  // Loop only exits via return/throw above; this satisfies the type checker.
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
