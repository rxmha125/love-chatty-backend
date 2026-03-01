import { logger } from "../utils/logger.js";
import { opsMetricsStore } from "../ops/metrics-store.js";

export const errorLoggingMiddleware = (error, req, _res, next) => {
  opsMetricsStore.recordError({
    requestId: req.requestId || null,
    method: req.method,
    path: req.originalUrl || req.url || "",
    error,
  });

  logger.error("http.error", {
    request_id: req.requestId || null,
    method: req.method,
    path: req.originalUrl || req.url || "",
    ip: req.ip,
    error: logger.serializeError(error),
  });
  next(error);
};
