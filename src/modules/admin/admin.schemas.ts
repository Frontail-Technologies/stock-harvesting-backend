import { z } from "zod";

import { SUPPORTED_AI_MODEL_CODES, SUPPORTED_COUNTRY_CODES, USER_PLANS, USER_ROLES } from "../../shared/constants";
import { GLOBAL_DATAFEEDS_INDEX_EXCHANGE } from "../data-provider/adapters/global-datafeeds/global-datafeeds.constants";
import { NSE_INDEX_EXCHANGE } from "../data-provider/adapters/zerodha-data-provider.adapter";
import { exchangeSchema } from "../market-data/market-data.schemas";

export const adminUserSortFields = [
  "name",
  "email",
  "role",
  "plan",
  "createdAt",
] as const;

export const adminUsersQuerySchema = z
  .object({
    q: z.string().trim().max(160).optional(),
    role: z.enum(USER_ROLES).optional(),
    plan: z.enum(USER_PLANS).optional(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
    sort: z.enum(adminUserSortFields).default("createdAt"),
    direction: z.enum(["asc", "desc"]).default("desc"),
  })
  .strict();

// Same filters as adminUsersQuerySchema minus page/limit — export always
// returns every user matching the current filters, not one page of them.
export const adminUsersExportQuerySchema = z
  .object({
    q: z.string().trim().max(160).optional(),
    role: z.enum(USER_ROLES).optional(),
    plan: z.enum(USER_PLANS).optional(),
    sort: z.enum(adminUserSortFields).default("createdAt"),
    direction: z.enum(["asc", "desc"]).default("desc"),
  })
  .strict();

export const providerConnectBodySchema = z
  .object({
    requestToken: z.string().min(1),
  })
  .strict();

export const providerSyncBodySchema = z
  .object({
    exchange: exchangeSchema,
  })
  .strict();

// Same closed whitelist as indexRelativeStrengthQuerySchema — only ever a
// handful of real index exchanges, worth rejecting anything else up front.
export const indexCandleBackfillBodySchema = z
  .object({
    exchange: z.enum([NSE_INDEX_EXCHANGE, GLOBAL_DATAFEEDS_INDEX_EXCHANGE]).default(NSE_INDEX_EXCHANGE),
  })
  .strict();

export const userIdParamsSchema = z
  .object({
    id: z.string().uuid(),
  })
  .strict();

export const updateUserRoleBodySchema = z
  .object({
    role: z.enum(USER_ROLES),
  })
  .strict();

export const updateUserPlanBodySchema = z
  .object({
    plan: z.enum(USER_PLANS),
  })
  .strict();

export const backfillCandlesBodySchema = z
  .object({
    symbol: z.string().trim().min(1).max(64),
    from: z.string().date(),
    to: z.string().date(),
  })
  .strict();

export const brandingBodySchema = z
  .object({
    brandName: z.string().trim().min(1).max(120),
    watermarkText: z.string().trim().min(1).max(160),
    logoUrl: z.string().url().nullable().optional(),
    enabled: z.boolean(),
  })
  .strict();

export const updateAiSettingsBodySchema = z
  .object({
    model: z.enum(SUPPORTED_AI_MODEL_CODES as [string, ...string[]]),
  })
  .strict();

export const updateAiKeyBodySchema = z
  .object({
    apiKey: z.string().trim().min(12).max(512),
  })
  .strict();

export const collectionIdParamsSchema = z
  .object({
    id: z.string().uuid(),
  })
  .strict();

export const createCollectionBodySchema = z
  .object({
    code: z.string().trim().min(1).max(64),
    name: z.string().trim().min(1).max(160),
    exchange: exchangeSchema,
    countryCode: z.enum(SUPPORTED_COUNTRY_CODES as [string, ...string[]]).optional(),
    description: z.string().trim().max(500).optional(),
  })
  .strict();

export const updateCollectionBodySchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    active: z.boolean().optional(),
  })
  .strict();

// Dry-run preview only diffs symbols against current membership - it never
// creates a version, so effectiveFrom isn't needed here (a dry-run must
// never create a version).
export const importCollectionCsvBodySchema = z
  .object({
    csvContent: z.string().min(1).max(2_000_000),
    sourceName: z.string().trim().max(160).optional(),
    sourceDate: z.string().date().optional(),
  })
  .strict();

// Confirming an import additionally requires the date this constituent
// snapshot becomes authoritative for historical membership resolution -
// required here, unlike the dry-run schema above.
export const confirmCollectionImportBodySchema = importCollectionCsvBodySchema.extend({
  effectiveFrom: z.string().date(),
});

export const collectionVersionIdParamsSchema = z
  .object({
    id: z.string().uuid(),
    versionId: z.string().uuid(),
  })
  .strict();

export const replaceCollectionVersionBodySchema = z
  .object({
    csvContent: z.string().min(1).max(2_000_000),
  })
  .strict();

export const dataProviderKeyParamsSchema = z
  .object({
    key: z.string().trim().min(1).max(32),
  })
  .strict();

// Empty string clears a previously-set disable reason, matching the
// monetization module's own empty-string-means-clear convention.
export const updateDataProviderSettingsBodySchema = z
  .object({
    enabled: z.boolean().optional(),
    priority: z.coerce.number().int().min(1).max(1000).optional(),
    disabledReason: z
      .string()
      .trim()
      .max(200)
      .transform((value) => (value.length === 0 ? null : value))
      .nullable()
      .optional(),
  })
  .strict();
