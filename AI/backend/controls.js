import { config } from "../../server/config.js";
import { AiPreference } from "../../server/models/AiPreference.js";
import { AiUsage } from "../../server/models/AiUsage.js";

export const AI_MODEL_PRESET_KEYS = ["fast", "balanced", "best"];

const DEFAULTS = {
  budgetGuardEnabled: false,
  monthlyRequestLimit: 400,
  monthlySearchLimit: 120,
  monthlyCostUsdLimit: 5,
};

const PRICE_PER_MILLION_TOKENS = {
  "llama-3.1-8b-instant": { input: 0.05, output: 0.08 },
  "llama-3.3-70b-versatile": { input: 0.59, output: 0.79 },
  "openai/gpt-oss-20b": { input: 0.2, output: 0.3 },
  "openai/gpt-oss-120b": { input: 0.9, output: 1.8 },
};

const FALLBACK_PRICE_BY_PRESET = {
  fast: { input: 0.08, output: 0.12 },
  balanced: { input: 0.8, output: 1.2 },
  best: { input: 1.5, output: 3 },
};

const toPositiveInt = (value, fallback) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(parsed));
};

const toPositiveMoney = (value, fallback) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.round(parsed * 100) / 100;
};

const periodKeyForDate = (date = new Date()) => {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
};

const nextPeriodStartIso = (periodKey) => {
  const match = String(periodKey || "").match(/^(\d{4})-(\d{2})$/);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (!Number.isFinite(year) || !Number.isFinite(monthIndex)) {
    return null;
  }
  const next = new Date(Date.UTC(year, monthIndex + 1, 1, 0, 0, 0, 0));
  return Number.isFinite(next.getTime()) ? next.toISOString() : null;
};

const estimateTokensFromChars = (value) => {
  const chars = Number(value);
  if (!Number.isFinite(chars) || chars <= 0) {
    return 0;
  }
  return Math.max(1, Math.ceil(chars / 4));
};

const getPricingForModel = (model, preset = "balanced") => {
  const normalizedModel = String(model || "").trim();
  return (
    PRICE_PER_MILLION_TOKENS[normalizedModel] ||
    FALLBACK_PRICE_BY_PRESET[String(preset || "balanced").toLowerCase()] ||
    FALLBACK_PRICE_BY_PRESET.balanced
  );
};

const roundMoney = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.round(parsed * 100000) / 100000;
};

const normalizePreferenceDoc = (doc) => ({
  userUuid: String(doc?.userUuid || "").trim(),
  modelPreset: AI_MODEL_PRESET_KEYS.includes(String(doc?.modelPreset || "").trim())
    ? String(doc.modelPreset).trim()
    : config.aiDefaultModelPreset || "balanced",
  budgetGuardEnabled: Boolean(doc?.budgetGuardEnabled),
  monthlyRequestLimit: toPositiveInt(doc?.monthlyRequestLimit, DEFAULTS.monthlyRequestLimit),
  monthlySearchLimit: toPositiveInt(doc?.monthlySearchLimit, DEFAULTS.monthlySearchLimit),
  monthlyCostUsdLimit: toPositiveMoney(doc?.monthlyCostUsdLimit, DEFAULTS.monthlyCostUsdLimit),
  updatedAt: doc?.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
});

export const getAiPresetCatalog = () => {
  const presetModels = config.aiModelPresets && typeof config.aiModelPresets === "object"
    ? config.aiModelPresets
    : {};

  return {
    default_preset: AI_MODEL_PRESET_KEYS.includes(String(config.aiDefaultModelPreset || ""))
      ? String(config.aiDefaultModelPreset)
      : "balanced",
    presets: {
      fast: String(presetModels.fast || config.aiModel || "").trim() || null,
      balanced: String(presetModels.balanced || config.aiModel || "").trim() || null,
      best: String(presetModels.best || presetModels.balanced || config.aiModel || "").trim() || null,
    },
  };
};

export const getResolvedModelForPreset = (preset) => {
  const normalizedPreset = String(preset || "").trim().toLowerCase();
  const catalog = getAiPresetCatalog();
  const presetKey = AI_MODEL_PRESET_KEYS.includes(normalizedPreset)
    ? normalizedPreset
    : catalog.default_preset || "balanced";
  const model = String(catalog.presets?.[presetKey] || config.aiModel || "").trim() || config.aiModel;
  return {
    preset: presetKey,
    model,
    catalog,
  };
};

export const getOrCreateAiPreference = async (userUuid) => {
  const normalizedUserUuid = String(userUuid || "").trim();
  if (!normalizedUserUuid) {
    throw new Error("userUuid is required");
  }

  let doc = await AiPreference.findOne({ userUuid: normalizedUserUuid });
  if (!doc) {
    doc = await AiPreference.create({
      userUuid: normalizedUserUuid,
      modelPreset: config.aiDefaultModelPreset || "balanced",
      budgetGuardEnabled: DEFAULTS.budgetGuardEnabled,
      monthlyRequestLimit: DEFAULTS.monthlyRequestLimit,
      monthlySearchLimit: DEFAULTS.monthlySearchLimit,
      monthlyCostUsdLimit: DEFAULTS.monthlyCostUsdLimit,
    });
  }
  return doc;
};

export const getOrCreateAiUsage = async (userUuid, date = new Date()) => {
  const normalizedUserUuid = String(userUuid || "").trim();
  if (!normalizedUserUuid) {
    throw new Error("userUuid is required");
  }
  const periodKey = periodKeyForDate(date);
  let usage = await AiUsage.findOne({ userUuid: normalizedUserUuid, periodKey });
  if (!usage) {
    usage = await AiUsage.create({ userUuid: normalizedUserUuid, periodKey });
  }
  return usage;
};

export const serializeAiUsage = (usageDoc, preferenceDoc = null) => {
  const pref = preferenceDoc ? normalizePreferenceDoc(preferenceDoc) : null;
  const usage = usageDoc || {};
  const requestsUsed = Math.max(0, Number(usage.requestsUsed || 0));
  const searchRequestsUsed = Math.max(0, Number(usage.searchRequestsUsed || 0));
  const toolOnlyRequestsUsed = Math.max(0, Number(usage.toolOnlyRequestsUsed || 0));
  const estimatedCostUsd = roundMoney(usage.estimatedCostUsd || 0);
  const monthlyRequestLimit = pref?.monthlyRequestLimit || DEFAULTS.monthlyRequestLimit;
  const monthlySearchLimit = pref?.monthlySearchLimit || DEFAULTS.monthlySearchLimit;
  const monthlyCostUsdLimit = pref?.monthlyCostUsdLimit || DEFAULTS.monthlyCostUsdLimit;

  return {
    period_key: String(usage.periodKey || periodKeyForDate()).trim(),
    resets_at: nextPeriodStartIso(usage.periodKey || periodKeyForDate()),
    requests_used: requestsUsed,
    search_requests_used: searchRequestsUsed,
    tool_only_requests_used: toolOnlyRequestsUsed,
    input_chars: Math.max(0, Number(usage.inputChars || 0)),
    output_chars: Math.max(0, Number(usage.outputChars || 0)),
    estimated_input_tokens: Math.max(0, Number(usage.estimatedInputTokens || 0)),
    estimated_output_tokens: Math.max(0, Number(usage.estimatedOutputTokens || 0)),
    estimated_cost_usd: estimatedCostUsd,
    last_request_at: usage.lastRequestAt ? new Date(usage.lastRequestAt).toISOString() : null,
    last_search_at: usage.lastSearchAt ? new Date(usage.lastSearchAt).toISOString() : null,
    last_model: String(usage.lastModel || "").trim() || null,
    last_provider: String(usage.lastProvider || "").trim() || null,
    last_model_preset: String(usage.lastModelPreset || "").trim() || null,
    limits: {
      requests: monthlyRequestLimit,
      search_requests: monthlySearchLimit,
      estimated_cost_usd: monthlyCostUsdLimit,
    },
    remaining: {
      requests: Math.max(0, monthlyRequestLimit - requestsUsed),
      search_requests: Math.max(0, monthlySearchLimit - searchRequestsUsed),
      estimated_cost_usd: Math.max(0, roundMoney(monthlyCostUsdLimit - estimatedCostUsd)),
    },
  };
};

export const updateAiPreference = async (userUuid, patch = {}) => {
  const doc = await getOrCreateAiPreference(userUuid);

  if (typeof patch.model_preset === "string" || typeof patch.modelPreset === "string") {
    const nextPreset = String(patch.model_preset ?? patch.modelPreset).trim().toLowerCase();
    if (AI_MODEL_PRESET_KEYS.includes(nextPreset)) {
      doc.modelPreset = nextPreset;
    }
  }

  if (typeof patch.budget_guard_enabled === "boolean" || typeof patch.budgetGuardEnabled === "boolean") {
    doc.budgetGuardEnabled = Boolean(patch.budget_guard_enabled ?? patch.budgetGuardEnabled);
  }

  if (patch.monthly_request_limit !== undefined || patch.monthlyRequestLimit !== undefined) {
    doc.monthlyRequestLimit = toPositiveInt(
      patch.monthly_request_limit ?? patch.monthlyRequestLimit,
      doc.monthlyRequestLimit || DEFAULTS.monthlyRequestLimit,
    );
  }

  if (patch.monthly_search_limit !== undefined || patch.monthlySearchLimit !== undefined) {
    doc.monthlySearchLimit = toPositiveInt(
      patch.monthly_search_limit ?? patch.monthlySearchLimit,
      doc.monthlySearchLimit || DEFAULTS.monthlySearchLimit,
    );
  }

  if (patch.monthly_cost_usd_limit !== undefined || patch.monthlyCostUsdLimit !== undefined) {
    doc.monthlyCostUsdLimit = toPositiveMoney(
      patch.monthly_cost_usd_limit ?? patch.monthlyCostUsdLimit,
      doc.monthlyCostUsdLimit || DEFAULTS.monthlyCostUsdLimit,
    );
  }

  await doc.save();
  return doc;
};

export const getAiControlSnapshot = async (userUuid) => {
  const [preferenceDoc, usageDoc] = await Promise.all([
    getOrCreateAiPreference(userUuid),
    getOrCreateAiUsage(userUuid),
  ]);

  const preference = normalizePreferenceDoc(preferenceDoc);
  const runtime = {
    provider: config.aiProvider,
    default_model: config.aiModel,
    ...getAiPresetCatalog(),
  };

  return {
    settings: {
      model_preset: preference.modelPreset,
      budget_guard_enabled: preference.budgetGuardEnabled,
      monthly_request_limit: preference.monthlyRequestLimit,
      monthly_search_limit: preference.monthlySearchLimit,
      monthly_cost_usd_limit: preference.monthlyCostUsdLimit,
      updated_at: preference.updatedAt,
    },
    usage: serializeAiUsage(usageDoc, preferenceDoc),
    runtime,
  };
};

const createBudgetError = (message) => {
  const error = new Error(message);
  error.code = "AI_BUDGET_LIMIT";
  return error;
};

export const resolveAiTurnControls = async (userUuid) => {
  const [preferenceDoc, usageDoc] = await Promise.all([
    getOrCreateAiPreference(userUuid),
    getOrCreateAiUsage(userUuid),
  ]);
  const preference = normalizePreferenceDoc(preferenceDoc);
  const usage = serializeAiUsage(usageDoc, preferenceDoc);
  const modelResolution = getResolvedModelForPreset(preference.modelPreset);
  return {
    preferenceDoc,
    usageDoc,
    preference,
    usage,
    modelPreset: modelResolution.preset,
    model: modelResolution.model,
    runtimeCatalog: modelResolution.catalog,
  };
};

export const assertAiRequestBudgetAllowed = (controls) => {
  if (!controls?.preference?.budgetGuardEnabled) {
    return;
  }
  const remainingRequests = Number(controls?.usage?.remaining?.requests || 0);
  const remainingCost = Number(controls?.usage?.remaining?.estimated_cost_usd || 0);
  if (remainingRequests <= 0) {
    throw createBudgetError("AI monthly request limit reached. Update AI budget settings to continue.");
  }
  if (remainingCost <= 0) {
    throw createBudgetError("AI estimated monthly cost budget reached. Update AI budget settings to continue.");
  }
};

export const assertAiSearchBudgetAllowed = (controls) => {
  if (!controls?.preference?.budgetGuardEnabled) {
    return;
  }
  const remainingSearch = Number(controls?.usage?.remaining?.search_requests || 0);
  if (remainingSearch <= 0) {
    throw createBudgetError("AI monthly web-search limit reached. Increase the search limit in AI settings.");
  }
};

export const recordAiTurnUsage = async ({
  userUuid,
  controls = null,
  provider = config.aiProvider,
  model = null,
  modelPreset = null,
  inputChars = 0,
  outputChars = 0,
  searchUsed = false,
  toolOnly = false,
  metrics = null,
}) => {
  const usageDoc = controls?.usageDoc || (await getOrCreateAiUsage(userUuid));
  const resolvedPreset = String(modelPreset || controls?.modelPreset || "balanced").trim().toLowerCase() || "balanced";
  const inputCharCount = Math.max(0, Number(inputChars || 0));
  const outputCharCount = Math.max(0, Number(outputChars || 0));
  const metricInputTokens = Number(metrics?.prompt_eval_count ?? metrics?.promptEvalCount);
  const metricOutputTokens = Number(metrics?.eval_count ?? metrics?.evalCount);
  const estimatedInputTokens = Number.isFinite(metricInputTokens) && metricInputTokens > 0
    ? Math.floor(metricInputTokens)
    : estimateTokensFromChars(inputCharCount);
  const estimatedOutputTokens = Number.isFinite(metricOutputTokens) && metricOutputTokens > 0
    ? Math.floor(metricOutputTokens)
    : estimateTokensFromChars(outputCharCount);
  const pricing = getPricingForModel(model, resolvedPreset);
  const estimatedCostUsd = roundMoney(
    (estimatedInputTokens / 1_000_000) * Number(pricing.input || 0) +
      (estimatedOutputTokens / 1_000_000) * Number(pricing.output || 0),
  );

  usageDoc.requestsUsed = Math.max(0, Number(usageDoc.requestsUsed || 0)) + 1;
  if (searchUsed) {
    usageDoc.searchRequestsUsed = Math.max(0, Number(usageDoc.searchRequestsUsed || 0)) + 1;
    usageDoc.lastSearchAt = new Date();
  }
  if (toolOnly) {
    usageDoc.toolOnlyRequestsUsed = Math.max(0, Number(usageDoc.toolOnlyRequestsUsed || 0)) + 1;
  }
  usageDoc.inputChars = Math.max(0, Number(usageDoc.inputChars || 0)) + inputCharCount;
  usageDoc.outputChars = Math.max(0, Number(usageDoc.outputChars || 0)) + outputCharCount;
  usageDoc.estimatedInputTokens = Math.max(0, Number(usageDoc.estimatedInputTokens || 0)) + estimatedInputTokens;
  usageDoc.estimatedOutputTokens = Math.max(0, Number(usageDoc.estimatedOutputTokens || 0)) + estimatedOutputTokens;
  usageDoc.estimatedCostUsd = roundMoney(Number(usageDoc.estimatedCostUsd || 0) + estimatedCostUsd);
  usageDoc.lastRequestAt = new Date();
  usageDoc.lastModel = String(model || "").trim() || null;
  usageDoc.lastProvider = String(provider || "").trim() || null;
  usageDoc.lastModelPreset = resolvedPreset || null;

  await usageDoc.save();
  return usageDoc;
};
