import type { IncomingMessage, Server } from "http";
import { WebSocketServer, type RawData, type WebSocket } from "ws";

import { verifyAccessToken } from "../security/tokens";
import { TOKEN_AUDIENCE } from "../../shared/constants";
import { logger } from "../../shared/logger";
import {
  registerMarketStreamClient,
  getMarketStreamStats,
} from "./market-stream.hub";
import {
  subscribeMarketStreamSymbols,
  unsubscribeMarketStreamSymbols,
} from "./market-stream.service";
import type { MarketStreamClientMessage, MarketStreamUser } from "./market-stream.types";

const MARKET_STREAM_PATH = "/ws/market";

function parseToken(req: IncomingMessage) {
  const url = new URL(req.url ?? "", "http://localhost");
  const queryToken = url.searchParams.get("token");
  const protocolHeader = req.headers["sec-websocket-protocol"];
  const protocolToken = Array.isArray(protocolHeader)
    ? protocolHeader[0]
    : protocolHeader;

  return queryToken || protocolToken?.replace(/^bearer,\s*/i, "") || null;
}

function parseMessage(raw: Buffer): MarketStreamClientMessage | null {
  try {
    const parsed = JSON.parse(raw.toString("utf8")) as MarketStreamClientMessage;
    if (!parsed || typeof parsed !== "object" || !("type" in parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function attachMarketStreamGateway(server: Server) {
  const wss = new WebSocketServer({
    noServer: true,
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "", "http://localhost");
    if (url.pathname !== MARKET_STREAM_PATH) return;

    const token = parseToken(req);
    if (!token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    let user;
    try {
      const payload = verifyAccessToken(token, TOKEN_AUDIENCE.user);
      user = {
        id: payload.sub,
        email: payload.email,
        role: payload.role,
        plan: payload.plan,
      };
    } catch {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      setupMarketStreamConnection(ws, user);
    });
  });

  logger.info({ path: MARKET_STREAM_PATH }, "Market stream gateway attached");

  return {
    close: () =>
      new Promise<void>((resolve) => {
        wss.close(() => resolve());
      }),
    stats: getMarketStreamStats,
  };
}

function setupMarketStreamConnection(socket: WebSocket, user: MarketStreamUser) {
  const client = registerMarketStreamClient(socket, user, {
    onSubscribe: subscribeMarketStreamSymbols,
    onUnsubscribe: unsubscribeMarketStreamSymbols,
  });

  socket.on("message", (raw: RawData) => {
    const message = parseMessage(Buffer.isBuffer(raw) ? raw : Buffer.from(raw.toString()));
    if (!message) {
      client.error("INVALID_MESSAGE", "Invalid market stream message");
      return;
    }

    if (message.type === "subscribe") {
      client.subscribe(message.symbols);
      return;
    }

    if (message.type === "unsubscribe") {
      client.unsubscribe(message.symbols);
      return;
    }

    if (message.type === "ping") {
      client.pong();
    }
  });
}
