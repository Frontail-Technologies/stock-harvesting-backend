import type { NextFunction, Request, Response } from "express";
import type { ZodType } from "zod";

type ValidationSchemas = {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
};

function setRequestValue<T extends keyof Request>(
  req: Request,
  key: T,
  value: Request[T]
) {
  Object.defineProperty(req, key, {
    value,
    configurable: true,
    enumerable: true,
    writable: true,
  });
}

export function validate(schemas: ValidationSchemas) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (schemas.body) {
      setRequestValue(req, "body", schemas.body.parse(req.body) as Request["body"]);
    }
    if (schemas.query) {
      setRequestValue(req, "query", schemas.query.parse(req.query) as Request["query"]);
    }
    if (schemas.params) {
      setRequestValue(req, "params", schemas.params.parse(req.params) as Request["params"]);
    }
    next();
  };
}
