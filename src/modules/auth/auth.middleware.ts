import type { NextFunction, Request, Response } from "express";

import { USER_ROLE, type UserRole } from "../../shared/constants";
import { forbidden, unauthorized } from "../../shared/errors";
import { verifyAccessToken } from "../security/tokens";

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  if (!token) {
    throw unauthorized();
  }

  const payload = verifyAccessToken(token);
  req.user = {
    id: payload.sub,
    email: payload.email,
    role: payload.role,
    plan: payload.plan,
  };
  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  requireRole(USER_ROLE.admin)(req, _res, next);
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      throw unauthorized();
    }
    if (!roles.includes(req.user.role)) {
      throw forbidden();
    }
    next();
  };
}

export function getAuthUser(req: Request) {
  if (!req.user) {
    throw unauthorized();
  }
  return req.user;
}

export function getAuthUserId(req: Request) {
  return getAuthUser(req).id;
}
