import { AI_ASSISTANT_PROFILE_PICTURE_URL, AI_ASSISTANT_UUID } from "../../AI/backend/constants.js";

const appendVersionQuery = (url, versionValue) => {
  const rawUrl = String(url || "").trim();
  if (!rawUrl) {
    return null;
  }

  const version =
    versionValue instanceof Date
      ? versionValue.getTime()
      : Number.isFinite(Number(versionValue))
        ? Number(versionValue)
        : null;

  if (!version) {
    return rawUrl;
  }

  const separator = rawUrl.includes("?") ? "&" : "?";
  return `${rawUrl}${separator}v=${version}`;
};

export const buildDisplayName = (user) => {
  const fullName = `${user.firstName || ""} ${user.lastName || ""}`.trim();
  return fullName || user.email || "Unknown User";
};

export const toClientUser = (user, online = false) => ({
  // Keep AI avatar stable even if legacy records still have null profile picture.
  profile_picture_url: appendVersionQuery(
    user.profilePictureUrl ||
      (user.uuid === AI_ASSISTANT_UUID ? AI_ASSISTANT_PROFILE_PICTURE_URL : null),
    user.updatedAt || user.createdAt || null,
  ),
  id: user.uuid,
  uuid: user.uuid,
  username: user.email,
  email: user.email,
  first_name: user.firstName || "",
  last_name: user.lastName || "",
  display_name: buildDisplayName(user),
  online_status: online,
  last_seen: user.lastSeen ? user.lastSeen.toISOString() : null,
  bio: user.profileBio || "",
  website_url: user.profileWebsiteUrl || "",
  social_links: {
    x: user.profileSocialLinks?.x || "",
    instagram: user.profileSocialLinks?.instagram || "",
    facebook: user.profileSocialLinks?.facebook || "",
    linkedin: user.profileSocialLinks?.linkedin || "",
    github: user.profileSocialLinks?.github || "",
    youtube: user.profileSocialLinks?.youtube || "",
  },
  created_at: user.createdAtExternal
    ? user.createdAtExternal.toISOString()
    : user.createdAt
      ? user.createdAt.toISOString()
      : null,
});

export const toClientMessage = (message) => ({
  id: message._id.toString(),
  client_id: message.clientId || null,
  message_type: message.messageType || "chat",
  content: message.content || "",
  sender_id: message.senderUuid,
  receiver_id: message.receiverUuid,
  group_id: message.groupUuid || null,
  created_at: message.createdAt ? message.createdAt.toISOString() : new Date().toISOString(),
  edited_at: message.editedAt ? message.editedAt.toISOString() : null,
  read_at: message.readAt ? message.readAt.toISOString() : null,
  read_by_uuids: Array.isArray(message.readByUuids) ? message.readByUuids : [],
  status: message.status || "sent",
  file_url: message.fileUrl || null,
  file_type: message.fileType || null,
  reactions: Array.isArray(message.reactions)
    ? message.reactions.map((reaction) => ({
        user_uuid: reaction.userUuid,
        emoji: reaction.emoji,
      }))
    : [],
  pinned: Boolean(message.pinned),
  pinned_at: message.pinnedAt ? message.pinnedAt.toISOString() : null,
  pinned_by: message.pinnedByUuid || null,
  reply_to_id: message.replyToId ? message.replyToId.toString() : null,
  call_meta: message.callMeta
    ? {
        call_id: message.callMeta.callId || null,
        mode: message.callMeta.mode || null,
        state: message.callMeta.state || null,
        caller_uuid: message.callMeta.callerUuid || null,
        ended_by_uuid: message.callMeta.endedByUuid || null,
        ended_reason: message.callMeta.endedReason || null,
        started_at: message.callMeta.startedAt ? message.callMeta.startedAt.toISOString() : null,
        ended_at: message.callMeta.endedAt ? message.callMeta.endedAt.toISOString() : null,
        duration_sec:
          typeof message.callMeta.durationSec === "number" ? message.callMeta.durationSec : 0,
      }
    : null,
  ai_meta: message.aiMeta
    ? {
        thinking: message.aiMeta.thinking || null,
        model: message.aiMeta.model || null,
        links: Array.isArray(message.aiMeta.links) ? message.aiMeta.links : [],
        tools_used: Array.isArray(message.aiMeta.toolsUsed) ? message.aiMeta.toolsUsed : [],
        tool_payload: message.aiMeta.toolPayload || null,
        metrics: message.aiMeta.metrics
          ? {
              endpoint: message.aiMeta.metrics.endpoint || null,
              stream_mode: message.aiMeta.metrics.streamMode || null,
              total_duration_ms:
                typeof message.aiMeta.metrics.totalDurationMs === "number"
                  ? message.aiMeta.metrics.totalDurationMs
                  : null,
              first_token_ms:
                typeof message.aiMeta.metrics.firstTokenMs === "number"
                  ? message.aiMeta.metrics.firstTokenMs
                  : null,
              chunk_count:
                typeof message.aiMeta.metrics.chunkCount === "number"
                  ? message.aiMeta.metrics.chunkCount
                  : null,
              output_chars:
                typeof message.aiMeta.metrics.outputChars === "number"
                  ? message.aiMeta.metrics.outputChars
                  : null,
              thinking_chars:
                typeof message.aiMeta.metrics.thinkingChars === "number"
                  ? message.aiMeta.metrics.thinkingChars
                  : null,
              eval_count:
                typeof message.aiMeta.metrics.evalCount === "number"
                  ? message.aiMeta.metrics.evalCount
                  : null,
              prompt_eval_count:
                typeof message.aiMeta.metrics.promptEvalCount === "number"
                  ? message.aiMeta.metrics.promptEvalCount
                  : null,
              eval_duration_ms:
                typeof message.aiMeta.metrics.evalDurationMs === "number"
                  ? message.aiMeta.metrics.evalDurationMs
                  : null,
              prompt_eval_duration_ms:
                typeof message.aiMeta.metrics.promptEvalDurationMs === "number"
                  ? message.aiMeta.metrics.promptEvalDurationMs
                  : null,
              load_duration_ms:
                typeof message.aiMeta.metrics.loadDurationMs === "number"
                  ? message.aiMeta.metrics.loadDurationMs
                  : null,
              provider: message.aiMeta.metrics.provider || null,
              requested_model: message.aiMeta.metrics.requestedModel || null,
              resolved_model: message.aiMeta.metrics.resolvedModel || null,
              model_preset: message.aiMeta.metrics.modelPreset || null,
              fallback_model_used:
                typeof message.aiMeta.metrics.fallbackModelUsed === "boolean"
                  ? message.aiMeta.metrics.fallbackModelUsed
                  : null,
              fallback_api_key_index:
                typeof message.aiMeta.metrics.fallbackApiKeyIndex === "number"
                  ? message.aiMeta.metrics.fallbackApiKeyIndex
                  : null,
              fallback_api_key_rotated:
                typeof message.aiMeta.metrics.fallbackApiKeyRotated === "boolean"
                  ? message.aiMeta.metrics.fallbackApiKeyRotated
                  : null,
              api_key_pool_size:
                typeof message.aiMeta.metrics.apiKeyPoolSize === "number"
                  ? message.aiMeta.metrics.apiKeyPoolSize
                  : null,
              web_searched:
                typeof message.aiMeta.metrics.webSearched === "boolean"
                  ? message.aiMeta.metrics.webSearched
                  : null,
              web_searched_at: message.aiMeta.metrics.webSearchedAt || null,
              two_pass_search:
                typeof message.aiMeta.metrics.twoPassSearch === "boolean"
                  ? message.aiMeta.metrics.twoPassSearch
                  : null,
              search_strategy: message.aiMeta.metrics.searchStrategy || null,
              search_query: message.aiMeta.metrics.searchQuery || null,
              search_mode: message.aiMeta.metrics.searchMode || null,
              search_result_count:
                typeof message.aiMeta.metrics.searchResultCount === "number"
                  ? message.aiMeta.metrics.searchResultCount
                  : null,
              search_sources_count:
                typeof message.aiMeta.metrics.searchSourcesCount === "number"
                  ? message.aiMeta.metrics.searchSourcesCount
                  : null,
            }
          : null,
      }
    : null,
});
