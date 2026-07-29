import type { UserPlan, UserRole } from "../shared/constants";

declare global {
  namespace Express {
    export interface Request {
      user?: {
        id: string;
        email: string;
        role: UserRole;
        plan: UserPlan;
      };
    }
  }
}

export {};
