import { userRoom } from "../../server/realtime/presence.js";
import {
  AI_ASSISTANT_UUID,
  AI_METRICS_EVENT,
  AI_STATUS_EVENT,
  AI_STREAM_EVENT,
  AI_DIRECTIVE_REGEX,
  AI_SEARCH_DIRECTIVE_REGEX,
} from "./constants.js";

const sanitizeDirectivePreview = (value) =>
  String(value || "")
    .replace(AI_DIRECTIVE_REGEX, "")
    .replace(AI_SEARCH_DIRECTIVE_REGEX, "")
    .replace(/\n{3,}/g, "\n\n")
    .trimStart();
const sanitizeDirectiveChunk = (value) =>
  String(value || "")
    .replace(AI_DIRECTIVE_REGEX, "")
    .replace(AI_SEARCH_DIRECTIVE_REGEX, "");

const toIso = () => new Date().toISOString();

export const emitAiTyping = (io, userUuid, isTyping) => {
  if (!io || !userUuid) {
    return;
  }

  const eventName = isTyping ? "typing:start" : "typing:stop";
  io.to(userRoom(userUuid)).emit(eventName, {
    fromUserUuid: AI_ASSISTANT_UUID,
    from_user_uuid: AI_ASSISTANT_UUID,
  });
};

export const emitAiStatus = (io, userUuid, payload = {}) => {
  if (!io || !userUuid) {
    return;
  }

  io.to(userRoom(userUuid)).emit(AI_STATUS_EVENT, {
    stream_id: String(payload.streamId || ""),
    from_user_uuid: AI_ASSISTANT_UUID,
    to_user_uuid: userUuid,
    status: String(payload.status || "thinking"),
    message: String(payload.message || ""),
    model: payload.model ? String(payload.model) : null,
    error: payload.error ? String(payload.error) : null,
    metrics: payload.metrics || null,
    updated_at: toIso(),
  });
};

export const emitAiStreamState = (io, userUuid, payload = {}) => {
  if (!io || !userUuid) {
    return;
  }

  io.to(userRoom(userUuid)).emit(AI_STREAM_EVENT, {
    stream_id: String(payload.streamId || ""),
    from_user_uuid: AI_ASSISTANT_UUID,
    to_user_uuid: userUuid,
    content: sanitizeDirectivePreview(payload.content || ""),
    thinking: String(payload.thinking || ""),
    content_delta: sanitizeDirectiveChunk(payload.content_delta || payload.contentDelta || ""),
    thinking_delta: String(payload.thinking_delta || payload.thinkingDelta || ""),
    model: payload.model ? String(payload.model) : null,
    done: Boolean(payload.done),
    error: payload.error ? String(payload.error) : null,
    metrics: payload.metrics || null,
    updated_at: toIso(),
  });
};

export const emitAiMetrics = (io, userUuid, payload = {}) => {
  if (!io || !userUuid) {
    return;
  }

  io.to(userRoom(userUuid)).emit(AI_METRICS_EVENT, {
    stream_id: String(payload.streamId || ""),
    from_user_uuid: AI_ASSISTANT_UUID,
    to_user_uuid: userUuid,
    metrics: payload.metrics || null,
    updated_at: toIso(),
  });
};
