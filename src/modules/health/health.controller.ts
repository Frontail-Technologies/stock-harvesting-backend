import type { Request, Response } from "express";

import { HTTP_STATUS } from "../../shared/constants";
import { sendData } from "../../shared/http";
import { getServiceHealth } from "./health.service";

export async function getHealthController(_req: Request, res: Response) {
  const health = await getServiceHealth();
  sendData(res, health, health.ok ? HTTP_STATUS.ok : HTTP_STATUS.serviceUnavailable);
}
