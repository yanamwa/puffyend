import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/* =========================================
   CURRENT FILE LOCATION
========================================= */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/*
  This file is expected here:

  server/
    middleware/
      profileImageUpload.js

  Therefore ../uploads/profile-images becomes:

  server/uploads/profile-images
*/

const uploadDirectory = path.resolve(
  __dirname,
  "..",
  "uploads",
  "profile-images",
);

/* =========================================
   CREATE UPLOAD DIRECTORY
========================================= */

if (!fs.existsSync(uploadDirectory)) {
  fs.mkdirSync(uploadDirectory, {
    recursive: true,
  });
}

console.log("Profile image upload directory:", uploadDirectory);

/* =========================================
   MULTER STORAGE
========================================= */

const storage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, uploadDirectory);
  },

  filename(req, file, cb) {
    /*
      Get authenticated user ID.
    */

    const userId =
      req.user?.id || req.user?.userId || req.user?.user_id || "user";

    /*
      Determine safe extension.
    */

    let extension = path.extname(file.originalname).toLowerCase();

    /*
      If browser doesn't provide a useful
      extension, determine it from MIME type.
    */

    if (!extension) {
      switch (file.mimetype) {
        case "image/jpeg":
        case "image/jpg":
          extension = ".jpg";
          break;

        case "image/png":
          extension = ".png";
          break;

        case "image/webp":
          extension = ".webp";
          break;

        default:
          extension = ".jpg";
      }
    }

    /*
      Generate unique filename.
    */

    const filename = `profile-${userId}-${Date.now()}${extension}`;

    cb(null, filename);
  },
});

/* =========================================
   IMAGE VALIDATION
========================================= */

const fileFilter = (req, file, cb) => {
  const allowedMimeTypes = [
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
  ];

  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
    return;
  }

  const error = new Error("Only JPG, JPEG, PNG, and WEBP images are allowed.");

  error.statusCode = 400;

  cb(error);
};

/* =========================================
   MULTER CONFIGURATION
========================================= */

const uploadProfileImage = multer({
  storage,

  fileFilter,

  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

export default uploadProfileImage;
