import mongoose from "mongoose";

const aiMemorySchema = new mongoose.Schema(
  {
    userUuid: { type: String, required: true, index: true },
    key: { type: String, required: true, trim: true, index: true },
    value: { type: String, required: true, trim: true },
    confidence: { type: Number, default: 0.7 },
    source: {
      type: String,
      enum: ["agent_tool", "assistant_inference"],
      default: "agent_tool",
    },
  },
  { timestamps: true },
);

aiMemorySchema.index({ userUuid: 1, key: 1 }, { unique: true });

export const AiMemory = mongoose.model("AiMemory", aiMemorySchema);
