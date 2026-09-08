import type { users } from "../../db/schema";
import type { AuthUser } from "./auth.types";

export function toAuthUser(user: typeof users.$inferSelect): AuthUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    role: user.role,
    plan: user.plan,
  };
}
