import { and, desc, eq } from "drizzle-orm";

import { db } from "../../db/client";
import { priceAlerts } from "../../db/schema";
import { DEFAULT_EXCHANGE } from "../../shared/constants";
import { badRequest, forbidden, notFound } from "../../shared/errors";
import { logger } from "../../shared/logger";
import { normalizeSymbol } from "../../shared/normalize";
import { sendPriceAlertNotification } from "../push-subscriptions/push-subscriptions.service";

export type PriceAlertCondition = "ABOVE" | "BELOW";
export type PriceAlertStatus = "ACTIVE" | "TRIGGERED" | "DISABLED";

export function isPriceAlertTriggered(input: {
  status: PriceAlertStatus;
  condition: PriceAlertCondition;
  targetPrice: number;
  price: number;
}) {
  if (input.status !== "ACTIVE") return false;
  return input.condition === "ABOVE"
    ? input.price >= input.targetPrice
    : input.price <= input.targetPrice;
}

export function getInvalidPriceAlertTargetMessage(input: {
  condition: PriceAlertCondition;
  targetPrice: number;
  currentPrice?: number | null;
}) {
  if (!Number.isFinite(input.currentPrice ?? NaN)) return null;
  const currentPrice = Number(input.currentPrice);
  if (input.condition === "ABOVE" && input.targetPrice <= currentPrice) {
    return "For ABOVE alerts, target price must be greater than the current price.";
  }
  if (input.condition === "BELOW" && input.targetPrice >= currentPrice) {
    return "For BELOW alerts, target price must be lower than the current price.";
  }
  return null;
}

export async function listPriceAlerts(input: {
  userId: string;
  exchange?: string;
  symbol?: string;
  status?: PriceAlertStatus;
}) {
  const filters = [eq(priceAlerts.userId, input.userId)];
  if (input.exchange) filters.push(eq(priceAlerts.exchange, input.exchange));
  if (input.symbol) filters.push(eq(priceAlerts.symbol, normalizeSymbol(input.symbol)));
  if (input.status) filters.push(eq(priceAlerts.status, input.status));

  const rows = await db
    .select()
    .from(priceAlerts)
    .where(and(...filters))
    .orderBy(desc(priceAlerts.createdAt));

  return rows.map(toPriceAlertResponse);
}

export async function createPriceAlert(input: {
  userId: string;
  exchange: string;
  symbol: string;
  condition: PriceAlertCondition;
  targetPrice: number;
  currentPrice?: number | null;
}) {
  const invalidTargetMessage = getInvalidPriceAlertTargetMessage(input);
  if (invalidTargetMessage) throw badRequest(invalidTargetMessage);
  const [row] = await db
    .insert(priceAlerts)
    .values({
      userId: input.userId,
      exchange: input.exchange || DEFAULT_EXCHANGE,
      symbol: normalizeSymbol(input.symbol),
      condition: input.condition,
      targetPrice: String(input.targetPrice),
      status: "ACTIVE",
    })
    .returning();

  return toPriceAlertResponse(row);
}

export async function updatePriceAlert(input: {
  userId: string;
  id: string;
  status?: PriceAlertStatus;
  targetPrice?: number;
}) {
  const [existing] = await db.select().from(priceAlerts).where(eq(priceAlerts.id, input.id)).limit(1);
  if (!existing) throw notFound("Price alert not found");
  if (existing.userId !== input.userId) throw forbidden("Price alert belongs to another user");

  const [row] = await db
    .update(priceAlerts)
    .set({
      status: input.status,
      targetPrice: input.targetPrice === undefined ? undefined : String(input.targetPrice),
      triggeredAt: input.status === "TRIGGERED" ? new Date() : undefined,
      updatedAt: new Date(),
    })
    .where(eq(priceAlerts.id, input.id))
    .returning();

  return toPriceAlertResponse(row);
}

export async function deletePriceAlert(input: { userId: string; id: string }) {
  const [existing] = await db.select().from(priceAlerts).where(eq(priceAlerts.id, input.id)).limit(1);
  if (!existing) throw notFound("Price alert not found");
  if (existing.userId !== input.userId) throw forbidden("Price alert belongs to another user");
  await db.delete(priceAlerts).where(eq(priceAlerts.id, input.id));
  return { ok: true };
}

export async function evaluatePriceAlertsForQuote(input: {
  exchange: string;
  symbol: string;
  price: number;
}) {
  const symbol = normalizeSymbol(input.symbol);
  const rows = await db
    .select()
    .from(priceAlerts)
    .where(
      and(
        eq(priceAlerts.exchange, input.exchange),
        eq(priceAlerts.symbol, symbol),
        eq(priceAlerts.status, "ACTIVE")
      )
    );

  for (const alert of rows) {
    const targetPrice = Number(alert.targetPrice);
    const triggered = isPriceAlertTriggered({
      status: alert.status as PriceAlertStatus,
      condition: alert.condition as PriceAlertCondition,
      targetPrice,
      price: input.price,
    });
    if (!triggered) continue;

    const [updated] = await db
      .update(priceAlerts)
      .set({ status: "TRIGGERED", triggeredAt: new Date(), updatedAt: new Date() })
      .where(and(eq(priceAlerts.id, alert.id), eq(priceAlerts.status, "ACTIVE")))
      .returning();

    if (!updated) continue;

    try {
      await sendPriceAlertNotification({
        userId: alert.userId,
        exchange: input.exchange,
        symbol,
        condition: alert.condition as PriceAlertCondition,
        targetPrice,
        price: input.price,
      });
    } catch (error) {
      logger.warn(
        { alertId: alert.id, message: error instanceof Error ? error.message : "Unknown push error" },
        "Price alert push notification failed"
      );
    }
  }
}

function toPriceAlertResponse(row: typeof priceAlerts.$inferSelect) {
  return {
    id: row.id,
    exchange: row.exchange,
    symbol: row.symbol,
    condition: row.condition as PriceAlertCondition,
    targetPrice: Number(row.targetPrice),
    status: row.status as PriceAlertStatus,
    triggeredAt: row.triggeredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
