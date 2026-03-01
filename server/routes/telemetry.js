import { Router } from "express";
import { logger } from "../utils/logger.js";

const router = Router();

const enabled = () => String(process.env.ENABLE_CLIENT_ERROR_INGEST || "true").trim().toLowerCase() !== "false";

router.post("/client-error", (req, res) => {
  if (!enabled()) {
    return res.status(404).json({ success: false, message: "Telemetry disabled" });
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const event = String(body.event || "client_error").trim() || "client_error";
  const message = String(body.message || "").trim() || "Unknown client error";
  const source = String(body.source || "web").trim() || "web";
  const path = String(body.path || "").trim() || null;
  const userAgent = String(req.headers["user-agent"] || "").slice(0, 300);

  logger.error("client.error", {
    source,
    path,
    message: message.slice(0, 1000),
    stack: typeof body.stack === "string" ? body.stack.slice(0, 4000) : null,
    extra: body.extra && typeof body.extra === "object" ? body.extra : null,
    user_agent: userAgent,
    ip: req.ip,
  });

  return res.status(202).json({ success: true });
});

export default router;
