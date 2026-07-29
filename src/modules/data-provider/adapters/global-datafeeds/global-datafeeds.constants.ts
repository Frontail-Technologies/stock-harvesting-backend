export const GLOBAL_DATAFEEDS_PROVIDER_NAME = "Global Datafeeds";
export const GLOBAL_DATAFEEDS_DEFAULT_EXCHANGE = "BSE";
export const GLOBAL_DATAFEEDS_INDEX_EXCHANGE = "BSE_IDX";
export const GLOBAL_DATAFEEDS_AUTH_TIMEOUT_MS = 15_000;
export const GLOBAL_DATAFEEDS_REQUEST_TIMEOUT_MS = 30_000;
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
