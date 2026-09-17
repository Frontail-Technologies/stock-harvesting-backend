import { pool } from "../../db/client";
import { getErrorMessage } from "../../shared/errors";
import { logger } from "../../shared/logger";

const DATABASE_HEALTH_CHECK_TIMEOUT_MS = 2_000;

export async function checkDatabaseHealth() {
  const startedAt = Date.now();

  try {
    await Promise.race([
      pool.query("SELECT 1"),
      new Promise((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("Database health check timed out")),
          DATABASE_HEALTH_CHECK_TIMEOUT_MS,
        ),
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
      { message: getErrorMessage(error, "Unknown error") },
      "Database health check failed",
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

export async function getServiceHealth() {
  const database = await checkDatabaseHealth();

  return {
    ok: database.ok,
    service: "stock-harvesting-backend",
    timestamp: new Date().toISOString(),
    database,
  };
}
