import mongoose from "mongoose";

const groupSchema = new mongoose.Schema(
  {
    uuid: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    profilePictureUrl: { type: String, default: null },
    createdByUuid: { type: String, required: true, index: true },
    memberUuids: { type: [String], default: [], index: true },
  },
  {
    timestamps: true,
  },
);

groupSchema.index({ memberUuids: 1, updatedAt: -1 });

export const Group = mongoose.model("Group", groupSchema);