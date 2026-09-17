import type { NextFunction, Request, Response } from "express";

import { rateLimited } from "../errors";

type RateLimitOptions = {
  keyPrefix: string;
  windowMs: number;
  max: number;
};

type Bucket = {
  resetAt: number;
  count: number;
};

const buckets = new Map<string, Bucket>();
const SWEEP_INTERVAL_MS = 5 * 60_000;

function requestKey(req: Request, keyPrefix: string) {
  const body = req.body as { email?: unknown } | undefined;
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  return [keyPrefix, req.ip || req.socket.remoteAddress || "unknown", email].join(":");
}

export function rateLimit(options: RateLimitOptions) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = requestKey(req, options.keyPrefix);
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }

    if (bucket.count >= options.max) {
      next(rateLimited());
      return;
    }

    bucket.count += 1;
    next();
  };
}

function sweepExpiredBuckets() {
  const now = Date.now();
  for (const [key, bucket] of buckets.entries()) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

const sweepInterval = setInterval(sweepExpiredBuckets, SWEEP_INTERVAL_MS);
sweepInterval.unref();
