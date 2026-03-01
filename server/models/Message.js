import mongoose from "mongoose";

const messageSchema = new mongoose.Schema(
  {
    senderUuid: { type: String, required: true, index: true },
    receiverUuid: { type: String, required: true, index: true },
    groupUuid: { type: String, default: null, index: true },
    clientId: { type: String, default: null, index: true },
    messageType: {
      type: String,
      enum: ["chat", "system_call"],
      default: "chat",
      index: true,
    },
    content: { type: String, default: "" },
    fileUrl: { type: String, default: null },
    fileType: { type: String, enum: ["image", "video", "audio", "file", null], default: null },
    status: {
      type: String,
      enum: ["sent", "delivered", "read", "deleted"],
      default: "sent",
    },
    editedAt: { type: Date, default: null },
    reactions: {
      type: [
        {
          userUuid: { type: String, required: true },
          emoji: { type: String, required: true },
          createdAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
    pinned: { type: Boolean, default: false },
    pinnedAt: { type: Date, default: null },
    pinnedByUuid: { type: String, default: null },
    readAt: { type: Date, default: null },
    readByUuids: { type: [String], default: [] },
    replyToId: { type: mongoose.Schema.Types.ObjectId, ref: "Message", default: null },
    callMeta: {
      callId: { type: String, default: null },
      mode: { type: String, enum: ["audio", "video", null], default: null },
      state: { type: String, enum: ["ended", "missed", "declined", null], default: null },
      callerUuid: { type: String, default: null },
      endedByUuid: { type: String, default: null },
      endedReason: { type: String, default: null },
      startedAt: { type: Date, default: null },
      endedAt: { type: Date, default: null },
      durationSec: { type: Number, default: 0 },
    },
    aiMeta: {
      thinking: { type: String, default: null },
      model: { type: String, default: null },
      links: { type: [String], default: [] },
      toolsUsed: { type: [String], default: [] },
      toolPayload: { type: mongoose.Schema.Types.Mixed, default: null },
      metrics: {
        endpoint: { type: String, default: null },
        streamMode: { type: String, default: null },
        totalDurationMs: { type: Number, default: null },
        firstTokenMs: { type: Number, default: null },
        chunkCount: { type: Number, default: null },
        outputChars: { type: Number, default: null },
        thinkingChars: { type: Number, default: null },
        evalCount: { type: Number, default: null },
        promptEvalCount: { type: Number, default: null },
        evalDurationMs: { type: Number, default: null },
        promptEvalDurationMs: { type: Number, default: null },
        loadDurationMs: { type: Number, default: null },
        provider: { type: String, default: null },
        requestedModel: { type: String, default: null },
        resolvedModel: { type: String, default: null },
        modelPreset: { type: String, default: null },
        fallbackModelUsed: { type: Boolean, default: null },
        fallbackApiKeyIndex: { type: Number, default: null },
        fallbackApiKeyRotated: { type: Boolean, default: null },
        apiKeyPoolSize: { type: Number, default: null },
        webSearched: { type: Boolean, default: null },
        webSearchedAt: { type: String, default: null },
        twoPassSearch: { type: Boolean, default: null },
        searchStrategy: { type: String, default: null },
        searchQuery: { type: String, default: null },
        searchMode: { type: String, default: null },
        searchResultCount: { type: Number, default: null },
        searchSourcesCount: { type: Number, default: null },
      },
    },
  },
  {
    timestamps: true,
  },
);

// Direct conversation reads and latest-message scans (both directions).
messageSchema.index({ senderUuid: 1, receiverUuid: 1, createdAt: -1 });
messageSchema.index({ receiverUuid: 1, senderUuid: 1, createdAt: -1 });

// Unread message lookup + mark-read updates for a specific conversation.
messageSchema.index({ receiverUuid: 1, senderUuid: 1, readAt: 1, status: 1, createdAt: -1 });

// Conversation list unread-count aggregations grouped by sender.
messageSchema.index({ receiverUuid: 1, readAt: 1, status: 1, senderUuid: 1, createdAt: -1 });

// Group conversation reads + latest message scans.
messageSchema.index({ groupUuid: 1, createdAt: -1 });
messageSchema.index({ groupUuid: 1, senderUuid: 1, createdAt: -1 });

// Group unread lookup for a member (messages not in readByUuids).
messageSchema.index({ groupUuid: 1, status: 1, readByUuids: 1, senderUuid: 1, createdAt: -1 });

export const Message = mongoose.model("Message", messageSchema);
