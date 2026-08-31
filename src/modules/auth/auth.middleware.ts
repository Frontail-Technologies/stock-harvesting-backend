import type { NextFunction, Request, Response } from "express";

import { TOKEN_AUDIENCE, USER_ROLE, type UserRole } from "../../shared/constants";
import { forbidden, unauthorized } from "../../shared/errors";
import { verifyAccessToken } from "../security/tokens";

function extractBearerToken(req: Request): string {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  if (!token) {
    throw unauthorized();
  }
  return token;
}

// Gates every USER-portal route (the main app: charts, dashboard,
// watchlists, ...). Validates the access token's `aud` claim is the USER
// portal audience - an admin-portal token is structurally a valid,
// unexpired token for the same account, but verifyAccessToken rejects it
// here anyway, since it was never meant to authorize this portal (item 13:
// role/account existing is not enough).
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const payload = verifyAccessToken(extractBearerToken(req), TOKEN_AUDIENCE.user);
  req.user = {
    id: payload.sub,
    email: payload.email,
    role: payload.role,
    plan: payload.plan,
  };
  next();
}

// Gates every ADMIN-portal route. Validates the access token's `aud` claim
// is the ADMIN portal audience - a user-portal token (even one belonging
// to an admin-role account, which shouldn't exist post-login-enforcement
// anyway) is rejected here. Always pair with requireAdmin below: this
// checks WHICH SESSION the caller has, requireAdmin checks WHAT the
// underlying account is permitted to do - neither is a substitute for the
// other (item 8/14).
export function requireAdminAuth(req: Request, _res: Response, next: NextFunction) {
  const payload = verifyAccessToken(extractBearerToken(req), TOKEN_AUDIENCE.admin);
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
