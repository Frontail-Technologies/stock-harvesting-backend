export const API_ROUTES = {
  health: "/api/health",
  auth: "/api/auth",
  // Strict portal separation - the ADMIN portal's own refresh/me/logout,
  // deliberately separate endpoints (not a `portal=admin` query param on
  // the routes above) so a request can never accidentally reuse the USER
  // portal's cookie-reading/token-rotation code path. See
  // admin-auth.routes.ts.
  adminAuth: "/api/admin-auth",
  users: "/api/users",
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
  refresh: "/refresh",
  me: "/me",
  logout: "/logout",
} as const;

export const GOOGLE_CALLBACK_PATH = `${API_ROUTES.auth}${AUTH_ROUTES.googleCallback}`;
