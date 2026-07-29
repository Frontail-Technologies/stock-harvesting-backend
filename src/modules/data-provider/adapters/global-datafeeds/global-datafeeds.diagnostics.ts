import { env } from "../../../../shared/env";
import {
  GLOBAL_DATAFEEDS_MESSAGE_TYPE,
} from "./global-datafeeds.constants";
import type {
  GlobalDatafeedsHistoryRow,
  GlobalDatafeedsInstrumentRow,
  GlobalDatafeedsQuoteRow,
} from "./global-datafeeds.types";
import { globalDatafeedsClient } from "./global-datafeeds.websocket-client";

const TEST_SYMBOLS = [
  "RELIANCE",
  "500325",
  "TCS",
  "532540",
  "INFY",
  "500209",
  "HDFCBANK",
  "500180",
  "SBIN",
  "500112",
  "SENSEX",
] as const;
const DIAGNOSTIC_REQUEST_TIMEOUT_MS = 12_000;

function resultArray<T>(response: { Result?: unknown } | unknown): T[] {
  if (Array.isArray(response)) return response as T[];
  if (
    typeof response === "object" &&
    response !== null &&
    "Result" in response &&
    Array.isArray((response as { Result?: unknown }).Result)
  ) {
    return (response as { Result: T[] }).Result;
  }
  return [];
}

function logStep(message: string, meta: Record<string, unknown> = {}) {
  console.error(JSON.stringify({ kind: "globalDatafeedsDiagnosticStep", message, ...meta }));
}

async function main() {
  if (!env.GLOBAL_DATAFEEDS_ENABLED || !env.GLOBAL_DATAFEEDS_API_KEY) {
    throw new Error(
      "Set GLOBAL_DATAFEEDS_ENABLED=true and GLOBAL_DATAFEEDS_API_KEY before running diagnostics"
    );
  }

  const exchanges = env.GLOBAL_DATAFEEDS_EXCHANGES.split(",")
    .map((exchange) => exchange.trim().toUpperCase())
    .filter(Boolean);
  const report: Record<string, unknown> = {
    kind: "globalDatafeedsCapabilitySummary",
    wsUrl: env.GLOBAL_DATAFEEDS_WS_URL.replace(env.GLOBAL_DATAFEEDS_API_KEY, "[redacted]"),
    configuredExchanges: exchanges,
    symbolLimit: env.GLOBAL_DATAFEEDS_SYMBOL_LIMIT,
    exchanges: [],
    probes: [],
  };

  const removeDebugListener = globalDatafeedsClient.addDebugListener((event) => {
    logStep(event.stage, {
      messageType: event.messageType,
      detail: event.message,
      payload: event.payload,
    });
  });

  try {
    logStep("requesting exchanges");
    const exchangeResponse = await globalDatafeedsClient.request({
      MessageType: GLOBAL_DATAFEEDS_MESSAGE_TYPE.getExchanges,
    }, DIAGNOSTIC_REQUEST_TIMEOUT_MS);
    report.exchanges = exchangeResponse.Result ?? exchangeResponse;
  } catch (error) {
    report.exchangesError = error instanceof Error ? error.message : "Unknown error";
  }

  const probes: unknown[] = [];
  for (const exchange of exchanges) {
    logStep("probing exchange", { exchange });
    let instruments: GlobalDatafeedsInstrumentRow[] = [];
    let instrumentError: string | null = null;
    const instrumentVariants: unknown[] = [];

    const variants = [
      {
        name: "no-series-boolean-detail",
        request: {
          OnlyActive: true,
          DetailedInfo: true,
        },
      },
      {
        name: "series-a-string-detail",
        request: {
          Series: exchange.endsWith("_IDX") ? undefined : "A",
          OnlyActive: true,
          DetailedInfo: true,
        },
      },
      {
        name: "all-active-no-series",
        request: {
          OnlyActive: false,
          DetailedInfo: true,
        },
      },
    ];

    for (const variant of variants) {
      try {
        logStep("requesting instrument variant", { exchange, variant: variant.name });
        const instrumentResponse = await globalDatafeedsClient.request({
          MessageType: GLOBAL_DATAFEEDS_MESSAGE_TYPE.getInstruments,
          Exchange: exchange,
          ...variant.request,
        }, DIAGNOSTIC_REQUEST_TIMEOUT_MS);
        const variantRows = resultArray<GlobalDatafeedsInstrumentRow>(instrumentResponse);
        instrumentVariants.push({
          variant: variant.name,
          count: variantRows.length,
          first: variantRows[0] ?? null,
          responseMessageType: instrumentResponse.MessageType,
          request: instrumentResponse.Request,
        });
        const first = variantRows[0];
        const looksLikeInstrument =
          typeof first === "object" &&
          first !== null &&
          ("Identifier" in first || "TradeSymbol" in first || "TokenNumber" in first);
        if (instruments.length === 0 && variantRows.length > 0 && looksLikeInstrument) {
          instruments = variantRows;
        }
        logStep("instrument variant received", {
          exchange,
          variant: variant.name,
          count: variantRows.length,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown instrument error";
        instrumentVariants.push({
          variant: variant.name,
          error: message,
        });
        instrumentError ??= message;
        logStep("instrument variant failed", { exchange, variant: variant.name, error: message });
      }
    }

    const matches: unknown[] = [];
    for (const symbol of TEST_SYMBOLS) {
      logStep("probing symbol", { exchange, symbol });
      let searchRows: GlobalDatafeedsInstrumentRow[] = [];
      let searchError: string | null = null;

      try {
        const searchResponse = await globalDatafeedsClient.request({
          MessageType: GLOBAL_DATAFEEDS_MESSAGE_TYPE.getInstrumentsOnSearch,
          Exchange: exchange,
          Search: symbol,
          OnlyActive: true,
          DetailedInfo: true,
        }, DIAGNOSTIC_REQUEST_TIMEOUT_MS);
        searchRows = resultArray<GlobalDatafeedsInstrumentRow>(searchResponse);
        logStep("symbol search received", {
          exchange,
          symbol,
          count: searchRows.length,
          first: searchRows[0] ?? null,
        });
      } catch (error) {
        searchError = error instanceof Error ? error.message : "Search probe failed";
      }

      const normalizedSymbol = symbol.toUpperCase();
      const exactLocalRows = instruments.filter((row) => {
        const identifier = row.Identifier?.toUpperCase() ?? "";
        const tradeSymbol = row.TradeSymbol?.toUpperCase() ?? "";
        const token = String(row.TokenNumber ?? "").toUpperCase();

        return (
          identifier === normalizedSymbol ||
          tradeSymbol === normalizedSymbol ||
          token === normalizedSymbol
        );
      });
      const broadLocalRows = instruments.filter((row) => {
        const identifier = row.Identifier?.toUpperCase() ?? "";
        const tradeSymbol = row.TradeSymbol?.toUpperCase() ?? "";
        const description = row.Description?.toUpperCase() ?? "";

        const isExact = identifier === normalizedSymbol || tradeSymbol === normalizedSymbol;
        const isBroad =
          identifier.includes(normalizedSymbol) ||
          tradeSymbol.includes(normalizedSymbol) ||
          description.includes(normalizedSymbol);

        return !isExact && isBroad;
      });
      const localRows = [...exactLocalRows, ...broadLocalRows];
      const first = exactLocalRows[0] ?? searchRows[0] ?? broadLocalRows[0];
      const instrumentIdentifier = first?.Identifier ?? symbol;

      let quote: GlobalDatafeedsQuoteRow | null = null;
      let historyCount = 0;
      let error: string | null = null;

      try {
        quote = await globalDatafeedsClient.request<GlobalDatafeedsQuoteRow>({
          MessageType: GLOBAL_DATAFEEDS_MESSAGE_TYPE.getLastQuote,
          Exchange: exchange,
          InstrumentIdentifier: instrumentIdentifier,
        }, DIAGNOSTIC_REQUEST_TIMEOUT_MS);
        if (quote.MessageType === "RequestError") {
          error = quote.Message ?? "Quote request returned RequestError";
          quote = null;
        }
        logStep("quote received", {
          exchange,
          symbol,
          instrumentIdentifier,
          price: quote?.LastTradePrice,
          messageType: quote?.MessageType ?? "RequestError",
          error,
        });
      } catch (quoteError) {
        error = quoteError instanceof Error ? quoteError.message : "Quote probe failed";
      }

      try {
        const historyResponse = await globalDatafeedsClient.request({
          MessageType: GLOBAL_DATAFEEDS_MESSAGE_TYPE.getHistory,
          Exchange: exchange,
          InstrumentIdentifier: instrumentIdentifier,
          Periodicity: "DAY",
          Period: 1,
          Max: 10,
          isShortIdentifier: "False",
        }, DIAGNOSTIC_REQUEST_TIMEOUT_MS);
        historyCount = resultArray<GlobalDatafeedsHistoryRow>(historyResponse).length;
        logStep("history received", {
          exchange,
          symbol,
          instrumentIdentifier,
          count: historyCount,
        });
      } catch (historyError) {
        error = historyError instanceof Error ? historyError.message : error;
      }

      matches.push({
        symbol,
        instrumentIdentifier,
        firstMatch: first ?? null,
        localRowsReturned: localRows.length,
        searchRowsReturned: searchRows.length,
        searchError,
        quoteReturned: Boolean(quote?.LastTradePrice),
        historyRowsReturned: historyCount,
        error,
      });
    }

    probes.push({
      exchange,
      instrumentCount: instruments.length,
      instrumentError,
      instrumentVariants,
      firstInstrument: instruments[0] ?? null,
      sampleMatches: matches,
    });
  }

  report.probes = probes;
  removeDebugListener();
  console.log(JSON.stringify(report));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "Unknown Global Datafeeds error");
    process.exitCode = 1;
  })
  .finally(() => {
    globalDatafeedsClient.close();
  });
