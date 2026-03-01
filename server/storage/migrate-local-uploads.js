import fs from "fs/promises";
import path from "path";
import { User } from "../models/User.js";
import { Message } from "../models/Message.js";
import { config } from "../config.js";
import { getUploadsBucket } from "./gridfs.js";

const LOCAL_UPLOAD_PREFIX = "/uploads/";

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
};

const detectMimeType = (filename = "") => {
  const extension = path.extname(filename || "").toLowerCase();
  return MIME_BY_EXT[extension] || "application/octet-stream";
};

const detectFileType = (mime = "") =>
  mime.startsWith("image/")
    ? "image"
    : mime.startsWith("video/")
      ? "video"
      : mime.startsWith("audio/")
        ? "audio"
        : "file";

const extractLocalFileName = (fileUrl = "") => {
  const normalized = String(fileUrl || "").trim();
  if (!normalized.startsWith(LOCAL_UPLOAD_PREFIX)) {
    return "";
  }
  const withoutPrefix = normalized.slice(LOCAL_UPLOAD_PREFIX.length);
  const clean = withoutPrefix.split("?")[0].split("#")[0];
  return path.basename(clean);
};

const uploadLocalFileToGridFs = async (fileName, ownerUuid, cacheMap) => {
  if (cacheMap.has(fileName)) {
    return cacheMap.get(fileName);
  }

  const absolutePath = path.resolve(config.uploadsDir, fileName);
  const fileBuffer = await fs.readFile(absolutePath);
  const mimeType = detectMimeType(fileName);
  const fileType = detectFileType(mimeType);
  const bucket = getUploadsBucket();

  const uploadStream = bucket.openUploadStream(
    `${ownerUuid || "user"}-${Date.now()}-${fileName}`,
    {
      contentType: mimeType,
      metadata: {
        ownerUuid: ownerUuid || null,
        originalName: fileName,
        fileType,
        mimeType,
        migratedFromLocalUploads: true,
        migratedAt: new Date(),
      },
    },
  );

  await new Promise((resolve, reject) => {
    uploadStream.on("finish", resolve);
    uploadStream.on("error", reject);
    uploadStream.end(fileBuffer);
  });

  const newUrl = `/api/uploads/${String(uploadStream.id)}`;
  cacheMap.set(fileName, newUrl);
  return newUrl;
};

export const migrateLocalUploadsToMongo = async () => {
  const migratedCache = new Map();
  let userUpdated = 0;
  let messageUpdated = 0;
  let skippedMissing = 0;

  const users = await User.find({
    profilePictureUrl: { $regex: "^/uploads/" },
  });

  for (const user of users) {
    const currentUrl = String(user.profilePictureUrl || "");
    const fileName = extractLocalFileName(currentUrl);
    if (!fileName) {
      continue;
    }

    try {
      const nextUrl = await uploadLocalFileToGridFs(fileName, user.uuid, migratedCache);
      if (nextUrl && nextUrl !== currentUrl) {
        user.profilePictureUrl = nextUrl;
        await user.save();
        userUpdated += 1;
      }
    } catch {
      skippedMissing += 1;
    }
  }

  const messages = await Message.find({
    fileUrl: { $regex: "^/uploads/" },
  });

  for (const message of messages) {
    const currentUrl = String(message.fileUrl || "");
    const fileName = extractLocalFileName(currentUrl);
    if (!fileName) {
      continue;
    }

    try {
      const nextUrl = await uploadLocalFileToGridFs(fileName, message.senderUuid, migratedCache);
      if (nextUrl && nextUrl !== currentUrl) {
        message.fileUrl = nextUrl;
        await message.save();
        messageUpdated += 1;
      }
    } catch {
      skippedMissing += 1;
    }
  }

  return {
    userUpdated,
    messageUpdated,
    skippedMissing,
    filesUploaded: migratedCache.size,
  };
};
