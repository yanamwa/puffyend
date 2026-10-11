import express from "express";

import authenticateUser from "../middleware/authMiddleware.js";
import { requireRole } from "../middleware/roleMiddleware.js";

import { getSystemAnalytics } from "../controllers/systemAnalyticsController.js";

const router = express.Router();

/* =====================================================
   SYSTEM ANALYTICS
===================================================== */

/*
 * Super Admin system-wide analytics
 *
 * GET /api/analytics/system
 */
router.get(
  "/system",
  authenticateUser,
  requireRole("super_admin"),
  getSystemAnalytics,
);

export default router;
