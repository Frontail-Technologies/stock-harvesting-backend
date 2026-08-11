import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema";
import { env } from "../shared/env";
import { logger } from "../shared/logger";

// Max possible connections to Postgres from this deployment:
//   (API process pool max) + (worker process pool max)
// Today that's exactly 2 processes — `npm run dev`/`start` (server.ts) and
// the optional `npm run worker` (worker.ts) — each importing this module
// and getting its own `Pool` instance (module state doesn't cross OS
// processes), so total = 2 * DB_POOL_MAX. No PM2/cluster mode is
// configured, so this is the real ceiling, not an estimate padded for
// hypothetical replicas — see docs/DATABASE.md if that changes.
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DB_POOL_MAX,
  connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
  idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
  statement_timeout: env.DB_STATEMENT_TIMEOUT_MS,
  query_timeout: env.DB_QUERY_TIMEOUT_MS,
});

// An idle client emitting an error with no listener is an unhandled
// 'error' event in Node — that crashes the process. Postgres connections
// can be dropped by the network or the server at any time, so this is a
// real, not hypothetical, gap without a handler.
pool.on("error", (error) => {
  logger.error({ message: error.message }, "Database pool error on an idle client");
});

export const db = drizzle(pool, { schema });

export type DbClient = typeof db;
// The type Drizzle actually passes into `db.transaction(async (tx) => ...)`.
// Derived instead of hand-typed so it always matches whatever this Drizzle
// version infers, rather than duplicating (and risking drift from) its
// internal generic signature.
export type DbTransaction = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
// What helper functions that may run inside or outside a transaction should
// accept — either the pooled client or an open transaction handle.
export type DbOrTx = DbClient | DbTransaction;
