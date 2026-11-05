import express from "express";
import path from "node:path";
import authenticateUser from "../middleware/authMiddleware.js";
import { requireRole } from "../middleware/roleMiddleware.js";

export function mountUploads(app, directory) {
  app.use(
    ["/uploads/profile-images", "/api/uploads/profile-images"],
    express.static(path.join(directory, "profile-images"), {
      dotfiles: "deny",
      index: false,
    }),
  );
  app.get(
    [
      "/uploads/professor-ids/:filename",
      "/api/uploads/professor-ids/:filename",
    ],
    authenticateUser,
    requireRole("super_admin", "admin"),
    (req, res, next) => {
      res.set("Cache-Control", "private, no-store");
      res.sendFile(
        req.params.filename,
        { root: path.join(directory, "professor-ids"), dotfiles: "deny" },
        (error) => {
          if (error) next(error);
        },
      );
    },
  );
  app.use(["/uploads", "/api/uploads"], (_req, res) => res.sendStatus(404));
}
