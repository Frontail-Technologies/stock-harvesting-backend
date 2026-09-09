import { eq } from "drizzle-orm";

import { db } from "../db/client";
import { users } from "../db/schema";
import { USER_ROLE } from "../shared/constants";
import { getErrorMessage } from "../shared/errors";
import { hashPassword, normalizeEmail } from "../modules/security/passwords";

// One-time/ops bootstrap for the very first admin account (or promoting an
// existing user to admin) - there is no other way to create an admin today,
// since the admin API itself requires an existing admin session to call it.
// Deliberately takes credentials via CLI flags/env vars rather than a
// hardcoded default, and never logs the plaintext password.

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;
const DEFAULT_ADMIN_NAME = "Admin";

export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const eqIndex = raw.indexOf("=");
    if (eqIndex === -1) {
      args[raw.slice(2)] = true;
    } else {
      args[raw.slice(2, eqIndex)] = raw.slice(eqIndex + 1);
    }
  }
  return args;
}

export function resolveSeedAdminInput(
  args: Record<string, string | boolean>,
  env: Record<string, string | undefined>
): { email: string; password: string; name: string; forcePassword: boolean } {
  const email = typeof args.email === "string" ? args.email : env.ADMIN_SEED_EMAIL;
  const password = typeof args.password === "string" ? args.password : env.ADMIN_SEED_PASSWORD;
  const name = (typeof args.name === "string" ? args.name : env.ADMIN_SEED_NAME) ?? DEFAULT_ADMIN_NAME;
  const forcePassword = args["force-password"] === true;

  if (!email || !EMAIL_PATTERN.test(email.trim())) {
    throw new Error(
      "A valid --email=<address> (or ADMIN_SEED_EMAIL env var) is required."
    );
  }
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `--password=<value> (or ADMIN_SEED_PASSWORD env var) is required and must be at least ${MIN_PASSWORD_LENGTH} characters.`
    );
  }
  if (!name.trim()) {
    throw new Error("--name must not be empty.");
  }

  return { email: email.trim(), password, name: name.trim(), forcePassword };
}

export type SeedAdminOutcome = "created" | "promoted" | "already-admin" | "password-reset";

export async function seedAdmin(input: {
  email: string;
  password: string;
  name: string;
  forcePassword: boolean;
}): Promise<SeedAdminOutcome> {
  const email = normalizeEmail(input.email);
  const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);

  if (!existing) {
    const passwordHash = await hashPassword(input.password);
    await db.insert(users).values({
      email,
      name: input.name,
      passwordHash,
      role: USER_ROLE.admin,
      emailVerifiedAt: new Date(),
    });
    return "created";
  }

  if (existing.role === USER_ROLE.admin) {
    if (!input.forcePassword) return "already-admin";
    const passwordHash = await hashPassword(input.password);
    await db
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(users.id, existing.id));
    return "password-reset";
  }

  const passwordHash = input.forcePassword ? await hashPassword(input.password) : undefined;
  await db
    .update(users)
    .set({
      role: USER_ROLE.admin,
      ...(passwordHash ? { passwordHash } : {}),
      updatedAt: new Date(),
    })
    .where(eq(users.id, existing.id));
  return "promoted";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = resolveSeedAdminInput(args, process.env as Record<string, string | undefined>);

  console.log(`Seeding admin account for ${input.email}...`);
  const outcome = await seedAdmin(input);

  switch (outcome) {
    case "created":
      console.log(`Created new admin account for ${input.email}.`);
      break;
    case "promoted":
      console.log(`Promoted existing user ${input.email} to admin.`);
      if (input.forcePassword) console.log("Password was also reset.");
      break;
    case "password-reset":
      console.log(`${input.email} was already an admin. Password reset as requested (--force-password).`);
      break;
    case "already-admin":
      console.log(`${input.email} is already an admin. No changes made.`);
      console.log("Pass --force-password to reset their password too.");
      break;
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(`Failed to seed admin account: ${getErrorMessage(error, "Unknown error")}`);
      process.exit(1);
    });
}
