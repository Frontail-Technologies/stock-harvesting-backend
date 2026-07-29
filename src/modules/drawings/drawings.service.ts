import { and, eq } from "drizzle-orm";

import { db } from "../../db/client";
import { scannerDrawings } from "../../db/schema";
import { DEFAULT_EXCHANGE, type CandleTimeframe } from "../../shared/constants";
import { forbidden, notFound } from "../../shared/errors";
import { normalizeSymbol } from "../../shared/normalize";

type DrawingInput = {
  id?: string;
  drawingType: string;
  payload: Record<string, unknown>;
  locked: boolean;
  hidden: boolean;
};

export async function getWorkspaceDrawings(input: {
  userId: string;
  symbol: string;
  timeframe: CandleTimeframe;
  exchange?: string;
}) {
  const exchange = input.exchange ?? DEFAULT_EXCHANGE;
  const rows = await db
    .select()
    .from(scannerDrawings)
    .where(
      and(
        eq(scannerDrawings.userId, input.userId),
        eq(scannerDrawings.exchange, exchange),
        eq(scannerDrawings.symbol, normalizeSymbol(input.symbol)),
        eq(scannerDrawings.timeframe, input.timeframe)
      )
    );

  return rows.map(toDrawingResponse);
}

export async function replaceWorkspaceDrawings(input: {
  userId: string;
  symbol: string;
  timeframe: CandleTimeframe;
  drawings: DrawingInput[];
  exchange?: string;
}) {
  const symbol = normalizeSymbol(input.symbol);
  const exchange = input.exchange ?? DEFAULT_EXCHANGE;

  await db.transaction(async (tx) => {
    await tx
      .delete(scannerDrawings)
      .where(
        and(
          eq(scannerDrawings.userId, input.userId),
          eq(scannerDrawings.exchange, exchange),
          eq(scannerDrawings.symbol, symbol),
          eq(scannerDrawings.timeframe, input.timeframe)
        )
      );

    if (input.drawings.length > 0) {
      await tx.insert(scannerDrawings).values(
        input.drawings.map((drawing) => ({
          id: drawing.id,
          userId: input.userId,
          exchange,
          symbol,
          timeframe: input.timeframe,
          drawingType: drawing.drawingType,
          payload: drawing.payload,
          locked: drawing.locked,
          hidden: drawing.hidden,
        }))
      );
    }
  });

  return getWorkspaceDrawings({ ...input, exchange });
}

export async function patchDrawing(input: {
  userId: string;
  id: string;
  patch: Partial<DrawingInput>;
}) {
  const [existing] = await db
    .select()
    .from(scannerDrawings)
    .where(eq(scannerDrawings.id, input.id))
    .limit(1);

  if (!existing) throw notFound("Drawing not found");
  if (existing.userId !== input.userId) throw forbidden("Drawing belongs to another user");

  const [updated] = await db
    .update(scannerDrawings)
    .set({
      drawingType: input.patch.drawingType,
      payload: input.patch.payload,
      locked: input.patch.locked,
      hidden: input.patch.hidden,
      updatedAt: new Date(),
    })
    .where(eq(scannerDrawings.id, input.id))
    .returning();

  return toDrawingResponse(updated);
}

export async function deleteDrawing(input: { userId: string; id: string }) {
  const [existing] = await db
    .select()
    .from(scannerDrawings)
    .where(eq(scannerDrawings.id, input.id))
    .limit(1);

  if (!existing) throw notFound("Drawing not found");
  if (existing.userId !== input.userId) throw forbidden("Drawing belongs to another user");

  await db.delete(scannerDrawings).where(eq(scannerDrawings.id, input.id));
  return { ok: true };
}

function toDrawingResponse(row: typeof scannerDrawings.$inferSelect) {
  return {
    id: row.id,
    symbol: row.symbol,
    timeframe: row.timeframe,
    drawingType: row.drawingType,
    payload: row.payload,
    locked: row.locked,
    hidden: row.hidden,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
