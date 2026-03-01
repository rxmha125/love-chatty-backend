import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import express from "express";
import http from "http";
import mongoose from "mongoose";
import path from "path";
import { Server as SocketServer } from "socket.io";

import { config } from "./config.js";
import userRoutes from "./routes/users.js";
import groupRoutes from "./routes/groups.js";
import messageRoutes from "./routes/messages.js";
import settingsRoutes from "./routes/settings.js";
import uploadRoutes from "./routes/uploads.js";
import telemetryRoutes from "./routes/telemetry.js";
import aiRoutes from "./routes/ai.js";
import opsRoutes from "./routes/ops.js";
import { PresenceStore } from "./realtime/presence.js";
import { requestLoggingMiddleware } from "./middleware/request-logging.js";
import { errorLoggingMiddleware } from "./middleware/error-logging.js";
import { bindSocketServer } from "./realtime/socket.js";
import { migrateLocalUploadsToMongo } from "./storage/migrate-local-uploads.js";
import { ensureAiAssistantUser } from "../AI/backend/agent.js";
import { logger } from "./utils/logger.js";

const createCorsOriginValidator = () => {
  const allowedOrigins = Array.isArray(config.clientOrigins) ? config.clientOrigins : [];
  const normalizedAllowedOrigins = allowedOrigins.map((origin) => {
    try {
      return new URL(origin).origin;
    } catch {
      return String(origin || "").trim().replace(/\/+$/, "");
    }
  });
  const allowAll = Boolean(config.corsAllowAll) || allowedOrigins.includes("*");

  return (origin, callback) => {
    // Allow server-to-server requests and health checks with no Origin header.
    if (!origin) {
      callback(null, true);
      return;
    }

    const normalizedOrigin = (() => {
      try {
        return new URL(origin).origin;
      } catch {
        return String(origin || "").trim().replace(/\/+$/, "");
      }
    })();

    if (allowAll || normalizedAllowedOrigins.includes(normalizedOrigin)) {
      callback(null, true);
      return;
    }

    callback(new Error(`CORS blocked for origin: ${origin}`));
  };
};

const createLimiter = ({ max, windowMs, name, methods } = {}) =>
  rateLimit({
    windowMs: windowMs || config.rateLimitWindowMs,
    max: Math.max(1, Number(max || config.rateLimitGlobalMax)),
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      message: `Too many requests${name ? ` (${name})` : ""}. Please try again shortly.`,
    },
    skip: methods?.length
      ? (req) => !methods.includes(String(req.method || "").toUpperCase())
      : undefined,
  });

const bootstrap = async () => {
  if (!config.mongoUri) {
    throw new Error("MONGODB_URI is required");
  }

  await mongoose.connect(config.mongoUri, {
    dbName: config.mongoDbName,
  });

  await ensureAiAssistantUser();

  try {
    const migration = await migrateLocalUploadsToMongo();
    if (migration.filesUploaded > 0 || migration.userUpdated > 0 || migration.messageUpdated > 0) {
      console.log(
        `Upload migration: files=${migration.filesUploaded}, users=${migration.userUpdated}, messages=${migration.messageUpdated}, skipped=${migration.skippedMissing}`,
      );
    }
  } catch (error) {
    console.warn("Upload migration skipped:", error instanceof Error ? error.message : error);
  }

  const app = express();
  app.set("trust proxy", config.trustProxy);
  const corsOriginValidator = createCorsOriginValidator();
  const corsOptions = {
    origin: corsOriginValidator,
    credentials: true,
  };
  const globalLimiter = createLimiter({
    max: config.rateLimitGlobalMax,
    windowMs: config.rateLimitWindowMs,
    name: "global",
  });
  const authLimiter = createLimiter({
    max: config.rateLimitAuthMax,
    windowMs: config.rateLimitWindowMs,
    name: "auth-sync",
    methods: ["POST"],
  });
  const messagesLimiter = createLimiter({
    max: config.rateLimitMessagesMax,
    windowMs: config.rateLimitWindowMs,
    name: "messages",
    methods: ["POST", "PATCH", "DELETE", "PUT"],
  });
  const uploadsLimiter = createLimiter({
    max: config.rateLimitUploadsMax,
    windowMs: config.rateLimitWindowMs,
    name: "uploads",
    methods: ["POST"],
  });

  const server = http.createServer(app);
  const io = new SocketServer(server, {
    cors: {
      origin: config.corsAllowAll ? true : config.clientOrigins,
      methods: ["GET", "POST", "PATCH", "PUT", "DELETE"],
      credentials: true,
    },
  });

  const presence = new PresenceStore();
  bindSocketServer(io, presence);

  app.set("io", io);
  app.set("presence", presence);

  app.use(helmet({
    crossOriginResourcePolicy: false,
    contentSecurityPolicy: false,
  }));
  app.use(cors(corsOptions));
  app.options(/.*/, cors(corsOptions));
  app.use(globalLimiter);
  app.use(express.json({ limit: config.apiJsonLimit }));
  app.use(
    express.urlencoded({
      extended: true,
      limit: config.apiUrlencodedLimit,
      parameterLimit: config.apiUrlencodedParameterLimit,
    }),
  );
  app.use("/uploads", express.static(path.resolve(config.uploadsDir)));
  app.use(requestLoggingMiddleware);

  app.get("/api/health", (_req, res) => {
    res.json({
      success: true,
      status: "ok",
      ai_runtime: {
        provider: config.aiProvider,
        model: config.aiModel,
        base_url: config.aiBaseUrl,
        keep_alive: config.aiKeepAlive,
        api_key_pool_size: Array.isArray(config.aiApiKeys) ? config.aiApiKeys.length : 0,
        search_enabled: Boolean(config.searchApiKey),
        cors_origins: config.corsAllowAll ? ["*"] : config.clientOrigins,
        rate_limit_window_ms: config.rateLimitWindowMs,
        environment: config.runtimeEnvName,
        client_error_ingest_enabled: String(process.env.ENABLE_CLIENT_ERROR_INGEST || "true").trim().toLowerCase() !== "false",
        ops_metrics_enabled: Boolean(config.opsMetricsEnabled),
      },
    });
  });

  app.use("/api/users/sync", authLimiter);
  app.use("/api/messages", messagesLimiter);
  app.use("/api/uploads", uploadsLimiter);
  app.use("/api/users", userRoutes);
  app.use("/api/groups", groupRoutes);
  app.use("/api/messages", messageRoutes);
  app.use("/api/settings", settingsRoutes);
  app.use("/api/ai", aiRoutes);
  app.use("/api/uploads", uploadRoutes);
  app.use("/api/telemetry", telemetryRoutes);
  app.use("/api/ops", opsRoutes);

  app.use(errorLoggingMiddleware);

  app.use((error, _req, res, next) => {
    if (error?.type === "entity.too.large") {
      return res.status(413).json({
        success: false,
        message: "Request body is too large",
      });
    }

    if (error?.message && String(error.message).startsWith("CORS blocked")) {
      return res.status(403).json({
        success: false,
        message: "Origin not allowed",
      });
    }

    return next(error);
  });

  app.use((_req, res) => {
    res.status(404).json({
      success: false,
      message: "Route not found",
    });
  });

  server.listen(config.port, () => {
    console.log(
      `AI runtime provider: ${config.aiProvider} | model: ${config.aiModel} | endpoint: ${config.aiBaseUrl} | keep_alive: ${config.aiKeepAlive}`,
    );
    console.log(`API and socket server running on port ${config.port}`);
  });
};

bootstrap().catch((error) => {
  logger.error("server.start_failed", { error: logger.serializeError(error) });
  process.exit(1);
});
