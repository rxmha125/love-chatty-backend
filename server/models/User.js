import mongoose from "mongoose";

const pushSubscriptionSchema = new mongoose.Schema(
  {
    endpoint: { type: String, required: true },
    expirationTime: { type: Number, default: null },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true },
    },
    userAgent: { type: String, default: "" },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const socialLinksSchema = new mongoose.Schema(
  {
    x: { type: String, default: "" },
    instagram: { type: String, default: "" },
    facebook: { type: String, default: "" },
    linkedin: { type: String, default: "" },
    github: { type: String, default: "" },
    youtube: { type: String, default: "" },
  },
  { _id: false },
);

const userSchema = new mongoose.Schema(
  {
    uuid: { type: String, required: true, unique: true, index: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    firstName: { type: String, default: "" },
    lastName: { type: String, default: "" },
    profilePictureUrl: { type: String, default: null },
    profileBio: { type: String, default: "" },
    profileWebsiteUrl: { type: String, default: "" },
    profileSocialLinks: { type: socialLinksSchema, default: () => ({}) },
    emailVerifiedAt: { type: Date, default: null },
    createdAtExternal: { type: Date, default: null },
    lastSeen: { type: Date, default: null },
    pushSubscriptions: { type: [pushSubscriptionSchema], default: [] },
  },
  {
    timestamps: true,
  },
);

export const User = mongoose.model("User", userSchema);