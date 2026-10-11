import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import multer from "multer";
import { fileURLToPath } from "node:url";

const uploadDirectory = fileURLToPath(
  new URL("../uploads/lessons/", import.meta.url),
);

if (!fs.existsSync(uploadDirectory)) {
  fs.mkdirSync(uploadDirectory, {
    recursive: true,
  });
}

const allowedExtensions = new Set([".pdf", ".docx", ".txt", ".ppt", ".pptx"]);

const allowedMimeTypes = new Set([
  "application/pdf",
  "text/plain",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",

  "application/octet-stream",
  "application/vnd.ms-powerpoint",
  "application/mspowerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

const storage = multer.diskStorage({
  destination(req, file, callback) {
    callback(null, uploadDirectory);
  },

  filename(req, file, callback) {
    const extension = path.extname(file.originalname).toLowerCase();

    const generatedName = [Date.now(), crypto.randomUUID()].join("-");

    callback(null, `${generatedName}${extension}`);
  },
});

const upload = multer({
  storage,

  limits: {
    fileSize: 25 * 1024 * 1024,
    files: 10,
  },

  fileFilter(req, file, callback) {
    const extension = path.extname(file.originalname).toLowerCase();

    const validExtension = allowedExtensions.has(extension);
    const validMimeType = allowedMimeTypes.has(file.mimetype);

    if (!validExtension || !validMimeType) {
      const error = new Error(
        "Only PDF, PPT, PPTX, DOCX, and TXT files are allowed.",
      );

      error.statusCode = 400;

      callback(error);
      return;
    }

    callback(null, true);
  },
});

export default upload;
