import { eq } from "drizzle-orm";

import { db } from "../../db/client";
import { users } from "../../db/schema";
import type { AuthPortal } from "../../shared/constants";
import { unauthorized } from "../../shared/errors";
import { normalizeEmail, verifyPassword } from "../security/passwords";
import { GENERIC_LOGIN_ERROR } from "./auth.constants";
import { toAuthUser } from "./auth.helpers";
import { createSession, evaluatePortalAccess } from "./session.service";

export async function loginWithPassword(input: {
  email: string;
  password: string;
  portal: AuthPortal;
}) {
  const email = normalizeEmail(input.email);
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

  if (!user) {
    throw unauthorized(GENERIC_LOGIN_ERROR);
  }

  const validPassword = await verifyPassword(input.password, user.passwordHash);
  if (!validPassword) {
    throw unauthorized(GENERIC_LOGIN_ERROR);
  }

  const access = evaluatePortalAccess(user.role, input.portal);
  if (!access.allowed) {
    throw unauthorized(GENERIC_LOGIN_ERROR);
  }

  const authUser = toAuthUser(user);
  const session = await createSession(authUser, input.portal);
  return { user: authUser, ...session };
}
