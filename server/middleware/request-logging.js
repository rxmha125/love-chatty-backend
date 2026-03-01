import { logger } from "../utils/logger.js";
import { opsMetricsStore } from "../ops/metrics-store.js";

export const requestLoggingMiddleware = (req, res, next) => {
  const startedAt = Date.now();
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  req.requestId = requestId;
  res.setHeader("x-request-id", requestId);

  res.on("finish", () => {
    const path = req.originalUrl || req.url || "";
    const durationMs = Date.now() - startedAt;
    opsMetricsStore.recordRequest({
      method: req.method,
      path,
      status: res.statusCode,
      durationMs,
    });

    if (path.startsWith("/api/health")) {
      return;
    }

    logger.info("http.request", {
      request_id: requestId,
      method: req.method,
      path,
      status: res.statusCode,
      duration_ms: durationMs,
      ip: req.ip,
    });
  });

  next();
};
