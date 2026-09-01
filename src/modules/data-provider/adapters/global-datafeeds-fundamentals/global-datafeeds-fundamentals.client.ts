import { HTTP_STATUS } from "../../../../shared/constants";
import {
  AppError,
  ERROR_CODES,
  ERROR_MESSAGES,
} from "../../../../shared/errors";
import { env } from "../../../../shared/env";

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

async function requestValue<T>(
  path: string,
  params: Record<string, string>,
): Promise<T[]> {
  requireConfig();

  const response = await fetch(buildUrl(path, params));
  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new AppError(
      HTTP_STATUS.badGateway,
      ERROR_CODES.providerError,
      `Global Datafeeds Fundamentals request failed (${response.status}): ${bodyText.slice(0, 300)}`,
    );
  }

  const body = (await response.json()) as { Value?: T[] };
  return Array.isArray(body.Value) ? body.Value : [];
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
