import type { Request, Response } from "express";

import { sendData } from "../../shared/http";
import { getPublicMonetizationConfig } from "./monetization.service";

export async function getPublicMonetizationConfigController(_req: Request, res: Response) {
  sendData(res, await getPublicMonetizationConfig());
}
