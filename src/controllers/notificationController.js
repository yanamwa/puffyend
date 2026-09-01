import { db } from "../db.js";

function cleanText(value) {
  return String(value || "").trim();
}

function normalizeRole(role = "") {
  const normalized = cleanText(role)
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  if (normalized === "superadmin") return "super_admin";
  if (normalized === "administrator") return "admin";
  if (normalized === "instructor") return "professor";
  if (normalized === "learner") return "student";

  return normalized;
}

function formatRoleLabel(role = "") {
  const normalizedRole = normalizeRole(role);

  if (normalizedRole === "super_admin") return "Super admin";
  if (normalizedRole === "admin") return "Admin";
  if (normalizedRole === "professor") return "Professor";
  if (normalizedRole === "student") return "Student";

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
  if (normalized === "users") return "user";
  if (normalized === "students") return "student";
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

  if (normalizedTarget === "all") return true;
  if (normalizedTarget === "user") {
    return ["student", "professor"].includes(normalizedRole);
  }
  if (normalizedTarget === "admin") {
    return ["admin", "super_admin"].includes(normalizedRole);
  }

  return normalizedTarget === normalizedRole;
}

function rowToNotification(row) {
  return {
    id: String(row.notification_id),
    title: row.title,
    message: row.message,
    target: row.target,
    type: row.type || "announcement",
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

async function getAuthenticatedUser(req) {
  const userId = req.user?.id || req.user?.userId || req.user?.user_id;
  const email = cleanText(req.user?.email).toLowerCase();

  if (userId) {
    const [rows] = await db.execute(
      `SELECT userId, email, role, name, display_name
       FROM users
       WHERE userId = ?
       LIMIT 1`,
      [userId]
    );

    if (rows[0]) return rows[0];
  }

  if (email) {
    const [rows] = await db.execute(
      `SELECT userId, email, role, name, display_name
       FROM users
       WHERE email = ?
       LIMIT 1`,
      [email]
    );

    if (rows[0]) return rows[0];
  }

  return null;
}

async function getLatestNotification() {
  const [rows] = await db.execute(
    `SELECT notification_id, title, message, target, type,
            created_by_user_id, created_by_name, created_by_role,
            created_at
     FROM managed_notifications
     ORDER BY created_at DESC, notification_id DESC
     LIMIT 1`
  );

  return rows[0] || null;
}

export async function getNotifications(req, res) {
  try {
    const currentUser = await getAuthenticatedUser(req);

    if (!currentUser) {
      return res.status(401).json({
        success: false,
        message: "You are not authenticated.",
      });
    }

    const latestNotification = await getLatestNotification();

    if (
      !latestNotification ||
      (!isNotificationManager(currentUser.role) &&
        !targetMatchesRole(latestNotification.target, currentUser.role))
    ) {
      return res.json({
        success: true,
        notifications: [],
      });
    }

    return res.json({
      success: true,
      notifications: [rowToNotification(latestNotification)],
    });
  } catch (error) {
    console.error("Get notifications error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch notifications.",
    });
  }
}

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

    const connection = await db.getConnection();

    try {
      await connection.beginTransaction();

      const [result] = await connection.execute(
        `INSERT INTO managed_notifications
         (title, message, target, type, created_by_user_id,
          created_by_name, created_by_role)
         VALUES (?, ?, ?, 'announcement', ?, ?, ?)`,
        [
          title,
          message,
          target,
          currentUser.userId || null,
          createdByName,
          createdByRole,
        ]
      );

      await connection.execute(
        "DELETE FROM managed_notifications WHERE notification_id <> ?",
        [result.insertId]
      );

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    const latestNotification = await getLatestNotification();
    const notification = rowToNotification(latestNotification);

    return res.status(201).json({
      success: true,
      message: "Notification posted.",
      notification,
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

export async function deleteNotification(req, res) {
  try {
    const currentUser = await getAuthenticatedUser(req);

    if (!currentUser || !isNotificationManager(currentUser.role)) {
      return res.status(403).json({
        success: false,
        message: "Only admins and super admins can delete notifications.",
      });
    }

    const notificationId = Number(
      String(req.params.id || "").replace(/^managed-/, "")
    );

    if (!Number.isFinite(notificationId) || notificationId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Notification id is invalid.",
      });
    }

    await db.execute(
      "DELETE FROM managed_notifications WHERE notification_id = ?",
      [notificationId]
    );

    return res.json({
      success: true,
      message: "Notification deleted.",
      notifications: [],
    });
  } catch (error) {
    console.error("Delete notification error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to delete notification.",
    });
  }
}
