import { Router } from "express";

import { adminRouter } from "./modules/admin/admin.routes";
import { aiRouter } from "./modules/ai/ai.routes";
import { adminAuthRouter } from "./modules/auth/admin-auth.routes";
import { authRouter } from "./modules/auth/auth.routes";
import { drawingsRouter } from "./modules/drawings/drawings.routes";
import { healthRouter } from "./modules/health/health.routes";
import { marketCollectionsRouter } from "./modules/market-collections/market-collections.routes";
import { marketDataRouter } from "./modules/market-data/market-data.routes";
import { monetizationRouter } from "./modules/monetization/monetization.routes";
import { priceAlertsRouter } from "./modules/price-alerts/price-alerts.routes";
import { pushSubscriptionsRouter } from "./modules/push-subscriptions/push-subscriptions.routes";
import { scannerRouter } from "./modules/scanner/scanner.routes";
import { watchlistsRouter } from "./modules/watchlists/watchlists.routes";
import { weeklyStrongBacktestRouter } from "./modules/weekly-strong-backtest/weekly-strong-backtest.routes";
import { widgetPreferencesRouter } from "./modules/widget-preferences/widget-preferences.routes";
import { API_ROUTES } from "./shared/constants";

export function createRouter() {
  const router = Router();

  router.use(API_ROUTES.health, healthRouter);
  router.use(API_ROUTES.auth, authRouter);
  router.use(API_ROUTES.adminAuth, adminAuthRouter);
  router.use(API_ROUTES.marketData, marketDataRouter);
  router.use(API_ROUTES.marketCollections, marketCollectionsRouter);
  router.use(API_ROUTES.scanner, scannerRouter);
  router.use(API_ROUTES.scanner, drawingsRouter);
  router.use(API_ROUTES.admin, adminRouter);
  router.use(API_ROUTES.ai, aiRouter);
  router.use(API_ROUTES.priceAlerts, priceAlertsRouter);
  router.use(API_ROUTES.pushSubscriptions, pushSubscriptionsRouter);
  router.use(API_ROUTES.watchlists, watchlistsRouter);
  router.use(API_ROUTES.widgetPreferences, widgetPreferencesRouter);
  router.use(API_ROUTES.monetization, monetizationRouter);
  router.use(API_ROUTES.weeklyStrongBacktest, weeklyStrongBacktestRouter);

  return router;
}
