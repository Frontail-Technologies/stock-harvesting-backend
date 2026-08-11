import type { ProviderStatus } from "../../shared/constants";

export type ProviderConnectionStatus = {
  providerConfigured: boolean;
  connected: boolean;
  status: ProviderStatus;
  lastSyncedAt: string | null;
  errorMessage: string | null;
};

export type ProviderHealthStatus = Pick<
  ProviderConnectionStatus,
  "connected" | "status" | "errorMessage"
>;

export type ProviderDailyCandle = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type ProviderSymbolDailyCandle = ProviderDailyCandle & {
  symbol: string;
};

export type ProviderInstrument = {
  exchange: string;
  symbol: string;
  name: string;
  instrumentToken: string;
  segment?: string;
};

export type ProviderExchange = {
  code: string;
  name: string;
  currency: string;
  country: string;
};

export interface DataProviderAdapter {
  readonly providerKey: string;
  readonly requiresConnection: boolean;
  isConfigured(): boolean;
  checkConnection?(): Promise<ProviderHealthStatus>;
  getConnectUrl(): string | null;
  exchangeRequestToken(requestToken: string): Promise<{
    accessToken: string;
    refreshToken?: string;
    accountId?: string;
    expiresAt?: Date;
  }>;
  fetchExchanges?(): Promise<ProviderExchange[]>;
  fetchInstruments(input?: {
    accessToken?: string;
    exchangeCode?: string;
  }): Promise<ProviderInstrument[]>;
  searchInstruments?(query: string, exchangeCode?: string): Promise<ProviderInstrument[]>;
  getInstrumentToken?(symbol: string, exchangeCode?: string): Promise<string> | string;
  fetchDailyCandles(input: {
    accessToken?: string;
    instrumentToken: string;
    symbol: string;
    from: string;
    to: string;
    exchangeCode?: string;
  }): Promise<ProviderDailyCandle[]>;
  fetchLatestDailyCandles?(input?: {
    accessToken?: string;
    symbols?: string[];
    exchangeCode?: string;
  }): Promise<ProviderSymbolDailyCandle[]>;
}
