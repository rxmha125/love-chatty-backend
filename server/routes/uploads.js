import path from "path";
import multer from "multer";
import mongoose from "mongoose";
import { Router } from "express";
import { requireAuth } from "../middleware/require-auth.js";
import { config } from "../config.js";
import { getUploadsBucket } from "../storage/gridfs.js";

const storage = multer.memoryStorage();

const allowedUploadMimeTypes = new Set(
  Array.isArray(config.uploadAllowedMimeTypes) ? config.uploadAllowedMimeTypes.map((value) => String(value).trim().toLowerCase()) : [],
);

class UploadValidationError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "UploadValidationError";
    this.statusCode = statusCode;
  }
}

const validateUploadFile = (file) => {
  const mime = String(file?.mimetype || "").trim().toLowerCase();
  if (!mime) {
    throw new UploadValidationError("File MIME type is missing");
  }

  if (allowedUploadMimeTypes.size > 0 && !allowedUploadMimeTypes.has(mime)) {
    throw new UploadValidationError("Unsupported file type");
  }

  const originalName = String(file?.originalname || "").trim();
  if (!originalName) {
    throw new UploadValidationError("File name is required");
  }

  if (originalName.length > 180) {
    throw new UploadValidationError("File name is too long");
  }
};

const runSingleUpload = (req, res) =>
  new Promise((resolve, reject) => {
    upload.single("file")(req, res, (error) => {
      if (!error) {
        resolve();
        return;
      }
      reject(error);
    });
  });

const upload = multer({
  storage,
  limits: {
    fileSize: config.uploadMaxBytes,
    files: 1,
  },
  fileFilter: (_req, file, callback) => {
    try {
      validateUploadFile(file);
      callback(null, true);
    } catch (error) {
      callback(error);
    }
  },
});

const router = Router();

const detectFileType = (mime = "") =>
  mime.startsWith("image/")
    ? "image"
    : mime.startsWith("video/")
      ? "video"
      : mime.startsWith("audio/")
        ? "audio"
        : "file";

const extensionFromMime = (mime = "") => {
  if (mime === "image/png") {
    return ".png";
  }
  if (mime === "image/jpeg") {
    return ".jpg";
  }
  if (mime === "image/webp") {
    return ".webp";
  }
  if (mime === "image/gif") {
    return ".gif";
  }
  if (mime === "video/mp4") {
    return ".mp4";
  }
  if (mime === "video/webm") {
    return ".webm";
  }
  if (mime === "audio/webm") {
    return ".webm";
  }
  if (mime === "audio/mp4" || mime === "audio/m4a") {
    return ".m4a";
  }
  if (mime === "audio/mpeg") {
    return ".mp3";
  }
  return "";
};

const sanitizeBaseName = (value = "") => {
  const stripped = value.replace(/[^a-zA-Z0-9_-]+/g, "-");
  const normalized = stripped.replace(/-+/g, "-").replace(/^-|-$/g, "");
  return normalized || "file";
};

const buildStoredFileName = (file, ownerUuid) => {
  const originalName = file?.originalname || "";
  const originalExt = path.extname(originalName || "").toLowerCase();
  const fallbackExt = extensionFromMime(file?.mimetype || "");
  const extension = originalExt || fallbackExt || "";
  const baseName = sanitizeBaseName(path.basename(originalName || "upload", originalExt || ""));
  return `${ownerUuid}-${Date.now()}-${Math.round(Math.random() * 1e9)}-${baseName}${extension}`;
};

router.post("/", requireAuth, async (req, res) => {
  try {
    await runSingleUpload(req, res);
  } catch (error) {
    if (error instanceof multer.MulterError) {
      if (error.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({
          success: false,
          message: `File is too large. Max allowed is ${Math.floor(config.uploadMaxBytes / (1024 * 1024))}MB`,
        });
      }

      return res.status(400).json({
        success: false,
        message: error.message || "Invalid upload request",
      });
    }

    if (error instanceof UploadValidationError) {
      return res.status(error.statusCode || 400).json({
        success: false,
        message: error.message,
      });
    }

    return res.status(400).json({
      success: false,
      message: error instanceof Error ? error.message : "Upload failed",
    });
  }

  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: "No file uploaded",
    });
  }

  if (!req.file.buffer || req.file.buffer.length === 0) {
    return res.status(400).json({
      success: false,
      message: "Uploaded file is empty",
    });
  }

  const mime = req.file.mimetype || "application/octet-stream";
  const fileType = detectFileType(mime);
  const ownerUuid = req.auth.userUuid;
  const bucket = getUploadsBucket();
  const fileName = buildStoredFileName(req.file, ownerUuid);

  const uploadStream = bucket.openUploadStream(fileName, {
    contentType: mime,
    metadata: {
      ownerUuid,
      originalName: req.file.originalname || null,
      fileType,
      mimeType: mime,
      uploadedAt: new Date(),
    },
  });

  await new Promise((resolve, reject) => {
    uploadStream.on("finish", resolve);
    uploadStream.on("error", reject);
    uploadStream.end(req.file.buffer);
  });

  const fileId = String(uploadStream.id);
  const relativeUrl = `/api/uploads/${fileId}`;

  return res.status(201).json({
    success: true,
    file_id: fileId,
    file_url: relativeUrl,
    file_type: fileType,
  });
});

router.get("/:fileId", async (req, res) => {
  const fileId = String(req.params.fileId || "").trim();
  if (!mongoose.Types.ObjectId.isValid(fileId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid file id",
    });
  }

  const objectId = new mongoose.Types.ObjectId(fileId);
  const bucket = getUploadsBucket();
  const files = await bucket.find({ _id: objectId }).limit(1).toArray();
  const file = files[0];

  if (!file) {
    return res.status(404).json({
      success: false,
      message: "File not found",
    });
  }

  const mimeType =
    file.contentType ||
    (typeof file.metadata?.mimeType === "string" ? file.metadata.mimeType : "") ||
    "application/octet-stream";
  const safeFileName = String(file.filename || `${fileId}`).replace(/[\r\n"]/g, "");

  res.setHeader("Content-Type", mimeType);
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.setHeader("Content-Disposition", `inline; filename="${safeFileName}"`);

  const stream = bucket.openDownloadStream(objectId);
  stream.on("error", () => {
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: "Failed to read file",
      });
    } else {
      res.end();
    }
  });
  stream.pipe(res);
});

export default router;
