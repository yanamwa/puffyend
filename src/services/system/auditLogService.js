import { db } from "../../db.js";

/* =====================================================
   HELPERS
===================================================== */

function cleanText(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const text = String(value).trim();

  return text || null;
}

function normalizeStatus(status) {
  const value = String(status || "Success")
    .trim()
    .toLowerCase();

  if (value === "failed" || value === "failure") {
    return "Failed";
  }

  if (value === "warning") {
    return "Warning";
  }

  return "Success";
}

/* =====================================================
   GET REQUEST IP ADDRESS
===================================================== */

export function getRequestIp(req) {
  if (!req) {
    return null;
  }

  const forwarded = req.headers?.["x-forwarded-for"];

  if (forwarded) {
    return String(forwarded).split(",")[0].trim();
  }

  return req.ip || req.socket?.remoteAddress || null;
}

/* =====================================================
   CREATE AUDIT LOG
===================================================== */

export async function createAuditLog({
  userId = null,
  userName = "System",
  userRole = "System",
  category,
  action,
  target = null,
  ipAddress = null,
  status = "Success",
  details = null,
}) {
  if (!category || !action) {
    console.warn("Audit log skipped: category and action are required.");

    return null;
  }

  try {
    const [result] = await db.execute(
      `INSERT INTO audit_logs (
        user_id,
        user_name,
        user_role,
        category,
        action,
        target,
        ip_address,
        status,
        details
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId || null,
        cleanText(userName) || "System",
        cleanText(userRole) || "System",
        cleanText(category),
        cleanText(action),
        cleanText(target),
        cleanText(ipAddress),
        normalizeStatus(status),
        cleanText(details),
      ],
    );

    return {
      auditId: result.insertId,
    };
  } catch (error) {
    /*
      Audit logging should not normally crash the
      original action.

      Example:
      If creating a student succeeds but audit logging
      fails, we don't want to report that student
      creation itself failed.
    */
    console.error("Create audit log error:", error);

    return null;
  }
}

/* =====================================================
   CREATE AUDIT LOG FROM EXPRESS REQUEST
===================================================== */

export async function logAuditFromRequest(
  req,
  {
    category,
    action,
    target = null,
    status = "Success",
    details = null,
    userId = null,
    userName = null,
    userRole = null,
  },
) {
  /*
    authMiddleware normally puts the authenticated
    user information somewhere on req.user.

    These fallbacks make this service tolerant of
    slightly different property names.
  */

  const authenticatedUser = req?.user || {};

  const resolvedUserId =
    userId ||
    authenticatedUser.userId ||
    authenticatedUser.user_id ||
    authenticatedUser.id ||
    null;

  const resolvedUserName =
    userName ||
    authenticatedUser.name ||
    authenticatedUser.fullName ||
    authenticatedUser.full_name ||
    authenticatedUser.email ||
    "System";

  const resolvedUserRole = userRole || authenticatedUser.role || "System";

  return createAuditLog({
    userId: resolvedUserId,
    userName: resolvedUserName,
    userRole: resolvedUserRole,

    category,
    action,
    target,

    ipAddress: getRequestIp(req),

    status,
    details,
  });
}
