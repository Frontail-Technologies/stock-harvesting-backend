import { eq } from "drizzle-orm";

import { db } from "../../db/client";
import { users } from "../../db/schema";
import { PLAN_USAGE_LIMITS } from "../../shared/constants";
import { notFound } from "../../shared/errors";

export async function getUserProfile(userId: string) {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw notFound("User not found");

  const usageLimits = PLAN_USAGE_LIMITS[user.plan];

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    avatarUrl: user.avatarUrl,
    role: user.role,
    plan: user.plan,
    usage: {
      dailyScanLimit: usageLimits.dailyScanLimit,
      scansUsedToday: 0,
      savedSignals: 0,
      activeAlerts: 0,
      apiAccessEnabled: usageLimits.apiAccessEnabled,
    },
  };
}
