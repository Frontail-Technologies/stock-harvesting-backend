import type { Response } from "express";

import { HTTP_STATUS } from "./constants";

export type ApiSuccess<T> = {
  data: T;
};

export function sendData<T>(res: Response, data: T, status: number = HTTP_STATUS.ok) {
  return res.status(status).json({ data } satisfies ApiSuccess<T>);
}

export function sendCreated<T>(res: Response, data: T) {
  return sendData(res, data, HTTP_STATUS.created);
}

export function sendAccepted<T>(res: Response, data: T) {
  return sendData(res, data, HTTP_STATUS.accepted);
}

export function sendNoContent(res: Response) {
  return res.status(HTTP_STATUS.noContent).send();
}
