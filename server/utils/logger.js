const LEVELS = ["debug", "info", "warn", "error"];

const getCurrentLevel = () => {
  const raw = String(process.env.LOG_LEVEL || "info").trim().toLowerCase();
  return LEVELS.includes(raw) ? raw : "info";
};

const shouldLog = (level) => {
  const current = getCurrentLevel();
  return LEVELS.indexOf(level) >= LEVELS.indexOf(current);
};

const serializeError = (error) => {
  if (!error) {
    return null;
  }
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack || null,
    };
  }
  return { message: String(error) };
};

const safeJson = (value) => {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ message: "Failed to serialize log payload" });
  }
};

const writeLog = (level, event, meta = {}) => {
  if (!shouldLog(level)) {
    return;
  }

  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...meta,
  };

  const line = safeJson(payload);
  if (level === "error") {
    console.error(line);
    return;
  }
  if (level === "warn") {
    console.warn(line);
    return;
  }
  console.log(line);
};

export const logger = {
  debug: (event, meta) => writeLog("debug", event, meta),
  info: (event, meta) => writeLog("info", event, meta),
  warn: (event, meta) => writeLog("warn", event, meta),
  error: (event, meta) => writeLog("error", event, meta),
  serializeError,
};
