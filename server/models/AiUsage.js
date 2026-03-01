import mongoose from "mongoose";

const aiUsageSchema = new mongoose.Schema(
  {
    userUuid: { type: String, required: true, index: true },
    periodKey: { type: String, required: true, index: true }, // YYYY-MM
    requestsUsed: { type: Number, default: 0 },
    searchRequestsUsed: { type: Number, default: 0 },
    toolOnlyRequestsUsed: { type: Number, default: 0 },
    inputChars: { type: Number, default: 0 },
    outputChars: { type: Number, default: 0 },
    estimatedInputTokens: { type: Number, default: 0 },
    estimatedOutputTokens: { type: Number, default: 0 },
    estimatedCostUsd: { type: Number, default: 0 },
    lastRequestAt: { type: Date, default: null },
    lastSearchAt: { type: Date, default: null },
    lastModel: { type: String, default: null },
    lastProvider: { type: String, default: null },
    lastModelPreset: { type: String, default: null },
  },
  { timestamps: true },
);

aiUsageSchema.index({ userUuid: 1, periodKey: 1 }, { unique: true });

export const AiUsage = mongoose.model("AiUsage", aiUsageSchema);
