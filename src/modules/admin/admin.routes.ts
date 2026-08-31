import { Router } from "express";

import {
  deleteAiApiKey,
  getAiKeyStatus,
  getAiSettings,
  updateAiApiKey,
  updateAiSettings,
} from "../ai/ai.service";
import {
  SUPPORTED_AI_MODELS,
  type AdPlacementKey,
  type MonetizationMode,
  type UserPlan,
  type UserRole,
} from "../../shared/constants";
import { sendAccepted, sendData } from "../../shared/http";
import {
  asyncHandler,
  getAuthUserId,
  requireAdmin,
  requireAdminAuth,
  validate,
} from "../../shared/middleware";
import {
  adminUsersExportQuerySchema,
  adminUsersQuerySchema,
  backfillCandlesBodySchema,
  brandingBodySchema,
  collectionIdParamsSchema,
  collectionVersionIdParamsSchema,
  confirmCollectionImportBodySchema,
  createCollectionBodySchema,
  dataProviderKeyParamsSchema,
  importCollectionCsvBodySchema,
  indexCandleBackfillBodySchema,
  replaceCollectionVersionBodySchema,
  providerConnectBodySchema,
  providerSyncBodySchema,
  updateAiSettingsBodySchema,
  updateAiKeyBodySchema,
  updateCollectionBodySchema,
  updateDataProviderSettingsBodySchema,
  updateUserPlanBodySchema,
  updateUserRoleBodySchema,
  userIdParamsSchema,
} from "./admin.schemas";
import {
  completeProviderConnection,
  createProviderConnectUrl,
  deleteUser,
  exportAdminUsersCsv,
  getAdminDataProviderSettings,
  getAdminProviderStatus,
  getAdminProviderStatuses,
  getBrandingSettings,
  getWeeklyStrongBacktestHistoricalStatus,
  getWeeklyStrongBacktestStatus,
  listAdminUsers,
  listJobs,
  triggerCandleBackfill,
  triggerIndexCandleBackfill,
  triggerInstrumentSync,
  triggerPriceRefresh,
  triggerSectorClassificationSync,
  triggerWeeklyStrongBacktestBackfill,
  triggerWeeklyStrongBacktestHistoricalRebuild,
  updateAdminDataProviderSettings,
  updateBrandingSettings,
  updateUserPlan,
  updateUserRole,
} from "./admin.service";
import {
  createCollection,
  getCollection,
  getCollectionMembersById,
  importCollectionCsv,
  listCollections,
  previewCollectionImport,
  updateCollection,
} from "../market-collections/market-collections.service";
import {
  getCollectionVersionMembers,
  listCollectionVersions,
  replaceCollectionVersionMembers,
} from "../market-collections/market-collection-versions.service";
import {
  collectionMembersQuerySchema,
} from "../market-collections/market-collections.schemas";
import { backfillBodySchema as weeklyStrongBacktestBackfillBodySchema } from "../weekly-strong-backtest/weekly-strong-backtest.schemas";
import {
  adPlacementKeyParamsSchema,
  updateAdPlacementBodySchema,
  updateMonetizationSettingsBodySchema,
} from "../monetization/monetization.schemas";
import {
  getAdminMonetizationConfig,
  updateAdPlacement,
  updateMonetizationSettings,
} from "../monetization/monetization.service";

export const adminRouter = Router();

adminRouter.use(requireAdminAuth, requireAdmin);

adminRouter.get(
  "/users",
  validate({ query: adminUsersQuerySchema }),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as Parameters<typeof listAdminUsers>[0];
    sendData(res, await listAdminUsers(query));
  })
);

adminRouter.get(
  "/users/export",
  validate({ query: adminUsersExportQuerySchema }),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as Parameters<typeof exportAdminUsersCsv>[0];
    const csv = await exportAdminUsersCsv(query);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="stock-harvesting-users-${Date.now()}.csv"`
    );
    res.send(csv);
  })
);

adminRouter.patch(
  "/users/:id/role",
  validate({ params: userIdParamsSchema, body: updateUserRoleBodySchema }),
  asyncHandler(async (req, res) => {
    const params = req.params as { id: string };
    const body = req.body as { role: UserRole };
    const user = await updateUserRole({
      actorUserId: getAuthUserId(req),
      userId: params.id,
      role: body.role,
    });
    sendData(res, { user });
  })
);

adminRouter.patch(
  "/users/:id/plan",
  validate({ params: userIdParamsSchema, body: updateUserPlanBodySchema }),
  asyncHandler(async (req, res) => {
    const params = req.params as { id: string };
    const body = req.body as { plan: UserPlan };
    const user = await updateUserPlan({
      actorUserId: getAuthUserId(req),
      userId: params.id,
      plan: body.plan,
    });
    sendData(res, { user });
  })
);

adminRouter.delete(
  "/users/:id",
  validate({ params: userIdParamsSchema }),
  asyncHandler(async (req, res) => {
    const params = req.params as { id: string };
    const result = await deleteUser({
      actorUserId: getAuthUserId(req),
      userId: params.id,
    });
    sendData(res, result);
  })
);

adminRouter.get("/data-provider/status", asyncHandler(async (_req, res) => {
  sendData(res, await getAdminProviderStatus());
}));

adminRouter.get("/data-provider/statuses", asyncHandler(async (_req, res) => {
  sendData(res, await getAdminProviderStatuses());
}));

adminRouter.get("/data-providers", asyncHandler(async (_req, res) => {
  sendData(res, { providers: await getAdminDataProviderSettings() });
}));

adminRouter.put(
  "/data-providers/:key",
  validate({ params: dataProviderKeyParamsSchema, body: updateDataProviderSettingsBodySchema }),
  asyncHandler(async (req, res) => {
    const params = req.params as { key: string };
    const provider = await updateAdminDataProviderSettings({
      actorUserId: getAuthUserId(req),
      key: params.key,
      ...(req.body as { enabled?: boolean; priority?: number; disabledReason?: string | null }),
    });
    sendData(res, { provider });
  })
);

adminRouter.post("/data-provider/connect-url", asyncHandler(async (req, res) => {
  sendData(res, await createProviderConnectUrl(getAuthUserId(req)));
}));

adminRouter.post(
  "/data-provider/connect",
  validate({ body: providerConnectBodySchema }),
  asyncHandler(async (req, res) => {
    const body = req.body as { requestToken: string };
    const result = await completeProviderConnection({
      actorUserId: getAuthUserId(req),
      requestToken: body.requestToken,
    });
    sendData(res, result);
  })
);

adminRouter.post(
  "/data-provider/sync",
  validate({ body: providerSyncBodySchema }),
  asyncHandler(async (req, res) => {
    const body = req.body as { exchange: string };
    const job = await triggerInstrumentSync({
      actorUserId: getAuthUserId(req),
      exchange: body.exchange,
    });
    sendAccepted(res, { job });
  })
);

adminRouter.post(
  "/data-provider/sector-classification-sync",
  asyncHandler(async (req, res) => {
    const job = await triggerSectorClassificationSync({
      actorUserId: getAuthUserId(req),
    });
    sendAccepted(res, { job });
  })
);

adminRouter.post(
  "/data-provider/index-candle-backfill",
  validate({ body: indexCandleBackfillBodySchema }),
  asyncHandler(async (req, res) => {
    const body = req.body as { exchange: string };
    const job = await triggerIndexCandleBackfill({
      actorUserId: getAuthUserId(req),
      exchange: body.exchange,
    });
    sendAccepted(res, { job });
  })
);

adminRouter.post(
  "/market-data/sync-prices",
  validate({ body: providerSyncBodySchema }),
  asyncHandler(async (req, res) => {
    const body = req.body as { exchange: string };
    const job = await triggerPriceRefresh({
      actorUserId: getAuthUserId(req),
      exchange: body.exchange,
    });
    sendAccepted(res, { job });
  })
);

adminRouter.post(
  "/market-data/backfill-candles",
  validate({ body: backfillCandlesBodySchema }),
  asyncHandler(async (req, res) => {
    const body = req.body as { symbol: string; from: string; to: string };
    const result = await triggerCandleBackfill({
      actorUserId: getAuthUserId(req),
      ...body,
    });
    sendAccepted(res, result);
  })
);

adminRouter.get("/jobs", asyncHandler(async (_req, res) => {
  sendData(res, { jobs: await listJobs() });
}));

adminRouter.get("/branding", asyncHandler(async (_req, res) => {
  sendData(res, { branding: await getBrandingSettings() });
}));

adminRouter.put(
  "/branding",
  validate({ body: brandingBodySchema }),
  asyncHandler(async (req, res) => {
    const branding = await updateBrandingSettings({
      actorUserId: getAuthUserId(req),
      ...(req.body as {
        brandName: string;
        watermarkText: string;
        logoUrl?: string | null;
        enabled: boolean;
      }),
    });
    sendData(res, { branding });
  })
);

adminRouter.get("/ai-settings", asyncHandler(async (_req, res) => {
  sendData(res, { aiSettings: await getAiSettings(), availableModels: SUPPORTED_AI_MODELS });
}));

adminRouter.put(
  "/ai-settings",
  validate({ body: updateAiSettingsBodySchema }),
  asyncHandler(async (req, res) => {
    const aiSettings = await updateAiSettings({
      actorUserId: getAuthUserId(req),
      ...(req.body as { model: (typeof SUPPORTED_AI_MODELS)[number]["code"] }),
    });
    sendData(res, { aiSettings });
  })
);

adminRouter.get("/ai-settings/key", asyncHandler(async (_req, res) => {
  sendData(res, { key: await getAiKeyStatus() });
}));

adminRouter.put(
  "/ai-settings/key",
  validate({ body: updateAiKeyBodySchema }),
  asyncHandler(async (req, res) => {
    const body = req.body as { apiKey: string };
    sendData(res, {
      key: await updateAiApiKey({
        actorUserId: getAuthUserId(req),
        apiKey: body.apiKey,
      }),
    });
  })
);

adminRouter.delete("/ai-settings/key", asyncHandler(async (req, res) => {
  sendData(res, { key: await deleteAiApiKey({ actorUserId: getAuthUserId(req) }) });
}));

adminRouter.get("/monetization", asyncHandler(async (_req, res) => {
  sendData(res, await getAdminMonetizationConfig());
}));

adminRouter.put(
  "/monetization/settings",
  validate({ body: updateMonetizationSettingsBodySchema }),
  asyncHandler(async (req, res) => {
    const settings = await updateMonetizationSettings({
      actorUserId: getAuthUserId(req),
      ...(req.body as { mode: MonetizationMode; publisherId: string | null }),
    });
    sendData(res, { settings });
  })
);

adminRouter.put(
  "/monetization/placements/:key",
  validate({ params: adPlacementKeyParamsSchema, body: updateAdPlacementBodySchema }),
  asyncHandler(async (req, res) => {
    const params = req.params as { key: AdPlacementKey };
    const placement = await updateAdPlacement({
      actorUserId: getAuthUserId(req),
      key: params.key,
      ...(req.body as { enabled: boolean; slotId: string | null }),
    });
    sendData(res, { placement });
  })
);

adminRouter.get("/market-collections", asyncHandler(async (_req, res) => {
  sendData(res, { collections: await listCollections({}) });
}));

adminRouter.post(
  "/market-collections",
  validate({ body: createCollectionBodySchema }),
  asyncHandler(async (req, res) => {
    const body = req.body as {
      code: string;
      name: string;
      exchange: string;
      countryCode?: string;
      description?: string;
    };
    const collection = await createCollection({
      actorUserId: getAuthUserId(req),
      ...body,
    });
    sendData(res, { collection });
  })
);

adminRouter.get(
  "/market-collections/:id",
  validate({ params: collectionIdParamsSchema }),
  asyncHandler(async (req, res) => {
    const params = req.params as { id: string };
    sendData(res, { collection: await getCollection(params.id) });
  })
);

adminRouter.get(
  "/market-collections/:id/members",
  validate({ params: collectionIdParamsSchema, query: collectionMembersQuerySchema }),
  asyncHandler(async (req, res) => {
    const params = req.params as { id: string };
    const query = req.query as unknown as {
      page: number;
      limit: number;
      q?: string;
      sortBy: "symbol" | "name";
      sortDirection: "asc" | "desc";
    };
    sendData(res, await getCollectionMembersById({ id: params.id, ...query }));
  })
);

adminRouter.patch(
  "/market-collections/:id",
  validate({ params: collectionIdParamsSchema, body: updateCollectionBodySchema }),
  asyncHandler(async (req, res) => {
    const params = req.params as { id: string };
    const body = req.body as { name?: string; description?: string | null; active?: boolean };
    const collection = await updateCollection({
      id: params.id,
      actorUserId: getAuthUserId(req),
      ...body,
    });
    sendData(res, { collection });
  })
);

adminRouter.post(
  "/market-collections/:id/import/dry-run",
  validate({ params: collectionIdParamsSchema, body: importCollectionCsvBodySchema }),
  asyncHandler(async (req, res) => {
    const params = req.params as { id: string };
    const body = req.body as { csvContent: string };
    const report = await previewCollectionImport({ id: params.id, csvContent: body.csvContent });
    sendData(res, { report });
  })
);

adminRouter.post(
  "/market-collections/:id/import",
  validate({ params: collectionIdParamsSchema, body: confirmCollectionImportBodySchema }),
  asyncHandler(async (req, res) => {
    const params = req.params as { id: string };
    const body = req.body as {
      csvContent: string;
      sourceName?: string;
      sourceDate?: string;
      effectiveFrom: string;
    };
    const report = await importCollectionCsv({
      id: params.id,
      actorUserId: getAuthUserId(req),
      ...body,
    });
    sendData(res, { report });
  })
);

adminRouter.get(
  "/market-collections/:id/versions",
  validate({ params: collectionIdParamsSchema }),
  asyncHandler(async (req, res) => {
    const params = req.params as { id: string };
    sendData(res, { versions: await listCollectionVersions(params.id) });
  })
);

adminRouter.get(
  "/market-collections/:id/versions/:versionId",
  validate({ params: collectionVersionIdParamsSchema }),
  asyncHandler(async (req, res) => {
    const params = req.params as { id: string; versionId: string };
    sendData(res, await getCollectionVersionMembers(params.id, params.versionId));
  })
);

adminRouter.post(
  "/market-collections/:id/versions/:versionId/replace",
  validate({ params: collectionVersionIdParamsSchema, body: replaceCollectionVersionBodySchema }),
  asyncHandler(async (req, res) => {
    const params = req.params as { id: string; versionId: string };
    const body = req.body as { csvContent: string };
    const result = await replaceCollectionVersionMembers({
      collectionId: params.id,
      versionId: params.versionId,
      csvContent: body.csvContent,
      actorUserId: getAuthUserId(req),
    });
    sendData(res, result);
  })
);

adminRouter.get(
  "/market-collections/:id/weekly-strong-backtest/status",
  validate({ params: collectionIdParamsSchema }),
  asyncHandler(async (req, res) => {
    const params = req.params as { id: string };
    sendData(res, { status: await getWeeklyStrongBacktestStatus({ collectionId: params.id }) });
  })
);

adminRouter.get(
  "/market-collections/:id/weekly-strong-backtest/historical-status",
  validate({ params: collectionIdParamsSchema }),
  asyncHandler(async (req, res) => {
    const params = req.params as { id: string };
    sendData(res, { status: await getWeeklyStrongBacktestHistoricalStatus({ collectionId: params.id }) });
  })
);

adminRouter.post(
  "/market-collections/:id/weekly-strong-backtest/generate",
  validate({ params: collectionIdParamsSchema, body: weeklyStrongBacktestBackfillBodySchema }),
  asyncHandler(async (req, res) => {
    const params = req.params as { id: string };
    const body = req.body as { weeks?: number };
    const result = await triggerWeeklyStrongBacktestBackfill({
      actorUserId: getAuthUserId(req),
      collectionId: params.id,
      weeks: body.weeks,
    });
    sendAccepted(res, result);
  })
);

adminRouter.post(
  "/market-collections/:id/weekly-strong-backtest/rebuild-historical",
  validate({ params: collectionIdParamsSchema }),
  asyncHandler(async (req, res) => {
    const params = req.params as { id: string };
    const result = await triggerWeeklyStrongBacktestHistoricalRebuild({
      actorUserId: getAuthUserId(req),
      collectionId: params.id,
    });
    sendAccepted(res, result);
  })
);
