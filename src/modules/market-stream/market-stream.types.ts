import type { UserPlan, UserRole } from "../../shared/constants";

export type MarketStreamUser = {
  id: string;
  email: string;
  role: UserRole;
  plan: UserPlan;
};

export type MarketStreamSymbol = {
  exchange: string;
  symbol: string;
};

export type MarketTickEvent = {
  type: "market.tick";
  data: MarketStreamSymbol & {
    price: number;
    volume?: number;
    time: string;
  };
};

export type MarketCandleUpdateEvent = {
  type: "market.candle.update";
  data: MarketStreamSymbol & {
    timeframe: string;
    time: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number;
  };
};

export type MarketProviderStatusEvent = {
  type: "market.provider.status";
  data: {
      provider: "eodhd" | "kite" | "global-datafeeds" | "internal";
    connected: boolean;
    exchange?: string;
    message?: string;
    time: string;
  };
};

export type JobProgressEvent = {
  type: "job.progress";
  data: {
    jobId: string;
    name: string;
    progress: number;
    message?: string;
    time: string;
  };
};

export type MarketStreamEvent =
  | MarketTickEvent
  | MarketCandleUpdateEvent
  | MarketProviderStatusEvent
  | JobProgressEvent;

export type MarketStreamClientMessage =
  | {
      type: "subscribe";
      symbols: MarketStreamSymbol[];
    }
  | {
      type: "unsubscribe";
      symbols: MarketStreamSymbol[];
    }
  | {
      type: "ping";
    };

export type MarketStreamServerMessage =
  | MarketStreamEvent
  | {
      type: "connection.ready";
      data: {
        userId: string;
        time: string;
      };
    }
  | {
      type: "subscription.updated";
      data: {
        subscriptions: MarketStreamSymbol[];
        time: string;
      };
    }
  | {
      type: "pong";
      data: {
        time: string;
      };
    }
  | {
      type: "error";
      error: {
        code: string;
        message: string;
      };
    };
