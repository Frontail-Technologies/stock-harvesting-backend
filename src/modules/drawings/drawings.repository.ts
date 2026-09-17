import { and, eq } from "drizzle-orm";

import { db } from "../../db/client";
import { scannerDrawings } from "../../db/schema";
import type { CandleTimeframe } from "../../shared/constants";

type DrawingInput = {
  id?: string;
  drawingType: string;
  payload: Record<string, unknown>;
  locked: boolean;
  hidden: boolean;
};

export async function findWorkspaceDrawingRows(input: {
  userId: string;
  symbol: string;
  timeframe: CandleTimeframe;
  exchange: string;
}) {
  return db
    .select()
    .from(scannerDrawings)
    .where(
      and(
        eq(scannerDrawings.userId, input.userId),
        eq(scannerDrawings.exchange, input.exchange),
        eq(scannerDrawings.symbol, input.symbol),
        eq(scannerDrawings.timeframe, input.timeframe)
      )
    );
}

export async function replaceWorkspaceDrawingRows(input: {
  userId: string;
  symbol: string;
  timeframe: CandleTimeframe;
  exchange: string;
  drawings: DrawingInput[];
}) {
  await db.transaction(async (tx) => {
    await tx
      .delete(scannerDrawings)
      .where(
        and(
          eq(scannerDrawings.userId, input.userId),
          eq(scannerDrawings.exchange, input.exchange),
          eq(scannerDrawings.symbol, input.symbol),
          eq(scannerDrawings.timeframe, input.timeframe)
        )
      );

    if (input.drawings.length > 0) {
      await tx.insert(scannerDrawings).values(
        input.drawings.map((drawing) => ({
          id: drawing.id,
          userId: input.userId,
          exchange: input.exchange,
          symbol: input.symbol,
          timeframe: input.timeframe,
          drawingType: drawing.drawingType,
          payload: drawing.payload,
          locked: drawing.locked,
          hidden: drawing.hidden,
        }))
      );
    }
  });
}

export async function findDrawingById(id: string) {
  const [row] = await db.select().from(scannerDrawings).where(eq(scannerDrawings.id, id)).limit(1);
  return row;
}

export async function updateDrawingRow(input: { id: string; patch: Partial<DrawingInput> }) {
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

  return updated;
}

export async function deleteDrawingRow(id: string) {
  await db.delete(scannerDrawings).where(eq(scannerDrawings.id, id));
}
