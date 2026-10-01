import express from "express";

import authenticateUser from "../middleware/authMiddleware.js";

import {
  getNotifications,
  getUnreadNotificationCount,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  createNotification,
  deleteNotification,
} from "../controllers/notificationController.js";

const router = express.Router();


/* =====================================================
   ALL NOTIFICATION ROUTES REQUIRE LOGIN
===================================================== */

router.use(authenticateUser);


/* =====================================================
   GET NOTIFICATIONS
===================================================== */

router.get(
  "/",
  getNotifications
);


/* =====================================================
   GET UNREAD COUNT
===================================================== */

router.get(
  "/unread-count",
  getUnreadNotificationCount
);


/* =====================================================
   MARK ALL AS READ
===================================================== */

router.patch(
  "/read-all",
  markAllNotificationsAsRead
);


/* =====================================================
   MARK ONE AS READ
===================================================== */

router.patch(
  "/:notificationId/read",
  markNotificationAsRead
);


/* =====================================================
   CREATE ADMIN / SUPER ADMIN ANNOUNCEMENT
===================================================== */

router.post(
  "/",
  createNotification
);


/* =====================================================
   DELETE MANAGED NOTIFICATION
===================================================== */

router.delete(
  "/:id",
  deleteNotification
);


export default router;