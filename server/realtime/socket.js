import { randomUUID } from "crypto";
import { Group } from "../models/Group.js";
import { Message } from "../models/Message.js";
import { User } from "../models/User.js";
import { sendPushToUser } from "../notifications/push.js";
import { buildDisplayName, toClientMessage } from "../utils/transformers.js";
import { parseJwtPayload } from "../utils/token.js";
import { groupRoom, userRoom } from "./presence.js";

const CALL_RING_TIMEOUT_MS = 90 * 1000;
const GROUP_ROUTE_PREFIX = "group:";
const activeCalls = new Map();

const createCallId = () => {
  try {
    return randomUUID();
  } catch {
    return `call-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
};

const isCallParticipant = (callSession, userUuid) =>
  callSession.callerUuid === userUuid || callSession.calleeUuid === userUuid;

const getCallPeerUuid = (callSession, userUuid) => {
  if (callSession.callerUuid === userUuid) {
    return callSession.calleeUuid;
  }
  if (callSession.calleeUuid === userUuid) {
    return callSession.callerUuid;
  }
  return "";
};

const resolveCallState = (reason, durationSec) => {
  if (reason === "missed" || reason === "no-answer") {
    return "missed";
  }
  if (reason === "declined" || reason === "busy" || reason === "rejected") {
    return "declined";
  }
  if (durationSec > 0) {
    return "ended";
  }
  return "missed";
};

const buildCallSummary = (callSession, endedByUuid, reason) => {
  const endedAt = new Date();
  const startedAt = callSession.answeredAt ? new Date(callSession.answeredAt) : null;
  const durationSec = startedAt
    ? Math.max(0, Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000))
    : 0;
  const callState = resolveCallState(reason, durationSec);

  return {
    endedAt,
    startedAt,
    durationSec,
    callState,
    payload: {
      callId: callSession.callId,
      mode: callSession.mode,
      callerUuid: callSession.callerUuid,
      calleeUuid: callSession.calleeUuid,
      fromUserUuid: endedByUuid || callSession.callerUuid,
      endedByUuid: endedByUuid || null,
      reason,
      state: callState,
      durationSec,
      endedAt: endedAt.toISOString(),
    },
  };
};

const emitCallEnded = (io, callSession, endedByUuid, reason) => {
  const summary = buildCallSummary(callSession, endedByUuid, reason);
  io.to(userRoom(callSession.callerUuid)).emit("call:ended", {
    ...summary.payload,
    toUserUuid: callSession.callerUuid,
  });
  io.to(userRoom(callSession.calleeUuid)).emit("call:ended", {
    ...summary.payload,
    toUserUuid: callSession.calleeUuid,
  });
  return summary;
};

const persistCallSummaryMessage = async (io, callSession, endedByUuid, reason) => {
  const summary = buildCallSummary(callSession, endedByUuid, reason);
  const message = await Message.create({
    senderUuid: callSession.callerUuid,
    receiverUuid: callSession.calleeUuid,
    messageType: "system_call",
    content: "",
    status: "sent",
    callMeta: {
      callId: callSession.callId,
      mode: callSession.mode,
      state: summary.callState,
      callerUuid: callSession.callerUuid,
      endedByUuid: endedByUuid || null,
      endedReason: reason || "ended",
      startedAt: summary.startedAt || new Date(callSession.createdAt),
      endedAt: summary.endedAt,
      durationSec: summary.durationSec,
    },
  });

  const clientMessage = toClientMessage(message);
  io.to(userRoom(callSession.callerUuid)).emit("message:new", clientMessage);
  io.to(userRoom(callSession.calleeUuid)).emit("message:new", clientMessage);
};

const finalizeCall = async (io, callId, endedByUuid, reason = "ended") => {
  const callSession = activeCalls.get(callId);
  if (!callSession) {
    return null;
  }

  activeCalls.delete(callId);
  emitCallEnded(io, callSession, endedByUuid, reason);

  try {
    await persistCallSummaryMessage(io, callSession, endedByUuid, reason);
  } catch {
    // do not fail socket flow if call summary persistence fails
  }

  return callSession;
};

const pruneExpiredCalls = async (io) => {
  const now = Date.now();
  const expiredCallIds = [];

  for (const [callId, callSession] of activeCalls.entries()) {
    if (callSession.state !== "ringing") {
      continue;
    }
    if (now - callSession.createdAt < CALL_RING_TIMEOUT_MS) {
      continue;
    }
    expiredCallIds.push(callId);
  }

  await Promise.all(
    expiredCallIds.map((callId) => finalizeCall(io, callId, null, "missed")),
  );
};
const closeCallsForUser = async (io, userUuid, reason = "disconnected") => {
  const callIds = [];
  for (const [callId, callSession] of activeCalls.entries()) {
    if (isCallParticipant(callSession, userUuid)) {
      callIds.push(callId);
    }
  }

  await Promise.all(
    callIds.map((callId) => finalizeCall(io, callId, userUuid, reason)),
  );
};

const parseTypingGroupUuid = (incomingPayload = {}) => {
  const directGroupUuid = String(incomingPayload.groupUuid || incomingPayload.group_uuid || "").trim();
  if (directGroupUuid) {
    return directGroupUuid;
  }

  const toUserUuid = String(incomingPayload.toUserUuid || incomingPayload.to_user_uuid || "").trim();
  if (toUserUuid.startsWith(GROUP_ROUTE_PREFIX)) {
    return toUserUuid.slice(GROUP_ROUTE_PREFIX.length).trim();
  }

  return "";
};

const ensureGroupMembership = async (groupUuid, userUuid) => {
  if (!groupUuid || !userUuid) {
    return false;
  }

  const group = await Group.findOne({ uuid: groupUuid }).select({ memberUuids: 1 });
  return Boolean(Array.isArray(group?.memberUuids) && group.memberUuids.includes(userUuid));
};

const joinKnownGroupsForUser = async (socket, userUuid) => {
  if (!socket || !userUuid) {
    return;
  }

  try {
    const groups = await Group.find({ memberUuids: userUuid }).select({ uuid: 1 });
    groups.forEach((group) => {
      if (group?.uuid) {
        socket.join(groupRoom(group.uuid));
      }
    });
  } catch {
    // Ignore room pre-join failures; user-room message delivery still works.
  }
};

const markPendingMessagesDeliveredForUser = async (io, userUuid) => {
  if (!io || !userUuid) {
    return;
  }

  const pending = await Message.find({
    receiverUuid: userUuid,
    groupUuid: null,
    status: "sent",
    readAt: null,
  }).limit(200);

  if (pending.length === 0) {
    return;
  }

  const ids = pending.map((message) => message._id);
  await Message.updateMany({ _id: { $in: ids } }, { $set: { status: "delivered" } });

  pending.forEach((message) => {
    message.status = "delivered";
    const payload = toClientMessage(message);
    io.to(userRoom(message.senderUuid)).emit("message:update", payload);
    io.to(userRoom(userUuid)).emit("message:update", payload);
  });
};

export const bindSocketServer = (io, presence) => {
  io.on("connection", (socket) => {
    const auth = socket.handshake.auth || {};
    const userUuid = auth.userUuid || auth.user_uuid || "";
    const token = auth.token || "";

    if (!userUuid || !token) {
      socket.disconnect(true);
      return;
    }

    const payload = parseJwtPayload(token);
    if (payload?.uuid && payload.uuid !== userUuid) {
      socket.disconnect(true);
      return;
    }

    socket.data.userUuid = userUuid;
    socket.join(userRoom(userUuid));
    presence.add(userUuid, socket.id);

    io.emit("presence:update", presence.listOnlineUserIds());

    void joinKnownGroupsForUser(socket, userUuid);

    socket.on("group:join", async (incomingPayload = {}) => {
      const groupUuid = String(incomingPayload.groupUuid || incomingPayload.group_uuid || "").trim();
      if (!groupUuid) {
        return;
      }
      if (!(await ensureGroupMembership(groupUuid, userUuid))) {
        return;
      }
      socket.join(groupRoom(groupUuid));
    });

    socket.on("group:leave", (incomingPayload = {}) => {
      const groupUuid = String(incomingPayload.groupUuid || incomingPayload.group_uuid || "").trim();
      if (!groupUuid) {
        return;
      }
      socket.leave(groupRoom(groupUuid));
    });
    socket.on("typing:start", async (incomingPayload = {}) => {
      const groupUuid = parseTypingGroupUuid(incomingPayload);
      if (groupUuid) {
        if (!(await ensureGroupMembership(groupUuid, userUuid))) {
          return;
        }
        socket.join(groupRoom(groupUuid));
        socket.to(groupRoom(groupUuid)).emit("typing:start", {
          fromUserUuid: userUuid,
          groupUuid,
        });
        return;
      }

      const toUserUuid = String(
        incomingPayload.toUserUuid || incomingPayload.to_user_uuid || "",
      ).trim();
      if (!toUserUuid) {
        return;
      }
      io.to(userRoom(toUserUuid)).emit("typing:start", {
        fromUserUuid: userUuid,
      });
    });

    socket.on("typing:stop", async (incomingPayload = {}) => {
      const groupUuid = parseTypingGroupUuid(incomingPayload);
      if (groupUuid) {
        if (!(await ensureGroupMembership(groupUuid, userUuid))) {
          return;
        }
        socket.to(groupRoom(groupUuid)).emit("typing:stop", {
          fromUserUuid: userUuid,
          groupUuid,
        });
        return;
      }

      const toUserUuid = String(
        incomingPayload.toUserUuid || incomingPayload.to_user_uuid || "",
      ).trim();
      if (!toUserUuid) {
        return;
      }
      io.to(userRoom(toUserUuid)).emit("typing:stop", {
        fromUserUuid: userUuid,
      });
    });

    socket.on("call:invite", async (incomingPayload = {}) => {
      const toUserUuid = String(incomingPayload.toUserUuid || incomingPayload.to_user_uuid || "").trim();
      if (!toUserUuid || toUserUuid === userUuid) {
        return;
      }

      await pruneExpiredCalls(io);

      const mode = incomingPayload.mode === "video" ? "video" : "audio";
      const callId =
        String(incomingPayload.callId || incomingPayload.call_id || "").trim() || createCallId();
      const createdAtIso = new Date().toISOString();

      const caller = await User.findOne({ uuid: userUuid });
      const fromDisplayName =
        String(incomingPayload.fromDisplayName || incomingPayload.from_display_name || "").trim() ||
        (caller ? buildDisplayName(caller) : "LoveChatty user");
      const fromProfilePictureUrl =
        String(
          incomingPayload.fromProfilePictureUrl || incomingPayload.from_profile_picture_url || "",
        ).trim() ||
        caller?.profilePictureUrl ||
        null;

      activeCalls.set(callId, {
        callId,
        callerUuid: userUuid,
        calleeUuid: toUserUuid,
        mode,
        createdAt: Date.now(),
        state: "ringing",
      });

      const callPayload = {
        callId,
        mode,
        fromUserUuid: userUuid,
        toUserUuid,
        fromDisplayName,
        fromProfilePictureUrl,
        createdAt: createdAtIso,
      };

      io.to(userRoom(toUserUuid)).emit("call:incoming", callPayload);
      io.to(userRoom(userUuid)).emit("call:outgoing", callPayload);

      sendPushToUser(toUserUuid, {
        title: `Incoming ${mode} call`,
        body: `${fromDisplayName} is calling you`,
        tag: `call:${callId}`,
        icon: fromProfilePictureUrl || "/logo_new.png",
        requireInteraction: true,
        data: {
          type: "incoming-call",
          callId,
          mode,
          fromUserUuid: userUuid,
          url: `/chat/${userUuid}?incomingCallId=${encodeURIComponent(callId)}&mode=${encodeURIComponent(mode)}&fromUserUuid=${encodeURIComponent(userUuid)}`,
        },
        actions: [
          { action: "accept", title: "Accept" },
          { action: "decline", title: "Decline" },
        ],
      }).catch(() => {});
    });

    socket.on("call:accept", (incomingPayload = {}) => {
      const callId = String(incomingPayload.callId || incomingPayload.call_id || "").trim();
      if (!callId) {
        return;
      }

      const callSession = activeCalls.get(callId);
      if (!callSession || !isCallParticipant(callSession, userUuid)) {
        return;
      }

      const peerUuid = getCallPeerUuid(callSession, userUuid);
      if (!peerUuid) {
        return;
      }

      callSession.state = "active";
      callSession.answeredAt = Date.now();
      activeCalls.set(callId, callSession);

      io.to(userRoom(peerUuid)).emit("call:accepted", {
        callId,
        mode: callSession.mode,
        fromUserUuid: userUuid,
        toUserUuid: peerUuid,
        acceptedAt: new Date().toISOString(),
      });
    });

    socket.on("call:decline", async (incomingPayload = {}) => {
      const callId = String(incomingPayload.callId || incomingPayload.call_id || "").trim();
      if (!callId) {
        return;
      }

      const callSession = activeCalls.get(callId);
      if (!callSession || !isCallParticipant(callSession, userUuid)) {
        return;
      }

      const peerUuid = getCallPeerUuid(callSession, userUuid);
      if (!peerUuid) {
        return;
      }

      const reason = String(incomingPayload.reason || "declined");
      io.to(userRoom(peerUuid)).emit("call:declined", {
        callId,
        fromUserUuid: userUuid,
        toUserUuid: peerUuid,
        reason,
      });

      await finalizeCall(io, callId, userUuid, reason);
    });

    socket.on("call:end", async (incomingPayload = {}) => {
      const callId = String(incomingPayload.callId || incomingPayload.call_id || "").trim();
      if (!callId) {
        return;
      }

      const callSession = activeCalls.get(callId);
      if (!callSession || !isCallParticipant(callSession, userUuid)) {
        return;
      }

      const reason = String(incomingPayload.reason || "ended");
      await finalizeCall(io, callId, userUuid, reason);
    });

    socket.on("call:signal", (incomingPayload = {}) => {
      const callId = String(incomingPayload.callId || incomingPayload.call_id || "").trim();
      const toUserUuid = String(incomingPayload.toUserUuid || incomingPayload.to_user_uuid || "").trim();
      if (!callId || !toUserUuid) {
        return;
      }

      const callSession = activeCalls.get(callId);
      if (callSession && !isCallParticipant(callSession, userUuid)) {
        return;
      }

      io.to(userRoom(toUserUuid)).emit("call:signal", {
        callId,
        fromUserUuid: userUuid,
        toUserUuid,
        description: incomingPayload.description || null,
        candidate: incomingPayload.candidate || null,
      });
    });

    socket.on("disconnect", () => {
      void closeCallsForUser(io, userUuid, "disconnected");
      presence.remove(userUuid, socket.id);
      io.emit("presence:update", presence.listOnlineUserIds());
    });
  });
};



