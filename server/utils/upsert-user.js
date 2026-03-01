import { User } from "../models/User.js";

const LOCAL_PROFILE_UPLOAD_URL_REGEX = /^\/api\/uploads\/[a-f0-9]{24}(?:\?.*)?$/i;

const isLocalUploadedProfilePicture = (value) =>
  LOCAL_PROFILE_UPLOAD_URL_REGEX.test(String(value || "").trim());

const parseDate = (value) => {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

export const upsertUserFromAuth = async (payloadUser) => {
  const existingUser = await User.findOne({ uuid: payloadUser.uuid });
  const incomingProfilePictureUrl = payloadUser.profile_picture_url || null;

  const shouldPreserveCustomUploadedProfilePicture =
    Boolean(existingUser?.profilePictureUrl) &&
    isLocalUploadedProfilePicture(existingUser.profilePictureUrl) &&
    String(existingUser.profilePictureUrl || "").trim() !== String(incomingProfilePictureUrl || "").trim();

  const resolvedProfilePictureUrl = shouldPreserveCustomUploadedProfilePicture
    ? existingUser.profilePictureUrl
    : incomingProfilePictureUrl;

  const update = {
    email: (payloadUser.email || "").toLowerCase(),
    firstName: payloadUser.first_name || "",
    lastName: payloadUser.last_name || "",
    profilePictureUrl: resolvedProfilePictureUrl,
    emailVerifiedAt: parseDate(payloadUser.email_verified_at),
    createdAtExternal: parseDate(payloadUser.created_at),
    lastSeen: new Date(),
  };

  const user = await User.findOneAndUpdate(
    { uuid: payloadUser.uuid },
    { $set: update },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  return user;
};

