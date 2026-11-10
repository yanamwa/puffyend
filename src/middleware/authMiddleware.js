import jwt from "jsonwebtoken";
import { db } from "../db.js";
import { hasPendingStudentTutorial } from "../utils/studentTutorial.js";
import { hasProfessorAdminAccess } from "../utils/professorAdminAccess.js";

const JWT_SECRET = process.env.JWT_SECRET || "puffybrain-secret";

function normalizeRole(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function normalizeVerificationStatus(value) {
  return String(value || "pending")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function isTemporaryAccountExpired(user) {
  if (Number(user.is_temporary) !== 1 || !user.temporary_expires_at) {
    return false;
  }

  const expiresAt = new Date(user.temporary_expires_at);
  return !Number.isNaN(expiresAt.getTime()) && expiresAt <= new Date();
}

async function authenticate(req, res, next, allowAccountSetup) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      message: "Authentication token is required.",
    });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const decodedUserId = decoded.userId || decoded.id;
    const decodedEmail = String(decoded.email || "")
      .trim()
      .toLowerCase();
    let rows = [];

    if (decodedUserId) {
      [rows] = await db.execute(
        `SELECT userId, email, role, verification_status, is_archived,
         is_temporary, temporary_expires_at, must_change_password,
         onboarding_completed, student_tutorial_pending, is_verified, professor_admin_access
         FROM users
         WHERE userId = ?
         LIMIT 1`,
        [decodedUserId],
      );
    } else if (decodedEmail) {
      [rows] = await db.execute(
        `SELECT userId, email, role, verification_status, is_archived,
         is_temporary, temporary_expires_at, must_change_password,
         onboarding_completed, student_tutorial_pending, is_verified, professor_admin_access
         FROM users
         WHERE email = ?
         LIMIT 1`,
        [decodedEmail],
      );
    }

    const user = rows[0];

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "User account was not found.",
      });
    }

    if (Number(user.is_archived) === 1) {
      return res.status(403).json({
        success: false,
        code: "ACCOUNT_ARCHIVED",
        message: "This account is archived. Please contact the Super Admin.",
      });
    }

    if (isTemporaryAccountExpired(user)) {
      return res.status(403).json({
        success: false,
        code: "TEMPORARY_ACCOUNT_EXPIRED",
        message:
          "This temporary account has expired. Please contact the Super Admin.",
      });
    }

    const primaryRole = normalizeRole(user.role);
    if (
      !["super_admin", "professor"].includes(primaryRole) &&
      Number(user.must_change_password) === 1 &&
      !allowAccountSetup
    ) {
      return res.status(403).json({
        success: false,
        code: "PASSWORD_CHANGE_REQUIRED",
        message: "Change your temporary password in Settings to continue.",
      });
    }

    if (!allowAccountSetup && hasPendingStudentTutorial(user)) {
      return res.status(403).json({
        success: false,
        code: "STUDENT_TUTORIAL_REQUIRED",
        message: "Finish or skip the student tutorial to continue.",
      });
    }

    const verificationStatus = normalizeVerificationStatus(
      user.verification_status,
    );

    if (primaryRole === "professor" && verificationStatus !== "approved") {
      const isDeclined = verificationStatus === "declined";

      return res.status(403).json({
        success: false,
        code: isDeclined
          ? "PROFESSOR_REGISTRATION_DECLINED"
          : "PROFESSOR_REGISTRATION_PENDING",
        message: isDeclined
          ? "Your professor registration was declined by the Super Admin."
          : "Your professor registration is pending Super Admin approval.",
        verificationStatus,
      });
    }

    const hasAdminAccess = hasProfessorAdminAccess(user);
    if (
      primaryRole === "professor" &&
      decoded.role === "admin" &&
      !hasAdminAccess
    ) {
      return res.status(403).json({
        success: false,
        message: "Admin access is unavailable for this professor account.",
      });
    }
    const role =
      hasAdminAccess && decoded.role === "admin" ? "admin" : primaryRole;
    req.user = {
      ...decoded,
      id: user.userId,
      userId: user.userId,
      email: user.email,
      role,
      primaryRole,
      hasAdminAccess,
      verificationStatus,
      verification_status: verificationStatus,
    };

    await db.execute(
      `UPDATE users
        SET last_active = NOW()
        WHERE userId = ?`,
      [user.userId],
    );

    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired token.",
    });
  }
}

export default function authenticateUser(req, res, next) {
  return authenticate(req, res, next, false);
}

export function authenticateAccountSetup(req, res, next) {
  return authenticate(req, res, next, true);
}
