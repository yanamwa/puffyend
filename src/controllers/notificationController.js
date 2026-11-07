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
  const normalizedRole = normalizeRole(role);

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
  return /\S+@\S+/.test(cleanText(value));
}

function getCreatorDisplayName(currentUser, tokenUser = {}) {
  const roleLabel = formatRoleLabel(currentUser?.role || tokenUser?.role);

  const candidates = [
    currentUser?.display_name,
    currentUser?.name,
    tokenUser?.displayName,
    tokenUser?.display_name,
    tokenUser?.name,
  ];

  for (const candidate of candidates) {
    const name = cleanText(candidate).replace(/^@+/, "");

    if (
      name &&
      !isEmailLike(name) &&
      normalizeLabel(name) !== normalizeLabel(roleLabel)
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

  if (!normalized || normalized === "everyone" || normalized === "all_users") {
    return "all";
  }

  if (normalized === "users") {
    return "user";
  }

  if (normalized === "students") {
    return "student";
  }

  if (normalized === "professors" || normalized === "instructors") {
    return "professor";
  }

  if (normalized === "admins" || normalized === "administrators") {
    return "admin";
  }

  if (normalized === "superadmin" || normalized === "super_admins") {
    return "super_admin";
  }

  return normalized;
}

function isNotificationManager(role) {
  return ["admin", "super_admin"].includes(normalizeRole(role));
}

function targetMatchesRole(target, role) {
  const normalizedTarget = normalizeTarget(target);

  const normalizedRole = normalizeRole(role);

  if (normalizedTarget === "all") {
    return true;
  }

  if (normalizedTarget === "user") {
    return ["student", "professor"].includes(normalizedRole);
  }

  if (normalizedTarget === "admin") {
    return ["admin", "super_admin"].includes(normalizedRole);
  }

  return normalizedTarget === normalizedRole;
}

/* =====================================================
   FORMAT MANAGED / ADMIN NOTIFICATION
===================================================== */

function rowToManagedNotification(row) {
  return {
    id: `managed-${row.notification_id}`,

    notificationId: row.notification_id,

    title: row.title,

    message: row.message,

    target: row.target,

    type: row.type || "announcement",

    isRead: false,

    is_read: false,

    source: "managed",

    createdByUserId: row.created_by_user_id,

    created_by_user_id: row.created_by_user_id,

    createdByName: row.created_by_name || "",

    created_by_name: row.created_by_name || "",

    createdByRole: row.created_by_role || "",

    created_by_role: row.created_by_role || "",

    createdAt: row.created_at,

    created_at: row.created_at,
  };
}

/* =====================================================
   FORMAT USER-SPECIFIC NOTIFICATION
===================================================== */

function rowToUserNotification(row) {
  return {
    id: String(row.notification_id),

    notificationId: row.notification_id,

    recipientUserId: row.recipient_user_id,

    recipient_user_id: row.recipient_user_id,

    courseId: row.course_id,

    course_id: row.course_id,

    enrollmentId: row.enrollment_id,

    enrollment_id: row.enrollment_id,

    title: row.title,

    message: row.message,

    target: row.target,

    type: row.type || "notification",

    isRead: Boolean(row.is_read),

    is_read: Boolean(row.is_read),

    readAt: row.read_at,

    read_at: row.read_at,

    source: "user",

    createdByUserId: row.created_by_user_id,

    created_by_user_id: row.created_by_user_id,

    createdByName: row.created_by_name || "",

    created_by_name: row.created_by_name || "",

    createdByRole: row.created_by_role || "",

    created_by_role: row.created_by_role || "",

    createdAt: row.created_at,

    created_at: row.created_at,
  };
}

/* =====================================================
   AUTHENTICATED USER
===================================================== */

async function getAuthenticatedUser(req) {
  const userId = req.user?.id || req.user?.userId || req.user?.user_id;

  const email = cleanText(req.user?.email).toLowerCase();

  if (userId) {
    const [rows] = await db.execute(
      `SELECT
           userId,
           email,
           role,
           name,
           display_name
         FROM users
         WHERE userId = ?
         LIMIT 1`,
      [userId],
    );

    if (rows[0]) {
      return rows[0];
    }
  }

  if (email) {
    const [rows] = await db.execute(
      `SELECT
           userId,
           email,
           role,
           name,
           display_name
         FROM users
         WHERE email = ?
         LIMIT 1`,
      [email],
    );

    if (rows[0]) {
      return rows[0];
    }
  }

  return null;
}

/* =====================================================
   GET MANAGED NOTIFICATIONS
===================================================== */

async function getManagedNotifications() {
  const [rows] = await db.execute(
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
     LIMIT 100`,
  );

  return rows;
}


export async function getPostedNotifications(req, res) {
  try {
    const currentUser = await getAuthenticatedUser(req);

    if (!currentUser || !isNotificationManager(currentUser.role)) {
      return res.status(403).json({
        success: false,
        message: "Access denied.",
      });
    }

    const [rows] = await db.execute(`
      SELECT
        notification_id,
        title,
        message,
        target,
        type,
        created_by_user_id,
        created_by_name,
        created_by_role,
        created_at
      FROM notifications
      WHERE recipient_user_id IS NULL
        AND type = 'announcement'
      ORDER BY created_at DESC, notification_id DESC
    `);

    const notifications = rows.map((row) => ({
      id: `managed-${row.notification_id}`,
      notificationId: row.notification_id,
      title: row.title,
      message: row.message,
      target: normalizeTarget(row.target),
      type: row.type,
      createdByUserId: row.created_by_user_id,
      createdByName: row.created_by_name || "",
      createdByRole: normalizeRole(row.created_by_role),
      createdAt: row.created_at,
      source: "managed",
    }));

    return res.json({
      success: true,
      notifications,
      total: notifications.length,
    });
  } catch (error) {
    console.error("Get posted notifications error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch posted notifications.",
    });
  }
}

/* =====================================================
   GET NOTIFICATIONS
===================================================== */

export async function getNotifications(req, res) {
  try {
    const currentUser = await getAuthenticatedUser(req);

    if (!currentUser) {
      return res.status(401).json({
        success: false,
        message: "You are not authenticated.",
      });
    }

    const userId = Number(currentUser.userId);
    const role = normalizeRole(currentUser.role);

    /*
     * A notification is visible when:
     *
     * 1. It was sent directly to this user
     * OR
     * 2. It is a broadcast announcement whose target
     *    matches this user's role.
     */

    const [rows] = await db.execute(
      `
      SELECT
        n.notification_id,
        n.recipient_user_id,
        n.course_id,
        n.enrollment_id,
        n.title,
        n.message,
        n.target,
        n.type,
        n.is_read,
        n.read_at,
        n.created_by_user_id,
        n.created_by_name,
        n.created_by_role,
        n.created_at,

        nr.notification_id AS broadcast_read_id,
        nr.read_at AS broadcast_read_at

      FROM notifications n

      LEFT JOIN notification_reads nr
        ON nr.notification_id = n.notification_id
       AND nr.user_id = ?

      WHERE
          n.recipient_user_id = ?

        OR (
            n.recipient_user_id IS NULL

            AND (
              n.created_by_user_id IS NULL
              OR n.created_by_user_id <> ?
            )

            AND (
              n.target = 'all'

              OR (
                n.target = 'user'
                AND ? IN ('student', 'professor')
              )

              OR (
                n.target = 'admin'
                AND ? IN ('admin', 'super_admin')
              )

              OR n.target = ?
            )
          )
      ORDER BY
        n.created_at DESC,
        n.notification_id DESC

      LIMIT 100
      `,
      [userId, userId, userId, role, role, role],
    );

    const notifications = rows.map((row) => {
      /*
       * Direct notification:
       * use notifications.is_read
       *
       * Broadcast notification:
       * use notification_reads
       */
      const isBroadcast = row.recipient_user_id === null;

      const isRead = isBroadcast
        ? Boolean(row.broadcast_read_id)
        : Boolean(Number(row.is_read));

      return {
        id: String(row.notification_id),

        notificationId: row.notification_id,

        notification_id: row.notification_id,

        recipientUserId: row.recipient_user_id,

        recipient_user_id: row.recipient_user_id,

        courseId: row.course_id,

        course_id: row.course_id,

        enrollmentId: row.enrollment_id,

        enrollment_id: row.enrollment_id,

        title: row.title || "Notification",

        message: row.message || "",

        target: normalizeTarget(row.target || "all"),

        type: cleanText(row.type) || "announcement",

        isRead,

        is_read: isRead,

        unread: !isRead,

        readAt: isBroadcast ? row.broadcast_read_at : row.read_at,

        read_at: isBroadcast ? row.broadcast_read_at : row.read_at,

        createdByUserId: row.created_by_user_id,

        created_by_user_id: row.created_by_user_id,

        createdByName: row.created_by_name || "",

        created_by_name: row.created_by_name || "",

        createdByRole: normalizeRole(row.created_by_role),

        created_by_role: normalizeRole(row.created_by_role),

        createdAt: row.created_at,

        created_at: row.created_at,

        source: isBroadcast ? "managed" : "user",

        icon: row.type === "announcement" ? "announcement" : "course",
      };
    });

    const unreadCount = notifications.filter(
      (notification) => !notification.isRead,
    ).length;

    return res.json({
      success: true,
      notifications,
      unreadCount,
    });
  } catch (error) {
    console.error("Get notifications error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch notifications.",
    });
  }
}

/* =====================================================
   GET UNREAD NOTIFICATION COUNT
===================================================== */

export async function getUnreadNotificationCount(req, res) {
  try {
    const currentUser = await getAuthenticatedUser(req);

    if (!currentUser) {
      return res.status(401).json({
        success: false,
        message: "You are not authenticated.",
      });
    }

    const userId = Number(currentUser.userId);

    const role = normalizeRole(currentUser.role);

    const [rows] = await db.execute(
      `
      SELECT COUNT(*) AS unreadCount

      FROM notifications n

      LEFT JOIN notification_reads nr
        ON nr.notification_id =
           n.notification_id
       AND nr.user_id = ?

      WHERE
        (
          n.recipient_user_id = ?

          AND n.is_read = 0
        )

        OR (
          n.recipient_user_id IS NULL

          AND nr.notification_id
              IS NULL

          AND (
            n.target = 'all'

            OR (
              n.target = 'user'
              AND ? IN (
                'student',
                'professor'
              )
            )

            OR (
              n.target = 'admin'
              AND ? IN (
                'admin',
                'super_admin'
              )
            )

            OR n.target = ?
          )
        )
      `,
      [userId, userId, role, role, role],
    );

    const unreadCount = Number(rows[0]?.unreadCount || 0);

    return res.json({
      success: true,
      unreadCount,
    });
  } catch (error) {
    console.error("Get unread notification count error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch unread notification count.",
    });
  }
}

/* =====================================================
   MARK ONE NOTIFICATION AS READ
===================================================== */

export async function markNotificationAsRead(req, res) {
  try {
    const currentUser = await getAuthenticatedUser(req);

    if (!currentUser) {
      return res.status(401).json({
        success: false,
        message: "You are not authenticated.",
      });
    }

    const userId = Number(currentUser.userId);

    const role = normalizeRole(currentUser.role);

    const notificationId = Number(
      String(req.params.notificationId || req.params.id || "").replace(
        /^managed-/,
        "",
      ),
    );

    if (!Number.isFinite(notificationId) || notificationId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Notification id is invalid.",
      });
    }

    const [rows] = await db.execute(
      `
      SELECT
        notification_id,
        recipient_user_id,
        target

      FROM notifications

      WHERE notification_id = ?

      LIMIT 1
      `,
      [notificationId],
    );

    const notification = rows[0];

    if (!notification) {
      return res.status(404).json({
        success: false,
        message: "Notification not found.",
      });
    }

    /*
     * DIRECT NOTIFICATION
     */
    if (notification.recipient_user_id !== null) {
      if (Number(notification.recipient_user_id) !== userId) {
        return res.status(403).json({
          success: false,
          message: "You cannot update this notification.",
        });
      }

      await db.execute(
        `
        UPDATE notifications

        SET
          is_read = 1,
          read_at = COALESCE(
            read_at,
            NOW()
          )

        WHERE notification_id = ?
          AND recipient_user_id = ?
        `,
        [notificationId, userId],
      );
    }

    /*
     * BROADCAST / ANNOUNCEMENT
     */
    else {
      if (!targetMatchesRole(notification.target, role)) {
        return res.status(403).json({
          success: false,
          message: "You cannot update this notification.",
        });
      }

      const [result] = await db.execute(
  `
    INSERT INTO notification_reads (
      notification_id,
      user_id,
      read_at
    )
    VALUES (?, ?, NOW())
    ON DUPLICATE KEY UPDATE
      read_at = VALUES(read_at)
  `,
  [notificationId, userId]
);

console.log("NOTIFICATION READ INSERT:", {
  notificationId,
  userId,
  affectedRows: result.affectedRows,
  insertId: result.insertId,
});

    const [savedRows] = await db.execute(
      `
        SELECT *
        FROM notification_reads
        WHERE notification_id = ?
          AND user_id = ?
      `,
      [notificationId, userId]
    );

    console.log("SAVED NOTIFICATION READ:", savedRows);
    }

    return res.json({
      success: true,
      message: "Notification marked as read.",
    });
  } catch (error) {
    console.error("Mark notification as read error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to mark notification as read.",
    });
  }
}

/* =====================================================
   MARK ALL NOTIFICATIONS AS READ
===================================================== */

export async function markAllNotificationsAsRead(req, res) {
  const connection = await db.getConnection();

  try {
    const currentUser = await getAuthenticatedUser(req);

    if (!currentUser) {

      return res.status(401).json({
        success: false,
        message: "You are not authenticated.",
      });
    }

    const userId = Number(currentUser.userId);

    const role = normalizeRole(currentUser.role);

    await connection.beginTransaction();

    /*
     * Mark direct notifications read.
     */
    await connection.execute(
      `
      UPDATE notifications

      SET
        is_read = 1,
        read_at = COALESCE(
          read_at,
          NOW()
        )

      WHERE recipient_user_id = ?
        AND is_read = 0
      `,
      [userId],
    );

    /*
     * Find broadcasts visible to this role.
     */
    const [broadcastRows] = await connection.execute(
      `
        SELECT notification_id

        FROM notifications

        WHERE recipient_user_id IS NULL

          AND (
            target = 'all'

            OR (
              target = 'user'
              AND ? IN (
                'student',
                'professor'
              )
            )

            OR (
              target = 'admin'
              AND ? IN (
                'admin',
                'super_admin'
              )
            )

            OR target = ?
          )
        `,
      [role, role, role],
    );

    for (const notification of broadcastRows) {
      await connection.execute(
        `
        INSERT INTO
          notification_reads (
            notification_id,
            user_id,
            read_at
          )

        VALUES (?, ?, NOW()) ON CONFLICT DO NOTHING`,
        [notification.notification_id, userId],
      );
    }

    await connection.commit();

    return res.json({
      success: true,
      message: "All notifications marked as read.",
      unreadCount: 0,
    });
  } catch (error) {
    try {
      await connection.rollback();
    } catch {
      // Ignore rollback errors.
    }

    console.error("Mark all notifications as read error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to mark notifications as read.",
    });
  } finally {
    connection.release();
  }
}

/* =====================================================
   CREATE ADMIN / SUPER ADMIN ANNOUNCEMENT
===================================================== */

export async function createNotification(req, res) {
  try {
    const currentUser = await getAuthenticatedUser(req);

    if (!currentUser || !isNotificationManager(currentUser.role)) {
      return res.status(403).json({
        success: false,
        message: "Only admins and super admins can create notifications.",
      });
    }

    const title = cleanText(req.body?.title);

    const message = cleanText(req.body?.message || req.body?.body);

    const target = normalizeTarget(req.body?.target || "all");

    const createdByName = getCreatorDisplayName(currentUser, req.user);

    const createdByRole = normalizeRole(currentUser.role || req.user?.role);

    if (!title || !message) {
      return res.status(400).json({
        success: false,
        message: "Title and message are required.",
      });
    }

    const allowedTargets = [
      "all",
      "user",
      "student",
      "professor",
      "admin",
      "super_admin",
    ];

    if (!allowedTargets.includes(target)) {
      return res.status(400).json({
        success: false,
        message: "Notification target is invalid.",
      });
    }

    /*
     * recipient_user_id = NULL means
     * this is a broadcast announcement.
     */
    const [result] = await db.execute(
      `
      INSERT INTO notifications (
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
        created_by_role
      )

      VALUES (
        NULL,
        NULL,
        NULL,
        ?,
        ?,
        ?,
        'announcement',
        0,
        NULL,
        ?,
        ?,
        ?
      )
      `,
      [
        title,
        message,
        target,
        currentUser.userId || null,
        createdByName,
        createdByRole,
      ],
    );

    /*
     * Get the announcement we just created.
     */
    const [rows] = await db.execute(
      `
      SELECT
        notification_id,
        recipient_user_id,
        course_id,
        enrollment_id,
        title,
        message,
        target,
        type,
        created_by_user_id,
        created_by_name,
        created_by_role,
        created_at

      FROM notifications

      WHERE notification_id = ?

      LIMIT 1
      `,
      [result.insertId],
    );

    const row = rows[0];

    const notification = {
      id: String(row.notification_id),

      notificationId: row.notification_id,

      notification_id: row.notification_id,

      recipientUserId: null,
      recipient_user_id: null,

      courseId: row.course_id,

      course_id: row.course_id,

      enrollmentId: row.enrollment_id,

      enrollment_id: row.enrollment_id,

      title: row.title,

      message: row.message,

      target: normalizeTarget(row.target),

      type: row.type || "announcement",

      isRead: false,
      is_read: false,
      unread: true,

      createdByUserId: row.created_by_user_id,

      created_by_user_id: row.created_by_user_id,

      createdByName: row.created_by_name || "",

      created_by_name: row.created_by_name || "",

      createdByRole: normalizeRole(row.created_by_role),

      created_by_role: normalizeRole(row.created_by_role),

      createdAt: row.created_at,

      created_at: row.created_at,

      source: "managed",
      icon: "announcement",
    };

   // await logAuditFromRequest(req, {
    //  category: "Notification Management",
      //action: "Created Announcement",
      //target: title,
     // status: "Success",
     // details: `Created announcement "${title}" ` + `for target "${target}".`,
     // userId: currentUser.userId || null,
     // userName: createdByName,
     // userRole: createdByRole,
   // });

    return res.status(201).json({
      success: true,
      message: "Notification posted.",
      notification,

      /*
       * Keep this for compatibility
       * with your existing React utility.
       */
      notifications: [notification],
    });
  } catch (error) {
    console.error("Create notification error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to create notification.",
    });
  }
}

/* =====================================================
   DELETE ANNOUNCEMENT
===================================================== */

export async function deleteNotification(req, res) {
  try {
    const currentUser = await getAuthenticatedUser(req);

    if (!currentUser || !isNotificationManager(currentUser.role)) {
      return res.status(403).json({
        success: false,
        message: "Only admins and super admins can delete notifications.",
      });
    }

    const currentRole = normalizeRole(currentUser.role);

    const notificationId = Number(
      String(req.params.id || req.params.notificationId || "").replace(
        /^managed-/,
        "",
      ),
    );

    if (!Number.isFinite(notificationId) || notificationId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Notification id is invalid.",
      });
    }

    /*
     * Get announcement BEFORE deleting it.
     *
     * We need this for:
     * 1. Permission checking
     * 2. Audit logging
     */
    const [rows] = await db.execute(
      `
        SELECT
          notification_id,
          title,
          message,
          target,
          type,
          recipient_user_id,
          created_by_user_id,
          created_by_name,
          created_by_role,
          created_at
        FROM notifications
        WHERE notification_id = ?
          AND recipient_user_id IS NULL
          AND type = 'announcement'
        LIMIT 1
      `,
      [notificationId],
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Announcement not found.",
      });
    }

    const notification = rows[0];

    const creatorRole = normalizeRole(notification.created_by_role);

    /*
     * SECURITY RULE:
     *
     * Admin cannot delete announcements
     * created by a Super Admin.
     */
    if (currentRole === "admin" && creatorRole === "super_admin") {
      return res.status(403).json({
        success: false,
        message: "Admins cannot delete announcements created by a Super Admin.",
      });
    }

    /*
     * Delete announcement.
     *
     * notification_reads records should
     * disappear automatically through
     * ON DELETE CASCADE.
     */
    const [result] = await db.execute(
      `
        DELETE FROM notifications
        WHERE notification_id = ?
          AND recipient_user_id IS NULL
          AND type = 'announcement'
      `,
      [notificationId],
    );

    if (Number(result.affectedRows) === 0) {
      return res.status(404).json({
        success: false,
        message: "Announcement not found.",
      });
    }

    const currentUserName = getCreatorDisplayName(currentUser, req.user);

    /*
     * AUDIT LOG
     */
   // await logAuditFromRequest(req, {
     // category: "Notification Management",

     // action: "Deleted Announcement",

      //target: notification.title || `Announcement #${notificationId}`,

    //  status: "Success",

      //details:
        //`Deleted announcement "${notification.title || `#${notificationId}`}" ` +
        //`targeted to "${normalizeTarget(notification.target)}".`,

     // userId: currentUser.userId || null,

      //userName: currentUserName,

      //userRole: currentRole,
    //});

    return res.json({
      success: true,
      message: "Notification deleted.",
    });
  } catch (error) {
    console.error("Delete notification error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to delete notification.",
    });
  }
}
