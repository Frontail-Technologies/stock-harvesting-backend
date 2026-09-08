import type { UserPlan, UserRole } from "../../shared/constants";

export type AuthUser = {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  role: UserRole;
  plan: UserPlan;
};
