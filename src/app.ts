import cors from "cors";
import express, { type Request, type Response } from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";

import { pool } from "./db/client";
import { adminRouter } from "./modules/admin/admin.routes";
import { aiRouter } from "./modules/ai/ai.routes";
import { authRouter } from "./modules/auth/auth.routes";
import { drawingsRouter } from "./modules/drawings/drawings.routes";
import { marketCollectionsRouter } from "./modules/market-collections/market-collections.routes";
import { marketDataRouter } from "./modules/market-data/market-data.routes";
import { priceAlertsRouter } from "./modules/price-alerts/price-alerts.routes";
import { pushSubscriptionsRouter } from "./modules/push-subscriptions/push-subscriptions.routes";
import { scannerRouter } from "./modules/scanner/scanner.routes";
import { usersRouter } from "./modules/users/users.routes";
import { API_ROUTES, HTTP_STATUS } from "./shared/constants";
import { corsOrigins } from "./shared/env";
import { errorHandler, notFound } from "./shared/errors";
import { sendData } from "./shared/http";
import { logger } from "./shared/logger";

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || corsOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error("Origin is not allowed"));
      },
      credentials: true,
    })
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(
    pinoHttp<Request, Response>({
      logger,
      quietReqLogger: true,
      quietResLogger: true,
      wrapSerializers: false,
      serializers: {
        req: (req) => toSafeRequestLog(req as Request),
        res: (res) => ({
          statusCode: (res as Response).statusCode,
        }),
      },
      customSuccessObject: (req, res, value) => ({
        req: toSafeRequestLog(req),
        res: {
          statusCode: res.statusCode,
        },
        responseTime: value.responseTime,
      }),
      customErrorObject: (req, res, error, value) => ({
        req: toSafeRequestLog(req),
        res: {
          statusCode: res.statusCode,
        },
        responseTime: value.responseTime,
        error: {
          message: error.message,
        },
      }),
    })
  );

  app.get(API_ROUTES.health, async (_req, res) => {
    const database = await checkDatabaseHealth();

    sendData(
      res,
      {
        ok: database.ok,
        service: "stock-harvesting-backend",
        timestamp: new Date().toISOString(),
        database,
      },
      database.ok ? HTTP_STATUS.ok : HTTP_STATUS.serviceUnavailable
    );
  });

  app.use(API_ROUTES.auth, authRouter);
  app.use(API_ROUTES.users, usersRouter);
  app.use(API_ROUTES.marketData, marketDataRouter);
  app.use(API_ROUTES.marketCollections, marketCollectionsRouter);
  app.use(API_ROUTES.scanner, scannerRouter);
  app.use(API_ROUTES.scanner, drawingsRouter);
  app.use(API_ROUTES.admin, adminRouter);
  app.use(API_ROUTES.ai, aiRouter);
  app.use(API_ROUTES.priceAlerts, priceAlertsRouter);
  app.use(API_ROUTES.pushSubscriptions, pushSubscriptionsRouter);

  app.use((_req, _res, next) => {
    next(notFound("Route not found"));
  });
  app.use(errorHandler);

  return app;
}

const DATABASE_HEALTH_CHECK_TIMEOUT_MS = 2_000;

// A lightweight liveness probe for the database connection itself, not just
// "the Node process is running" — the health route previously always
// returned ok:true even if Postgres was completely unreachable. Times out
// independently of DB_CONNECTION_TIMEOUT_MS so a slow-but-not-dead database
// still reports unhealthy quickly rather than hanging the health check too.
async function checkDatabaseHealth() {
  const startedAt = Date.now();

  try {
    await Promise.race([
      pool.query("SELECT 1"),
      new Promise((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("Database health check timed out")),
          DATABASE_HEALTH_CHECK_TIMEOUT_MS
        )
      ),
    ]);

    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      pool: {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      },
    };
  } catch (error) {
    logger.error(
      { message: error instanceof Error ? error.message : "Unknown error" },
      "Database health check failed"
    );

    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      pool: {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      },
    };
  }
}

function toSafeRequestLog(req: Request) {
  return {
    id: req.id,
    method: req.method,
    url: req.originalUrl,
    path: req.path,
    queryKeys: Object.keys(req.query ?? {}),
    remoteAddress: req.ip,
  };
}
