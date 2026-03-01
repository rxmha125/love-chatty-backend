import { Router } from "express";
import mongoose from "mongoose";
import { isAiAssistantUuid } from "../../AI/backend/agent.js";
import { requireAuth } from "../middleware/require-auth.js";
import { User } from "../models/User.js";
import { Message } from "../models/Message.js";
import { Group } from "../models/Group.js";
import { ChatSetting } from "../models/ChatSetting.js";
import { getUploadsBucket } from "../storage/gridfs.js";
import { toClientUser } from "../utils/transformers.js";
import { parseJwtPayload } from "../utils/token.js";
import { upsertUserFromAuth } from "../utils/upsert-user.js";

const router = Router();

const PROFILE_SOCIAL_LINK_KEYS = [
  "x",
  "instagram",
  "facebook",
  "linkedin",
  "github",
  "youtube",
];

const normalizeProfileText = (value, maxLength) => {
  if (typeof value !== "string") {
    return null;
  }
  return value.trim().slice(0, maxLength);
};

const normalizeProfileUrl = (value) => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `${'https://'}${trimmed}`;
  return withProtocol.slice(0, 300);
};

const normalizePushSubscription = (rawSubscription) => {
  const endpoint = String(rawSubscription?.endpoint || "").trim();
  const p256dh = String(rawSubscription?.keys?.p256dh || "").trim();
  const auth = String(rawSubscription?.keys?.auth || "").trim();

  if (!endpoint || !p256dh || !auth) {
    return null;
  }

  const expirationRaw = rawSubscription?.expirationTime;
  const expirationTime =
    typeof expirationRaw === "number" && Number.isFinite(expirationRaw) ? expirationRaw : null;

  return {
    endpoint,
    expirationTime,
    keys: {
      p256dh,
      auth,
    },
  };
};

const LOCAL_UPLOAD_URL_REGEX = /^\/api\/uploads\/([a-f0-9]{24})(?:\?.*)?$/i;

const extractLocalUploadFileId = (value) => {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  const match = raw.match(LOCAL_UPLOAD_URL_REGEX);
  return match?.[1] ? String(match[1]).trim() : "";
};

const deleteProfileUploadIfUnused = async ({ fileUrl, ownerUuid }) => {
  const trimmedUrl = String(fileUrl || "").trim();
  const trimmedOwner = String(ownerUuid || "").trim();
  const fileId = extractLocalUploadFileId(trimmedUrl);

  if (!trimmedUrl || !trimmedOwner || !fileId || !mongoose.Types.ObjectId.isValid(fileId)) {
    return;
  }

  const [userRef, messageRef, groupRef] = await Promise.all([
    User.exists({ profilePictureUrl: trimmedUrl }),
    Message.exists({ fileUrl: trimmedUrl }),
    Group.exists({ profilePictureUrl: trimmedUrl }),
  ]);

  if (userRef || messageRef || groupRef) {
    return;
  }

  const bucket = getUploadsBucket();
  const objectId = new mongoose.Types.ObjectId(fileId);
  const files = await bucket.find({ _id: objectId }).limit(1).toArray();
  const file = files[0];
  if (!file) {
    return;
  }

  const storedOwnerUuid = String(file.metadata?.ownerUuid || "").trim();
  if (storedOwnerUuid && storedOwnerUuid !== trimmedOwner) {
    return;
  }

  await bucket.delete(objectId);
};


const buildMessagePreview = (message) => {
  const status = String(message?.status || "").trim().toLowerCase();
  if (status === "deleted") {
    return "Message removed";
  }

  const messageType = String(message?.messageType || "chat").trim().toLowerCase();
  if (messageType === "system_call") {
    const callState = String(message?.callMeta?.state || "").trim().toLowerCase();
    const mode = String(message?.callMeta?.mode || "audio").trim().toLowerCase();
    if (callState === "missed") {
      return "Missed call";
    }
    if (callState === "declined") {
      return "Declined call";
    }
    return mode === "video" ? "Video call" : "Audio call";
  }

  const content = typeof message?.content === "string" ? message.content.replace(/\s+/g, " ").trim() : "";
  if (content) {
    return content.slice(0, 140);
  }

  if (message?.fileUrl) {
    const fileType = String(message?.fileType || "").trim().toLowerCase();
    if (fileType === "image") {
      return "Photo";
    }
    if (fileType === "video") {
      return "Video";
    }
    if (fileType === "audio") {
      return "Audio";
    }
    return "File";
  }

  return "New message";
};

router.post("/sync", async (req, res) => {
  const authorization = req.headers.authorization || "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
  const user = req.body?.user;

  if (!token || !user?.uuid) {
    return res.status(401).json({
      success: false,
      message: "Missing token or user payload",
    });
  }

  const payload = parseJwtPayload(token);
  if (payload?.uuid && payload.uuid !== user.uuid) {
    return res.status(401).json({
      success: false,
      message: "Token uuid mismatch",
    });
  }

  try {
    const syncedUser = await upsertUserFromAuth({
      uuid: user.uuid,
      email: user.email,
      first_name: user.first_name,
      last_name: user.last_name,
      profile_picture_url: user.profile_picture_url,
    });

    const presence = req.app.get("presence");
    return res.json({
      success: true,
      user: toClientUser(syncedUser, presence.isOnline(syncedUser.uuid)),
    });
  } catch {
    return res.status(500).json({
      success: false,
      message: "Failed to sync user",
    });
  }
});

router.get("/me", requireAuth, async (req, res) => {
  const user = await User.findOne({ uuid: req.auth.userUuid });
  if (!user) {
    return res.status(404).json({
      success: false,
      message: "User not found",
    });
  }

  const presence = req.app.get("presence");
  return res.json({
    success: true,
    user: toClientUser(user, presence.isOnline(user.uuid)),
  });
});

router.patch("/me/profile", requireAuth, async (req, res) => {
  const user = await User.findOne({ uuid: req.auth.userUuid });
  if (!user) {
    return res.status(404).json({
      success: false,
      message: "User not found",
    });
  }

  let hasChanges = false;
  let previousProfilePictureUrlToDelete = "";

  if (Object.prototype.hasOwnProperty.call(req.body || {}, "profile_picture_url")) {
    const nextProfilePicture = req.body?.profile_picture_url;
    if (nextProfilePicture !== null && typeof nextProfilePicture !== "string") {
      return res.status(400).json({
        success: false,
        message: "profile_picture_url must be a string or null",
      });
    }

    const previousProfilePictureUrl = String(user.profilePictureUrl || "").trim();
    const normalizedNextProfilePicture =
      typeof nextProfilePicture === "string" ? nextProfilePicture.trim() || null : null;

    user.profilePictureUrl = normalizedNextProfilePicture;
    if (previousProfilePictureUrl && previousProfilePictureUrl !== String(normalizedNextProfilePicture || "")) {
      previousProfilePictureUrlToDelete = previousProfilePictureUrl;
    }
    hasChanges = true;
  }

  if (typeof req.body?.first_name === "string") {
    user.firstName = req.body.first_name.trim();
    hasChanges = true;
  }

  if (typeof req.body?.last_name === "string") {
    user.lastName = req.body.last_name.trim();
    hasChanges = true;
  }

  if (Object.prototype.hasOwnProperty.call(req.body || {}, "bio")) {
    const normalizedBio = normalizeProfileText(req.body?.bio, 500);
    if (normalizedBio === null) {
      return res.status(400).json({
        success: false,
        message: "bio must be a string",
      });
    }
    user.profileBio = normalizedBio;
    hasChanges = true;
  }

  if (Object.prototype.hasOwnProperty.call(req.body || {}, "website_url")) {
    const normalizedWebsite = normalizeProfileUrl(req.body?.website_url);
    if (normalizedWebsite === null) {
      return res.status(400).json({
        success: false,
        message: "website_url must be a string",
      });
    }
    user.profileWebsiteUrl = normalizedWebsite;
    hasChanges = true;
  }

  if (Object.prototype.hasOwnProperty.call(req.body || {}, "social_links")) {
    const rawSocialLinks = req.body?.social_links;
    if (!rawSocialLinks || typeof rawSocialLinks !== "object" || Array.isArray(rawSocialLinks)) {
      return res.status(400).json({
        success: false,
        message: "social_links must be an object",
      });
    }

    const nextSocialLinks = {
      x: user.profileSocialLinks?.x || "",
      instagram: user.profileSocialLinks?.instagram || "",
      facebook: user.profileSocialLinks?.facebook || "",
      linkedin: user.profileSocialLinks?.linkedin || "",
      github: user.profileSocialLinks?.github || "",
      youtube: user.profileSocialLinks?.youtube || "",
    };

    for (const key of PROFILE_SOCIAL_LINK_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(rawSocialLinks, key)) {
        continue;
      }
      const normalizedUrl = normalizeProfileUrl(rawSocialLinks[key]);
      if (normalizedUrl === null) {
        return res.status(400).json({
          success: false,
          message: `social_links.${key} must be a string`,
        });
      }
      nextSocialLinks[key] = normalizedUrl;
      hasChanges = true;
    }

    user.profileSocialLinks = nextSocialLinks;
  }

  if (!hasChanges) {
    return res.status(400).json({
      success: false,
      message: "No profile fields provided",
    });
  }

  await user.save();

  if (previousProfilePictureUrlToDelete) {
    deleteProfileUploadIfUnused({
      fileUrl: previousProfilePictureUrlToDelete,
      ownerUuid: user.uuid,
    }).catch(() => {
      // Ignore cleanup failures so profile updates still succeed.
    });
  }

  const presence = req.app.get("presence");
  const clientUser = toClientUser(user, presence.isOnline(user.uuid));
  const io = req.app.get("io");
  io.emit("user:update", clientUser);

  return res.json({
    success: true,
    user: clientUser,
  });
});

router.post("/me/push-subscriptions", requireAuth, async (req, res) => {
  const user = await User.findOne({ uuid: req.auth.userUuid });
  if (!user) {
    return res.status(404).json({
      success: false,
      message: "User not found",
    });
  }

  const normalized = normalizePushSubscription(req.body?.subscription);
  if (!normalized) {
    return res.status(400).json({
      success: false,
      message: "Invalid push subscription payload",
    });
  }

  const existingIndex = user.pushSubscriptions.findIndex(
    (item) => item.endpoint === normalized.endpoint,
  );

  const record = {
    ...normalized,
    userAgent: String(req.headers["user-agent"] || ""),
    updatedAt: new Date(),
  };

  if (existingIndex === -1) {
    user.pushSubscriptions.push({
      ...record,
      createdAt: new Date(),
    });
  } else {
    const existing = user.pushSubscriptions[existingIndex];
    existing.keys = record.keys;
    existing.expirationTime = record.expirationTime;
    existing.userAgent = record.userAgent;
    existing.updatedAt = record.updatedAt;
  }

  await user.save();

  return res.json({
    success: true,
    subscriptions_count: user.pushSubscriptions.length,
  });
});

router.delete("/me/push-subscriptions", requireAuth, async (req, res) => {
  const endpoint = String(req.body?.endpoint || "").trim();
  if (!endpoint) {
    return res.status(400).json({
      success: false,
      message: "endpoint is required",
    });
  }

  const user = await User.findOne({ uuid: req.auth.userUuid });
  if (!user) {
    return res.status(404).json({
      success: false,
      message: "User not found",
    });
  }

  const before = user.pushSubscriptions.length;
  user.pushSubscriptions = user.pushSubscriptions.filter((item) => item.endpoint !== endpoint);
  if (user.pushSubscriptions.length !== before) {
    await user.save();
  }

  return res.json({
    success: true,
    removed: before - user.pushSubscriptions.length,
  });
});

router.get("/", requireAuth, async (req, res) => {
  const currentUserUuid = req.auth.userUuid;
  const users = await User.find({ uuid: { $ne: currentUserUuid } });
  const contactUuids = users.map((user) => user.uuid);
  const lastMessageByUserUuid = new Map();
  const unreadCountByUserUuid = new Map();
  const conversationFlagsByPeerUuid = new Map();

  if (contactUuids.length > 0) {
    const chatSetting = await ChatSetting.findOne({ userUuid: currentUserUuid });
    const scopedEntries =
      chatSetting?.conversationSettings instanceof Map
        ? Array.from(chatSetting.conversationSettings.entries())
        : [];

    for (const [peerUuid, scoped] of scopedEntries) {
      const normalizedPeerUuid = String(peerUuid || "").trim();
      if (!normalizedPeerUuid) {
        continue;
      }
      conversationFlagsByPeerUuid.set(normalizedPeerUuid, {
        pinned: Boolean(scoped?.pinned),
        muted: Boolean(scoped?.muted),
        archived: Boolean(scoped?.archived),
        blocked: Boolean(scoped?.blocked),
      });
    }

    const latestMessageRows = await Message.aggregate([
      {
        $match: {
          $or: [
            { senderUuid: currentUserUuid, receiverUuid: { $in: contactUuids } },
            { receiverUuid: currentUserUuid, senderUuid: { $in: contactUuids } },
          ],
        },
      },
      { $sort: { createdAt: -1 } },
      {
        $project: {
          counterpartUuid: {
            $cond: [{ $eq: ["$senderUuid", currentUserUuid] }, "$receiverUuid", "$senderUuid"],
          },
          createdAt: 1,
          content: 1,
          senderUuid: 1,
          fileUrl: 1,
          fileType: 1,
          messageType: 1,
          status: 1,
          readAt: 1,
          callMeta: 1,
        },
      },
      {
        $group: {
          _id: "$counterpartUuid",
          lastMessageAt: { $first: "$createdAt" },
          content: { $first: "$content" },
          senderUuid: { $first: "$senderUuid" },
          fileUrl: { $first: "$fileUrl" },
          fileType: { $first: "$fileType" },
          messageType: { $first: "$messageType" },
          status: { $first: "$status" },
          readAt: { $first: "$readAt" },
          callMeta: { $first: "$callMeta" },
        },
      },
    ]);

    latestMessageRows.forEach((row) => {
      if (!row?._id || !row.lastMessageAt) {
        return;
      }
      lastMessageByUserUuid.set(String(row._id), {
        at: new Date(row.lastMessageAt).toISOString(),
        preview: buildMessagePreview(row),
        senderId: row.senderUuid ? String(row.senderUuid) : null,
        status: row.status ? String(row.status) : null,
        readAt: row.readAt ? new Date(row.readAt).toISOString() : null,
      });
    });

    const unreadRows = await Message.aggregate([
      {
        $match: {
          senderUuid: { $in: contactUuids },
          receiverUuid: currentUserUuid,
          readAt: null,
          status: { $ne: "deleted" },
        },
      },
      { $group: { _id: "$senderUuid", unreadCount: { $sum: 1 } } },
    ]);

    unreadRows.forEach((row) => {
      if (!row?._id) {
        return;
      }
      unreadCountByUserUuid.set(String(row._id), Math.max(0, Number(row.unreadCount) || 0));
    });
  }

  const presence = req.app.get("presence");
  const usersWithActivity = users.map((user) => {
    const summary = lastMessageByUserUuid.get(user.uuid) || null;
    const chatFlags = conversationFlagsByPeerUuid.get(user.uuid) || null;
    return {
      ...toClientUser(user, presence.isOnline(user.uuid) || isAiAssistantUuid(user.uuid)),
      last_message_at: summary?.at || null,
      last_message_preview: summary?.preview || null,
      last_message_sender_id: summary?.senderId || null,
      last_message_status: summary?.status || null,
      last_message_read_at: summary?.readAt || null,
      unread_count: unreadCountByUserUuid.get(user.uuid) || 0,
      chat_pinned: Boolean(chatFlags?.pinned),
      chat_muted: Boolean(chatFlags?.muted),
      chat_archived: Boolean(chatFlags?.archived),
      chat_blocked: Boolean(chatFlags?.blocked),
    };
  });

  usersWithActivity.sort((a, b) => {
    const timeA = a.last_message_at ? Date.parse(a.last_message_at) : 0;
    const timeB = b.last_message_at ? Date.parse(b.last_message_at) : 0;
    if (timeA !== timeB) {
      return timeB - timeA;
    }
    return a.display_name.localeCompare(b.display_name);
  });

  return res.json({
    success: true,
    users: usersWithActivity,
  });
});

router.get("/:uuid", requireAuth, async (req, res) => {
  const user = await User.findOne({ uuid: req.params.uuid });
  if (!user) {
    return res.status(404).json({
      success: false,
      message: "User not found",
    });
  }

  const presence = req.app.get("presence");
  return res.json({
    success: true,
    user: toClientUser(user, presence.isOnline(user.uuid) || isAiAssistantUuid(user.uuid)),
  });
});

export default router;
