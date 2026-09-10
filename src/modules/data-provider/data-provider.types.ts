import type { dataProviderSettings } from "../../db/schema";
import type { ProviderStatus } from "../../shared/constants";

export type DataProviderSettingsRow = typeof dataProviderSettings.$inferSelect;

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

// Local/DB-derived provider status only - resolves without ANY external
// provider request. `connected`/`status` are DB-derived for OAuth providers
// (Zerodha's stored connection row + token expiry); for non-OAuth providers
// they mirror `providerConfigured` (there is no connection concept - real
// reachability comes from the separate health check). See getProviderHealth
// for the external `adapter.checkConnection()` path.
export type ProviderLocalStatus = {
  provider: string;
  providerConfigured: boolean;
  enabled: boolean;
  priority: number;
  requiresConnection: boolean;
  connected: boolean;
  status: ProviderStatus;
  lastSyncedAt: string | null;
  errorMessage: string | null;
};

// Result of the bounded external health check for a single provider.
export type ProviderHealthResult = ProviderHealthStatus & { provider: string };

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
