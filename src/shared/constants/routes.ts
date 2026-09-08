export const API_ROUTES = {
  health: "/api/health",
  // Deliberately NOT under /api - Prometheus scrape convention is a bare /metrics path, and this is not a REST resource. See docs/OBSERVABILITY.md.
  metrics: "/metrics",
  auth: "/api/auth",
  // Strict portal separation - the ADMIN portal's own refresh/me/logout, deliberately separate endpoints (not a `portal=admin` query param) so a request can never accidentally reuse the USER portal's code path. See admin-auth.routes.ts.
  adminAuth: "/api/admin-auth",
  marketData: "/api/market-data",
  marketCollections: "/api/market-collections",
  scanner: "/api/scanner",
  admin: "/api/admin",
  ai: "/api/ai",
  priceAlerts: "/api/price-alerts",
  pushSubscriptions: "/api/push-subscriptions",
  watchlists: "/api/watchlists",
  monetization: "/api/monetization",
  weeklyStrongBacktest: "/api/weekly-strong-backtest",
} as const;

export const AUTH_ROUTES = {
  googleUrl: "/google/url",
  googleCallback: "/google/callback",
  login: "/login",
  register: "/register",
  registerResend: "/register/resend",
  registerVerify: "/register/verify",
  refresh: "/refresh",
  me: "/me",
  logout: "/logout",
} as const;

export const GOOGLE_CALLBACK_PATH = `${API_ROUTES.auth}${AUTH_ROUTES.googleCallback}`;
