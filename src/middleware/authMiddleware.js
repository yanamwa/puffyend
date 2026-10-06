import jwt from "jsonwebtoken";
import { db } from "../db.js";

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

export default async function authenticateUser(req, res, next) {
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
    const decodedEmail = String(decoded.email || "").trim().toLowerCase();
    let rows = [];

    if (decodedUserId) {
      [rows] = await db.execute(
        `SELECT userId, email, role, verification_status, is_archived,
         is_temporary, temporary_expires_at
         FROM users
         WHERE userId = ?
         LIMIT 1`,
        [decodedUserId]
      );
    } else if (decodedEmail) {
      [rows] = await db.execute(
        `SELECT userId, email, role, verification_status, is_archived,
         is_temporary, temporary_expires_at
         FROM users
         WHERE email = ?
         LIMIT 1`,
        [decodedEmail]
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

    const role = normalizeRole(user.role);
    const verificationStatus = normalizeVerificationStatus(
      user.verification_status
    );

    if (role === "professor" && verificationStatus !== "approved") {
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

    req.user = {
      ...decoded,
      id: user.userId,
      userId: user.userId,
      email: user.email,
      role,
      verificationStatus,
      verification_status: verificationStatus,
    };

    await db.execute(
        `UPDATE users
        SET last_active = NOW()
        WHERE userId = ?`,
        [user.userId]
      );

    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired token.",
    });
  }
}
