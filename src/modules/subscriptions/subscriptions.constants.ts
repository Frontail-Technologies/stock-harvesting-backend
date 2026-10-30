export const SUBSCRIPTION_CATALOG = [
  { code: "pro-monthly", name: "Pro Monthly", intervalMonths: 1, amountPaise: 59_900 },
  { code: "pro-quarterly", name: "Pro Quarterly", intervalMonths: 3, amountPaise: 165_000 },
  { code: "pro-half-yearly", name: "Pro Half-yearly", intervalMonths: 6, amountPaise: 300_000 },
  { code: "pro-yearly", name: "Pro Yearly", intervalMonths: 12, amountPaise: 550_000 },
] as const;

export const SUBSCRIPTION_GRACE_MS = 3 * 24 * 60 * 60 * 1000;
export const SUBSCRIPTION_PROVIDER = "razorpay";
export const ACTIVE_SUBSCRIPTION_STATUSES = ["active", "authenticated", "cancelled"] as const;

export type SubscriptionPlanCode = (typeof SUBSCRIPTION_CATALOG)[number]["code"];
