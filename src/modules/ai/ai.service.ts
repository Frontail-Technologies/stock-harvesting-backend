import { eq } from "drizzle-orm";

import { db } from "../../db/client";
import { aiSettings, auditLogs } from "../../db/schema";
import {
  AI_SETTINGS_DEFAULTS,
  HTTP_STATUS,
  SUPPORTED_AI_MODELS,
  type CandleTimeframe,
  type SupportedAiModelCode,
} from "../../shared/constants";
import { env } from "../../shared/env";
import { AppError, ERROR_CODES, ERROR_MESSAGES } from "../../shared/errors";
import { logger } from "../../shared/logger";
import { getChartCandles, listStocks } from "../market-data/market-data.service";
import { decryptField, encryptField } from "../security/encryption";

const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com";
const GEMINI_API_VERSIONS = ["v1beta", "v1"] as const;
const GEMINI_TIMEOUT_MS = 15_000;
const CANDLE_CONTEXT_LIMIT = 60;
const GEMINI_FALLBACK_MODELS = [
  "gemini-flash-latest",
  "gemini-flash-lite-latest",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-1.5-flash-latest",
  "gemini-1.5-flash",
] as const;

type ChatTurn = { role: "user" | "assistant"; text: string };

type GeminiGenerateContentResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
};

type GeminiListModelsResponse = {
  models?: Array<{
    name?: string;
    supportedGenerationMethods?: string[];
  }>;
};

export async function getAiSettings() {
  const [settings] = await db
    .select()
    .from(aiSettings)
    .where(eq(aiSettings.id, AI_SETTINGS_DEFAULTS.id));
  if (settings) return settings;

  const [created] = await db
    .insert(aiSettings)
    .values({ id: AI_SETTINGS_DEFAULTS.id })
    .onConflictDoNothing()
    .returning();

  return created;
}

export async function updateAiSettings(input: {
  actorUserId: string;
  model: SupportedAiModelCode;
}) {
  const [settings] = await db
    .insert(aiSettings)
    .values({ id: AI_SETTINGS_DEFAULTS.id, model: input.model, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: aiSettings.id,
      set: { model: input.model, updatedAt: new Date() },
    })
    .returning();

  await audit(input.actorUserId, "ai_settings.updated", "ai_settings", String(AI_SETTINGS_DEFAULTS.id), {
    model: input.model,
  });

  return settings;
}

export async function getAiKeyStatus() {
  const settings = await getAiSettings();
  const hasStoredKey = Boolean(settings?.encryptedApiKey);
  const hasEnvFallback = Boolean(env.GEMINI_API_KEY);

  return {
    hasKey: hasStoredKey || hasEnvFallback,
    source: hasStoredKey ? "stored" : hasEnvFallback ? "env" : "missing",
    updatedAt: settings?.apiKeyUpdatedAt?.toISOString() ?? null,
  };
}

export async function updateAiApiKey(input: {
  actorUserId: string;
  apiKey: string;
}) {
  const encryptedApiKey = encryptField(input.apiKey);
  const updatedAt = new Date();
  await getAiSettings();
  const [settings] = await runAiSettingsMutation(() =>
    db
      .update(aiSettings)
      .set({
        encryptedApiKey,
        apiKeyUpdatedAt: updatedAt,
        updatedAt,
      })
      .where(eq(aiSettings.id, AI_SETTINGS_DEFAULTS.id))
      .returning()
  );

  await audit(input.actorUserId, "ai_api_key.updated", "ai_settings", String(AI_SETTINGS_DEFAULTS.id));

  return {
    hasKey: Boolean(settings.encryptedApiKey),
    source: "stored" as const,
    updatedAt: settings.apiKeyUpdatedAt?.toISOString() ?? null,
  };
}

export async function deleteAiApiKey(input: { actorUserId: string }) {
  const updatedAt = new Date();
  await getAiSettings();
  await runAiSettingsMutation(() =>
    db
      .update(aiSettings)
      .set({
        encryptedApiKey: null,
        apiKeyUpdatedAt: null,
        updatedAt,
      })
      .where(eq(aiSettings.id, AI_SETTINGS_DEFAULTS.id))
  );

  await audit(input.actorUserId, "ai_api_key.deleted", "ai_settings", String(AI_SETTINGS_DEFAULTS.id));
  return getAiKeyStatus();
}

async function runAiSettingsMutation<T>(mutation: () => Promise<T>) {
  try {
    return await mutation();
  } catch (error) {
    if (isMissingAiSettingsColumnError(error)) {
      throw new AppError(
        HTTP_STATUS.internalServerError,
        ERROR_CODES.internalError,
        ERROR_MESSAGES.aiSettingsMigrationRequired
      );
    }

    throw error;
  }
}

function isMissingAiSettingsColumnError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const dbError = error as { code?: string; message?: string };
  return (
    dbError.code === "42703" ||
    Boolean(
      dbError.message?.includes("encrypted_api_key") ||
        dbError.message?.includes("api_key_updated_at")
    )
  );
}

export async function askScannerQuestion(input: {
  symbol: string;
  question: string;
  timeframe: CandleTimeframe;
  exchange: string;
  history: ChatTurn[];
}) {
  const settings = await getAiSettings();
  const model = env.GEMINI_CHAT_MODEL ?? settings?.model ?? AI_SETTINGS_DEFAULTS.model;

  const [stockList, candles] = await Promise.all([
    listStocks({ q: input.symbol, page: 1, limit: 1, exchange: input.exchange }),
    getChartCandles({ symbol: input.symbol, timeframe: input.timeframe, exchange: input.exchange }),
  ]);

  const systemInstruction = buildSystemInstruction({
    symbol: input.symbol,
    exchange: input.exchange,
    timeframe: input.timeframe,
    stock: stockList.stocks[0],
    recentCandles: candles.slice(-CANDLE_CONTEXT_LIMIT),
  });

  const answer = await callGemini({
    model,
    systemInstruction,
    history: input.history,
    question: input.question,
  });

  logger.info({ symbol: input.symbol, model }, "AI scanner question answered");

  return { answer };
}

async function getAiProviderApiKey() {
  const settings = await getAiSettings();
  if (settings?.encryptedApiKey) return decryptField(settings.encryptedApiKey);
  return env.GEMINI_API_KEY ?? "";
}

async function requireAiProviderConfig() {
  const apiKey = await getAiProviderApiKey();
  if (!apiKey) {
    throw new AppError(
      HTTP_STATUS.internalServerError,
      ERROR_CODES.internalError,
      ERROR_MESSAGES.aiProviderNotConfigured
    );
  }

  return apiKey;
}

function buildSystemInstruction(input: {
  symbol: string;
  exchange: string;
  timeframe: CandleTimeframe;
  stock?: { close?: number; changePct?: number; volume?: number; open?: number };
  recentCandles: Array<{
    time: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>;
}) {
  const stats = input.stock
    ? `Latest close: ${input.stock.close ?? "n/a"}, change: ${input.stock.changePct ?? "n/a"}%, volume: ${input.stock.volume ?? "n/a"}, open: ${input.stock.open ?? "n/a"}.`
    : "No current price snapshot is available.";

  const candleLines = input.recentCandles
    .map((candle) => `${candle.time},${candle.open},${candle.high},${candle.low},${candle.close},${candle.volume}`)
    .join("\n");

  return [
    "You are a technical-analysis chart assistant for a stock scanner app.",
    "Answer questions about chart setups, entries, risk, and volume using the data below.",
    "Return valid compact Markdown. Use bullets, short tables, or numbered lists when they improve readability.",
    "Be concise. Frame everything as technical observations, never as investment advice or a buy/sell recommendation.",
    `Symbol: ${input.symbol} (${input.exchange}), timeframe: ${input.timeframe}.`,
    stats,
    input.recentCandles.length > 0
      ? `Recent candles (date,open,high,low,close,volume):\n${candleLines}`
      : "No recent candle history is available.",
  ].join("\n\n");
}

async function callGemini(input: {
  model: string;
  systemInstruction: string;
  history: ChatTurn[];
  question: string;
}) {
  const apiKey = await requireAiProviderConfig();
  const contents = [
    ...input.history.map((turn) => ({
      role: turn.role === "assistant" ? "model" : "user",
      parts: [{ text: turn.text }],
    })),
    { role: "user", parts: [{ text: input.question }] },
  ];
  const body = {
    systemInstruction: { parts: [{ text: input.systemInstruction }] },
    contents,
  };

  let model = input.model;
  let response = await requestGeminiGenerateContent({ apiKey, model, body });

  if (response.status === HTTP_STATUS.notFound) {
    const fallbackModel = await findAvailableGeminiModel(apiKey, model);
    if (fallbackModel && fallbackModel !== model) {
      logger.warn({ requestedModel: model, fallbackModel }, "Retrying Gemini request with available model");
      model = fallbackModel;
      response = await requestGeminiGenerateContent({ apiKey, model, body });
    }
  }

  if (response.status === HTTP_STATUS.notFound) {
    const fallback = await tryGeminiFallbackModels({
      apiKey,
      rejectedModel: model,
      body,
    });

    if (fallback) {
      model = fallback.model;
      response = fallback.response;
    }
  }

  if (!response.ok) {
    throw new AppError(
      HTTP_STATUS.badGateway,
      ERROR_CODES.badRequest,
      `${ERROR_MESSAGES.aiRequestFailed} for ${model} (${response.status})`
    );
  }

  const json = (await response.json()) as GeminiGenerateContentResponse;
  const answer = json.candidates?.[0]?.content?.parts
    ?.map((part) => part.text ?? "")
    .join("")
    .trim();

  if (!answer) {
    throw new AppError(HTTP_STATUS.badGateway, ERROR_CODES.badRequest, ERROR_MESSAGES.aiRequestFailed);
  }

  return answer;
}

async function requestGeminiGenerateContent(input: {
  apiKey: string;
  model: string;
  body: unknown;
  version?: (typeof GEMINI_API_VERSIONS)[number];
}) {
  const version = input.version ?? GEMINI_API_VERSIONS[0];

  try {
    return await fetch(`${GEMINI_API_BASE_URL}/${version}/${formatGeminiModelName(input.model)}:generateContent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": input.apiKey,
      },
      body: JSON.stringify(input.body),
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    });
  } catch (error) {
    logger.warn(
      { model: input.model, message: error instanceof Error ? error.message : "Unknown error" },
      "Gemini request failed"
    );
    throw new AppError(HTTP_STATUS.badGateway, ERROR_CODES.badRequest, ERROR_MESSAGES.aiRequestFailed);
  }
}

async function findAvailableGeminiModel(apiKey: string, requestedModel: string) {
  for (const version of GEMINI_API_VERSIONS) {
    try {
      const response = await fetch(`${GEMINI_API_BASE_URL}/${version}/models`, {
        headers: { "x-goog-api-key": apiKey },
        signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
      });

      if (!response.ok) continue;

      const json = (await response.json()) as GeminiListModelsResponse;
      const generateContentModels =
        json.models?.filter((model) =>
          model.supportedGenerationMethods?.includes("generateContent")
        ) ?? [];
      const availableModelIds = new Set(
        generateContentModels
          .map((model) => model.name?.replace(/^models\//, ""))
          .filter((model): model is string => Boolean(model))
      );
      const requestedModelId = requestedModel.replace(/^models\//, "");

      if (availableModelIds.has(requestedModelId)) return requestedModelId;

      return (
        SUPPORTED_AI_MODELS.find((model) => availableModelIds.has(model.code))?.code ??
        generateContentModels[0]?.name?.replace(/^models\//, "") ??
        null
      );
    } catch (error) {
      logger.warn(
        { version, message: error instanceof Error ? error.message : "Unknown error" },
        "Unable to list Gemini models"
      );
    }
  }

  return null;
}

async function tryGeminiFallbackModels(input: {
  apiKey: string;
  rejectedModel: string;
  body: unknown;
}) {
  const triedModels = new Set([input.rejectedModel.replace(/^models\//, "")]);

  for (const model of GEMINI_FALLBACK_MODELS) {
    if (triedModels.has(model)) continue;
    triedModels.add(model);

    for (const version of GEMINI_API_VERSIONS) {
      const response = await requestGeminiGenerateContent({
        apiKey: input.apiKey,
        model,
        body: input.body,
        version,
      });

      if (response.ok) {
        logger.warn(
          { rejectedModel: input.rejectedModel, fallbackModel: model, version },
          "Gemini fallback model succeeded"
        );
        return { model, response };
      }

      if (response.status !== HTTP_STATUS.notFound) {
        return { model, response };
      }
    }
  }

  return null;
}

function formatGeminiModelName(model: string) {
  const modelId = model.replace(/^models\//, "");
  return `models/${encodeURIComponent(modelId)}`;
}

async function audit(
  actorUserId: string | null,
  action: string,
  targetType?: string,
  targetId?: string,
  metadata: Record<string, unknown> = {}
) {
  await db.insert(auditLogs).values({
    actorUserId,
    action,
    targetType,
    targetId,
    metadata,
  });
}
