import { DATA_PROVIDER_KEY, HTTP_STATUS } from "../../../../shared/constants";
import { env } from "../../../../shared/env";
import { AppError, ERROR_CODES } from "../../../../shared/errors";
import { normalizeSymbol } from "../../../../shared/normalize";
import type {
  DataProviderAdapter,
  ProviderDailyCandle,
  ProviderExchange,
  ProviderInstrument,
  ProviderSymbolDailyCandle,
} from "../../data-provider.types";
import {
  GLOBAL_DATAFEEDS_DEFAULT_EXCHANGE,
  GLOBAL_DATAFEEDS_INDEX_EXCHANGE,
  GLOBAL_DATAFEEDS_MESSAGE_TYPE,
  GLOBAL_DATAFEEDS_PROVIDER_NAME,
} from "./global-datafeeds.constants";
import {
  toGlobalDatafeedsDailyCandle,
  toGlobalDatafeedsInstrument,
} from "./global-datafeeds.mapper";
import type {
  GlobalDatafeedsHistoryRow,
  GlobalDatafeedsInstrumentRow,
  GlobalDatafeedsResponse,
} from "./global-datafeeds.types";
import { globalDatafeedsClient } from "./global-datafeeds.websocket-client";

function configuredExchanges() {
  return env.GLOBAL_DATAFEEDS_EXCHANGES.split(",")
    .map((exchange) => exchange.trim().toUpperCase())
    .filter(Boolean);
}

function assertExchangeSupported(exchange: string) {
  const normalized = normalizeSymbol(exchange);
  if (!configuredExchanges().includes(normalized)) {
    throw new AppError(
      HTTP_STATUS.badRequest,
      ERROR_CODES.badRequest,
      `Global Datafeeds exchange is not configured: ${normalized}`
    );
  }
  return normalized;
}

function toEpochSeconds(dateOnly: string, endOfDay = false) {
  const suffix = endOfDay ? "T23:59:59.000Z" : "T00:00:00.000Z";
  return Math.floor(new Date(`${dateOnly}${suffix}`).getTime() / 1000);
}

function resultArray<T>(response: GlobalDatafeedsResponse | unknown): T[] {
  if (Array.isArray(response)) return response as T[];
  if (
    typeof response === "object" &&
    response !== null &&
    "Result" in response &&
    Array.isArray((response as GlobalDatafeedsResponse).Result)
  ) {
    return (response as GlobalDatafeedsResponse).Result as T[];
  }
  return [];
}

export class GlobalDatafeedsDataProviderAdapter implements DataProviderAdapter {
  readonly providerKey = DATA_PROVIDER_KEY.globalDatafeeds;
  readonly requiresConnection = false;
  private instrumentCache = new Map<
    string,
    { expiresAt: number; rows: ProviderInstrument[] }
  >();

  isConfigured() {
    return globalDatafeedsClient.isConfigured();
  }

  getConnectUrl() {
    return "https://globaldatafeeds.in/global-datafeeds-apis/";
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
    try {
      const response = await globalDatafeedsClient.request({
        MessageType: GLOBAL_DATAFEEDS_MESSAGE_TYPE.getExchanges,
      });
      const rows = resultArray<string | { Exchange?: string; Name?: string }>(response);
      const exchanges = rows
        .map((row) => (typeof row === "string" ? row : row.Exchange ?? row.Name ?? ""))
        .map((exchange) => exchange.trim().toUpperCase())
        .filter(Boolean);

      return [...new Set(exchanges)].map(toProviderExchange);
    } catch {
      return configuredExchanges().map(toProviderExchange);
    }
  }

  async fetchInstruments(input: {
    exchangeCode?: string;
  } = {}): Promise<ProviderInstrument[]> {
    const exchange = assertExchangeSupported(
      input.exchangeCode ?? GLOBAL_DATAFEEDS_DEFAULT_EXCHANGE
    );
    const cached = this.instrumentCache.get(exchange);
    if (cached && cached.expiresAt > Date.now()) return cached.rows;

    const response = await globalDatafeedsClient.request({
      MessageType: GLOBAL_DATAFEEDS_MESSAGE_TYPE.getInstruments,
      Exchange: exchange,
      OnlyActive: true,
      DetailedInfo: true,
    });

    const rows = resultArray<GlobalDatafeedsInstrumentRow>(response)
      .map((row) => toGlobalDatafeedsInstrument(row, exchange))
      .filter((instrument): instrument is ProviderInstrument => Boolean(instrument));

    this.instrumentCache.set(exchange, {
      expiresAt: Date.now() + 30 * 60_000,
      rows,
    });

    return rows;
  }

  async searchInstruments(query: string, exchangeCode?: string): Promise<ProviderInstrument[]> {
    const exchange = assertExchangeSupported(exchangeCode ?? GLOBAL_DATAFEEDS_DEFAULT_EXCHANGE);
    const normalizedQuery = normalizeSymbol(query);
    const rows = await this.fetchInstruments({ exchangeCode: exchange });
    const exactMatches = rows.filter((row) => row.symbol === normalizedQuery);
    const startsWithMatches = rows.filter(
      (row) =>
        row.symbol !== normalizedQuery &&
        (row.symbol.startsWith(normalizedQuery) ||
          row.name.toUpperCase().startsWith(normalizedQuery))
    );
    const containsMatches = rows.filter(
      (row) =>
        row.symbol !== normalizedQuery &&
        !row.symbol.startsWith(normalizedQuery) &&
        !row.name.toUpperCase().startsWith(normalizedQuery) &&
        (row.symbol.includes(normalizedQuery) ||
          row.name.toUpperCase().includes(normalizedQuery))
    );

    return [...exactMatches, ...startsWithMatches, ...containsMatches].slice(0, 50);
  }

  async getInstrumentToken(symbol: string, exchangeCode?: string) {
    const exchange = assertExchangeSupported(exchangeCode ?? GLOBAL_DATAFEEDS_DEFAULT_EXCHANGE);
    const normalizedSymbol = normalizeSymbol(symbol);
    const [instrument] = await this.searchInstruments(normalizedSymbol, exchange);
    return instrument?.instrumentToken ?? normalizedSymbol;
  }

  async fetchDailyCandles(input: {
    instrumentToken: string;
    symbol: string;
    from: string;
    to: string;
    exchangeCode?: string;
  }): Promise<ProviderDailyCandle[]> {
    const exchange = assertExchangeSupported(
      input.exchangeCode ?? GLOBAL_DATAFEEDS_DEFAULT_EXCHANGE
    );
    const response = await globalDatafeedsClient.request({
      MessageType: GLOBAL_DATAFEEDS_MESSAGE_TYPE.getHistory,
      Exchange: exchange,
      InstrumentIdentifier: input.instrumentToken || normalizeSymbol(input.symbol),
      Periodicity: "DAY",
      Period: 1,
      From: toEpochSeconds(input.from),
      To: toEpochSeconds(input.to, true),
      isShortIdentifier: "False",
      AdjustSplits: true,
    });

    return resultArray<GlobalDatafeedsHistoryRow>(response)
      .map(toGlobalDatafeedsDailyCandle)
      .filter((candle): candle is ProviderDailyCandle => Boolean(candle))
      .sort((a, b) => a.time.localeCompare(b.time));
  }

  async fetchLatestDailyCandles(input: {
    symbols?: string[];
    exchangeCode?: string;
  } = {}): Promise<ProviderSymbolDailyCandle[]> {
    const exchange = assertExchangeSupported(
      input.exchangeCode ?? GLOBAL_DATAFEEDS_DEFAULT_EXCHANGE
    );
    const rows: ProviderSymbolDailyCandle[] = [];
    const to = new Date().toISOString().slice(0, 10);
    const fromDate = new Date();
    fromDate.setUTCDate(fromDate.getUTCDate() - 14);
    const from = fromDate.toISOString().slice(0, 10);

    for (const symbol of [...new Set(input.symbols ?? [])].slice(0, env.GLOBAL_DATAFEEDS_SYMBOL_LIMIT)) {
      const normalizedSymbol = normalizeSymbol(symbol);
      const instrumentToken = await this.getInstrumentToken(normalizedSymbol, exchange);
      const candles = await this.fetchDailyCandles({
        instrumentToken,
        symbol: normalizedSymbol,
        from,
        to,
        exchangeCode: exchange,
      });
      const latest = candles[candles.length - 1];
      if (latest) rows.push({ ...latest, symbol: normalizedSymbol });
    }

    return rows;
  }
}

function toProviderExchange(exchange: string): ProviderExchange {
  return {
    code: exchange,
    name:
      exchange === GLOBAL_DATAFEEDS_INDEX_EXCHANGE
        ? "India (BSE Indices)"
        : exchange === GLOBAL_DATAFEEDS_DEFAULT_EXCHANGE
          ? "India (BSE)"
          : `${GLOBAL_DATAFEEDS_PROVIDER_NAME} ${exchange}`,
    currency: "INR",
    country: "India",
  };
}
