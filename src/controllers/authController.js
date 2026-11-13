import { security } from "../config/security.js";
import bcrypt from "bcrypt";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import jwt from "jsonwebtoken";

import { db } from "../db.js";
import { cleanupDeclinedRegistrations } from "../services/declinedRegistrationCleanup.js";
import { sendOtpEmail, sendPasswordResetEmail } from "../utils/mailer.js";
import { hasPendingStudentTutorial } from "../utils/studentTutorial.js";
import { hasPendingProfessorTutorial } from "../utils/professorTutorial.js";
import { hasProfessorAdminAccess } from "../utils/professorAdminAccess.js";

import {
  getSystemSettingsConfig,
  isProfessorApprovalRequired,
} from "../services/system/systemSettingsService.js";
import { sendMaintenanceResponse } from "../middleware/maintenanceMode.js";
import { logAuditFromRequest } from "../services/system/auditLogService.js";

/* =====================================================
   CONFIGURATION
===================================================== */

import { JWT_SECRET } from "../config/security.js";

const OTP_TTL_SECONDS = 5 * 60;

const RESET_PASSWORD_TTL_SECONDS = 60 * 60;

const RESERVED_SUPER_ADMIN_EMAIL = cleanEmailValue(
  process.env.SUPER_ADMIN_EMAIL || "superadmin@puffybrain.local",
);

/* =====================================================
   HELPERS
===================================================== */

function createOtp() {
  return crypto.randomInt(1000, 10000).toString();
}

function cleanEmailValue(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normalizeRoleValue(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function normalizeVerificationStatusValue(value) {
  return String(value || "pending")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function hashPasswordResetToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function createPasswordResetToken() {
  const token = crypto.randomBytes(32).toString("hex");

  return {
    token,
    tokenHash: hashPasswordResetToken(token),
  };
}

function isStrongPassword(password) {
  return (
    password.length >= 12 &&
    /[A-Z]/.test(password) &&
    /[a-z]/.test(password) &&
    /[0-9]/.test(password) &&
    /[^A-Za-z0-9]/.test(password)
  );
}

function getPasswordResetBaseUrl(req) {
  return security.frontendUrl;
}

async function getOtpTiming(userId) {
  const [rows] = await db.execute(
    `SELECT
       GREATEST(
         TRUNC(EXTRACT(EPOCH FROM (otp_expires - NOW()))),
         0
       ) AS otp_seconds_remaining
     FROM users
     WHERE userId = ?
     LIMIT 1`,
    [userId],
  );

  const seconds = Number(rows[0]?.otp_seconds_remaining);

  return Number.isFinite(seconds) ? seconds : 0;
}

function getUploadedProofUrl(file) {
  if (!file?.filename) {
    return "";
  }

  return `/api/uploads/professor-ids/` + `${file.filename}`;
}

async function removeUploadedProof(file) {
  if (!file?.path) {
    return;
  }

  try {
    await fs.unlink(file.path);
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("Could not delete uploaded proof:", error);
    }
  }
}

function isTemporaryAccountExpired(user) {
  if (Number(user.is_temporary) !== 1 || !user.temporary_expires_at) {
    return false;
  }

  const expiresAt = new Date(user.temporary_expires_at);

  return !Number.isNaN(expiresAt.getTime()) && expiresAt <= new Date();
}

function authUserPayload(user, role = user.role) {
  const displayName = user.display_name || user.name || "";

  const isTemporary = Number(user.is_temporary) === 1;

  const temporaryExpired = isTemporaryAccountExpired(user);

  return {
    id: user.userId,

    userId: user.userId,

    email: user.email,

    role,
    primaryRole: user.role,
    hasAdminAccess: hasProfessorAdminAccess(user),

    name: user.name,
    profileImage: user.profile_image || "",

    displayName,

    display_name: displayName,

    yearLevel: user.year_level || "",

    year_level: user.year_level || "",

    sectionName: user.section_name || "",

    section_name: user.section_name || "",
    course: user.course || "",
    program: user.course || "",

    professorDepartment: user.professor_department || "",

    professor_department: user.professor_department || "",

    onboardingCompleted: Number(user.onboarding_completed) === 1,

    onboarding_completed: Number(user.onboarding_completed) === 1 ? 1 : 0,
    studentTutorialPending: hasPendingStudentTutorial(user),
    professorTutorialPending: hasPendingProfessorTutorial(user),

    verificationStatus: user.verification_status,

    verification_status: user.verification_status,

    isArchived: Number(user.is_archived) === 1,

    is_archived: Number(user.is_archived) === 1 ? 1 : 0,

    mustChangePassword: Number(user.must_change_password) === 1,

    must_change_password: Number(user.must_change_password) === 1 ? 1 : 0,

    isTemporary,

    is_temporary: isTemporary ? 1 : 0,

    temporaryExpiresAt: user.temporary_expires_at,

    temporary_expires_at: user.temporary_expires_at,

    temporaryExpired,

    temporary_expired: temporaryExpired ? 1 : 0,
  };
}

/* =====================================================
   PROFESSOR SIGNUP
===================================================== */

export async function signup(req, res) {
  const {
    email,
    password,
    name,
    role = "professor",
    facultyId,
    employeeId,
    department,
    employmentProof,
    proofOfEmployment,
  } = req.body || {};

  const uploadedProofUrl = getUploadedProofUrl(req.file);

  const cleanEmail = cleanEmailValue(email);

  const cleanName = name?.toString().trim();

  const cleanFacultyId = (facultyId || employeeId || "").toString().trim();

  const cleanDepartment = (department || "").toString().trim();

  const cleanEmploymentProof = (
    uploadedProofUrl ||
    employmentProof ||
    proofOfEmployment ||
    ""
  )
    .toString()
    .trim();

  const requestedRole = role === "professor" ? "professor" : "";

  if (!cleanEmail || !password || !cleanName) {
    await removeUploadedProof(req.file);

    return res.status(400).json({
      success: false,
      message: "Missing required fields.",
    });
  }

  if (cleanEmail === RESERVED_SUPER_ADMIN_EMAIL) {
    await removeUploadedProof(req.file);

    return res.status(409).json({
      success: false,
      message:
        "This email is reserved for the Super Admin account. Please use a different professor email.",
    });
  }

  if (!requestedRole) {
    await removeUploadedProof(req.file);

    return res.status(400).json({
      success: false,
      message: "Public sign up is only available for professors.",
    });
  }

  if (!cleanDepartment) {
    await removeUploadedProof(req.file);

    return res.status(400).json({
      success: false,
      message: "Department is required.",
    });
  }

  if (cleanFacultyId.length > 100) {
    await removeUploadedProof(req.file);

    return res.status(400).json({
      success: false,
      message: "Employee or faculty ID is too long.",
    });
  }

  if (!cleanEmploymentProof) {
    return res.status(400).json({
      success: false,
      message: "Faculty or employee ID photo is required.",
    });
  }

  try {
    await cleanupDeclinedRegistrations(cleanEmail);
    const [existing] = await db.execute(
      `SELECT userId, role, verification_status,
         GREATEST(CEIL(EXTRACT(EPOCH FROM
           (professor_declined_at + INTERVAL '24 hours' - NOW()))), 1) AS retry_after_seconds
         FROM users
         WHERE email = ?
         LIMIT 1`,
      [cleanEmail],
    );

    if (existing.length > 0) {
      await removeUploadedProof(req.file);

      if (existing[0].role === "professor" && existing[0].verification_status === "declined") {
        const retryAfterSeconds = Number(existing[0].retry_after_seconds) || 86400;
        const hours = Math.ceil(retryAfterSeconds / 3600);
        return res.status(409).json({
          success: false,
          code: "REGISTRATION_DECLINED",
          retryAfterSeconds,
          message: `This email is already registered and the registration was declined. Please try again in ${hours} hour${hours === 1 ? "" : "s"}, after the 24-hour waiting period.`,
        });
      }

      return res.status(409).json({
        success: false,
        message: "Email is already registered.",
      });
    }

    const requiresApproval = await isProfessorApprovalRequired();
    const hashedPassword = await bcrypt.hash(password, 10);
    const otp = createOtp();

    const [result] = await db.execute(
      `INSERT INTO users
         (
           email,
           password,
           role,
           name,
           display_name,
           verification_id,
           student_id,
           professor_id,
           professor_faculty_id,
           professor_department,
           professor_employment_proof,
           verification_status,
           otp_code,
           otp_expires,
           is_verified,
           onboarding_completed,
           professor_tutorial_pending
         )
         VALUES (
           ?,
           ?,
           'professor',
           ?,
           ?,
           NULL,
           NULL,
           NULL,
           ?,
           ?,
           ?,
           'pending',
           ?,
           (NOW() + (?::double precision * INTERVAL '1 second')),
           0,
           1,
           1
         )`,
      [
        cleanEmail,
        hashedPassword,
        cleanName,
        cleanName,
        cleanFacultyId || null,
        cleanDepartment || null,
        cleanEmploymentProof || null,
        otp,
        OTP_TTL_SECONDS,
      ],
    );

    try {
      await sendOtpEmail(cleanEmail, cleanName, otp);

      const otpSecondsRemaining = await getOtpTiming(result.insertId);

      /* ===============================================
         AUDIT LOG - PROFESSOR SIGNUP
      =============================================== */

      await logAuditFromRequest(req, {
        userId: result.insertId,

        userName: cleanName,

        userRole: "professor",

        category: "Authentication",

        action: "Professor Signup",

        target: cleanEmail,

        status: "Success",

        details: `${cleanName} submitted a professor registration.`,
      });

      return res.json({
        success: true,

        message: "Verification code sent to your email.",

        email: cleanEmail,

        requiresApproval,

        otpSecondsRemaining,
      });
    } catch (emailError) {
      await db.execute(
        `DELETE FROM users
         WHERE userId = ?
           AND is_verified = 0`,
        [result.insertId],
      );

      await removeUploadedProof(req.file);

      console.error("Signup verification email failed:", emailError);

      return res.status(emailError.code === "SMTP_CONFIG_MISSING" ? 503 : 500).json({
        success: false,
        message: emailError.code === "SMTP_CONFIG_MISSING"
          ? "Email verification is not configured. Please contact the administrator."
          : "Unable to send your verification email. Please try again later.",
      });
    }
  } catch (error) {
    await removeUploadedProof(req.file);

    console.error("Signup error:", error);

    return res.status(500).json({
      success: false,
      message: "Signup failed.",
    });
  }
}

/* =====================================================
   VERIFY EMAIL
===================================================== */

export async function verifyEmail(req, res) {
  const { otp } = req.body;

  const email = cleanEmailValue(req.body?.email);

  if (!email || !otp) {
    return res.status(400).json({
      success: false,
      message: "Email and OTP are required.",
    });
  }

  try {
    const [rows] = await db.execute(
      `SELECT
           users.*,
           TRUNC(EXTRACT(EPOCH FROM (otp_expires - NOW()))) AS otp_seconds_remaining
         FROM users
         WHERE email = ?
           AND role IN ('professor', 'student')
         LIMIT 1`,
      [email],
    );

    const user = rows[0];

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    if (user.is_verified === 1) {
      return res.json({
        success: true,
        message: "Email already verified.",
        role: user.role,
        requiresApproval:
          user.role === "professor" &&
          user.verification_status === "pending" &&
          (await isProfessorApprovalRequired()),
        verificationStatus: user.verification_status,
      });
    }

    if (user.otp_code !== otp) {
      return res.status(400).json({
        success: false,
        message: "Wrong OTP. Make sure to input the correct code.",
      });
    }

    if (!user.otp_expires || Number(user.otp_seconds_remaining) <= 0) {
      return res.status(400).json({
        success: false,
        message: "Verification code expired",
        otpSecondsRemaining: 0,
      });
    }

    const settings = await getSystemSettingsConfig();
    const [verified] = await db.execute(
      `UPDATE users
       SET
         is_verified = 1,
         otp_code = NULL,
         otp_expires = NULL,
         verification_status = CASE
           WHEN role = 'professor' AND verification_status = 'pending' AND ? = 0 THEN 'approved'
           ELSE verification_status
         END
       WHERE userId = ? AND is_verified = 0 AND otp_code = ? AND otp_expires > NOW()`,
      [Number(settings.professorApproval), user.userId, otp],
    );
    const [[current]] = await db.execute(
      "SELECT is_verified, verification_status FROM users WHERE userId = ?",
      [user.userId],
    );
    if (!current?.is_verified) {
      return res.status(400).json({
        success: false,
        message: "The verification code changed or expired. Request a new code.",
      });
    }

    const requiresApproval =
      user.role === "professor" && current.verification_status === "pending";
    if (
      verified.affectedRows &&
      requiresApproval &&
      settings.professorApprovalNotification
    ) {
      try {
        await db.execute(
          `INSERT INTO notifications
             (recipient_user_id, title, message, target, type)
           SELECT userId, 'Professor Registration Pending', ?, 'super_admin', 'professor_registration_pending'
           FROM users
           WHERE role = 'super_admin' AND is_archived = 0`,
          [`${user.name || user.email} verified their email and is waiting for approval.`],
        );
      } catch (error) {
        console.error("Professor registration notification failed:", error);
      }
    }

    /* ===============================================
       AUDIT LOG - EMAIL VERIFIED
    =============================================== */

    await logAuditFromRequest(req, {
      userId: user.userId,

      userName: user.name || user.email,

      userRole: user.role || "professor",

      category: "Authentication",

      action: "Email Verified",

      target: user.email,

      status: "Success",

      details: `${user.name || user.email} successfully verified their email address.`,
    });

    return res.json({
      success: true,
      message: "Email verified successfully.",
      role: user.role,
      requiresApproval,
      verificationStatus: current.verification_status,
    });
  } catch (error) {
    console.error("Verify email error:", error);

    return res.status(500).json({
      success: false,
      message: "Verification failed.",
    });
  }
}

/* =====================================================
   RESEND OTP
===================================================== */

export async function resendOtp(req, res) {
  const email = cleanEmailValue(req.body?.email);

  if (!email) {
    return res.status(400).json({
      success: false,
      message: "Email is required.",
    });
  }

  try {
    const [rows] = await db.execute(
      `SELECT *
         FROM users
         WHERE email = ?
           AND role IN ('professor', 'student')
         LIMIT 1`,
      [email],
    );

    const user = rows[0];

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    if (user.is_verified === 1) {
      return res.status(400).json({
        success: false,
        message: "Email is already verified.",
      });
    }

    const remainingSeconds = await getOtpTiming(user.userId);
    if (remainingSeconds > 0) {
      return res.status(429).json({
        success: false,
        message: "Please wait until the current verification code expires before requesting another.",
        otpSecondsRemaining: remainingSeconds,
      });
    }

    const otp = createOtp();

    const [updateResult] = await db.execute(
      `UPDATE users
       SET
         otp_code = ?,
         otp_expires =
           (NOW() + ? * INTERVAL '1 second')
       WHERE userId = ?
         AND (otp_expires IS NULL OR otp_expires <= NOW())`,
      [otp, OTP_TTL_SECONDS, user.userId],
    );

    if (updateResult.affectedRows === 0) {
      return res.status(429).json({
        success: false,
        message: "A verification code has already been requested. Please wait for it to expire.",
        otpSecondsRemaining: await getOtpTiming(user.userId),
      });
    }

    try {
      await sendOtpEmail(user.email, user.name, otp);
    } catch (emailError) {
      try {
        await db.execute(
          "UPDATE users SET otp_code = NULL, otp_expires = NULL WHERE userId = ? AND otp_code = ? AND is_verified = 0",
          [user.userId, otp],
        );
      } catch (cleanupError) {
        console.error("Resend OTP cleanup error:", cleanupError);
      }
      throw emailError;
    }

    const otpSecondsRemaining = await getOtpTiming(user.userId);

    /*
     * OTP resend intentionally does not create
     * an audit entry to avoid excessive noise.
     */

    return res.json({
      success: true,
      message: "New verification code sent.",
      otpSecondsRemaining,
    });
  } catch (error) {
    console.error("Resend OTP error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to resend OTP.",
    });
  }
}

/* =====================================================
   FORGOT PASSWORD
===================================================== */

export async function forgotPassword(req, res) {
  const email = cleanEmailValue(req.body?.email);

  const genericResponse = {
    success: true,
    message:
      "If an account exists for that email, a password reset link has been sent.",
  };

  if (!email) {
    return res.status(400).json({
      success: false,
      message: "Email is required.",
    });
  }

  try {
    const [rows] = await db.execute(
      `SELECT
           userId,
           email,
           name,
           role,
           is_archived
         FROM users
         WHERE email = ?
         LIMIT 1`,
      [email],
    );

    const user = rows[0];

    /*
     * Keep the generic response.
     *
     * This prevents exposing whether
     * an account exists.
     */
    if (!user || Number(user.is_archived) === 1) {
      return res.json(genericResponse);
    }

    const { token, tokenHash } = createPasswordResetToken();

    await db.execute(
      `UPDATE users
       SET
         password_reset_token = ?,
         password_reset_expires =
           (NOW() + (?::double precision * INTERVAL '1 second'))
       WHERE userId = ?`,
      [tokenHash, RESET_PASSWORD_TTL_SECONDS, user.userId],
    );

    const resetLink =
      `${getPasswordResetBaseUrl(req)}` +
      `/change-password?token=` +
      `${encodeURIComponent(token)}`;

    try {
      await sendPasswordResetEmail(user.email, user.name || "there", resetLink);
    } catch (emailError) {
      try {
        await db.execute(
          `UPDATE users
           SET
             password_reset_token = NULL,
             password_reset_expires = NULL
           WHERE userId = ? AND password_reset_token = ?`,
          [user.userId, tokenHash],
        );
      } catch (cleanupError) {
        console.error("Password reset token cleanup error:", cleanupError);
      }

      console.error("Password reset email error:", {
        code: emailError.code,

        command: emailError.command,

        responseCode: emailError.responseCode,

        message: emailError.message,
      });

      return res.status(503).json({
        success: false,

        code: "PASSWORD_RESET_EMAIL_FAILED",

        message:
          "Password reset email service is unavailable. Please try again later.",
      });
    }

    /* ===============================================
       AUDIT LOG - PASSWORD RESET REQUEST
    =============================================== */

    await logAuditFromRequest(req, {
      userId: user.userId,

      userName: user.name || user.email,

      userRole: user.role || "Unknown",

      category: "Security",

      action: "Password Reset Requested",

      target: user.email,

      status: "Success",

      details: `${user.name || user.email} requested a password reset.`,
    });

    return res.json(genericResponse);
  } catch (error) {
    console.error("Forgot password error:", error);

    return res.status(503).json({
      success: false,
      message: "Password reset is temporarily unavailable. Please try again later.",
    });
  }
}

/* =====================================================
   RESET PASSWORD
===================================================== */

export async function resetPassword(req, res) {
  const token = String(req.body?.token || "").trim();

  const password = String(req.body?.password || req.body?.newPassword || "");

  if (!token || !password) {
    return res.status(400).json({
      success: false,
      message: "Reset token and new password are required.",
    });
  }

  if (!isStrongPassword(password)) {
    return res.status(400).json({
      success: false,
      message:
        "Password must contain 12 characters, uppercase, lowercase, number, and symbol.",
    });
  }

  try {
    const tokenHash = hashPasswordResetToken(token);

    /*
     * Fetch identifying fields as well
     * so the successful reset can be
     * recorded in the audit log.
     */
    const [rows] = await db.execute(
      `SELECT
           userId,
           name,
           email,
           role,
           password,
           must_change_password
         FROM users
         WHERE password_reset_token = ?
           AND password_reset_expires
               IS NOT NULL
           AND password_reset_expires
               > NOW()
           AND is_archived = 0
         LIMIT 1`,
      [tokenHash],
    );

    const user = rows[0];

    if (!user) {
      return res.status(400).json({
        success: false,
        message: "This password reset link is invalid or has expired.",
      });
    }

    if (
      normalizeRoleValue(user.role) === "student" &&
      Number(user.must_change_password) === 1 &&
      (await bcrypt.compare(password, user.password))
    ) {
      return res.status(400).json({
        success: false,
        message: "Choose a new password different from your temporary password.",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const [result] = await db.execute(
      `UPDATE users
       SET
         password = ?,
         password_reset_token = NULL,
         password_reset_expires = NULL,
         student_tutorial_pending = CASE
           WHEN LOWER(TRIM(role)) = 'student' AND onboarding_completed = 0 AND must_change_password = 1
           THEN 1 ELSE student_tutorial_pending
         END,
         must_change_password = 0
       WHERE userId = ? AND password = ? AND password_reset_token = ?
         AND password_reset_expires > NOW() AND is_archived = 0`,
      [hashedPassword, user.userId, user.password, tokenHash],
    );

    if (result.affectedRows !== 1) {
      return res.status(400).json({
        success: false,
        message: "This password reset link is invalid or has expired.",
      });
    }

    /* ===============================================
       AUDIT LOG - RESET PASSWORD
    =============================================== */

    await logAuditFromRequest(req, {
      userId: user.userId,

      userName: user.name || user.email,

      userRole: user.role || "Unknown",

      category: "Security",

      action: "Reset Password",

      target: user.email,

      status: "Success",

      details: `${user.name || user.email} successfully reset their password.`,
    });

    return res.json({
      success: true,
      message: "Your password has been updated.",
    });
  } catch (error) {
    console.error("Reset password error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to update password.",
    });
  }
}

/* =====================================================
   LOGIN
===================================================== */

export async function login(req, res) {
  const { email, username, password } = req.body || {};
  if (typeof (email || username || "") !== "string" || typeof password !== "string") {
    return res.status(400).json({ success: false, message: "Email and password must be strings." });
  }

  const loginEmail = (email || username || "").trim().toLowerCase();

  if (!loginEmail || !password) {
    return res.status(400).json({
      success: false,
      code: "MISSING_LOGIN_FIELDS",
      message: "Please enter email and password.",
    });
  }

  try {
    const [rows] = await db.execute(
      `SELECT *
         FROM users
         WHERE email = ?
         LIMIT 1`,
      [loginEmail],
    );

    const user = rows[0];
    const settings = await getSystemSettingsConfig();

    if (settings.maintenanceMode && normalizeRoleValue(user?.role) !== "super_admin") {
      return sendMaintenanceResponse(res);
    }

    if (!user) {
      /*
       * We cannot associate this with an
       * actual user account because the
       * email does not exist.
       *
       * The audit service therefore records
       * this as a System/unknown-user event.
       */
      await logAuditFromRequest(req, {
        userId: null,
        userName: "System",
        userRole: "System",

        category: "Authentication",

        action: "Failed Login Attempt",

        target: loginEmail,

        status: "Failed",

        details:
          "Login attempt failed because the email address was not found.",
      });

      return res.status(401).json({
        success: false,
        code: "INVALID_CREDENTIALS",
        message: "Invalid email or password.",
      });
    }

    const validPassword = await bcrypt.compare(password, user.password);

    if (!validPassword) {
      await logAuditFromRequest(req, {
        userId: user.userId,

        userName: user.name || user.email,

        userRole: user.role || "Unknown",

        category: "Authentication",

        action: "Failed Login Attempt",

        target: user.email,

        status: "Failed",

        details:
          "Login attempt failed because an incorrect password was entered.",
      });

      return res.status(401).json({
        success: false,
        code: "INVALID_CREDENTIALS",
        message: "Invalid email or password.",
      });
    }

    if (user.is_verified !== 1) {
      return res.status(403).json({
        success: false,
        code: "EMAIL_NOT_VERIFIED",
        message: "Please verify your email first.",
        email: user.email,
        role: normalizeRoleValue(user.role),
        otpSecondsRemaining: await getOtpTiming(user.userId),
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

    const role = normalizeRoleValue(user.role);

    let verificationStatus = normalizeVerificationStatusValue(
      user.verification_status,
    );

    if (
      role === "professor" &&
      verificationStatus === "pending" &&
      !settings.professorApproval
    ) {
      await db.execute(
        `UPDATE users SET verification_status = 'approved'
         WHERE userId = ? AND verification_status = 'pending' AND is_verified = 1 AND is_archived = 0`,
        [user.userId],
      );
      const [[current]] = await db.execute(
        "SELECT verification_status FROM users WHERE userId = ?",
        [user.userId],
      );
      verificationStatus = normalizeVerificationStatusValue(current?.verification_status);
    }

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

    const tokenMaxAgeSeconds = 7 * 24 * 60 * 60;

    const temporaryExpiresAt =
      Number(user.is_temporary) === 1 && user.temporary_expires_at
        ? new Date(user.temporary_expires_at)
        : null;

    const temporaryRemainingSeconds =
      temporaryExpiresAt && !Number.isNaN(temporaryExpiresAt.getTime())
        ? Math.max(
            1,
            Math.floor((temporaryExpiresAt.getTime() - Date.now()) / 1000),
          )
        : tokenMaxAgeSeconds;

    const token = signRoleToken(
      { ...user, verification_status: verificationStatus },
      role,
      Math.floor(Date.now() / 1000) +
        Math.min(tokenMaxAgeSeconds, temporaryRemainingSeconds),
    );

    await db.execute(
      `UPDATE users
       SET session_last_active = NOW(), last_active = NOW()
       WHERE userId = ?`,
      [user.userId],
    );

    /* ===============================================
       AUDIT LOG - SUCCESSFUL LOGIN
    =============================================== */

    await logAuditFromRequest(req, {
      userId: user.userId,

      userName: user.name || user.email,

      userRole: role,

      category: "Authentication",

      action: "User Login",

      target: user.email,

      status: "Success",

      details: `${user.name || user.email} logged in successfully.`,
    });

    return res.json({
      success: true,
      message: "Login successful.",

      token,

      email: user.email,

      username: user.name,

      isNewUser: role === "student" && Number(user.onboarding_completed) !== 1,

      user: authUserPayload({
        ...user,
        role,
        verification_status: verificationStatus,
      }),
    });
  } catch (error) {
    console.error("Login error:", error);

    return res.status(500).json({
      success: false,
      message: "Login failed.",
    });
  }
}

export async function recordSessionActivity(req, res) {
  try {
    await db.execute(
      `UPDATE users SET session_last_active = NOW() WHERE userId = ?`,
      [req.user.userId],
    );

    return res.json({ success: true });
  } catch (error) {
    console.error("Session activity update failed:", error);
    return res.status(500).json({
      success: false,
      message: "Could not update session activity.",
    });
  }
}

function signRoleToken(user, role, expiresAt) {
  const verificationStatus = normalizeVerificationStatusValue(
    user.verification_status,
  );
  return jwt.sign(
    {
      id: user.userId,
      userId: user.userId,
      email: user.email,
      name: user.name,
      role,
      verificationStatus,
      verification_status: verificationStatus,
      exp: expiresAt,
    },
    JWT_SECRET,
  );
}

export async function switchProfessorRole(req, res) {
  const role = req.body?.role;
  if (role !== "admin" && role !== "professor") {
    return res.status(400).json({
      success: false,
      message: "Choose Admin or Professor.",
    });
  }

  if (req.user.primaryRole !== "professor" || !Number.isFinite(req.user.exp)) {
    return res.status(403).json({
      success: false,
      message: "Role switching is unavailable for this account.",
    });
  }

  try {
    const [[user]] = await db.execute(
      "SELECT * FROM users WHERE userId = ?",
      [req.user.userId],
    );
    if (
      !hasProfessorAdminAccess(user) ||
      Number(user.is_archived) === 1 ||
      isTemporaryAccountExpired(user)
    ) {
      return res.status(403).json({
        success: false,
        message: "This professor account does not have admin access.",
      });
    }

    return res.json({
      success: true,
      token: signRoleToken(user, role, req.user.exp),
      user: authUserPayload(user, role),
    });
  } catch (error) {
    console.error("Switch professor role error:", error.code || error.name);
    return res.status(500).json({
      success: false,
      message: "Could not switch roles. Please try again.",
    });
  }
}

/* =====================================================
   LOGOUT
===================================================== */

export async function logout(req, res) {
  try {
    const currentUser = req.user || {};

    await logAuditFromRequest(req, {
      userId: currentUser.userId || currentUser.id || null,

      userName: currentUser.name || currentUser.email || "Unknown User",

      userRole: currentUser.role || "Unknown",

      category: "Authentication",

      action: "User Logout",

      target: currentUser.email || null,

      status: "Success",

      details: `${
        currentUser.name || currentUser.email || "User"
      } logged out successfully.`,
    });

    return res.json({
      success: true,
      message: "Logout successful.",
    });
  } catch (error) {
    console.error("Logout error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to logout.",
    });
  }
}
