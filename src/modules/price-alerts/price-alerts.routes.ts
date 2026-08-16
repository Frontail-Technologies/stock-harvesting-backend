import { Router } from "express";

import { sendData } from "../../shared/http";
import { asyncHandler, getAuthUserId, requireAuth, validate } from "../../shared/middleware";
import {
  createPriceAlertBodySchema,
  listPriceAlertsQuerySchema,
  priceAlertIdParamsSchema,
  updatePriceAlertBodySchema,
} from "./price-alerts.schemas";
import {
  createPriceAlert,
  deletePriceAlert,
  listPriceAlerts,
  updatePriceAlert,
  type PriceAlertStatus,
} from "./price-alerts.service";

export const priceAlertsRouter = Router();

priceAlertsRouter.use(requireAuth);

priceAlertsRouter.get(
  "/",
  validate({ query: listPriceAlertsQuerySchema }),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as {
      exchange?: string;
      symbol?: string;
      status?: PriceAlertStatus;
    };
    const alerts = await listPriceAlerts({ userId: getAuthUserId(req), ...query });
    sendData(res, { alerts });
  })
);

priceAlertsRouter.post(
  "/",
  validate({ body: createPriceAlertBodySchema }),
  asyncHandler(async (req, res) => {
    const alert = await createPriceAlert({ userId: getAuthUserId(req), ...req.body });
    sendData(res, { alert });
  })
);

priceAlertsRouter.patch(
  "/:id",
  validate({ params: priceAlertIdParamsSchema, body: updatePriceAlertBodySchema }),
  asyncHandler(async (req, res) => {
    const params = req.params as { id: string };
    const alert = await updatePriceAlert({ userId: getAuthUserId(req), id: params.id, ...req.body });
    sendData(res, { alert });
  })
);

priceAlertsRouter.delete(
  "/:id",
  validate({ params: priceAlertIdParamsSchema }),
  asyncHandler(async (req, res) => {
    const params = req.params as { id: string };
    sendData(res, await deletePriceAlert({ userId: getAuthUserId(req), id: params.id }));
  })
);
