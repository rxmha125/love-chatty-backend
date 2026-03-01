import { Router } from "express";
import { requireAuth } from "../middleware/require-auth.js";
import { getAiControlSnapshot, updateAiPreference } from "../../AI/backend/controls.js";

const router = Router();

router.get("/settings", requireAuth, async (req, res) => {
  const snapshot = await getAiControlSnapshot(req.auth.userUuid);
  return res.json({ success: true, ...snapshot });
});

router.put("/settings", requireAuth, async (req, res) => {
  await updateAiPreference(req.auth.userUuid, req.body || {});
  const snapshot = await getAiControlSnapshot(req.auth.userUuid);
  return res.json({ success: true, ...snapshot });
});

router.get("/usage", requireAuth, async (req, res) => {
  const snapshot = await getAiControlSnapshot(req.auth.userUuid);
  return res.json({ success: true, usage: snapshot.usage, runtime: snapshot.runtime, settings: snapshot.settings });
});

export default router;
