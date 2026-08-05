import fs from "node:fs";
import path from "node:path";
import multer from "multer";

const uploadDirectory = path.join(
  process.cwd(),
  "uploads",
  "profile-images"
);

if (!fs.existsSync(uploadDirectory)) {
  fs.mkdirSync(uploadDirectory, {
    recursive: true,
  });
}

const allowedMimeTypes = [
  "image/jpeg",
  "image/png",
  "image/webp",
];

const storage = multer.diskStorage({
  destination(req, file, callback) {
    callback(null, uploadDirectory);
  },

  filename(req, file, callback) {
    const userId =
      req.user?.id ||
      req.user?.userId ||
      req.user?.user_id ||
      "user";

    const extension = path
      .extname(file.originalname)
      .toLowerCase();

    const filename =
      `profile-${userId}-${Date.now()}${extension}`;

    callback(null, filename);
  },
});

const uploadProfileImage = multer({
  storage,

  limits: {
    fileSize: 5 * 1024 * 1024,
  },

  fileFilter(req, file, callback) {
    if (!allowedMimeTypes.includes(file.mimetype)) {
      return callback(
        new Error(
          "Only JPG, PNG, and WEBP images are allowed."
        )
      );
    }

    callback(null, true);
  },
});

export default uploadProfileImage;