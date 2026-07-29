import { Router } from "express";

import type { CandleTimeframe } from "../../shared/constants";
import { sendData } from "../../shared/http";
import { asyncHandler, requireAuth, validate } from "../../shared/middleware";
import { askScannerQuestionBodySchema, askScannerQuestionParamsSchema } from "./ai.schemas";
import { askScannerQuestion } from "./ai.service";

export const aiRouter = Router();

aiRouter.use(requireAuth);

aiRouter.post(
  "/scanner/:symbol/ask",
  validate({ params: askScannerQuestionParamsSchema, body: askScannerQuestionBodySchema }),
  asyncHandler(async (req, res) => {
    const params = req.params as { symbol: string };
    const body = req.body as {
      question: string;
      timeframe: CandleTimeframe;
      exchange: string;
      history: Array<{ role: "user" | "assistant"; text: string }>;
    };
    const result = await askScannerQuestion({ symbol: params.symbol, ...body });
    sendData(res, result);
  })
);
