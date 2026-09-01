import { env } from "../../../shared/env";
import { getErrorMessage } from "../../../shared/errors";
import { EODHD_BASE_URL } from "./eodhd-data-provider.adapter";

const EXCHANGE_PROBES = [
  {
    exchangeCode: "US",
    symbols: ["AAPL", "MSFT", "NVDA", "GOOGL", "AMZN"],
  },
  {
    exchangeCode: "XNSE",
    symbols: ["RELIANCE", "TCS", "INFY", "HDFCBANK", "SBIN"],
  },
  {
    exchangeCode: "NSE",
    symbols: ["RELIANCE", "TCS", "INFY", "HDFCBANK", "SBIN"],
  },
] as const;

type ProbeResult = {
  status: number | "request_failed" | "missing_token";
  url: string;
  supported: boolean;
  rowsReturned?: number;
};

type EodhdCandleRow = {
  date?: string;
  open?: number | string;
  high?: number | string;
  low?: number | string;
  close?: number | string;
  volume?: number | string;
};

export async function runEodhdProviderDiagnostics() {
  const exchangeReports = [];

  for (const probe of EXCHANGE_PROBES) {
    const { exchangeCode } = probe;
    const exchangeDetailsProbe = await probeJson(
      `/v2/exchange-details/${exchangeCode}`,
      {},
      isObjectLike
    );
    const symbolListProbe = await probeJson(
      `/exchange-symbol-list/${exchangeCode}`,
      {},
      Array.isArray
    );
    const eodProbes = [];

    for (const symbol of probe.symbols) {
      const ticker = `${symbol}.${exchangeCode}`;
      const dailyProbe = await probeJson(
        `/eod/${ticker}`,
        {
          from: getDiagnosticsFromDate(),
          to: getTodayDate(),
          period: "d",
          order: "a",
        },
        isOhlcvResponse
      );

      eodProbes.push({
        symbol,
        ticker,
        status: dailyProbe.status,
        url: dailyProbe.url,
        ohlcvDataReturned: dailyProbe.supported,
        rowsReturned: dailyProbe.rowsReturned ?? 0,
      });
    }

    const workingTicker = eodProbes.find((probe) => probe.ohlcvDataReturned);

    exchangeReports.push({
      exchangeCode,
      exchangeDetailsSupported: exchangeDetailsProbe.supported,
      exchangeDetailsStatus: exchangeDetailsProbe.status,
      exchangeDetailsUrl: exchangeDetailsProbe.url,
      symbolListSupported: symbolListProbe.supported,
      symbolListStatus: symbolListProbe.status,
      symbolListUrl: symbolListProbe.url,
      symbolListCount: symbolListProbe.rowsReturned ?? 0,
      eodCandlesSupported: Boolean(workingTicker),
      workingTickerFormat: workingTicker ? `${workingTicker.symbol}.${exchangeCode}` : null,
      eodProbes,
    });
  }

  const workingExchange = exchangeReports.find((report) => report.eodCandlesSupported);

  console.log(
    JSON.stringify({
      kind: "eodhdCapabilitySummary",
      exchangeDetailsSupported: exchangeReports.some(
        (report) => report.exchangeDetailsSupported
      ),
      symbolListSupported: exchangeReports.some((report) => report.symbolListSupported),
      eodCandlesSupported: Boolean(workingExchange),
      workingExchangeCode: workingExchange?.exchangeCode ?? null,
      workingTickerFormat: workingExchange?.workingTickerFormat ?? null,
      usableForProject: Boolean(workingExchange),
      usabilityRule: "usable only when /api/eod/{ticker} returns OHLCV data",
      exchangeReports,
    })
  );
}

async function probeJson(
  path: string,
  params: Record<string, string>,
  isSupportedResponse: (json: unknown) => boolean
): Promise<ProbeResult> {
  const url = createEodhdUrl(path, params);

  if (!env.EODHD_API_TOKEN) {
    return {
      status: "missing_token",
      url: toSafeUrl(url),
      supported: false,
    };
  }

  try {
    const response = await fetch(url);
    const json = response.ok ? await response.json() : null;
    const supported = response.ok && isSupportedResponse(json);

    return {
      status: response.status,
      url: toSafeUrl(url),
      supported,
      rowsReturned: Array.isArray(json) ? json.length : undefined,
    };
  } catch {
    return {
      status: "request_failed",
      url: toSafeUrl(url),
      supported: false,
    };
  }
}

function createEodhdUrl(path: string, params: Record<string, string>) {
  const url = new URL(`${EODHD_BASE_URL}${path}`);
  url.searchParams.set("api_token", env.EODHD_API_TOKEN ?? "");
  url.searchParams.set("fmt", "json");

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  return url;
}

function isObjectLike(value: unknown) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOhlcvResponse(value: unknown) {
  return Array.isArray(value) && value.some(isOhlcvRow);
}

function isOhlcvRow(value: unknown): value is EodhdCandleRow {
  if (!isObjectLike(value)) return false;

  const row = value as EodhdCandleRow;
  return Boolean(
    row.date &&
      isFiniteNumberLike(row.open) &&
      isFiniteNumberLike(row.high) &&
      isFiniteNumberLike(row.low) &&
      isFiniteNumberLike(row.close) &&
      isFiniteNumberLike(row.volume)
  );
}

function isFiniteNumberLike(value: unknown) {
  return Number.isFinite(Number(value));
}

function toSafeUrl(url: URL) {
  const safeUrl = new URL(url);
  safeUrl.searchParams.set("api_token", "[redacted]");
  return safeUrl.toString();
}

function getTodayDate() {
  return new Date().toISOString().slice(0, 10);
}

function getDiagnosticsFromDate() {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - 2);
  return date.toISOString().slice(0, 10);
}

if (require.main === module) {
  runEodhdProviderDiagnostics().catch((error) => {
    console.error(getErrorMessage(error, "Unknown EODHD error"));
    process.exitCode = 1;
  });
}
