import express from "express";

import authenticateUser from "../middleware/authMiddleware.js";
import { requireRole } from "../middleware/roleMiddleware.js";

import {
  getPublicSystemStatus,
  getSystemSettings,
  updateSystemSettings,
} from "../controllers/systemSettingsController.js";

const router = express.Router();
router.get("/status", getPublicSystemStatus);
router.get(
  "/",
  authenticateUser,
  requireRole("super_admin"),
  getSystemSettings,
);

router.put(
  "/",
  authenticateUser,
  requireRole("super_admin"),
  updateSystemSettings,
);

export default router;
