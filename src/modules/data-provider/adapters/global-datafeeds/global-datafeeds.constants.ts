export const GLOBAL_DATAFEEDS_PROVIDER_NAME = "Global Datafeeds";
export const GLOBAL_DATAFEEDS_DEFAULT_EXCHANGE = "BSE";
export const GLOBAL_DATAFEEDS_INDEX_EXCHANGE = "BSE_IDX";
export const GLOBAL_DATAFEEDS_AUTH_TIMEOUT_MS = 15_000;
export const GLOBAL_DATAFEEDS_REQUEST_TIMEOUT_MS = 30_000;
// GetHistory specifically times out intermittently against the live socket
// but "reliably succeeds on a fresh attempt" (see requestWithRetry's own
// comment) - confirmed live: a stuck attempt was measured riding the full
// 30s default before its retry could even start, making one bad attempt
// cost a user ~29-30s of dead waiting on their chart. A much shorter
// timeout here means a bad attempt fails fast and the (usually
// successful) retry kicks in within ~10s total instead of ~30s+, without
// touching the timeout for every OTHER Global Datafeeds request type
// (GetInstruments, quotes, ...), which don't show this same flakiness.
export const GLOBAL_DATAFEEDS_HISTORY_REQUEST_TIMEOUT_MS = 9_000;
export const GLOBAL_DATAFEEDS_RECONNECT_DELAY_MS = 3_000;
export const GLOBAL_DATAFEEDS_QUOTE_BATCH_SIZE = 25;

export const GLOBAL_DATAFEEDS_MESSAGE_TYPE = {
  authenticate: "Authenticate",
  authenticateResult: "AuthenticateResult",
  getExchanges: "GetExchanges",
  getInstruments: "GetInstruments",
  getInstrumentsOnSearch: "GetInstrumentsOnSearch",
  getHistory: "GetHistory",
  getLastQuote: "GetLastQuote",
  getLastQuoteArray: "GetLastQuoteArray",
  lastQuoteResult: "LastQuoteResult",
  lastQuoteArrayResult: "LastQuoteArrayResult",
  subscribeRealtime: "SubscribeRealtime",
  realtimeResult: "RealtimeResult",
} as const;
