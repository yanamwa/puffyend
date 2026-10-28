import express from "express";

import authenticateUser from "../middleware/authMiddleware.js";
import { requireRole } from "../middleware/roleMiddleware.js";

import {
  getSystemSettings,
  updateSystemSettings,
} from "../controllers/systemSettingsController.js";

const router = express.Router();

/* =====================================================
   SYSTEM SETTINGS
   SUPER ADMIN ONLY
===================================================== */

/*
 * Get current system settings
 *
 * GET /api/system-settings
 */
router.get(
  "/",
  authenticateUser,
  requireRole("super_admin"),
  getSystemSettings,
);

/*
 * Update system settings
 *
 * PUT /api/system-settings
 */
router.put(
  "/",
  authenticateUser,
  requireRole("super_admin"),
  updateSystemSettings,
);

export default router;
