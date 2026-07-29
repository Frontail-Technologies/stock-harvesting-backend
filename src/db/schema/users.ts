import { pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

import {
  DEFAULT_USER_PLAN,
  DEFAULT_USER_ROLE,
} from "../../shared/constants";
import { userPlanEnum, userRoleEnum } from "./enums";

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  avatarUrl: text("avatar_url"),
  role: userRoleEnum("role").default(DEFAULT_USER_ROLE).notNull(),
  plan: userPlanEnum("plan").default(DEFAULT_USER_PLAN).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
