import fs from "fs";
import path from "path";

const args = process.argv.slice(2);
const getArg = (name, fallback = "") => {
  const prefix = `${name}=`;
  const found = args.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
};
const hasFlag = (flag) => args.includes(flag);

const fileArg = String(getArg("--file", ".env.production")).trim() || ".env.production";
const targetPath = path.resolve(process.cwd(), fileArg);
const allowPlaceholders = hasFlag("--allow-placeholders");

const report = {
  file: targetPath,
  ok: true,
  errors: [],
  warnings: [],
  info: {},
};

const fail = (message) => {
  report.ok = false;
  report.errors.push(message);
};

const warn = (message) => {
  report.warnings.push(message);
};

const parseEnvFile = (raw) => {
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eqIndex = line.indexOf("=");
    if (eqIndex <= 0) {
      continue;
    }
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
};

const isPlaceholder = (value) => {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return true;
  }
  return [
    /your-[a-z0-9-]+/i,
    /your_[a-z0-9_]+/i,
    /example\.com/i,
    /mongodb\+srv:\/\/\.\.\./i,
    /^\.{3,}$/,
    /<.+>/,
  ].some((pattern) => pattern.test(normalized));
};

const mustBeUrl = (name, value, { requireHttps = true, allowPath = true } = {}) => {
  try {
    const url = new URL(String(value || ""));
    if (requireHttps && url.protocol !== "https:") {
      fail(`${name} must use https in production`);
    }
    if (!allowPath && (url.pathname !== "/" || url.search || url.hash)) {
      fail(`${name} should not include a path/query/hash`);
    }
    return url;
  } catch {
    fail(`${name} must be a valid URL`);
    return null;
  }
};

if (!fs.existsSync(targetPath)) {
  fail(`Env file not found: ${targetPath}`);
  console.log(JSON.stringify(report, null, 2));
  process.exit(1);
}

const env = parseEnvFile(fs.readFileSync(targetPath, "utf8"));

const requiredKeys = ["APP_ENV", "NODE_ENV", "MONGODB_URI", "MONGODB_DB", "CLIENT_ORIGINS", "AI_PROVIDER", "AI_MODEL", "SEARCH_API_KEY", "OPS_METRICS_ENABLED"];
for (const key of requiredKeys) {
  if (!(key in env)) {
    fail(`Missing required key: ${key}`);
  }
}

const groqKeyEntries = Object.entries(env).filter(([key]) => /^GROQ_API_KEY(_\d+)?$/i.test(key));
const groqKeys = groqKeyEntries
  .filter(([, value]) => String(value || "").trim())
  .map(([key]) => key)
  .sort();
if (groqKeyEntries.length === 0) {
  fail("At least one GROQ_API_KEY (or numbered key) variable must exist");
} else if (groqKeys.length === 0) {
  if (allowPlaceholders) {
    warn("No non-empty GROQ_API_KEY values found (allowed in template mode)");
  } else {
    fail("At least one GROQ_API_KEY (or numbered key) must be set");
  }
}

if ((env.APP_ENV || "").trim().toLowerCase() !== "production") {
  fail("APP_ENV must be 'production'");
}
if ((env.NODE_ENV || "").trim().toLowerCase() !== "production") {
  fail("NODE_ENV must be 'production'");
}

const mongoUri = String(env.MONGODB_URI || "").trim();
if (!/^mongodb(\+srv)?:\/\//i.test(mongoUri)) {
  fail("MONGODB_URI must start with mongodb:// or mongodb+srv://");
}

const clientOrigins = String(env.CLIENT_ORIGINS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
if (clientOrigins.length === 0) {
  fail("CLIENT_ORIGINS must contain at least one frontend origin");
}
for (const origin of clientOrigins) {
  const url = mustBeUrl("CLIENT_ORIGINS entry", origin, { requireHttps: true, allowPath: false });
  if (url && /localhost|127\.0\.0\.1/i.test(url.hostname)) {
    warn(`CLIENT_ORIGINS contains local host '${origin}'`);
  }
}

if ((env.AI_PROVIDER || "").trim().toLowerCase() !== "groq") {
  warn("AI_PROVIDER is not 'groq'; confirm this is intentional for production");
}

const opsEnabled = String(env.OPS_METRICS_ENABLED || "true").trim().toLowerCase() !== "false";
if (opsEnabled) {
  if (!("OPS_METRICS_TOKEN" in env)) {
    fail("Missing required key: OPS_METRICS_TOKEN (required when OPS_METRICS_ENABLED=true)");
  }
  const token = String(env.OPS_METRICS_TOKEN || "").trim();
  if (!allowPlaceholders && token.length < 16) {
    fail("OPS_METRICS_TOKEN should be at least 16 characters in production");
  } else if (allowPlaceholders && token.length < 16) {
    warn("OPS_METRICS_TOKEN appears short/placeholder (allowed in template mode)");
  }
}

if (!allowPlaceholders) {
  for (const [key, value] of Object.entries(env)) {
    if (["PORT", "TRUST_PROXY", "LOG_LEVEL", "ENABLE_CLIENT_ERROR_INGEST"].includes(key)) {
      continue;
    }
    if (isPlaceholder(value)) {
      fail(`Placeholder/empty value detected for ${key}`);
    }
  }
} else {
  for (const [key, value] of Object.entries(env)) {
    if (isPlaceholder(value)) {
      warn(`Placeholder/empty value detected for ${key} (allowed in template mode)`);
    }
  }
}

report.info = {
  app_env: env.APP_ENV || null,
  node_env: env.NODE_ENV || null,
  groq_key_count: groqKeys.length,
  client_origin_count: clientOrigins.length,
  ai_provider: env.AI_PROVIDER || null,
  ai_model: env.AI_MODEL || null,
  ops_metrics_enabled: opsEnabled,
};

console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
