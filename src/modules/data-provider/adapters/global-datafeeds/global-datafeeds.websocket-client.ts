import { randomUUID } from "crypto";
import WebSocket from "ws";

import { DATA_PROVIDER_KEY, HTTP_STATUS } from "../../../../shared/constants";
import { env } from "../../../../shared/env";
import { AppError, ERROR_CODES, ERROR_MESSAGES } from "../../../../shared/errors";
import { logger } from "../../../../shared/logger";
import {
  GLOBAL_DATAFEEDS_AUTH_TIMEOUT_MS,
  GLOBAL_DATAFEEDS_MESSAGE_TYPE,
  GLOBAL_DATAFEEDS_RECONNECT_DELAY_MS,
  GLOBAL_DATAFEEDS_REQUEST_TIMEOUT_MS,
} from "./global-datafeeds.constants";
import type {
  GlobalDatafeedsQuoteRow,
  GlobalDatafeedsRequest,
  GlobalDatafeedsResponse,
} from "./global-datafeeds.types";

type PendingRequest = {
  messageType: string;
  userTag: string;
  resolve: (response: GlobalDatafeedsResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

type QuoteListener = (quote: GlobalDatafeedsQuoteRow) => void;
type StatusListener = (connected: boolean, message?: string) => void;
type DebugListener = (event: {
  stage: string;
  message?: string;
  messageType?: string;
  payload?: unknown;
}) => void;

function requireConfig() {
  if (!env.GLOBAL_DATAFEEDS_ENABLED || !env.GLOBAL_DATAFEEDS_API_KEY) {
    throw new AppError(
      HTTP_STATUS.internalServerError,
      ERROR_CODES.internalError,
      ERROR_MESSAGES.providerNotConfigured
    );
  }
}

function parseMessage(raw: string): GlobalDatafeedsResponse | null {
  try {
    return JSON.parse(raw) as GlobalDatafeedsResponse;
  } catch {
    logger.warn(
      { provider: DATA_PROVIDER_KEY.globalDatafeeds, message: raw.slice(0, 300) },
      "Global Datafeeds non-JSON message"
    );
    return null;
  }
}

function getRequestMessageType(response: GlobalDatafeedsResponse) {
  const resultToRequestMessageType: Record<string, string> = {
    AuthenticateResult: GLOBAL_DATAFEEDS_MESSAGE_TYPE.authenticate,
    ExchangesResult: GLOBAL_DATAFEEDS_MESSAGE_TYPE.getExchanges,
    InstrumentsResult: GLOBAL_DATAFEEDS_MESSAGE_TYPE.getInstruments,
    InstrumentsOnSearchResult: GLOBAL_DATAFEEDS_MESSAGE_TYPE.getInstrumentsOnSearch,
    InstrumentSearchResult: GLOBAL_DATAFEEDS_MESSAGE_TYPE.getInstrumentsOnSearch,
    HistoryResult: GLOBAL_DATAFEEDS_MESSAGE_TYPE.getHistory,
    LastQuoteResult: GLOBAL_DATAFEEDS_MESSAGE_TYPE.getLastQuote,
    LastQuoteArrayResult: GLOBAL_DATAFEEDS_MESSAGE_TYPE.getLastQuoteArray,
    RealtimeResult: GLOBAL_DATAFEEDS_MESSAGE_TYPE.subscribeRealtime,
  };

  return (
    response.Request?.MessageType ??
    (response.MessageType ? resultToRequestMessageType[response.MessageType] : undefined) ??
    response.MessageType?.replace(/Result$/, "")
  );
}

function isAuxiliaryMessage(response: GlobalDatafeedsResponse) {
  return (
    response.MessageType === "AllowVMRunningResult" ||
    response.MessageType === "AllowServerOSRunningResult" ||
    response.MessageType === "Echo"
  );
}

function canUseSinglePendingFallback(response: GlobalDatafeedsResponse) {
  return response.MessageType === "RequestError";
}

function summarizePayload(payload: unknown) {
  if (Array.isArray(payload)) {
    return {
      kind: "array",
      count: payload.length,
      first: payload[0] ?? null,
    };
  }

  if (
    typeof payload === "object" &&
    payload !== null &&
    "Result" in payload &&
    Array.isArray((payload as GlobalDatafeedsResponse).Result)
  ) {
    const result = (payload as GlobalDatafeedsResponse).Result as unknown[];
    return {
      kind: "result-array",
      messageType: (payload as GlobalDatafeedsResponse).MessageType,
      count: result.length,
      first: result[0] ?? null,
    };
  }

  return payload;
}

export class GlobalDatafeedsWebSocketClient {
  private socket: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private authenticated = false;
  private pending = new Map<string, PendingRequest>();
  private quoteListeners = new Set<QuoteListener>();
  private statusListeners = new Set<StatusListener>();
  private debugListeners = new Set<DebugListener>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private shouldReconnect = false;

  isConfigured() {
    return Boolean(env.GLOBAL_DATAFEEDS_ENABLED && env.GLOBAL_DATAFEEDS_API_KEY);
  }

  addQuoteListener(listener: QuoteListener) {
    this.quoteListeners.add(listener);
    return () => this.quoteListeners.delete(listener);
  }

  addStatusListener(listener: StatusListener) {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  addDebugListener(listener: DebugListener) {
    this.debugListeners.add(listener);
    return () => this.debugListeners.delete(listener);
  }

  async request<T extends GlobalDatafeedsResponse = GlobalDatafeedsResponse>(
    request: GlobalDatafeedsRequest,
    timeoutMs = GLOBAL_DATAFEEDS_REQUEST_TIMEOUT_MS
  ): Promise<T> {
    await this.connect();

    if (this.socket?.readyState !== WebSocket.OPEN) {
      throw new AppError(
        HTTP_STATUS.badGateway,
        ERROR_CODES.providerError,
        "Global Datafeeds socket is not open"
      );
    }

    const userTag = request.UserTag ?? randomUUID();
    const payload = { ...request, UserTag: userTag };
    this.emitDebug({
      stage: "request.send",
      messageType: request.MessageType,
    });

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(userTag);
        this.emitDebug({
          stage: "request.timeout",
          messageType: request.MessageType,
        });
        reject(new Error(`Global Datafeeds request timed out: ${request.MessageType}`));
      }, timeoutMs);

      this.pending.set(userTag, {
        messageType: request.MessageType,
        userTag,
        resolve: (response) => resolve(response as T),
        reject,
        timeout,
      });

      this.socket?.send(JSON.stringify(payload), (error) => {
        if (!error) return;
        clearTimeout(timeout);
        this.pending.delete(userTag);
        reject(error);
      });
    });
  }

  async send(request: GlobalDatafeedsRequest) {
    await this.connect();
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(request));
  }

  close() {
    this.shouldReconnect = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
    this.connectPromise = null;
    this.authenticated = false;
  }

  private async connect() {
    requireConfig();
    if (this.socket?.readyState === WebSocket.OPEN && this.authenticated) return;
    if (this.connectPromise) return this.connectPromise;

    this.shouldReconnect = true;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.emitDebug({ stage: "socket.connecting", message: env.GLOBAL_DATAFEEDS_WS_URL });
      const socket = new WebSocket(env.GLOBAL_DATAFEEDS_WS_URL);
      this.socket = socket;

      const authTimeout = setTimeout(() => {
        this.emitDebug({ stage: "auth.timeout" });
        reject(new Error("Global Datafeeds authentication timed out"));
        socket.close();
      }, GLOBAL_DATAFEEDS_AUTH_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(authTimeout);
        this.connectPromise = null;
      };

      socket.on("open", () => {
        this.emitDebug({ stage: "socket.open" });
        this.emitDebug({ stage: "auth.send" });
        socket.send(
          JSON.stringify({
            MessageType: GLOBAL_DATAFEEDS_MESSAGE_TYPE.authenticate,
            Password: env.GLOBAL_DATAFEEDS_API_KEY,
          })
        );
      });

      socket.on("message", (raw) => {
        const response = parseMessage(raw.toString());
        if (!response) return;

        if (response.MessageType === GLOBAL_DATAFEEDS_MESSAGE_TYPE.authenticateResult) {
          if (response.Complete === true) {
            this.authenticated = true;
            cleanup();
            this.emitDebug({
              stage: "auth.success",
              message: response.Message,
              messageType: response.MessageType,
            });
            this.emitStatus(true);
            resolve();
          } else {
            cleanup();
            this.emitDebug({
              stage: "auth.failed",
              message: response.Message,
              messageType: response.MessageType,
            });
            reject(new Error(response.Message ?? "Global Datafeeds authentication failed"));
          }
          return;
        }

        this.handleMessage(response);
      });

      socket.on("close", () => {
        this.emitDebug({ stage: "socket.close" });
        cleanup();
        this.socket = null;
        this.authenticated = false;
        this.rejectPending(new Error("Global Datafeeds socket closed"));
        this.emitStatus(false);
        if (this.shouldReconnect) this.scheduleReconnect();
      });

      socket.on("error", (error) => {
        this.emitDebug({ stage: "socket.error", message: error.message });
        logger.warn(
          { provider: DATA_PROVIDER_KEY.globalDatafeeds, message: error.message },
          "Global Datafeeds socket error"
        );
      });
    });

    return this.connectPromise;
  }

  private handleMessage(response: GlobalDatafeedsResponse) {
    if (isAuxiliaryMessage(response)) {
      this.emitDebug({
        stage: "response.auxiliary",
        messageType: response.MessageType,
        payload: summarizePayload(response),
      });
      return;
    }

    if (response.MessageType === GLOBAL_DATAFEEDS_MESSAGE_TYPE.realtimeResult) {
      for (const listener of this.quoteListeners) {
        listener(response as GlobalDatafeedsQuoteRow);
      }
      return;
    }

    const userTag = response.Request?.UserTag;
    const requestMessageType = getRequestMessageType(response);
    let pending = userTag ? this.pending.get(userTag) : undefined;
    pending ??= [...this.pending.values()].find(
      (item) => item.messageType === requestMessageType
    );
    if (!pending && canUseSinglePendingFallback(response) && this.pending.size === 1) {
      pending = [...this.pending.values()][0];
    }

    if (!pending) {
      this.emitDebug({
        stage: "response.unmatched",
        messageType: response.MessageType,
        payload: summarizePayload(response),
      });
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(pending.userTag);
    this.emitDebug({
      stage: "request.result",
      messageType: pending.messageType,
    });
    pending.resolve(response);
  }

  private rejectPending(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => undefined);
    }, GLOBAL_DATAFEEDS_RECONNECT_DELAY_MS);
  }

  private emitStatus(connected: boolean, message?: string) {
    for (const listener of this.statusListeners) {
      listener(connected, message);
    }
  }

  private emitDebug(event: {
    stage: string;
    message?: string;
    messageType?: string;
    payload?: unknown;
  }) {
    for (const listener of this.debugListeners) {
      listener(event);
    }
  }
}

export const globalDatafeedsClient = new GlobalDatafeedsWebSocketClient();
