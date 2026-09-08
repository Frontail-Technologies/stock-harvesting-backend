import type { NextFunction, Request, Response } from "express";

import { API_ROUTES } from "../constants";
import {
  httpRequestDurationSeconds,
  httpRequestsTotal,
  safeInc,
} from "./metrics";

export function httpMetricsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (req.path === API_ROUTES.metrics) {
    next();
    return;
  }

  const endTimer = httpRequestDurationSeconds.startTimer();

  res.on("finish", () => {
    try {
      const route = routeLabel(req);
      const statusClass = `${Math.floor(res.statusCode / 100)}xx`;
      endTimer({ method: req.method, route });
      safeInc(httpRequestsTotal, {
        method: req.method,
        route,
        status_class: statusClass,
      });
    } catch {}
  });

  next();
}

function routeLabel(req: Request): string {
  const routePath = (req.route as { path?: string } | undefined)?.path;
  if (!routePath) return "unmatched";
  return `${req.baseUrl}${routePath}` || routePath;
}
