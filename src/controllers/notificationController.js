import { db } from "../db.js";


/* =====================================================
   HELPERS
===================================================== */

function cleanText(value) {
  return String(value || "").trim();
}


function normalizeRole(role = "") {
  const normalized = cleanText(role)
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  if (normalized === "superadmin") {
    return "super_admin";
  }

  if (normalized === "administrator") {
    return "admin";
  }

  if (normalized === "instructor") {
    return "professor";
  }

  if (normalized === "learner") {
    return "student";
  }

  return normalized;
}


function formatRoleLabel(role = "") {
  const normalizedRole =
    normalizeRole(role);

  if (normalizedRole === "super_admin") {
    return "Super admin";
  }

  if (normalizedRole === "admin") {
    return "Admin";
  }

  if (normalizedRole === "professor") {
    return "Professor";
  }

  if (normalizedRole === "student") {
    return "Student";
  }

  return "User";
}


function normalizeLabel(value = "") {
  return cleanText(value)
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}


function isEmailLike(value = "") {
  return /\S+@\S+/.test(
    cleanText(value)
  );
}


function getCreatorDisplayName(
  currentUser,
  tokenUser = {}
) {
  const roleLabel =
    formatRoleLabel(
      currentUser?.role ||
      tokenUser?.role
    );

  const candidates = [
    currentUser?.display_name,
    currentUser?.name,
    tokenUser?.displayName,
    tokenUser?.display_name,
    tokenUser?.name,
  ];

  for (const candidate of candidates) {
    const name = cleanText(candidate)
      .replace(/^@+/, "");

    if (
      name &&
      !isEmailLike(name) &&
      normalizeLabel(name) !==
        normalizeLabel(roleLabel)
    ) {
      return name;
    }
  }

  return roleLabel;
}


function normalizeTarget(target = "all") {
  const normalized = cleanText(target)
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  if (
    !normalized ||
    normalized === "everyone" ||
    normalized === "all_users"
  ) {
    return "all";
  }

  if (normalized === "users") {
    return "user";
  }

  if (normalized === "students") {
    return "student";
  }

  if (
    normalized === "professors" ||
    normalized === "instructors"
  ) {
    return "professor";
  }

  if (
    normalized === "admins" ||
    normalized === "administrators"
  ) {
    return "admin";
  }

  if (
    normalized === "superadmin" ||
    normalized === "super_admins"
  ) {
    return "super_admin";
  }

  return normalized;
}


function isNotificationManager(role) {
  return [
    "admin",
    "super_admin",
  ].includes(normalizeRole(role));
}


function targetMatchesRole(
  target,
  role
) {
  const normalizedTarget =
    normalizeTarget(target);

  const normalizedRole =
    normalizeRole(role);

  if (normalizedTarget === "all") {
    return true;
  }

  if (normalizedTarget === "user") {
    return [
      "student",
      "professor",
    ].includes(normalizedRole);
  }

  if (normalizedTarget === "admin") {
    return [
      "admin",
      "super_admin",
    ].includes(normalizedRole);
  }

  return (
    normalizedTarget ===
    normalizedRole
  );
}


/* =====================================================
   FORMAT MANAGED / ADMIN NOTIFICATION
===================================================== */

function rowToManagedNotification(row) {
  return {
    id: `managed-${row.notification_id}`,

    notificationId:
      row.notification_id,

    title:
      row.title,

    message:
      row.message,

    target:
      row.target,

    type:
      row.type || "announcement",

    isRead:
      false,

    is_read:
      false,

    source:
      "managed",

    createdByUserId:
      row.created_by_user_id,

    created_by_user_id:
      row.created_by_user_id,

    createdByName:
      row.created_by_name || "",

    created_by_name:
      row.created_by_name || "",

    createdByRole:
      row.created_by_role || "",

    created_by_role:
      row.created_by_role || "",

    createdAt:
      row.created_at,

    created_at:
      row.created_at,
  };
}


/* =====================================================
   FORMAT USER-SPECIFIC NOTIFICATION
===================================================== */

function rowToUserNotification(row) {
  return {
    id: String(
      row.notification_id
    ),

    notificationId:
      row.notification_id,

    recipientUserId:
      row.recipient_user_id,

    recipient_user_id:
      row.recipient_user_id,

    courseId:
      row.course_id,

    course_id:
      row.course_id,

    enrollmentId:
      row.enrollment_id,

    enrollment_id:
      row.enrollment_id,

    title:
      row.title,

    message:
      row.message,

    target:
      row.target,

    type:
      row.type ||
      "notification",

    isRead:
      Boolean(row.is_read),

    is_read:
      Boolean(row.is_read),

    readAt:
      row.read_at,

    read_at:
      row.read_at,

    source:
      "user",

    createdByUserId:
      row.created_by_user_id,

    created_by_user_id:
      row.created_by_user_id,

    createdByName:
      row.created_by_name || "",

    created_by_name:
      row.created_by_name || "",

    createdByRole:
      row.created_by_role || "",

    created_by_role:
      row.created_by_role || "",

    createdAt:
      row.created_at,

    created_at:
      row.created_at,
  };
}


/* =====================================================
   AUTHENTICATED USER
===================================================== */

async function getAuthenticatedUser(req) {
  const userId =
    req.user?.id ||
    req.user?.userId ||
    req.user?.user_id;

  const email =
    cleanText(
      req.user?.email
    ).toLowerCase();

  if (userId) {
    const [rows] =
      await db.execute(
        `SELECT
           userId,
           email,
           role,
           name,
           display_name
         FROM users
         WHERE userId = ?
         LIMIT 1`,
        [userId]
      );

    if (rows[0]) {
      return rows[0];
    }
  }

  if (email) {
    const [rows] =
      await db.execute(
        `SELECT
           userId,
           email,
           role,
           name,
           display_name
         FROM users
         WHERE email = ?
         LIMIT 1`,
        [email]
      );

    if (rows[0]) {
      return rows[0];
    }
  }

  return null;
}


/* =====================================================
   GET LATEST MANAGED NOTIFICATION
===================================================== */

async function getLatestNotification() {
  const [rows] =
    await db.execute(
      `SELECT
         notification_id,
         title,
         message,
         target,
         type,
         created_by_user_id,
         created_by_name,
         created_by_role,
         created_at
       FROM managed_notifications
       ORDER BY
         created_at DESC,
         notification_id DESC
       LIMIT 1`
    );

  return rows[0] || null;
}


/* =====================================================
   GET NOTIFICATIONS
===================================================== */

export async function getNotifications(
  req,
  res
) {
  try {
    const currentUser =
      await getAuthenticatedUser(req);

    if (!currentUser) {
      return res.status(401).json({
        success: false,
        message:
          "You are not authenticated.",
      });
    }

    const notifications = [];

    /*
     * ===============================================
     * ADMIN / GENERAL ANNOUNCEMENT
     * ===============================================
     */

    const latestNotification =
      await getLatestNotification();

    const isOwnAnnouncement =
        latestNotification &&
        Number(
          latestNotification.created_by_user_id
        ) === Number(currentUser.userId);

      if (
        latestNotification &&
        !isOwnAnnouncement &&
        (
          isNotificationManager(
            currentUser.role
          ) ||
          targetMatchesRole(
            latestNotification.target,
            currentUser.role
          )
        )
      ) {
        notifications.push(
          rowToManagedNotification(
            latestNotification
          )
        );
      }

    /*
     * ===============================================
     * USER-SPECIFIC NOTIFICATIONS
     *
     * Enrollment request
     * Approval
     * Decline
     * Unenrollment
     * ===============================================
     */

    const [userRows] =
      await db.execute(
        `SELECT
           notification_id,
           recipient_user_id,
           course_id,
           enrollment_id,
           title,
           message,
           target,
           type,
           is_read,
           read_at,
           created_by_user_id,
           created_by_name,
           created_by_role,
           created_at

         FROM notifications

         WHERE recipient_user_id = ?

         ORDER BY
           created_at DESC,
           notification_id DESC

         LIMIT 100`,
        [currentUser.userId]
      );

    for (
      const row of userRows
    ) {
      notifications.push(
        rowToUserNotification(row)
      );
    }

    /*
     * Sort everything together,
     * newest first.
     */

    notifications.sort(
      (a, b) =>
        new Date(b.createdAt) -
        new Date(a.createdAt)
    );

    /*
     * Only user-specific notifications
     * have a persistent read state.
     */

    const unreadCount =
      notifications.filter(
        (notification) =>
          notification.source ===
            "user" &&
          !notification.isRead
      ).length;

    return res.json({
      success: true,
      notifications,
      unreadCount,
    });
  } catch (error) {
    console.error(
      "Get notifications error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to fetch notifications.",
    });
  }
}


/* =====================================================
   GET UNREAD COUNT
===================================================== */

export async function getUnreadNotificationCount(
  req,
  res
) {
  try {
    const currentUser =
      await getAuthenticatedUser(req);

    if (!currentUser) {
      return res.status(401).json({
        success: false,
        message:
          "You are not authenticated.",
      });
    }

    const [rows] =
      await db.execute(
        `SELECT
           COUNT(*) AS unread_count
         FROM notifications
         WHERE recipient_user_id = ?
           AND is_read = 0`,
        [currentUser.userId]
      );

    return res.json({
      success: true,

      unreadCount:
        Number(
          rows[0]?.unread_count || 0
        ),
    });
  } catch (error) {
    console.error(
      "Get unread notification count error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to fetch unread notification count.",
    });
  }
}


/* =====================================================
   MARK ONE NOTIFICATION AS READ
===================================================== */

export async function markNotificationAsRead(
  req,
  res
) {
  try {
    const currentUser =
      await getAuthenticatedUser(req);

    if (!currentUser) {
      return res.status(401).json({
        success: false,
        message:
          "You are not authenticated.",
      });
    }

    const notificationId =
      Number(
        String(
          req.params.id ||
          req.params.notificationId ||
          ""
        ).replace(/^managed-/, "")
      );

    if (
      !Number.isFinite(
        notificationId
      ) ||
      notificationId <= 0
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Notification id is invalid.",
      });
    }

    const [result] =
      await db.execute(
        `UPDATE notifications
         SET
           is_read = 1,
           read_at = CURRENT_TIMESTAMP
         WHERE notification_id = ?
           AND recipient_user_id = ?`,
        [
          notificationId,
          currentUser.userId,
        ]
      );

    if (
      result.affectedRows === 0
    ) {
      return res.status(404).json({
        success: false,
        message:
          "Notification not found.",
      });
    }

    return res.json({
      success: true,
      message:
        "Notification marked as read.",
    });
  } catch (error) {
    console.error(
      "Mark notification as read error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to update notification.",
    });
  }
}


/* =====================================================
   MARK ALL USER NOTIFICATIONS AS READ
===================================================== */

export async function markAllNotificationsAsRead(
  req,
  res
) {
  try {
    const currentUser =
      await getAuthenticatedUser(req);

    if (!currentUser) {
      return res.status(401).json({
        success: false,
        message:
          "You are not authenticated.",
      });
    }

    await db.execute(
      `UPDATE notifications
       SET
         is_read = 1,
         read_at = CURRENT_TIMESTAMP
       WHERE recipient_user_id = ?
         AND is_read = 0`,
      [currentUser.userId]
    );

    return res.json({
      success: true,
      message:
        "All notifications marked as read.",
    });
  } catch (error) {
    console.error(
      "Mark all notifications as read error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to update notifications.",
    });
  }
}


/* =====================================================
   CREATE ADMIN / SUPER ADMIN ANNOUNCEMENT
===================================================== */

export async function createNotification(
  req,
  res
) {
  try {
    const currentUser =
      await getAuthenticatedUser(req);

    if (
      !currentUser ||
      !isNotificationManager(
        currentUser.role
      )
    ) {
      return res.status(403).json({
        success: false,
        message:
          "Only admins and super admins can create notifications.",
      });
    }

    const title =
      cleanText(req.body?.title);

    const message =
      cleanText(
        req.body?.message ||
        req.body?.body
      );

    const target =
      normalizeTarget(
        req.body?.target ||
        "all"
      );

    const createdByName =
      getCreatorDisplayName(
        currentUser,
        req.user
      );

    const createdByRole =
      normalizeRole(
        currentUser.role ||
        req.user?.role
      );

    if (!title || !message) {
      return res.status(400).json({
        success: false,
        message:
          "Title and message are required.",
      });
    }

    const connection =
      await db.getConnection();

    try {
      await connection.beginTransaction();

      const [result] =
        await connection.execute(
          `INSERT INTO managed_notifications
           (
             title,
             message,
             target,
             type,
             created_by_user_id,
             created_by_name,
             created_by_role
           )
           VALUES (
             ?,
             ?,
             ?,
             'announcement',
             ?,
             ?,
             ?
           )`,
          [
            title,
            message,
            target,
            currentUser.userId ||
              null,
            createdByName,
            createdByRole,
          ]
        );

      /*
       * Keep only the latest managed
       * announcement, preserving your
       * current behavior.
       */
      await connection.execute(
        `DELETE
         FROM managed_notifications
         WHERE notification_id <> ?`,
        [result.insertId]
      );

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    const latestNotification =
      await getLatestNotification();

    const notification =
      rowToManagedNotification(
        latestNotification
      );

    return res.status(201).json({
      success: true,
      message:
        "Notification posted.",
      notification,
      notifications: [
        notification,
      ],
    });
  } catch (error) {
    console.error(
      "Create notification error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to create notification.",
    });
  }
}


/* =====================================================
   DELETE MANAGED NOTIFICATION
===================================================== */

export async function deleteNotification(
  req,
  res
) {
  try {
    const currentUser =
      await getAuthenticatedUser(req);

    if (
      !currentUser ||
      !isNotificationManager(
        currentUser.role
      )
    ) {
      return res.status(403).json({
        success: false,
        message:
          "Only admins and super admins can delete notifications.",
      });
    }

    const notificationId =
      Number(
        String(
          req.params.id || ""
        ).replace(
          /^managed-/,
          ""
        )
      );

    if (
      !Number.isFinite(
        notificationId
      ) ||
      notificationId <= 0
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Notification id is invalid.",
      });
    }

    await db.execute(
      `DELETE
       FROM managed_notifications
       WHERE notification_id = ?`,
      [notificationId]
    );

    return res.json({
      success: true,
      message:
        "Notification deleted.",
      notifications: [],
    });
  } catch (error) {
    console.error(
      "Delete notification error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to delete notification.",
    });
  }
}