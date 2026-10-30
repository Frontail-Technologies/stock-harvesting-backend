import { env } from "../../shared/env";
import { providerError } from "../../shared/errors";

const API_BASE = "https://api.razorpay.com/v1";

function credentials() {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    throw providerError("Razorpay is not configured");
  }
  return Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString("base64");
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Basic ${credentials()}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const description = (body.error as { description?: string } | undefined)?.description;
    throw providerError(description || "Razorpay request failed", { status: response.status });
  }
  return body as T;
}

export type RazorpaySubscription = {
  id: string;
  plan_id: string;
  status: string;
  current_start?: number;
  current_end?: number;
  charge_at?: number;
  ended_at?: number;
  notes?: Record<string, string>;
};

export function createRazorpayPlan(input: { name: string; amountPaise: number; intervalMonths: number; code: string }) {
  return request<{ id: string }>("/plans", {
    method: "POST",
    body: JSON.stringify({
      period: "monthly",
      interval: input.intervalMonths,
      item: {
        name: input.name,
        amount: input.amountPaise,
        currency: "INR",
        description: `Stock Harvesting ${input.name} (GST inclusive)`,
      },
      notes: { catalog_code: input.code, mode: env.RAZORPAY_MODE },
    }),
  });
}

export function createRazorpaySubscription(input: { planId: string; userId: string; email: string; planCode: string }) {
  return request<RazorpaySubscription>("/subscriptions", {
    method: "POST",
    body: JSON.stringify({
      plan_id: input.planId,
      total_count: 100,
      quantity: 1,
      customer_notify: 1,
      notes: { user_id: input.userId, email: input.email, plan_code: input.planCode },
    }),
  });
}

export function fetchRazorpaySubscription(id: string) {
  return request<RazorpaySubscription>(`/subscriptions/${encodeURIComponent(id)}`);
}

export function cancelRazorpaySubscription(id: string) {
  return request<RazorpaySubscription>(`/subscriptions/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    body: JSON.stringify({ cancel_at_cycle_end: 1 }),
  });
}

export function scheduleRazorpayPlanChange(id: string, planId: string) {
  return request<RazorpaySubscription>(`/subscriptions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ plan_id: planId, schedule_change_at: "cycle_end", quantity: 1 }),
  });
}

export function getRazorpayPublicKey() {
  if (!env.RAZORPAY_KEY_ID) throw providerError("Razorpay is not configured");
  return env.RAZORPAY_KEY_ID;
}
