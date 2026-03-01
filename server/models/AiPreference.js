import mongoose from "mongoose";

const aiPreferenceSchema = new mongoose.Schema(
  {
    userUuid: { type: String, required: true, unique: true, index: true },
    modelPreset: {
      type: String,
      enum: ["fast", "balanced", "best"],
      default: "balanced",
    },
    budgetGuardEnabled: { type: Boolean, default: false },
    monthlyRequestLimit: { type: Number, default: 400 },
    monthlySearchLimit: { type: Number, default: 120 },
    monthlyCostUsdLimit: { type: Number, default: 5 },
  },
  { timestamps: true },
);

export const AiPreference = mongoose.model("AiPreference", aiPreferenceSchema);
