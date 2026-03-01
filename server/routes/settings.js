import { Router } from "express";
import { requireAuth } from "../middleware/require-auth.js";
import { ChatSetting } from "../models/ChatSetting.js";

const router = Router();

const resolvePeerUuid = (req) => {
  const fromQuery = req.query?.peer_uuid || req.query?.peerUuid;
  const fromBody = req.body?.peer_uuid || req.body?.peerUuid;
  const raw = typeof fromQuery === "string" && fromQuery.trim() ? fromQuery : fromBody;
  return typeof raw === "string" ? raw.trim() : "";
};

const toBooleanIfProvided = (value) => (typeof value === "boolean" ? value : undefined);

const normalizeDraftMessage = (value) => {
  if (typeof value !== "string") {
    return undefined;
  }
  return value.slice(0, 5000);
};

const normalizeReportReason = (value) => {
  if (typeof value !== "string") {
    return undefined;
  }
  return value.trim().slice(0, 500);
};

const buildScopedResponse = (setting, peerUuid) => {
  const scoped =
    peerUuid && setting?.conversationSettings instanceof Map
      ? setting.conversationSettings.get(peerUuid) || null
      : null;

  const theme = scoped?.theme || setting?.theme || "default";
  const customNickname = peerUuid ? scoped?.customNickname || "" : setting?.customNickname || "";

  return {
    theme,
    custom_nickname: customNickname,
    peer_uuid: peerUuid || null,
    muted: Boolean(scoped?.muted),
    pinned: Boolean(scoped?.pinned),
    archived: Boolean(scoped?.archived),
    blocked: Boolean(scoped?.blocked),
    draft_message: scoped?.draftMessage || "",
    reported_at: scoped?.reportedAt ? new Date(scoped.reportedAt).toISOString() : null,
    report_reason: scoped?.reportReason || "",
  };
};

const getOrCreateSetting = async (userUuid) => {
  let setting = await ChatSetting.findOne({ userUuid });
  if (!setting) {
    setting = await ChatSetting.create({ userUuid });
  }
  return setting;
};

router.get("/conversations", requireAuth, async (req, res) => {
  const setting = await ChatSetting.findOne({ userUuid: req.auth.userUuid });
  const entries =
    setting?.conversationSettings instanceof Map
      ? Array.from(setting.conversationSettings.entries())
      : [];

  const conversationSettings = entries
    .map(([peerUuid, scoped]) => ({
      peer_uuid: String(peerUuid || "").trim(),
      theme: scoped?.theme || setting?.theme || "default",
      custom_nickname: scoped?.customNickname || "",
      muted: Boolean(scoped?.muted),
      pinned: Boolean(scoped?.pinned),
      archived: Boolean(scoped?.archived),
      blocked: Boolean(scoped?.blocked),
      draft_message: scoped?.draftMessage || "",
      reported_at: scoped?.reportedAt ? new Date(scoped.reportedAt).toISOString() : null,
      report_reason: scoped?.reportReason || "",
    }))
    .filter((entry) => entry.peer_uuid);

  return res.json({
    success: true,
    conversation_settings: conversationSettings,
  });
});

router.get("/", requireAuth, async (req, res) => {
  const peerUuid = resolvePeerUuid(req);
  const setting = await ChatSetting.findOne({ userUuid: req.auth.userUuid });

  return res.json({
    success: true,
    settings: buildScopedResponse(setting, peerUuid),
  });
});

router.put("/", requireAuth, async (req, res) => {
  const peerUuid = resolvePeerUuid(req);
  const theme = req.body?.theme;
  const customNickname = req.body?.custom_nickname ?? req.body?.customNickname;

  const muted = toBooleanIfProvided(req.body?.muted);
  const pinned = toBooleanIfProvided(req.body?.pinned);
  const archived = toBooleanIfProvided(req.body?.archived);
  const blocked = toBooleanIfProvided(req.body?.blocked);
  const clearDraft = req.body?.clear_draft === true || req.body?.clearDraft === true;
  const draftMessage = normalizeDraftMessage(req.body?.draft_message ?? req.body?.draftMessage);
  const reportContact = req.body?.report_contact === true || req.body?.reportContact === true;
  const reportReason = normalizeReportReason(req.body?.report_reason ?? req.body?.reportReason);

  const setting = await getOrCreateSetting(req.auth.userUuid);

  if (peerUuid) {
    const existingScoped =
      setting.conversationSettings instanceof Map
        ? setting.conversationSettings.get(peerUuid) || {}
        : {};

    const scopedUpdate = {
      theme:
        typeof theme === "string" && theme.trim()
          ? theme.trim()
          : existingScoped.theme || setting.theme || "default",
      customNickname:
        typeof customNickname === "string"
          ? customNickname.trim()
          : existingScoped.customNickname || "",
      muted: typeof muted === "boolean" ? muted : Boolean(existingScoped.muted),
      pinned: typeof pinned === "boolean" ? pinned : Boolean(existingScoped.pinned),
      archived: typeof archived === "boolean" ? archived : Boolean(existingScoped.archived),
      blocked: typeof blocked === "boolean" ? blocked : Boolean(existingScoped.blocked),
      draftMessage:
        clearDraft
          ? ""
          : typeof draftMessage === "string"
            ? draftMessage
            : existingScoped.draftMessage || "",
      reportedAt: reportContact ? new Date() : existingScoped.reportedAt || null,
      reportReason:
        reportContact
          ? reportReason || ""
          : typeof reportReason === "string"
            ? reportReason
            : existingScoped.reportReason || "",
    };

    setting.conversationSettings.set(peerUuid, scopedUpdate);
  } else {
    if (typeof theme === "string" && theme.trim()) {
      setting.theme = theme.trim();
    }
    if (typeof customNickname === "string") {
      setting.customNickname = customNickname.trim();
    }
  }

  await setting.save();

  return res.json({
    success: true,
    settings: buildScopedResponse(setting, peerUuid),
  });
});

export default router;
