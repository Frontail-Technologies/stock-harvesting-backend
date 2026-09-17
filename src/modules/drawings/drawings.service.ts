import { scannerDrawings } from "../../db/schema";
import { DEFAULT_EXCHANGE, type CandleTimeframe } from "../../shared/constants";
import { forbidden, notFound } from "../../shared/errors";
import { normalizeSymbol } from "../../shared/normalize";
import {
  deleteDrawingRow,
  findDrawingById,
  findWorkspaceDrawingRows,
  replaceWorkspaceDrawingRows,
  updateDrawingRow,
} from "./drawings.repository";

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
  const rows = await findWorkspaceDrawingRows({
    userId: input.userId,
    symbol: normalizeSymbol(input.symbol),
    timeframe: input.timeframe,
    exchange: input.exchange ?? DEFAULT_EXCHANGE,
  });

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

  await replaceWorkspaceDrawingRows({
    userId: input.userId,
    symbol,
    timeframe: input.timeframe,
    exchange,
    drawings: input.drawings,
  });

  return getWorkspaceDrawings({ ...input, exchange });
}

export async function patchDrawing(input: {
  userId: string;
  id: string;
  patch: Partial<DrawingInput>;
}) {
  const existing = await findDrawingById(input.id);

  if (!existing) throw notFound("Drawing not found");
  if (existing.userId !== input.userId) throw forbidden("Drawing belongs to another user");

  const updated = await updateDrawingRow({ id: input.id, patch: input.patch });
  return toDrawingResponse(updated);
}

export async function deleteDrawing(input: { userId: string; id: string }) {
  const existing = await findDrawingById(input.id);

  if (!existing) throw notFound("Drawing not found");
  if (existing.userId !== input.userId) throw forbidden("Drawing belongs to another user");

  await deleteDrawingRow(input.id);
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
