import mongoose from "mongoose";

const scopedSettingSchema = new mongoose.Schema(
  {
    theme: { type: String, default: "default" },
    customNickname: { type: String, default: "" },
    muted: { type: Boolean, default: false },
    pinned: { type: Boolean, default: false },
    archived: { type: Boolean, default: false },
    blocked: { type: Boolean, default: false },
    draftMessage: { type: String, default: "" },
    reportedAt: { type: Date, default: null },
    reportReason: { type: String, default: "" },
  },
  { _id: false },
);

const chatSettingSchema = new mongoose.Schema(
  {
    userUuid: { type: String, required: true, unique: true, index: true },
    theme: { type: String, default: "default" },
    customNickname: { type: String, default: "" },
    conversationSettings: {
      type: Map,
      of: scopedSettingSchema,
      default: {},
    },
  },
  {
    timestamps: true,
  },
);

export const ChatSetting = mongoose.model("ChatSetting", chatSettingSchema);
