import mongoose from "mongoose";

let uploadsBucket = null;

export const getUploadsBucket = () => {
  if (uploadsBucket) {
    return uploadsBucket;
  }

  const db = mongoose.connection?.db;
  if (!db) {
    throw new Error("MongoDB connection is not ready");
  }

  uploadsBucket = new mongoose.mongo.GridFSBucket(db, {
    bucketName: "uploads",
  });
  return uploadsBucket;
};
