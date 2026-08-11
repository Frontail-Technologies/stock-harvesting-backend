import { createHash } from "crypto";

import { DATA_PROVIDER_KEY, HTTP_STATUS } from "../../../shared/constants";
import { env } from "../../../shared/env";
import { AppError, ERROR_CODES, ERROR_MESSAGES } from "../../../shared/errors";
import type {
  DataProviderAdapter,
  ProviderDailyCandle,
  ProviderInstrument,
  ProviderSymbolDailyCandle,
} from "../data-provider.types";

const KITE_BASE_URL = "https://api.kite.trade";
const ZERODHA_DEFAULT_EXCHANGE = "NSE";
const ZERODHA_MAX_DAILY_CANDLE_DAYS = 1_800;
const NSE_NON_EQ_SERIES_SYMBOL_PATTERN = /-(BE|BZ|SM|ST|SZ|E[0-9]+|N[0-9]+)$/;
// A virtual exchange code (mirrors GlobalDataFeeds' BSE_IDX elsewhere in this
// codebase) — Kite has no separate index endpoint, index instruments live
// mixed into the regular /instruments/NSE dump with segment=INDICES, so
// this is resolved specially in fetchInstruments below rather than as a
// real Kite exchange.
export const NSE_INDEX_EXCHANGE = "NSE_IDX";
// Non-"sector rotation" noise present in Kite's INDICES segment: leveraged/
// inverse synthetic products, the volatility index, government-securities/
// bond indices, a foreign-index tracker, and dividend-point indices (a
// cumulative points series, not a price series — Kite only populates
// `close` for these, leaving open/high/low at 0 and breaking the %-based
// combined score) — confirmed by inspecting the full live list rather than
// guessing.
const NSE_INDEX_DENYLIST_PATTERNS = [
  "LEV",
  " INV",
  "INDIA VIX",
  "NIFTY GS",
  "BHARATBOND",
  "HANGSENG",
  "DIV POINT",
];

function isTradableNseIndexSymbol(name: string) {
  const normalized = name.trim().toUpperCase();
  if (!normalized) return false;
  return !NSE_INDEX_DENYLIST_PATTERNS.some((pattern) => normalized.includes(pattern));
}

type KiteErrorBody = {
  status?: string;
  message?: string;
  error_type?: string;
};

function requireProviderConfig() {
  if (!env.ZERODHA_API_KEY || !env.ZERODHA_API_SECRET) {
    throw new AppError(
      HTTP_STATUS.internalServerError,
      ERROR_CODES.internalError,
      ERROR_MESSAGES.providerNotConfigured
    );
  }
}

function parseCsvLine(line: string) {
  const values: string[] = [];
  let current = "";
  let quoted = false;

  for (const char of line) {
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === "," && !quoted) {
      values.push(current);
      current = "";
      continue;
    }
    current += char;
  }

  values.push(current);
  return values;
}

function isTradableNseEquitySymbol(symbol: string) {
  const normalized = symbol.trim().toUpperCase();
  return (
    Boolean(normalized) &&
    /^[A-Z][A-Z0-9&-]*$/.test(normalized) &&
    !NSE_NON_EQ_SERIES_SYMBOL_PATTERN.test(normalized)
  );
}

function parseDateOnly(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) {
    throw new AppError(
      HTTP_STATUS.badRequest,
      ERROR_CODES.badRequest,
      "Invalid candle date"
    );
  }

  return new Date(Date.UTC(year, month - 1, day));
}

function formatKiteDateTime(date: Date, endOfDay = false) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day} ${endOfDay ? "23:59:59" : "00:00:00"}`;
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function compareDateOnly(a: Date, b: Date) {
  return a.getTime() - b.getTime();
}

function buildDateChunks(from: string, to: string) {
  const start = parseDateOnly(from);
  const end = parseDateOnly(to);
  const chunks: Array<{ from: Date; to: Date }> = [];
  let cursor = start;

  while (compareDateOnly(cursor, end) <= 0) {
    const chunkEnd = addDays(cursor, ZERODHA_MAX_DAILY_CANDLE_DAYS - 1);
    chunks.push({
      from: cursor,
      to: compareDateOnly(chunkEnd, end) > 0 ? end : chunkEnd,
    });
    cursor = addDays(chunkEnd, 1);
  }

  return chunks;
}

async function readKiteError(response: Response) {
  try {
    const body = (await response.json()) as KiteErrorBody;
    return {
      message: body.message,
      errorType: body.error_type,
    };
  } catch {
    return {
      message: response.statusText,
      errorType: undefined,
    };
  }
}

export class ZerodhaDataProviderAdapter implements DataProviderAdapter {
  readonly providerKey = DATA_PROVIDER_KEY.zerodha;
  readonly requiresConnection = true;

  isConfigured() {
    return Boolean(env.ZERODHA_API_KEY && env.ZERODHA_API_SECRET);
  }

  getConnectUrl() {
    requireProviderConfig();
    const params = new URLSearchParams({
      v: "3",
      api_key: env.ZERODHA_API_KEY ?? "",
    });
    return `https://kite.zerodha.com/connect/login?${params.toString()}`;
  }

  async exchangeRequestToken(requestToken: string) {
    requireProviderConfig();
    const checksum = createHash("sha256")
      .update(`${env.ZERODHA_API_KEY}${requestToken}${env.ZERODHA_API_SECRET}`)
      .digest("hex");

    const response = await fetch(`${KITE_BASE_URL}/session/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-kite-version": "3",
      },
      body: new URLSearchParams({
        api_key: env.ZERODHA_API_KEY ?? "",
        request_token: requestToken,
        checksum,
      }),
    });

    if (!response.ok) {
      throw new AppError(
        HTTP_STATUS.badGateway,
        ERROR_CODES.badRequest,
        "Data provider token exchange failed"
      );
    }

    const json = (await response.json()) as {
      data?: {
        access_token?: string;
        refresh_token?: string;
        user_id?: string;
      };
    };

    if (!json.data?.access_token) {
      throw new AppError(
        HTTP_STATUS.badGateway,
        ERROR_CODES.badRequest,
        "Data provider access token missing"
      );
    }

    return {
      accessToken: json.data.access_token,
      refreshToken: json.data.refresh_token,
      accountId: json.data.user_id,
    };
  }

  async fetchInstruments(input?: {
    accessToken?: string;
    exchangeCode?: string;
  }): Promise<ProviderInstrument[]> {
    if (!input?.accessToken) {
      throw new AppError(
        HTTP_STATUS.unauthorized,
        ERROR_CODES.unauthorized,
        "Data provider access token missing"
      );
    }

    const exchangeCode = input.exchangeCode ?? ZERODHA_DEFAULT_EXCHANGE;
    const isIndexRequest = exchangeCode === NSE_INDEX_EXCHANGE;
    // Indices live in the same NSE dump, not a separate Kite endpoint.
    const kiteExchange = isIndexRequest ? ZERODHA_DEFAULT_EXCHANGE : exchangeCode;
    const response = await fetch(`${KITE_BASE_URL}/instruments/${kiteExchange}`, {
      headers: {
        authorization: `token ${env.ZERODHA_API_KEY}:${input.accessToken}`,
        "x-kite-version": "3",
      },
    });

    if (!response.ok) {
      const error = await readKiteError(response);
      throw new AppError(
        HTTP_STATUS.badGateway,
        ERROR_CODES.badRequest,
        `Unable to fetch instruments (${response.status}${
          error.errorType ? ` ${error.errorType}` : ""
        })`,
        {
          provider: DATA_PROVIDER_KEY.zerodha,
          status: response.status,
          message: error.message,
        }
      );
    }

    const text = await response.text();
    const [headerLine, ...rows] = text.trim().split(/\r?\n/);
    const headers = parseCsvLine(headerLine);
    const indexOf = (name: string) => headers.indexOf(name);

    const parsedRows = rows
      .map((row) => parseCsvLine(row))
      .filter((cols) => cols[indexOf("exchange")] === kiteExchange);

    const filteredRows = isIndexRequest
      ? parsedRows
          .filter((cols) => cols[indexOf("segment")] === "INDICES")
          .filter((cols) => isTradableNseIndexSymbol(cols[indexOf("tradingsymbol")]))
      : parsedRows
          .filter((cols) => cols[indexOf("instrument_type")] === "EQ")
          .filter((cols) => isTradableNseEquitySymbol(cols[indexOf("tradingsymbol")]));

    return filteredRows.map((cols) => ({
      exchange: exchangeCode,
      symbol: cols[indexOf("tradingsymbol")],
      name: cols[indexOf("name")] || cols[indexOf("tradingsymbol")],
      instrumentToken: cols[indexOf("instrument_token")],
      segment: cols[indexOf("segment")],
    }));
  }

  async fetchDailyCandles(input: {
    accessToken?: string;
    instrumentToken: string;
    symbol: string;
    from: string;
    to: string;
  }): Promise<ProviderDailyCandle[]> {
    if (!input.accessToken) {
      throw new AppError(
        HTTP_STATUS.unauthorized,
        ERROR_CODES.unauthorized,
        "Data provider access token missing"
      );
    }

    const accessToken = input.accessToken;
    const candleRows: ProviderDailyCandle[] = [];
    const candlesByTime = new Map<string, ProviderDailyCandle>();

    for (const chunk of buildDateChunks(input.from, input.to)) {
      const chunkRows = await this.fetchDailyCandleChunk({
        ...input,
        accessToken,
        fromDate: chunk.from,
        toDate: chunk.to,
      });

      for (const row of chunkRows) {
        candlesByTime.set(row.time, row);
      }
    }

    candleRows.push(
      ...[...candlesByTime.values()].sort((a, b) => a.time.localeCompare(b.time))
    );

    return candleRows;
  }

  async fetchLatestDailyCandles(input: {
    accessToken?: string;
    symbols?: string[];
    exchangeCode?: string;
  } = {}): Promise<ProviderSymbolDailyCandle[]> {
    if (!input.accessToken) {
      throw new AppError(
        HTTP_STATUS.unauthorized,
        ERROR_CODES.unauthorized,
        "Data provider access token missing"
      );
    }

    const symbols = [...new Set((input.symbols ?? []).map((symbol) => symbol.trim()).filter(Boolean))];
    if (symbols.length === 0) return [];

    const exchangeCode = input.exchangeCode ?? ZERODHA_DEFAULT_EXCHANGE;
    const instruments = await this.fetchInstruments({
      accessToken: input.accessToken,
      exchangeCode,
    });
    const instrumentBySymbol = new Map(
      instruments.map((instrument) => [instrument.symbol, instrument])
    );
    const to = new Date();
    const from = addDays(to, -14);
    const rows: ProviderSymbolDailyCandle[] = [];

    for (const symbol of symbols) {
      const instrument = instrumentBySymbol.get(symbol);
      if (!instrument) continue;

      const candles = await this.fetchDailyCandles({
        accessToken: input.accessToken,
        instrumentToken: instrument.instrumentToken,
        symbol,
        from: from.toISOString().slice(0, 10),
        to: to.toISOString().slice(0, 10),
      });
      const latest = candles[candles.length - 1];
      if (!latest) continue;

      rows.push({
        ...latest,
        symbol,
      });
    }

    return rows;
  }

  private async fetchDailyCandleChunk(input: {
    accessToken: string;
    instrumentToken: string;
    symbol: string;
    fromDate: Date;
    toDate: Date;
  }): Promise<ProviderDailyCandle[]> {
    const params = new URLSearchParams({
      from: formatKiteDateTime(input.fromDate),
      to: formatKiteDateTime(input.toDate, true),
    });
    const url = `${KITE_BASE_URL}/instruments/historical/${input.instrumentToken}/day?${params.toString()}`;
    const response = await fetch(url, {
      headers: {
        authorization: `token ${env.ZERODHA_API_KEY}:${input.accessToken}`,
        "x-kite-version": "3",
      },
    });

    if (!response.ok) {
      const error = await readKiteError(response);
      throw new AppError(
        HTTP_STATUS.badGateway,
        ERROR_CODES.badRequest,
        `Unable to fetch daily candles (${response.status}${
          error.errorType ? ` ${error.errorType}` : ""
        })`,
        {
          provider: DATA_PROVIDER_KEY.zerodha,
          symbol: input.symbol,
          instrumentToken: input.instrumentToken,
          from: formatKiteDateTime(input.fromDate),
          to: formatKiteDateTime(input.toDate, true),
          status: response.status,
          message: error.message,
        }
      );
    }

    const json = (await response.json()) as {
      data?: { candles?: [string, number, number, number, number, number][] };
    };

    return (json.data?.candles ?? []).map((candle) => ({
      time: candle[0].slice(0, 10),
      open: candle[1],
      high: candle[2],
      low: candle[3],
      close: candle[4],
      volume: candle[5],
    }));
  }
}
