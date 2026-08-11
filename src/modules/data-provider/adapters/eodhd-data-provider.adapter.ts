import { DATA_PROVIDER_KEY, HTTP_STATUS, PROVIDER_STATUS } from "../../../shared/constants";
import { env } from "../../../shared/env";
import { AppError, ERROR_CODES, ERROR_MESSAGES } from "../../../shared/errors";
import { logger } from "../../../shared/logger";
import { normalizeSymbol } from "../../../shared/normalize";
import type {
  DataProviderAdapter,
  ProviderDailyCandle,
  ProviderExchange,
  ProviderHealthStatus,
  ProviderInstrument,
  ProviderSymbolDailyCandle,
} from "../data-provider.types";
import {
  configuredProviderConnected,
  configuredProviderMissing,
  getConfiguredExpiryHealth,
  providerHealthFromError,
} from "../provider-health";

const EODHD_BASE_URL = "https://eodhd.com/api";
const EODHD_SETTINGS_URL = "https://eodhd.com/cp/settings";
const EODHD_TEST_SYMBOLS = ["AAPL", "MSFT", "NVDA", "GOOGL", "AMZN"] as const;

type EodhdExchangeRow = {
  Code?: string;
  Name?: string;
  Country?: string;
  CountryISO2?: string;
  CountryISO3?: string;
  OperatingMIC?: string;
  Currency?: string;
};

type EodhdSymbolRow = {
  Code?: string;
  Name?: string;
  Exchange?: string;
  Currency?: string;
  Type?: string;
  Isin?: string;
};

type EodhdCoverageDiscovery = {
  selectedExchangeCode: string;
  selectedExchange: EodhdExchangeRow | null;
  testMatches: EodhdSymbolRow[];
  candleSupported: boolean;
};

type EodhdCandleRow = {
  code?: string;
  Code?: string;
  exchange?: string;
  Exchange?: string;
  date?: string;
  open?: number | string;
  high?: number | string;
  low?: number | string;
  close?: number | string;
  adjusted_close?: number | string;
  adjustedClose?: number | string;
  volume?: number | string;
};

function requireProviderConfig() {
  if (!env.EODHD_API_TOKEN) {
    throw new AppError(
      HTTP_STATUS.internalServerError,
      ERROR_CODES.internalError,
      ERROR_MESSAGES.providerNotConfigured
    );
  }
}

function createEodhdUrl(path: string, params: Record<string, string | undefined> = {}) {
  requireProviderConfig();

  const url = new URL(`${EODHD_BASE_URL}${path}`);
  url.searchParams.set("api_token", env.EODHD_API_TOKEN ?? "");
  url.searchParams.set("fmt", "json");

  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }

  return url;
}

function toEodhdTicker(symbol: string, exchangeCode: string) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const suffix = `.${exchangeCode}`;

  return normalizedSymbol.endsWith(suffix)
    ? normalizedSymbol
    : `${normalizedSymbol}${suffix}`;
}

function fromEodhdTicker(symbol: string, exchangeCode: string) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const suffix = `.${exchangeCode}`;

  return normalizedSymbol.endsWith(suffix)
    ? normalizedSymbol.slice(0, -suffix.length)
    : normalizedSymbol;
}

function toDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}
function toFiniteNumber(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

async function readJsonResponse<T>(response: Response, failureMessage: string) {
  if (!response.ok) {
    throw new AppError(
      HTTP_STATUS.badGateway,
      ERROR_CODES.badRequest,
      `${failureMessage} (${response.status})`
    );
  }

  const json = (await response.json()) as unknown;

  if (typeof json === "object" && json !== null && "errors" in json) {
    throw new AppError(
      HTTP_STATUS.badGateway,
      ERROR_CODES.badRequest,
      failureMessage
    );
  }

  return json as T;
}

export class EodhdDataProviderAdapter implements DataProviderAdapter {
  readonly providerKey = DATA_PROVIDER_KEY.eodhd;
  readonly requiresConnection = false;
  private coverageDiscoveryPromise: Promise<EodhdCoverageDiscovery> | null = null;

  isConfigured() {
    return Boolean(env.EODHD_API_TOKEN);
  }

  getConnectUrl() {
    return EODHD_SETTINGS_URL;
  }
  async checkConnection(): Promise<ProviderHealthStatus> {
    if (!this.isConfigured()) {
      return configuredProviderMissing("EODHD API token is not configured");
    }

    const expiryHealth = getConfiguredExpiryHealth("EODHD", env.EODHD_EXPIRES_AT);
    if (expiryHealth) return expiryHealth;

    try {
      const to = toDateOnly(new Date());
      const from = toDateOnly(new Date(Date.now() - 21 * 24 * 60 * 60 * 1000));
      const candles = await this.fetchDailyCandles({
        symbol: "AAPL",
        instrumentToken: "AAPL.US",
        exchangeCode: "US",
        from,
        to,
      });

      if (candles.length === 0) {
        return {
          connected: false,
          status: PROVIDER_STATUS.error,
          errorMessage: "EODHD health check returned no candles",
        };
      }

      return configuredProviderConnected();
    } catch (error) {
      return providerHealthFromError(error);
    }
  }

  async exchangeRequestToken(): Promise<{
    accessToken: string;
    refreshToken?: string;
    accountId?: string;
    expiresAt?: Date;
  }> {
    throw new AppError(
      HTTP_STATUS.badRequest,
      ERROR_CODES.badRequest,
      "Selected data provider uses a server-side API token"
    );
  }

  async fetchExchanges(): Promise<ProviderExchange[]> {
    const url = createEodhdUrl("/exchanges-list/");
    const json = await readJsonResponse<EodhdExchangeRow[]>(
      await fetch(url),
      "Unable to fetch exchanges list"
    );

    return Array.isArray(json) ? json.filter((row) => row.Code).map(toProviderExchange) : [];
  }

  async fetchInstruments(input: { exchangeCode?: string } = {}): Promise<ProviderInstrument[]> {
    if (input.exchangeCode) {
      const exchangeCode = normalizeSymbol(input.exchangeCode);
      const rows = await fetchSymbolsForExchange(exchangeCode);

      return rows
        .filter((row) => row.Code)
        .map((row) => toProviderInstrument(row, exchangeCode));
    }

    const discovery = await this.getCoverageDiscovery();
    const rows = await fetchSymbolsForExchange(discovery.selectedExchangeCode);
    const symbols = rows.length > 0 ? rows : discovery.testMatches;

    return symbols
      .filter((row) => row.Code)
      .map((row) => toProviderInstrument(row, discovery.selectedExchangeCode));
  }

  async searchInstruments(
    query: string,
    exchangeCode?: string
  ): Promise<ProviderInstrument[]> {
    const json = await searchEodhdSymbols(query);
    const selectedExchangeCode = exchangeCode
      ? normalizeSymbol(exchangeCode)
      : ((await this.getCoverageDiscoveryOrNull())?.selectedExchangeCode ??
        getConfiguredEodhdExchangeCode());

    if (!Array.isArray(json)) return [];
    if (!selectedExchangeCode) return [];

    const rows = json
      .filter((row) => row.Code)
      .filter((row) => {
        return isSymbolOnSelectedExchange(row, selectedExchangeCode);
      });

    return rows.map((row) => toProviderInstrument(row, selectedExchangeCode));
  }

  async getInstrumentToken(symbol: string, exchangeCode?: string) {
    const selectedExchangeCode = exchangeCode
      ? normalizeSymbol(exchangeCode)
      : await this.getSelectedExchangeCode();
    return toEodhdTicker(symbol, selectedExchangeCode);
  }

  async fetchDailyCandles(input: {
    symbol: string;
    instrumentToken: string;
    from: string;
    to: string;
    exchangeCode?: string;
  }): Promise<ProviderDailyCandle[]> {
    const selectedExchangeCode = input.exchangeCode
      ? normalizeSymbol(input.exchangeCode)
      : await this.getSelectedExchangeCode();
    const tickerCandidates = getDailyCandleTickerCandidates({
      symbol: input.symbol,
      instrumentToken: input.instrumentToken,
      exchangeCode: selectedExchangeCode,
    });
    const failedTickers: Array<{ ticker: string; status: number }> = [];

    for (const ticker of tickerCandidates) {
      const url = createEodhdUrl(`/eod/${encodeURIComponent(ticker)}`, {
        from: input.from,
        to: input.to,
        period: "d",
        order: "a",
      });
      const response = await fetch(url);

      if (!response.ok) {
        failedTickers.push({ ticker, status: response.status });
        logger.debug(
          {
            ticker,
            status: response.status,
            from: input.from,
            to: input.to,
          },
          "EODHD daily candle request failed"
        );
        continue;
      }

      const json = await readJsonResponse<EodhdCandleRow[]>(
        response,
        "Unable to fetch daily candles"
      );

      if (!Array.isArray(json)) return [];

      logger.debug(
        {
          ticker,
          candlesReturned: json.length,
          failedTickers,
        },
        "EODHD daily candle request succeeded"
      );

      return json.flatMap((row) => {
        const candle = toProviderDailyCandle(row);
        return candle ? [candle] : [];
      });
    }

    throw new AppError(
      HTTP_STATUS.badGateway,
      ERROR_CODES.badRequest,
      "Unable to fetch daily candles",
      { failedTickers }
    );
  }

  async fetchLatestDailyCandles(input: {
    symbols?: string[];
    exchangeCode?: string;
  } = {}): Promise<ProviderSymbolDailyCandle[]> {
    const normalizedSymbols = input.symbols
      ?.map((symbol) => normalizeSymbol(symbol).split(".")[0])
      .filter(Boolean);
    const selectedExchangeCode = input.exchangeCode
      ? normalizeSymbol(input.exchangeCode)
      : await this.getSelectedExchangeCode();
    const symbols = normalizedSymbols
      ?.map((symbol) => toEodhdTicker(symbol, selectedExchangeCode))
      .filter(Boolean)
      .join(",");
    const url = createEodhdUrl(
      `/eod-bulk-last-day/${encodeURIComponent(selectedExchangeCode)}`,
      {
        symbols,
      }
    );
    let json: EodhdCandleRow[];

    try {
      json = await readJsonResponse<EodhdCandleRow[]>(
        await fetch(url),
        "Unable to fetch latest daily candles"
      );
    } catch (error) {
      if (!normalizedSymbols || normalizedSymbols.length === 0) {
        throw error;
      }

      return this.fetchLatestDailyCandlesByHistory(normalizedSymbols, selectedExchangeCode);
    }

    if (!Array.isArray(json)) return [];

    return json.flatMap((row) => {
      const symbol = fromEodhdTicker(
        row.code ?? row.Code ?? "",
        selectedExchangeCode
      );
      const candle = toProviderDailyCandle(row);

      return symbol && candle ? [{ ...candle, symbol }] : [];
    });
  }

  private async fetchLatestDailyCandlesByHistory(
    symbols: string[],
    selectedExchangeCode: string
  ): Promise<ProviderSymbolDailyCandle[]> {
    const from = getRecentHistoryFromDate();
    const to = getTodayDate();
    const candles: ProviderSymbolDailyCandle[] = [];

    for (const symbol of symbols) {
      let dailyCandles: ProviderDailyCandle[] = [];

      try {
        dailyCandles = await this.fetchDailyCandles({
          symbol,
          instrumentToken: symbol,
          from,
          to,
          exchangeCode: selectedExchangeCode,
        });
      } catch (error) {
        logger.debug(
          {
            symbol,
            message: error instanceof Error ? error.message : "Unknown provider error",
          },
          "EODHD latest candle history fallback skipped symbol"
        );
        continue;
      }

      const latest = dailyCandles[dailyCandles.length - 1];
      if (latest) {
        candles.push({
          ...latest,
          symbol: fromEodhdTicker(symbol, selectedExchangeCode),
        });
      }
    }

    return candles;
  }

  private getCoverageDiscovery() {
    if (!this.coverageDiscoveryPromise) {
      this.coverageDiscoveryPromise = discoverEodhdCoverage().catch((error) => {
        this.coverageDiscoveryPromise = null;
        throw error;
      });
    }

    return this.coverageDiscoveryPromise;
  }

  private async getCoverageDiscoveryOrNull() {
    try {
      return await this.getCoverageDiscovery();
    } catch (error) {
      logger.info(
        {
          fallbackExchangeCode: getConfiguredEodhdExchangeCode(),
          message: error instanceof Error ? error.message : "Unknown discovery error",
        },
        "EODHD coverage discovery unavailable; using configured exchange fallback"
      );
      return null;
    }
  }

  private async getSelectedExchangeCode() {
    const discovery = await this.getCoverageDiscoveryOrNull();
    const configuredExchangeCode = getConfiguredEodhdExchangeCode();

    if (discovery?.selectedExchangeCode) return discovery.selectedExchangeCode;
    if (configuredExchangeCode) return configuredExchangeCode;

    throw new AppError(
      HTTP_STATUS.badGateway,
      ERROR_CODES.badRequest,
      "Unable to resolve EODHD exchange code"
    );
  }
}

function toProviderExchange(row: EodhdExchangeRow): ProviderExchange {
  return {
    code: normalizeSymbol(row.Code ?? row.OperatingMIC ?? ""),
    name: row.Name?.trim() || row.Code || "Unknown exchange",
    currency: row.Currency?.trim() || "USD",
    country: row.Country?.trim() || "Unknown",
  };
}

function toProviderInstrument(
  row: EodhdSymbolRow,
  exchangeCode: string
): ProviderInstrument {
  const symbol = fromEodhdTicker(row.Code ?? "", exchangeCode);
  const instrumentToken = toEodhdTicker(row.Code ?? symbol, exchangeCode);

  return {
    exchange: exchangeCode,
    symbol,
    name: row.Name?.trim() || symbol,
    instrumentToken,
    segment: row.Type,
  };
}

async function discoverEodhdCoverage(): Promise<EodhdCoverageDiscovery> {
  const exchangesUrl = createEodhdUrl("/exchanges-list/");
  const exchanges = await readJsonResponse<EodhdExchangeRow[]>(
    await fetch(exchangesUrl),
    "Unable to discover EODHD exchanges"
  );
  const exchangeRows = Array.isArray(exchanges) ? exchanges : [];
  const marketRelatedExchanges = exchangeRows.filter(isConfiguredOrGlobalExchange);

  logger.info(
    {
      totalExchanges: exchangeRows.length,
      marketRelatedCount: marketRelatedExchanges.length,
      marketRelatedExchanges: marketRelatedExchanges.map(toExchangeDebugLog),
    },
    "EODHD coverage discovery: exchanges scanned"
  );

  const candidates = sortExchangeCandidates(marketRelatedExchanges);

  for (const exchange of candidates) {
    const exchangeCode = normalizeSymbol(exchange.Code ?? exchange.OperatingMIC ?? "");
    if (!exchangeCode) continue;

    const symbolRows = await fetchSymbolsForExchange(exchangeCode);
    const testMatches = symbolRows.filter((row) =>
      EODHD_TEST_SYMBOLS.includes(
        fromEodhdTicker(row.Code ?? "", exchangeCode) as (typeof EODHD_TEST_SYMBOLS)[number]
      )
    );

    logger.info(
      {
        selectedExchangeCandidate: exchangeCode,
        symbolCount: symbolRows.length,
        testSymbolMatchesFound: testMatches.length,
        testSymbolMatches: testMatches.map(toSymbolDebugLog),
      },
      "EODHD coverage discovery: symbol list probed"
    );

    if (testMatches.length > 0) {
      const candleSupported = await logCandleProbe(exchangeCode, testMatches[0]);

      logger.info(
        {
          selectedExchangeCode: exchangeCode,
          selectedExchange: toExchangeDebugLog(exchange),
          candleSupported,
          testSymbolMatches: testMatches.map(toSymbolDebugLog),
        },
        "EODHD coverage discovery: exchange selected"
      );

      return {
        selectedExchangeCode: exchangeCode,
        selectedExchange: exchange,
        testMatches,
        candleSupported,
      };
    }
  }

  const configuredExchange = getConfiguredEodhdExchangeCode();

  if (configuredExchange) {
    const configuredExchangeSymbols = await fetchSymbolsForExchange(configuredExchange);
    const configuredMatches = configuredExchangeSymbols.filter((row) =>
      EODHD_TEST_SYMBOLS.includes(
        fromEodhdTicker(row.Code ?? "", configuredExchange) as (typeof EODHD_TEST_SYMBOLS)[number]
      )
    );

    logger.info(
      {
        selectedExchangeCandidate: configuredExchange,
        symbolCount: configuredExchangeSymbols.length,
        testSymbolMatchesFound: configuredMatches.length,
        testSymbolMatches: configuredMatches.map(toSymbolDebugLog),
      },
      "EODHD coverage discovery: configured exchange probed"
    );

    if (configuredMatches.length > 0) {
      const candleSupported = await logCandleProbe(configuredExchange, configuredMatches[0]);

      return {
        selectedExchangeCode: configuredExchange,
        selectedExchange: null,
        testMatches: configuredMatches,
        candleSupported,
      };
    }
  }

  const searchDiscovery = await discoverEodhdCoverageFromSymbolSearch();
  if (searchDiscovery) return searchDiscovery;

  throw new AppError(
    HTTP_STATUS.badGateway,
    ERROR_CODES.badRequest,
    "Unable to discover EODHD market coverage from exchanges-list and test symbols"
  );
}

async function discoverEodhdCoverageFromSymbolSearch(): Promise<EodhdCoverageDiscovery | null> {
  const matchesByExchange = new Map<string, EodhdSymbolRow[]>();

  for (const symbol of EODHD_TEST_SYMBOLS) {
    const searchRows = await searchEodhdSymbols(symbol);
    const exactMatches = searchRows.filter(
      (row) => stripTickerSuffix(row.Code ?? "") === symbol
    );

    logger.info(
      {
        testSymbol: symbol,
        searchRowsReturned: searchRows.length,
        exactMatchesFound: exactMatches.length,
        exactMatches: exactMatches.map(toSymbolDebugLog),
      },
      "EODHD coverage discovery: test symbol search"
    );

    for (const match of exactMatches) {
      const exchangeCode = getSymbolExchangeCode(match);
      if (!exchangeCode) continue;

      matchesByExchange.set(exchangeCode, [
        ...(matchesByExchange.get(exchangeCode) ?? []),
        match,
      ]);
    }
  }

  const rankedExchangeMatches = [...matchesByExchange.entries()].sort((a, b) => {
    return b[1].length - a[1].length || getExchangeCodeScore(b[0]) - getExchangeCodeScore(a[0]);
  });
  const [bestMatch] = rankedExchangeMatches;

  logger.info(
    {
      discoveredExchangeCandidates: rankedExchangeMatches.map(([exchangeCode, matches]) => ({
        exchangeCode,
        testSymbolMatchesFound: matches.length,
        testSymbolMatches: matches.map(toSymbolDebugLog),
      })),
    },
    "EODHD coverage discovery: search-derived exchange candidates"
  );

  if (!bestMatch) return null;

  const [selectedExchangeCode, testMatches] = bestMatch;
  const symbolRows = await fetchSymbolsForExchange(selectedExchangeCode);
  const exchangeListMatches =
    symbolRows.length > 0
      ? symbolRows.filter((row) =>
          EODHD_TEST_SYMBOLS.includes(
            stripTickerSuffix(row.Code ?? "") as (typeof EODHD_TEST_SYMBOLS)[number]
          )
        )
      : testMatches;

  const candleSupported = await logCandleProbe(
    selectedExchangeCode,
    exchangeListMatches[0] ?? testMatches[0]
  );

  logger.info(
    {
      selectedExchangeCode,
      selectedExchange: null,
      symbolCount: symbolRows.length,
      candleSupported,
      testSymbolMatches: exchangeListMatches.map(toSymbolDebugLog),
    },
    "EODHD coverage discovery: search-derived exchange selected"
  );

  return {
    selectedExchangeCode,
    selectedExchange: null,
    testMatches: exchangeListMatches,
    candleSupported,
  };
}

async function searchEodhdSymbols(query: string) {
  const url = createEodhdUrl(`/search/${encodeURIComponent(query)}`, {
    limit: "20",
    type: "stock",
  });
  const json = await readJsonResponse<EodhdSymbolRow[]>(
    await fetch(url),
    `Unable to search instruments for ${query}`
  );

  return Array.isArray(json) ? json : [];
}

async function fetchSymbolsForExchange(exchangeCode: string) {
  const url = createEodhdUrl(
    `/exchange-symbol-list/${encodeURIComponent(exchangeCode)}`
  );

  try {
    const json = await readJsonResponse<EodhdSymbolRow[]>(
      await fetch(url),
      `Unable to fetch symbol list for ${exchangeCode}`
    );

    return Array.isArray(json) ? json : [];
  } catch (error) {
    logger.info(
      {
        exchangeCode,
        status: error instanceof AppError ? error.status : undefined,
        message: error instanceof Error ? error.message : "Unknown provider error",
      },
      "EODHD coverage discovery: symbol list probe failed"
    );

    return [];
  }
}

async function logCandleProbe(exchangeCode: string, symbolRow: EodhdSymbolRow) {
  const symbol = fromEodhdTicker(symbolRow.Code ?? "", exchangeCode);
  const ticker = toEodhdTicker(symbol, exchangeCode);
  const url = createEodhdUrl(`/eod/${encodeURIComponent(ticker)}`, {
    from: getRecentHistoryFromDate(),
    to: getTodayDate(),
    period: "d",
    order: "a",
  });
  let status: number | "request_failed" = "request_failed";

  try {
    const response = await fetch(url);
    status = response.status;
    const json = await readJsonResponse<EodhdCandleRow[]>(
      response,
      `Unable to fetch candle probe for ${ticker}`
    );

    logger.info(
      {
        selectedExchangeCode: exchangeCode,
        generatedTestTicker: ticker,
        candleTestUrl: toSafeProviderUrl(url),
        ticker,
        status,
        candlesReturned: Array.isArray(json) ? json.length : 0,
      },
      "EODHD coverage discovery: candle test"
    );
    return response.ok;
  } catch (error) {
    logger.info(
      {
        selectedExchangeCode: exchangeCode,
        generatedTestTicker: ticker,
        candleTestUrl: toSafeProviderUrl(url),
        ticker,
        status,
        message: error instanceof Error ? error.message : "Unknown provider error",
      },
      "EODHD coverage discovery: candle test"
    );
    return false;
  }
}

function toSafeProviderUrl(url: URL) {
  const safeUrl = new URL(url);
  safeUrl.searchParams.set("api_token", "[redacted]");
  return safeUrl.toString();
}

function isConfiguredOrGlobalExchange(exchange: EodhdExchangeRow) {
  const configuredExchangeCode = getConfiguredEodhdExchangeCode();
  const searchable = [
    exchange.Code,
    exchange.Name,
    exchange.Country,
    exchange.CountryISO2,
    exchange.CountryISO3,
    exchange.OperatingMIC,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const searchTerms = [
    configuredExchangeCode?.toLowerCase(),
    "united states",
    "usa",
    "us stock",
    "nasdaq",
    "nyse",
  ].filter((term): term is string => Boolean(term));

  return searchTerms.some((term) => searchable.includes(term));
}

function sortExchangeCandidates(exchanges: EodhdExchangeRow[]) {
  return [...exchanges].sort((a, b) => getExchangeScore(b) - getExchangeScore(a));
}

function getExchangeScore(exchange: EodhdExchangeRow) {
  const configuredExchangeCode = getConfiguredEodhdExchangeCode();
  const searchable = [
    exchange.Code,
    exchange.Name,
    exchange.Country,
    exchange.OperatingMIC,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  let score = 0;
  if (configuredExchangeCode && normalizeSymbol(exchange.Code ?? "") === configuredExchangeCode) {
    score += 120;
  }
  if (searchable.includes("united states")) score += 90;
  if (searchable.includes("usa")) score += 80;
  if (searchable.includes("us stock")) score += 70;
  if (searchable.includes("nasdaq")) score += 50;
  if (searchable.includes("nyse")) score += 50;
  if (searchable.includes("xnse")) score += 100;
  if (searchable.includes("national stock exchange")) score += 80;
  if (searchable.includes("nse")) score += 60;
  if (searchable.includes("india")) score += 30;

  return score;
}

function getExchangeCodeScore(exchangeCode: string) {
  const configuredExchangeCode = getConfiguredEodhdExchangeCode();
  const normalizedExchangeCode = normalizeSymbol(exchangeCode);

  if (configuredExchangeCode && normalizedExchangeCode === configuredExchangeCode) return 120;
  if (normalizedExchangeCode === "US") return 110;
  if (normalizedExchangeCode === "XNSE") return 100;
  if (normalizedExchangeCode === "NSE") return 90;
  if (normalizedExchangeCode.includes("NSE")) return 70;
  return 0;
}

function getSymbolExchangeCode(symbol: EodhdSymbolRow) {
  const exchange = normalizeSymbol(symbol.Exchange ?? "");
  if (exchange) return exchange;

  const code = normalizeSymbol(symbol.Code ?? "");
  const [, exchangeCode] = code.split(".");
  return exchangeCode ?? "";
}

function isSymbolOnSelectedExchange(symbol: EodhdSymbolRow, selectedExchangeCode: string) {
  const exchangeCode = getSymbolExchangeCode(symbol);

  if (exchangeCode === selectedExchangeCode) return true;

  if (selectedExchangeCode === "US") {
    return ["NASDAQ", "NYSE", "NYSE ARCA", "AMEX", "BATS", "OTC", "OTCM"].includes(
      exchangeCode
    );
  }

  return false;
}

function stripTickerSuffix(code: string) {
  return normalizeSymbol(code).split(".")[0];
}

function getConfiguredEodhdExchangeCode() {
  return env.EODHD_EXCHANGE_CODE ? normalizeSymbol(env.EODHD_EXCHANGE_CODE) : null;
}

function getDailyCandleTickerCandidates(input: {
  symbol: string;
  instrumentToken: string;
  exchangeCode: string;
}) {
  const normalizedSymbol = normalizeSymbol(input.symbol);
  const normalizedInstrumentToken = normalizeSymbol(input.instrumentToken);
  const baseInstrumentToken = stripTickerSuffix(normalizedInstrumentToken);

  const candidates = [
    normalizedInstrumentToken.includes(".")
      ? normalizedInstrumentToken
      : toEodhdTicker(baseInstrumentToken || normalizedSymbol, input.exchangeCode),
    toEodhdTicker(normalizedSymbol, input.exchangeCode),
  ];

  return [...new Set(candidates.filter(Boolean))];
}

function toExchangeDebugLog(exchange: EodhdExchangeRow) {
  return {
    Code: exchange.Code,
    Name: exchange.Name,
    Country: exchange.Country,
    CountryISO2: exchange.CountryISO2,
    CountryISO3: exchange.CountryISO3,
    OperatingMIC: exchange.OperatingMIC,
    Currency: exchange.Currency,
  };
}

function toSymbolDebugLog(symbol: EodhdSymbolRow) {
  return {
    Code: symbol.Code,
    Name: symbol.Name,
    Exchange: symbol.Exchange,
    Currency: symbol.Currency,
    Type: symbol.Type,
    Isin: symbol.Isin,
  };
}

function toProviderDailyCandle(row: EodhdCandleRow): ProviderDailyCandle | null {
  const open = toFiniteNumber(row.open);
  const high = toFiniteNumber(row.high);
  const low = toFiniteNumber(row.low);
  const close = toFiniteNumber(row.close);
  const adjustedClose = toFiniteNumber(row.adjusted_close ?? row.adjustedClose);
  const volume = toFiniteNumber(row.volume);

  if (!row.date || open === null || high === null || low === null || close === null) {
    return null;
  }

  const adjustmentFactor =
    adjustedClose !== null && close !== 0 ? adjustedClose / close : 1;

  return {
    time: row.date,
    open: open * adjustmentFactor,
    high: high * adjustmentFactor,
    low: low * adjustmentFactor,
    close: adjustedClose ?? close,
    volume: volume ?? 0,
  };
}

function getTodayDate() {
  return new Date().toISOString().slice(0, 10);
}

function getRecentHistoryFromDate() {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - 14);
  return date.toISOString().slice(0, 10);
}
