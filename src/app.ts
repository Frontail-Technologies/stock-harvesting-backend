import cors from "cors";
import express, { type Request, type Response } from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { registerMarketCollectionsMetricsCollectors } from "./modules/market-collections/market-collections.metrics";
import { createRouter } from "./routes";
import { corsOrigins, env } from "./shared/env";
import { errorHandler, notFound } from "./shared/errors";
import { logger } from "./shared/logger";
import { httpMetricsMiddleware } from "./shared/metrics/http-metrics.middleware";
import { metricsRouter } from "./shared/metrics/metrics.routes";

export function createApp() {
  const app = express();

  app.set("trust proxy", env.TRUST_PROXY_HOPS);

  if (env.METRICS_ENABLED) {
    registerMarketCollectionsMetricsCollectors();
    app.use(metricsRouter);
    app.use(httpMetricsMiddleware);
  }

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
    }),
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
    }),
  );

  app.use(createRouter());

  app.use((_req, _res, next) => {
    next(notFound("Route not found"));
  });
  app.use(errorHandler);

  return app;
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
