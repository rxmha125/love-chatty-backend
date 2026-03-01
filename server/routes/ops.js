import { Router } from "express";

import { config } from "../config.js";
import { opsMetricsStore } from "../ops/metrics-store.js";

const router = Router();

const readOpsToken = (req) =>
  String(
    req.headers["x-ops-token"]
      || req.headers["x-monitor-token"]
      || req.query?.token
      || "",
  ).trim();

router.get("/metrics", (req, res) => {
  if (!config.opsMetricsEnabled) {
    return res.status(404).json({
      success: false,
      message: "Ops metrics endpoint is disabled",
    });
  }

  if (!config.opsMetricsToken) {
    return res.status(503).json({
      success: false,
      message: "Ops metrics token is not configured",
    });
  }

  const provided = readOpsToken(req);
  if (!provided || provided !== config.opsMetricsToken) {
    return res.status(401).json({
      success: false,
      message: "Invalid ops metrics token",
    });
  }

  const io = req.app.get("io");
  const presence = req.app.get("presence");
  const snapshot = opsMetricsStore.snapshot({ io, presence });
  return res.json({
    success: true,
    metrics: snapshot,
  });
});

export default router;
