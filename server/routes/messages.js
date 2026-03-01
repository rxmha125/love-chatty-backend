import mongoose from "mongoose";
import { Router } from "express";
import { isAiAssistantUuid, processAiTurn } from "../../AI/backend/agent.js";
import { requireAuth } from "../middleware/require-auth.js";
import { Group } from "../models/Group.js";
import { ChatSetting } from "../models/ChatSetting.js";
import { Message } from "../models/Message.js";
import { User } from "../models/User.js";
import { sendPushToUser } from "../notifications/push.js";
import { buildDisplayName, toClientMessage } from "../utils/transformers.js";
import { groupRoom, userRoom } from "../realtime/presence.js";

const router = Router();
const GROUP_ROUTE_PREFIX = "group:";

const isGroupConversationId = (value) => String(value || "").startsWith(GROUP_ROUTE_PREFIX);
const toGroupUuidFromConversationId = (value) =>
  isGroupConversationId(value) ? String(value).slice(GROUP_ROUTE_PREFIX.length).trim() : "";

const findAuthorizedGroup = async (groupUuid, currentUserUuid) => {
  const normalizedGroupUuid = String(groupUuid || "").trim();
  const normalizedUserUuid = String(currentUserUuid || "").trim();
  if (!normalizedGroupUuid || !normalizedUserUuid) {
    return null;
  }

  const group = await Group.findOne({ uuid: normalizedGroupUuid });
  if (!group) {
    return null;
  }

  if (!Array.isArray(group.memberUuids) || !group.memberUuids.includes(normalizedUserUuid)) {
    return null;
  }

  return group;
};

const isGroupMessage = (message) => Boolean(message?.groupUuid);

const emitMessageEvent = async (req, message, eventName = "message:new") => {
  const io = req.app.get("io");
  const clientMessage = toClientMessage(message);

  if (isGroupMessage(message)) {
    const groupUuid = String(message.groupUuid || "").trim();
    if (groupUuid) {
      io.to(groupRoom(groupUuid)).emit(eventName, clientMessage);
      const group = await Group.findOne({ uuid: groupUuid }).select({ memberUuids: 1 });
      const memberUuids = Array.isArray(group?.memberUuids) ? group.memberUuids : [];
      memberUuids.forEach((memberUuid) => {
        io.to(userRoom(memberUuid)).emit(eventName, clientMessage);
      });
      return clientMessage;
    }
  }

  io.to(userRoom(message.senderUuid)).emit(eventName, clientMessage);
  io.to(userRoom(message.receiverUuid)).emit(eventName, clientMessage);
  return clientMessage;
};

const emitMessageUpdate = (req, message) => emitMessageEvent(req, message, "message:update");

const emitConversationCleared = (req, userA, userB, clearedBy) => {
  const io = req.app.get("io");
  const payload = {
    user_a: userA,
    user_b: userB,
    cleared_by: clearedBy,
    cleared_at: new Date().toISOString(),
  };
  io.to(userRoom(userA)).emit("conversation:cleared", payload);
  io.to(userRoom(userB)).emit("conversation:cleared", payload);
};

const markDirectMessagesRead = async (req, currentUserUuid, otherUserUuid) => {
  const unreadMessages = await Message.find({
    senderUuid: otherUserUuid,
    receiverUuid: currentUserUuid,
    readAt: null,
    status: { $ne: "deleted" },
  });

  if (unreadMessages.length === 0) {
    return { updated: 0 };
  }

  const now = new Date();
  const unreadIds = unreadMessages.map((msg) => msg._id);
  await Message.updateMany(
    { _id: { $in: unreadIds } },
    {
      $set: {
        readAt: now,
        status: "read",
      },
    },
  );

  await Promise.all(
    unreadMessages.map((message) => {
      message.readAt = now;
      message.status = "read";
      return emitMessageUpdate(req, message);
    }),
  );

  return { updated: unreadMessages.length };
};

const markGroupMessagesRead = async (req, currentUserUuid, groupUuid) => {
  const unreadMessages = await Message.find({
    groupUuid,
    senderUuid: { $ne: currentUserUuid },
    status: { $ne: "deleted" },
    readByUuids: { $ne: currentUserUuid },
  });

  if (unreadMessages.length === 0) {
    return { updated: 0 };
  }

  const unreadIds = unreadMessages.map((msg) => msg._id);
  await Message.updateMany(
    { _id: { $in: unreadIds } },
    {
      $addToSet: {
        readByUuids: currentUserUuid,
      },
    },
  );

  const updatedMessages = await Message.find({ _id: { $in: unreadIds } });
  await Promise.all(updatedMessages.map((message) => emitMessageUpdate(req, message)));

  return { updated: unreadIds.length };
};

const isMessageParticipant = async (message, currentUserUuid) => {
  if (!message) {
    return false;
  }

  if (message.senderUuid === currentUserUuid || message.receiverUuid === currentUserUuid) {
    return true;
  }

  if (!message.groupUuid) {
    return false;
  }

  const group = await Group.findOne({ uuid: message.groupUuid }).select({ memberUuids: 1 });
  return Boolean(Array.isArray(group?.memberUuids) && group.memberUuids.includes(currentUserUuid));
};

const escapeRegex = (value = "") => String(value).replace(/[\^$.*+?()[]{}|]/g, "\\$&");

const parsePositiveInt = (value, fallback, min = 1, max = 200) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(parsed)));
};

const parseBooleanLike = (value, fallback = false) => {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return fallback;
};

const parseBeforeCursorDate = (value) => {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const buildListPageResponse = (items, requestedLimit) => {
  const hasMore = items.length > requestedLimit;
  const sliced = hasMore ? items.slice(0, requestedLimit) : items;
  const ordered = [...sliced].reverse();
  const oldest = ordered[0] || null;
  return {
    messages: ordered,
    page: {
      has_more: hasMore,
      next_before: oldest?.createdAt ? new Date(oldest.createdAt).toISOString() : null,
      returned: ordered.length,
    },
  };
};

const getScopedConversationFlags = async (userUuid, peerUuid) => {
  if (!userUuid || !peerUuid) {
    return null;
  }
  const setting = await ChatSetting.findOne({ userUuid }).select({ conversationSettings: 1 });
  const scoped =
    setting?.conversationSettings instanceof Map
      ? setting.conversationSettings.get(peerUuid) || null
      : null;
  if (!scoped) {
    return null;
  }
  return {
    blocked: Boolean(scoped.blocked),
    muted: Boolean(scoped.muted),
    pinned: Boolean(scoped.pinned),
    archived: Boolean(scoped.archived),
  };
};

const isDirectMessageBlocked = async (senderUuid, receiverUuid) => {
  if (!senderUuid || !receiverUuid) {
    return false;
  }
  const [senderFlags, receiverFlags] = await Promise.all([
    getScopedConversationFlags(senderUuid, receiverUuid),
    getScopedConversationFlags(receiverUuid, senderUuid),
  ]);
  return Boolean(senderFlags?.blocked || receiverFlags?.blocked);
};

const markDirectMessagesDelivered = async (req, currentUserUuid, otherUserUuid = null) => {
  const match = {
    receiverUuid: currentUserUuid,
    groupUuid: null,
    status: "sent",
    readAt: null,
  };
  if (otherUserUuid) {
    match.senderUuid = otherUserUuid;
  }

  const pending = await Message.find(match);
  if (pending.length === 0) {
    return { updated: 0 };
  }

  const ids = pending.map((message) => message._id);
  await Message.updateMany({ _id: { $in: ids } }, { $set: { status: "delivered" } });

  await Promise.all(
    pending.map((message) => {
      message.status = "delivered";
      return emitMessageUpdate(req, message);
    }),
  );

  return { updated: pending.length };
};

router.get("/:otherUserUuid", requireAuth, async (req, res) => {
  const currentUserUuid = req.auth.userUuid;
  const otherUserUuid = req.params.otherUserUuid;

  const limit = parsePositiveInt(req.query?.limit, 60, 1, 200);
  const beforeCursor = parseBeforeCursorDate(req.query?.before);
  const searchQuery = String(req.query?.q || "").trim();
  const mediaOnly = parseBooleanLike(req.query?.media_only ?? req.query?.mediaOnly, false);
  const pinnedOnly = parseBooleanLike(req.query?.pinned_only ?? req.query?.pinnedOnly, false);
  const shouldMarkRead = parseBooleanLike(req.query?.mark_read ?? req.query?.markRead, !searchQuery && !beforeCursor);

  const baseCreatedAtFilter = beforeCursor ? { createdAt: { $lt: beforeCursor } } : {};
  const contentFilter = searchQuery
    ? { content: { $regex: new RegExp(escapeRegex(searchQuery), "i") } }
    : {};
  const mediaFilter = mediaOnly ? { fileUrl: { $ne: null } } : {};
  const pinnedFilter = pinnedOnly ? { pinned: true } : {};

  if (isGroupConversationId(otherUserUuid)) {
    const groupUuid = toGroupUuidFromConversationId(otherUserUuid);
    if (!groupUuid) {
      return res.status(400).json({ success: false, message: "Invalid group id" });
    }

    const group = await findAuthorizedGroup(groupUuid, currentUserUuid);
    if (!group) {
      return res.status(404).json({ success: false, message: "Group not found or not allowed" });
    }

    if (shouldMarkRead && !searchQuery) {
      await markGroupMessagesRead(req, currentUserUuid, group.uuid);
    }

    const query = {
      groupUuid: group.uuid,
      ...baseCreatedAtFilter,
      ...contentFilter,
      ...mediaFilter,
      ...pinnedFilter,
    };
    const rows = await Message.find(query).sort({ createdAt: -1 }).limit(limit + 1);
    const page = buildListPageResponse(rows, limit);

    return res.json({
      success: true,
      messages: page.messages.map(toClientMessage),
      page: page.page,
    });
  }

  await markDirectMessagesDelivered(req, currentUserUuid, otherUserUuid);
  if (shouldMarkRead && !searchQuery) {
    await markDirectMessagesRead(req, currentUserUuid, otherUserUuid);
  }

  const query = {
    $and: [
      {
        $or: [
          { senderUuid: currentUserUuid, receiverUuid: otherUserUuid },
          { senderUuid: otherUserUuid, receiverUuid: currentUserUuid },
        ],
      },
      baseCreatedAtFilter,
      contentFilter,
      mediaFilter,
      pinnedFilter,
    ],
  };

  const rows = await Message.find(query).sort({ createdAt: -1 }).limit(limit + 1);
  const page = buildListPageResponse(rows, limit);

  return res.json({
    success: true,
    messages: page.messages.map(toClientMessage),
    page: page.page,
  });
});
router.post("/", requireAuth, async (req, res) => {
  const senderUuid = req.auth.userUuid;
  const receiverUuid = req.body?.receiver_id || req.body?.receiverUuid || "";
  const clientId = req.body?.client_id || req.body?.clientId || null;
  const content = (req.body?.content || "").trim();
  const fileUrl = req.body?.file_url || req.body?.fileUrl || null;
  const fileType = req.body?.file_type || req.body?.fileType || null;
  const replyToId = req.body?.reply_to_id || req.body?.replyToId || null;

  if (!receiverUuid) {
    return res.status(400).json({
      success: false,
      message: "receiver id is required",
    });
  }

  if (!content && !fileUrl) {
    return res.status(400).json({
      success: false,
      message: "message content or file is required",
    });
  }

  if (replyToId && !mongoose.Types.ObjectId.isValid(replyToId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid reply message id",
    });
  }

  const defaultStatus = "sent";
  const isGroupTarget = isGroupConversationId(receiverUuid);

  if (isGroupTarget) {
    const groupUuid = toGroupUuidFromConversationId(receiverUuid);
    if (!groupUuid) {
      return res.status(400).json({ success: false, message: "Invalid group id" });
    }

    const group = await findAuthorizedGroup(groupUuid, senderUuid);
    if (!group) {
      return res.status(403).json({ success: false, message: "Group not found or not allowed" });
    }

    const message = await Message.create({
      senderUuid,
      receiverUuid: `${GROUP_ROUTE_PREFIX}${group.uuid}`,
      groupUuid: group.uuid,
      clientId,
      content,
      fileUrl,
      fileType,
      replyToId: replyToId || null,
      readByUuids: [senderUuid],
      status: defaultStatus,
    });

    await Group.updateOne({ uuid: group.uuid }, { $set: { updatedAt: new Date() } });
    const clientMessage = await emitMessageEvent(req, message, "message:new");

    User.findOne({ uuid: senderUuid })
      .then((sender) => {
        const senderName = sender ? buildDisplayName(sender) : "New message";
        const groupName = String(group.name || "Group").trim() || "Group";
        const bodyPreview = content
          ? content.slice(0, 120)
          : fileType === "image"
            ? "Sent a photo"
            : fileType === "video"
              ? "Sent a video"
              : fileType === "audio"
                ? "Sent a voice note"
                : "Sent an attachment";

        return Promise.allSettled(
          (group.memberUuids || [])
            .filter((memberUuid) => memberUuid && memberUuid !== senderUuid)
            .map((memberUuid) =>
              sendPushToUser(memberUuid, {
                title: `${senderName} in ${groupName}`,
                body: bodyPreview,
                tag: `group:${group.uuid}`,
                data: {
                  type: "group-message",
                  groupUuid: group.uuid,
                  fromUserUuid: senderUuid,
                  url: `/chat/${GROUP_ROUTE_PREFIX}${group.uuid}`,
                  messageId: message._id.toString(),
                },
                icon: sender?.profilePictureUrl || "/logo_new.png",
              }),
            ),
        );
      })
      .catch(() => {});

    return res.status(201).json({
      success: true,
      message: clientMessage,
    });
  }

  if (!isAiAssistantUuid(receiverUuid)) {
    const blockState = await isDirectMessageBlocked(senderUuid, receiverUuid);
    if (blockState) {
      return res.status(403).json({
        success: false,
        message: "This conversation is blocked",
      });
    }
  }

  const presence = req.app.get("presence");
  const directStatus = isAiAssistantUuid(receiverUuid) || presence?.isOnline?.(receiverUuid) ? "delivered" : defaultStatus;

  const message = await Message.create({
    senderUuid,
    receiverUuid,
    clientId,
    content,
    fileUrl,
    fileType,
    replyToId: replyToId || null,
    status: directStatus,
  });

  const clientMessage = await emitMessageEvent(req, message, "message:new");

  if (!isAiAssistantUuid(receiverUuid)) {
    User.findOne({ uuid: senderUuid })
      .then((sender) => {
        const senderName = sender ? buildDisplayName(sender) : "New message";
        const bodyPreview = content
          ? content.slice(0, 120)
          : fileType === "image"
            ? "Sent a photo"
            : fileType === "video"
              ? "Sent a video"
              : fileType === "audio"
                ? "Sent a voice note"
                : "Sent an attachment";

        return sendPushToUser(receiverUuid, {
          title: senderName,
          body: bodyPreview,
          tag: `message:${senderUuid}`,
          data: {
            type: "message",
            fromUserUuid: senderUuid,
            url: `/chat/${senderUuid}`,
            messageId: message._id.toString(),
          },
          icon: sender?.profilePictureUrl || "/logo_new.png",
        });
      })
      .catch(() => {});
  } else {
    const aiInputText =
      content ||
      (fileType === "image"
        ? "[user sent an image]"
        : fileType === "video"
          ? "[user sent a video]"
          : fileType === "audio"
            ? "[user sent a voice note]"
            : fileType
              ? "[user sent an attachment]"
              : "");

    if (aiInputText) {
      const io = req.app.get("io");
      void processAiTurn({
        io,
        userUuid: senderUuid,
        latestUserMessage: aiInputText,
      }).catch(() => {});
    }
  }

  return res.status(201).json({
    success: true,
    message: clientMessage,
  });
});

router.patch("/:messageId/delete", requireAuth, async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.messageId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid message id",
    });
  }

  const message = await Message.findOne({
    _id: req.params.messageId,
    senderUuid: req.auth.userUuid,
  });

  if (!message) {
    return res.status(404).json({
      success: false,
      message: "Message not found",
    });
  }

  if (message.messageType !== "chat") {
    return res.status(400).json({
      success: false,
      message: "System messages cannot be changed",
    });
  }

  message.content = "This message was removed";
  message.status = "deleted";
  message.pinned = false;
  message.pinnedAt = null;
  message.pinnedByUuid = null;
  await message.save();

  await emitMessageUpdate(req, message);

  return res.json({
    success: true,
    message: toClientMessage(message),
  });
});

router.patch("/:messageId/edit", requireAuth, async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.messageId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid message id",
    });
  }

  const content = (req.body?.content || "").trim();
  if (!content) {
    return res.status(400).json({
      success: false,
      message: "content is required",
    });
  }

  const message = await Message.findOne({
    _id: req.params.messageId,
    senderUuid: req.auth.userUuid,
  });

  if (!message) {
    return res.status(404).json({
      success: false,
      message: "Message not found",
    });
  }

  if (message.messageType !== "chat") {
    return res.status(400).json({
      success: false,
      message: "System messages cannot be changed",
    });
  }

  if (message.status === "deleted") {
    return res.status(400).json({
      success: false,
      message: "Cannot edit a removed message",
    });
  }

  message.content = content;
  message.editedAt = new Date();
  await message.save();

  await emitMessageUpdate(req, message);

  return res.json({
    success: true,
    message: toClientMessage(message),
  });
});

router.patch("/:messageId/reaction", requireAuth, async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.messageId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid message id",
    });
  }

  const emoji = String(req.body?.emoji || "").trim();
  if (!emoji) {
    return res.status(400).json({
      success: false,
      message: "emoji is required",
    });
  }

  const message = await Message.findById(req.params.messageId);
  if (!message) {
    return res.status(404).json({
      success: false,
      message: "Message not found",
    });
  }

  const currentUserUuid = req.auth.userUuid;
  const isParticipant = await isMessageParticipant(message, currentUserUuid);
  if (!isParticipant) {
    return res.status(403).json({
      success: false,
      message: "Not allowed",
    });
  }

  if (message.status === "deleted") {
    return res.status(400).json({
      success: false,
      message: "Cannot react to a removed message",
    });
  }

  if (message.messageType !== "chat") {
    return res.status(400).json({
      success: false,
      message: "System messages cannot be changed",
    });
  }

  const existingIndex = message.reactions.findIndex(
    (reaction) => reaction.userUuid === currentUserUuid,
  );

  if (existingIndex !== -1) {
    const existing = message.reactions[existingIndex];
    if (existing.emoji === emoji) {
      message.reactions.splice(existingIndex, 1);
    } else {
      message.reactions[existingIndex] = {
        userUuid: currentUserUuid,
        emoji,
        createdAt: new Date(),
      };
    }
  } else {
    message.reactions.push({
      userUuid: currentUserUuid,
      emoji,
      createdAt: new Date(),
    });
  }

  await message.save();
  await emitMessageUpdate(req, message);

  return res.json({
    success: true,
    message: toClientMessage(message),
  });
});

router.patch("/:messageId/pin", requireAuth, async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.messageId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid message id",
    });
  }

  const message = await Message.findById(req.params.messageId);
  if (!message) {
    return res.status(404).json({
      success: false,
      message: "Message not found",
    });
  }

  const currentUserUuid = req.auth.userUuid;
  const isParticipant = await isMessageParticipant(message, currentUserUuid);
  if (!isParticipant) {
    return res.status(403).json({
      success: false,
      message: "Not allowed",
    });
  }

  if (message.status === "deleted") {
    return res.status(400).json({
      success: false,
      message: "Cannot pin a removed message",
    });
  }

  if (message.messageType !== "chat") {
    return res.status(400).json({
      success: false,
      message: "System messages cannot be changed",
    });
  }

  const shouldPin =
    typeof req.body?.pinned === "boolean" ? req.body.pinned : !Boolean(message.pinned);

  message.pinned = shouldPin;
  message.pinnedAt = shouldPin ? new Date() : null;
  message.pinnedByUuid = shouldPin ? currentUserUuid : null;
  await message.save();

  await emitMessageUpdate(req, message);

  return res.json({
    success: true,
    message: toClientMessage(message),
  });
});

router.delete("/:otherUserUuid", requireAuth, async (req, res) => {
  const currentUserUuid = req.auth.userUuid;
  const otherUserUuid = req.params.otherUserUuid;

  if (!otherUserUuid) {
    return res.status(400).json({
      success: false,
      message: "other user uuid is required",
    });
  }

  if (isGroupConversationId(otherUserUuid)) {
    return res.status(400).json({
      success: false,
      message: "Clearing group conversations is not supported yet",
    });
  }

  const result = await Message.deleteMany({
    $or: [
      { senderUuid: currentUserUuid, receiverUuid: otherUserUuid },
      { senderUuid: otherUserUuid, receiverUuid: currentUserUuid },
    ],
  });

  emitConversationCleared(req, currentUserUuid, otherUserUuid, currentUserUuid);

  return res.json({
    success: true,
    deletedCount: result.deletedCount || 0,
  });
});

router.post("/:otherUserUuid/read", requireAuth, async (req, res) => {
  const currentUserUuid = req.auth.userUuid;
  const otherUserUuid = req.params.otherUserUuid;

  if (isGroupConversationId(otherUserUuid)) {
    const groupUuid = toGroupUuidFromConversationId(otherUserUuid);
    if (!groupUuid) {
      return res.status(400).json({ success: false, message: "Invalid group id" });
    }

    const group = await findAuthorizedGroup(groupUuid, currentUserUuid);
    if (!group) {
      return res.status(404).json({ success: false, message: "Group not found or not allowed" });
    }

    const result = await markGroupMessagesRead(req, currentUserUuid, group.uuid);
    return res.json({ success: true, updated: result.updated });
  }

  const result = await markDirectMessagesRead(req, currentUserUuid, otherUserUuid);
  return res.json({
    success: true,
    updated: result.updated,
  });
});

export default router;
