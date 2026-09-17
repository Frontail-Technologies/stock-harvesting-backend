import type { Request, Response } from "express";

import type { CandleTimeframe } from "../../shared/constants";
import { sendData } from "../../shared/http";
import { getAuthUserId } from "../../shared/middleware";
import { deleteDrawing, getWorkspaceDrawings, patchDrawing, replaceWorkspaceDrawings } from "./drawings.service";

export async function getWorkspaceDrawingsController(req: Request, res: Response) {
  const params = req.params as { symbol: string; timeframe: CandleTimeframe };
  const query = req.query as unknown as { exchange: string };
  const drawings = await getWorkspaceDrawings({
    userId: getAuthUserId(req),
    ...params,
    exchange: query.exchange,
  });
  sendData(res, { drawings });
}

export async function replaceWorkspaceDrawingsController(req: Request, res: Response) {
  const params = req.params as { symbol: string; timeframe: CandleTimeframe };
  const query = req.query as unknown as { exchange: string };
  const body = req.body as {
    drawings: {
      id?: string;
      drawingType: string;
      payload: Record<string, unknown>;
      locked: boolean;
      hidden: boolean;
    }[];
  };
  const drawings = await replaceWorkspaceDrawings({
    userId: getAuthUserId(req),
    ...params,
    exchange: query.exchange,
    drawings: body.drawings,
  });
  sendData(res, { drawings });
}

export async function patchDrawingController(req: Request, res: Response) {
  const params = req.params as { id: string };
  const drawing = await patchDrawing({
    userId: getAuthUserId(req),
    id: params.id,
    patch: req.body,
  });
  sendData(res, { drawing });
}

export async function deleteDrawingController(req: Request, res: Response) {
  const params = req.params as { id: string };
  const result = await deleteDrawing({
    userId: getAuthUserId(req),
    id: params.id,
  });
  sendData(res, result);
}
