import express from "express";

import authenticateUser from "../middleware/authMiddleware.js";
import { requireRole } from "../middleware/roleMiddleware.js";

import {
  createDatabaseBackup,
  restoreDatabaseBackup,
} from "../controllers/backupController.js";

const router = express.Router();

/* =====================================================
   BACKUP & RESTORE
   SUPER ADMIN ONLY
===================================================== */

/*
 * Download database backup
 *
 * GET /api/backup
 */
router.get(
  "/",
  authenticateUser,
  requireRole("super_admin"),
  createDatabaseBackup,
);

/*
 * Restore database backup
 *
 * POST /api/backup/restore
 */
router.post(
  "/restore",
  authenticateUser,
  requireRole("super_admin"),
  restoreDatabaseBackup,
);

export default router;
