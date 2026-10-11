import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import multer from "multer";

const uploadDirectory = path.resolve("src/uploads/professor-ids");

if (!fs.existsSync(uploadDirectory)) {
  fs.mkdirSync(uploadDirectory, {
    recursive: true,
  });
}

const allowedExtensions = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const allowedMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

const storage = multer.diskStorage({
  destination(req, file, callback) {
    callback(null, uploadDirectory);
  },

  filename(req, file, callback) {
    const extension = path.extname(file.originalname).toLowerCase();

    callback(null, `${Date.now()}-${crypto.randomUUID()}${extension}`);
  },
});

const professorProofUpload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 1,
  },

  fileFilter(req, file, callback) {
    const extension = path.extname(file.originalname).toLowerCase();
    const validExtension = allowedExtensions.has(extension);
    const validMimeType = allowedMimeTypes.has(file.mimetype);

    if (!validExtension || !validMimeType) {
      const error = new Error("Please upload a JPG, PNG, or WEBP image.");
      error.statusCode = 400;
      callback(error);
      return;
    }

    callback(null, true);
  },
});

export default professorProofUpload;
