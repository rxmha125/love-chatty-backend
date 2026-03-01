import fs from "fs";
import path from "path";
import dotenv from "dotenv";

const resolveEnvProfile = () => {
  const raw = String(process.env.APP_ENV || process.env.NODE_ENV || "").trim().toLowerCase();
  return raw || "development";
};

const envProfile = resolveEnvProfile();
const envCandidates = [
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), ".env.local"),
  path.resolve(process.cwd(), `.env.${envProfile}`),
  path.resolve(process.cwd(), `.env.${envProfile}.local`),
];

for (const envPath of envCandidates) {
  if (!fs.existsSync(envPath)) {
    continue;
  }
  dotenv.config({ path: envPath, override: true });
}

const normalizeSecret = (value) => String(value || "").trim();

const normalizeOriginEntry = (value) => {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  if (raw === "*") {
    return "*";
  }
  try {
    return new URL(raw).origin;
  } catch {
    return raw.replace(/\/+$/, "");
  }
};

const parseCsvList = (value) =>
  String(value || "")
    .split(",")
    .map((entry) => normalizeOriginEntry(entry))
    .filter(Boolean);

const parsePositiveInteger = (value, fallback) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
};

const parseTrustProxy = (value) => {
  if (value === undefined || value === null || value === "") {
    return process.env.NODE_ENV === "production" ? 1 : 0;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["true", "yes", "on"].includes(normalized)) {
    return 1;
  }
  if (["false", "no", "off"].includes(normalized)) {
    return 0;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
};

const collectEnvKeyPool = (baseNames) => {
  const values = [];
  const seen = new Set();
  const envEntries = Object.entries(process.env || {});

  const pushIfPresent = (rawValue) => {
    const next = normalizeSecret(rawValue);
    if (!next || seen.has(next)) {
      return;
    }
    seen.add(next);
    values.push(next);
  };

  for (const baseName of baseNames) {
    pushIfPresent(process.env[baseName]);

    const numbered = envEntries
      .map(([key, value]) => {
        const match = String(key || "").match(new RegExp(`^${baseName}_(\\d+)$`, "i"));
        if (!match) {
          return null;
        }
        return {
          index: Number(match[1]),
          value,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.index - b.index);

    for (const item of numbered) {
      pushIfPresent(item.value);
    }
  }

  return values;
};

const groqApiKeys = collectEnvKeyPool(["GROQ_API_KEY", "AI_API_KEY"]);
const genericAiApiKeys = collectEnvKeyPool(["AI_API_KEY"]);

const requestedAiProvider = String(process.env.AI_PROVIDER || "")
  .trim()
  .toLowerCase();
const hasGroqApiKey = groqApiKeys.length > 0;
const resolvedAiProvider =
  requestedAiProvider === "groq" || requestedAiProvider === "ollama"
    ? requestedAiProvider
    : hasGroqApiKey
      ? "groq"
      : "ollama";
const isGroqProvider = resolvedAiProvider === "groq";
const resolvedAiApiKeys = isGroqProvider ? groqApiKeys : genericAiApiKeys;

const resolvedDefaultAiModel =
  isGroqProvider
    ? process.env.AI_MODEL || process.env.GROQ_MODEL || "llama-3.3-70b-versatile"
    : process.env.AI_MODEL || process.env.OLLAMA_MODEL || "ministral-3:14b";

const aiModelPresets = isGroqProvider
  ? {
      fast: process.env.AI_MODEL_FAST || process.env.GROQ_MODEL_FAST || "llama-3.1-8b-instant",
      balanced: process.env.AI_MODEL_BALANCED || process.env.GROQ_MODEL_BALANCED || resolvedDefaultAiModel,
      best: process.env.AI_MODEL_BEST || process.env.GROQ_MODEL_BEST || "openai/gpt-oss-120b",
    }
  : {
      fast: process.env.AI_MODEL_FAST || process.env.OLLAMA_MODEL_FAST || "ministral-3:14b",
      balanced: process.env.AI_MODEL_BALANCED || process.env.OLLAMA_MODEL_BALANCED || resolvedDefaultAiModel,
      best: process.env.AI_MODEL_BEST || process.env.OLLAMA_MODEL_BEST || "qwen2.5:32b",
    };

const allowedAiPresetKeys = ["fast", "balanced", "best"];
const requestedDefaultPreset = String(process.env.AI_MODEL_PRESET_DEFAULT || "balanced")
  .trim()
  .toLowerCase();
const aiDefaultModelPreset = allowedAiPresetKeys.includes(requestedDefaultPreset)
  ? requestedDefaultPreset
  : "balanced";

const DEFAULT_UPLOAD_ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/webm",
  "audio/webm",
  "audio/mp4",
  "audio/m4a",
  "audio/mpeg",
  "application/pdf",
  "text/plain",
  "application/json",
  "application/zip",
  "application/x-zip-compressed",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
];

const configuredClientOrigins = parseCsvList(process.env.CLIENT_ORIGINS);
const fallbackClientOrigin = normalizeOriginEntry(process.env.CLIENT_ORIGIN || "http://localhost:8080") || "http://localhost:8080";
const clientOrigins = configuredClientOrigins.length > 0 ? configuredClientOrigins : [fallbackClientOrigin];
const corsAllowAll = clientOrigins.includes("*");
const uploadAllowedMimeTypes = parseCsvList(process.env.UPLOAD_ALLOWED_MIME_TYPES);

const DEFAULT_VAPID_PUBLIC_KEY =
  "BFGX32mpw7yQfvbaoMzBPzuSb58IFJ8gkM3tqobjXcJUFrkZgupnAAuyMpXSjf2Pm3mketc5rFRIv1Nek-8zxyU";
const DEFAULT_VAPID_PRIVATE_KEY = "1wZ6Ql_tcZEY0459S7C-C1XWP9A0hYovSZF128lMZTw";

export const config = {
  runtimeEnvName: envProfile,
  port: Number(process.env.PORT || 3001),
  mongoUri: process.env.MONGODB_URI || "",
  mongoDbName: process.env.MONGODB_DB || "lovechatty",
  clientOrigin: clientOrigins[0] || "http://localhost:8080",
  clientOrigins,
  corsAllowAll,
  uploadsDir: path.resolve(process.cwd(), "uploads"),
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  apiJsonLimit: process.env.API_JSON_LIMIT || "2mb",
  apiUrlencodedLimit: process.env.API_URLENCODED_LIMIT || "512kb",
  apiUrlencodedParameterLimit: parsePositiveInteger(process.env.API_URLENCODED_PARAMETER_LIMIT, 200),
  rateLimitWindowMs: parsePositiveInteger(process.env.RATE_LIMIT_WINDOW_MS, 60_000),
  rateLimitGlobalMax: parsePositiveInteger(process.env.RATE_LIMIT_GLOBAL_MAX, 300),
  rateLimitAuthMax: parsePositiveInteger(process.env.RATE_LIMIT_AUTH_MAX, 30),
  rateLimitMessagesMax: parsePositiveInteger(process.env.RATE_LIMIT_MESSAGES_MAX, 180),
  rateLimitUploadsMax: parsePositiveInteger(process.env.RATE_LIMIT_UPLOADS_MAX, 40),
  uploadMaxBytes: parsePositiveInteger(process.env.UPLOAD_MAX_BYTES, 20 * 1024 * 1024),
  uploadAllowedMimeTypes:
    uploadAllowedMimeTypes.length > 0 ? uploadAllowedMimeTypes : DEFAULT_UPLOAD_ALLOWED_MIME_TYPES,
  aiProvider: resolvedAiProvider,
  aiBaseUrl:
    isGroqProvider
      ? process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1"
      : process.env.AI_BASE_URL ||
        process.env.OLLAMA_BASE_URL ||
        "https://crucial-untractable-loren.ngrok-free.dev",
  aiApiKeys: resolvedAiApiKeys,
  aiApiKey: resolvedAiApiKeys[0] || "",
  aiModel: resolvedDefaultAiModel,
  aiModelPresets,
  aiDefaultModelPreset,
  aiKeepAlive: process.env.AI_KEEP_ALIVE || "30m",
  aiTimeoutMs: Math.max(3000, Number(process.env.AI_TIMEOUT_MS || 120000)),
  aiTemperature: Number.isFinite(Number(process.env.AI_TEMPERATURE))
    ? Number(process.env.AI_TEMPERATURE)
    : 0.35,
  searchApiKey: process.env.SEARCH_API_KEY || process.env.SERPER_API_KEY || "",
  searchTimeoutMs: Math.max(3000, Number(process.env.SEARCH_TIMEOUT_MS || 20000)),
  searchBaseUrl: process.env.SEARCH_BASE_URL || "https://google.serper.dev",
  scrapeBaseUrl: process.env.SCRAPE_BASE_URL || "https://scrape.serper.dev",
  webPushPublicKey: process.env.WEB_PUSH_PUBLIC_KEY || DEFAULT_VAPID_PUBLIC_KEY,
  webPushPrivateKey: process.env.WEB_PUSH_PRIVATE_KEY || DEFAULT_VAPID_PRIVATE_KEY,
  webPushSubject: process.env.WEB_PUSH_SUBJECT || "mailto:noreply@lovechatty.app",
  opsMetricsToken: normalizeSecret(process.env.OPS_METRICS_TOKEN),
  opsMetricsEnabled: String(process.env.OPS_METRICS_ENABLED || "true").trim().toLowerCase() !== "false",
};
