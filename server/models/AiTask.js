import mongoose from "mongoose";

const aiTaskSchema = new mongoose.Schema(
  {
    userUuid: { type: String, required: true, index: true },
    title: { type: String, required: true, trim: true },
    details: { type: String, default: "", trim: true },
    dueAt: { type: Date, default: null, index: true },
    status: {
      type: String,
      enum: ["pending", "done", "cancelled"],
      default: "pending",
      index: true,
    },
    source: {
      type: String,
      enum: ["agent_tool", "manual"],
      default: "agent_tool",
    },
  },
  { timestamps: true },
);

aiTaskSchema.index({ userUuid: 1, status: 1, dueAt: 1 });

export const AiTask = mongoose.model("AiTask", aiTaskSchema);
