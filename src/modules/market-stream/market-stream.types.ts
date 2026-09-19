import type { AuthPortal, UserPlan, UserRole } from "../../shared/constants";

export type MarketStreamUser = {
  id: string;
  email: string;
  role: UserRole;
  plan: UserPlan;
  portal: AuthPortal;
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
    lastUpdatedAt?: string;
  };
};

export type MarketProviderStatusEvent = {
  type: "market.provider.status";
  data: {
      provider: "eodhd" | "global-datafeeds" | "internal";
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

export type MarketSymbolRefreshedEvent = {
  type: "market.symbol.refreshed";
  data: MarketStreamSymbol & {
    instrumentId: string | null;
    latestDataDate: string;
    status: "updated" | "repaired";
    time: string;
  };
};

export type MarketStreamEvent =
  | MarketTickEvent
  | MarketCandleUpdateEvent
  | MarketProviderStatusEvent
  | JobProgressEvent
  | MarketSymbolRefreshedEvent;

export type AdminJobStartedEvent = {
  type: "market-data:job-started";
  data: { runId: string; jobType: string; startedAt: string };
};

export type AdminJobProgressEvent = {
  type: "market-data:job-progress";
  data: {
    runId: string;
    jobType: string;
    processed: number;
    total: number;
    updated: number;
    repaired: number;
    failed: number;
  };
};

export type AdminJobCompletedEvent = {
  type: "market-data:job-completed";
  data: {
    runId: string;
    jobType: string;
    status: "completed" | "partial";
    finishedAt: string;
    processed: number;
    updated: number;
    repaired: number;
    failed: number;
  };
};

export type AdminJobFailedEvent = {
  type: "market-data:job-failed";
  data: { runId: string; jobType: string; status: "failed"; finishedAt: string; failed: number };
};

export type AdminWorkerStatusEvent = {
  type: "worker:status";
  data: { name: string; status: "online" | "offline"; lastHeartbeat: string | null };
};

export type AdminMarketDataEvent =
  | AdminJobStartedEvent
  | AdminJobProgressEvent
  | AdminJobCompletedEvent
  | AdminJobFailedEvent
  | AdminWorkerStatusEvent;

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
      type: "admin.subscribe";
    }
  | {
      type: "admin.unsubscribe";
    }
  | {
      type: "ping";
    };

export type MarketStreamServerMessage =
  | MarketStreamEvent
  | AdminMarketDataEvent
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
