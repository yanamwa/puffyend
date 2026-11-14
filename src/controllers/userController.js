import { db } from "../db.js";
import bcrypt from "bcrypt";
import crypto from "crypto";
import fs from "node:fs/promises";
import authenticateUser from "../middleware/authMiddleware.js";
import {
  sendAccountArchivedEmail,
  sendProfessorAdminAccessEmail,
  sendProfessorRegistrationDecisionEmail,
  sendStudentTemporaryPasswordEmail,
} from "../utils/mailer.js";
import {
  getSystemSettingsConfig,
  isPasswordChangeRequired,
} from "../services/system/systemSettingsService.js";
import { createNotification } from "../utils/notification.js";
import { logAuditFromRequest } from "../services/system/auditLogService.js";
import { hasPendingStudentTutorial } from "../utils/studentTutorial.js";
import { hasPendingProfessorTutorial } from "../utils/professorTutorial.js";
import {
  hasProfessorAdminAccess,
  isApprovedProfessor,
} from "../utils/professorAdminAccess.js";

const YEAR_LEVELS = ["1st Year", "2nd Year", "3rd Year", "4th Year"];
const APPROVAL_STATUSES = ["pending", "approved", "declined"];
const DEFAULT_TEMPORARY_ACCOUNT_DAYS = 30;
const MAX_TEMPORARY_ACCOUNT_DAYS = 365;
const YEAR_ALIASES = new Map([
  ["1", "1st Year"],
  ["1st", "1st Year"],
  ["1st year", "1st Year"],
  ["1st yr", "1st Year"],
  ["first year", "1st Year"],
  ["2", "2nd Year"],
  ["2nd", "2nd Year"],
  ["2nd year", "2nd Year"],
  ["2nd yr", "2nd Year"],
  ["second year", "2nd Year"],
  ["3", "3rd Year"],
  ["3rd", "3rd Year"],
  ["3rd year", "3rd Year"],
  ["3rd yr", "3rd Year"],
  ["third year", "3rd Year"],
  ["4", "4th Year"],
  ["4th", "4th Year"],
  ["4th year", "4th Year"],
  ["4th yr", "4th Year"],
  ["fourth year", "4th Year"],
]);

function cleanText(value) {
  return String(value || "").trim();
}

function cleanEmail(value) {
  return cleanText(value).toLowerCase();
}

function getUploadedProfessorProofUrl(file) {
  if (!file?.filename) return "";
  return `/api/uploads/professor-ids/${file.filename}`;
}

async function removeUploadedProfessorProof(file) {
  if (!file?.path) return;

  try {
    await fs.unlink(file.path);
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("Could not remove professor proof upload:", error);
    }
  }
}

function normalizeYearLevel(value) {
  const cleaned = cleanText(value);
  const alias = YEAR_ALIASES.get(cleaned.toLowerCase());

  if (alias) return alias;

  return YEAR_LEVELS.includes(cleaned) ? cleaned : "";
}

function normalizeGender(value) {
  const cleaned = cleanText(value).toLowerCase();

  if (cleaned === "male") {
    return "Male";
  }

  if (cleaned === "female") {
    return "Female";
  }

  return "";
}
function getYearNumber(yearLevel) {
  return normalizeYearLevel(yearLevel).match(/[1-4]/)?.[0] || "";
}

function normalizeSectionName(value) {
  const cleaned = cleanText(value).replace(/\s+/g, "").toUpperCase();
  return /^[1-4][A-F]$/.test(cleaned) ? cleaned : "";
}

function normalizeVerificationStatus(value) {
  const cleaned = cleanText(value).toLowerCase();
  return APPROVAL_STATUSES.includes(cleaned) ? cleaned : "";
}

function isTruthy(value) {
  return value === true || value === 1 || value === "1" || value === "true";
}

function getTemporaryAccountSettings(body = {}) {
  const isTemporary = isTruthy(body.isTemporary ?? body.is_temporary);

  if (!isTemporary) {
    return {
      isTemporary: 0,
      temporaryExpiresAt: null,
    };
  }

  const rawExpiresAt = cleanText(
    body.temporaryExpiresAt ||
      body.temporary_expires_at ||
      body.expiresAt ||
      body.expires_at,
  );
  const rawDays = cleanText(
    body.temporaryDurationDays ||
      body.temporary_duration_days ||
      body.durationDays ||
      body.duration_days,
  );
  let temporaryExpiresAt = null;

  if (rawExpiresAt) {
    temporaryExpiresAt = new Date(rawExpiresAt);
  } else {
    const durationDays = rawDays
      ? Number(rawDays)
      : DEFAULT_TEMPORARY_ACCOUNT_DAYS;

    if (
      !Number.isFinite(durationDays) ||
      durationDays <= 0 ||
      durationDays > MAX_TEMPORARY_ACCOUNT_DAYS
    ) {
      return {
        error: `Temporary accounts must expire in 1 to ${MAX_TEMPORARY_ACCOUNT_DAYS} days.`,
      };
    }

    temporaryExpiresAt = new Date(
      Date.now() + durationDays * 24 * 60 * 60 * 1000,
    );
  }

  if (
    !(temporaryExpiresAt instanceof Date) ||
    Number.isNaN(temporaryExpiresAt.getTime())
  ) {
    return {
      error: "Temporary account expiration date is invalid.",
    };
  }

  if (temporaryExpiresAt <= new Date()) {
    return {
      error: "Temporary account expiration must be in the future.",
    };
  }

  return {
    isTemporary: 1,
    temporaryExpiresAt,
  };
}

function isTemporaryAccountExpired(user) {
  if (Number(user.is_temporary) !== 1 || !user.temporary_expires_at) {
    return false;
  }

  const expiresAt = new Date(user.temporary_expires_at);
  return !Number.isNaN(expiresAt.getTime()) && expiresAt <= new Date();
}

function getAccountStatus(user) {
  if (Number(user.is_archived) === 1) return "Archived";
  if (isTemporaryAccountExpired(user)) return "Expired";

  const verificationStatus = normalizeVerificationStatus(
    user.verification_status,
  );

  if (verificationStatus === "declined") return "Declined";
  if (user.role === "professor" && verificationStatus === "pending") {
    return "Pending";
  }

  if (
    Number(user.must_change_password) === 1 ||
    (user.role === "student" && Number(user.is_verified) !== 1)
  ) {
    return "Pending";
  }

  return "Active";
}

function getDashboardPath(role) {
  if (role === "super_admin") return "/super-admin";
  if (role === "admin") return "/admin";
  if (role === "professor") return "/professor";
  return "/student";
}

function generateTemporaryPassword() {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const digits = "23456789";
  const symbols = "!@#$%&*?";
  const allCharacters = upper + lower + digits + symbols;
  const requiredCharacters = [
    upper[crypto.randomInt(upper.length)],
    lower[crypto.randomInt(lower.length)],
    digits[crypto.randomInt(digits.length)],
    symbols[crypto.randomInt(symbols.length)],
  ];

  while (requiredCharacters.length < 14) {
    requiredCharacters.push(
      allCharacters[crypto.randomInt(allCharacters.length)],
    );
  }

  return requiredCharacters.sort(() => crypto.randomInt(3) - 1).join("");
}

function rowToUser(user) {
  const displayName = user.display_name || user.name || "";
  const isTemporary = Number(user.is_temporary) === 1;
  const temporaryExpired = isTemporaryAccountExpired(user);

  return {
    id: user.id || user.userId,
    userId: user.id || user.userId,
    email: user.email,
    role: user.role,
    hasAdminAccess: hasProfessorAdminAccess(user),
    name: user.name,

    profileImage: user.profile_image || "",
    profile_image: user.profile_image || "",

    displayName,
    display_name: displayName,
    yearLevel: user.year_level || "",
    year_level: user.year_level || "",
    sectionName: user.section_name || "",
    section_name: user.section_name || "",
    course: user.course || "",
    program: user.course || "",
    onboardingCompleted: Number(user.onboarding_completed) === 1,
    onboarding_completed: Number(user.onboarding_completed) === 1 ? 1 : 0,
    verified: user.is_verified === 1,
    is_verified: user.is_verified,
    verificationId: user.verification_id,
    verification_id: user.verification_id,
    studentId: user.student_id,
    student_id: user.student_id,
    gender: user.gender || "",
    professorId: user.professor_id,
    professor_id: user.professor_id,

    professorFacultyId: user.professor_faculty_id,
    professor_faculty_id: user.professor_faculty_id,

    professorDepartment: user.professor_department,
    professor_department: user.professor_department,

    professorPosition: user.professor_position,
    professor_position: user.professor_position,

    professorSpecialization: user.professor_specialization,
    professor_specialization: user.professor_specialization,

    professorEmploymentProof: user.professor_employment_proof,
    professor_employment_proof: user.professor_employment_proof,
    verificationStatus: user.verification_status,
    verification_status: user.verification_status,
    status: getAccountStatus(user),
    isArchived: Number(user.is_archived) === 1,
    is_archived: Number(user.is_archived) === 1 ? 1 : 0,
    archivedAt: user.archived_at,
    archived_at: user.archived_at,
    mustChangePassword: Number(user.must_change_password) === 1,
    must_change_password: Number(user.must_change_password) === 1 ? 1 : 0,
    isTemporary,
    is_temporary: isTemporary ? 1 : 0,
    temporaryExpiresAt: user.temporary_expires_at,
    temporary_expires_at: user.temporary_expires_at,
    temporaryExpired,
    temporary_expired: temporaryExpired ? 1 : 0,

    joined: user.created_at,
    created_at: user.created_at,

    lastActive: user.last_active || null,
    last_active: user.last_active || null,
  };
}

function rowToSessionUser(user, role) {
  return {
    ...rowToUser(user),
    role: role || user.role,
    primaryRole: user.role,
    studentTutorialPending: hasPendingStudentTutorial(user),
    professorTutorialPending: hasPendingProfessorTutorial(user),
  };
}

async function getUserByEmail(email) {
  const [rows] = await db.execute(
    `SELECT
       userId,
       email,
       role,
       name,
       display_name,
       profile_image,
       year_level,
       section_name, course,
       onboarding_completed,
       is_verified,
       verification_id,
       student_id,
       professor_id,
       professor_faculty_id,
       professor_department,
       professor_position,
       professor_specialization,
       professor_employment_proof,
       verification_status,
       professor_admin_access,
       is_archived,
       archived_at,
       must_change_password,
       is_temporary,
       temporary_expires_at,
       created_at
     FROM users
     WHERE email = ?
     LIMIT 1`,
    [email],
  );

  return rows[0] || null;
}

async function sendUpdatedProfile(email, res) {
  const user = await getUserByEmail(email);

  if (!user) {
    return res.status(404).json({
      success: false,
      message: "User not found.",
    });
  }

  return res.json({
    success: true,
    user: rowToUser(user),
  });
}


export async function getUsers(_req, res) {
  try {
    const [rows] = await db.execute(
      `SELECT
        userId AS id,
        email,
        role,
        name,
        display_name,
        profile_image,
        year_level,
        section_name, course,
        onboarding_completed,
        is_verified,
        verification_id,
        student_id,
        gender,
        professor_id,
        professor_faculty_id,
        professor_department,
        professor_position,
        professor_specialization,
        professor_employment_proof,
        verification_status,
        professor_admin_access,
        is_archived,
        archived_at,
        must_change_password,
        is_temporary,
        temporary_expires_at,
        created_at,
        last_active
      FROM users
      ORDER BY userId DESC`,
    );

    return res.json({
      success: true,
      users: rows.map((row) => {
        const user = rowToUser(row);

        return {
          ...user,
          profileImage: row.profile_image || "",
          profile_image: row.profile_image || "",
        };
      }),
    });
  } catch (error) {
    console.error("Get users error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch users.",
    });
  }
}

export async function getUserById(req, res) {
  const { id } = req.params;

  try {
    const [rows] = await db.execute(
      `SELECT userId AS id, email, role, name, display_name, year_level,
       section_name, course, onboarding_completed, is_verified, verification_id,
       student_id, professor_id, professor_faculty_id, professor_department,
       professor_position, professor_specialization,
       professor_employment_proof, verification_status, professor_admin_access, is_archived,
       archived_at, must_change_password, is_temporary, temporary_expires_at,
       created_at
       FROM users
       WHERE userId = ?
       LIMIT 1`,
      [id],
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    return res.json({
      success: true,
      user: rowToUser(rows[0]),
    });
  } catch (error) {
    console.error("Get user error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch user.",
    });
  }
}

export async function createStudentAccount(req, res) {
  const bulkImport = req.body.bulkImport === true;
  const email = cleanEmail(req.body.email);
  const course = cleanText(req.body.course || req.body.program);
  const name = cleanText(req.body.name || req.body.displayName);
  const studentId = cleanText(req.body.studentId || req.body.student_id);

  const gender = normalizeGender(req.body.gender);


const yearLevel = normalizeYearLevel(
  req.body.yearLevel || req.body.year_level,
);

const sectionInput = cleanText(
  req.body.sectionName ||
  req.body.section_name ||
  req.body.section
).toUpperCase();

const sectionName = normalizeSectionName(
  /^[A-F]$/.test(sectionInput)
    ? `${getYearNumber(yearLevel)}${sectionInput}`
    : sectionInput
);

  const temporaryAccount = getTemporaryAccountSettings(req.body);

  /* ===================================================
     VALIDATION
  =================================================== */

  if (!name || !email || !studentId || !gender || !yearLevel || !sectionName) {
    return res.status(400).json({
      success: false,
      message:
        "Student name, email, Student ID, gender, year level, and section are required.",
    });
  }

  if (course.length > 255) {
    return res.status(400).json({
      success: false,
      message: "Course / Program must be 255 characters or fewer.",
    });
  }

  if (bulkImport && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({
      success: false,
      message: "Invalid email address.",
    });
  }

  const rawGender = cleanText(req.body.gender);

  if (
    rawGender.toLowerCase() !== "male" &&
    rawGender.toLowerCase() !== "female"
  ) {
    return res.status(400).json({
      success: false,
      message: "Gender must be Male or Female.",
    });
  }

  const yearNumber = getYearNumber(yearLevel);

  if (sectionName.charAt(0) !== yearNumber) {
    return res.status(400).json({
      success: false,
      message: `Please choose a ${yearNumber}A-${yearNumber}F section for ${yearLevel}.`,
    });
  }

  if (temporaryAccount.error) {
    return res.status(400).json({
      success: false,
      message: temporaryAccount.error,
    });
  }

  try {
    /* =================================================
       CHECK DUPLICATE EMAIL
    ================================================= */

    const [existingEmail] = await db.execute(
      bulkImport
        ? "SELECT userId FROM users WHERE LOWER(email) = ? LIMIT 1"
        : "SELECT userId FROM users WHERE email = ? LIMIT 1",
      [email],
    );

    if (existingEmail.length > 0) {
      return res.status(409).json({
        success: false,
        message: "Email is already registered.",
      });
    }

    /* =================================================
       CHECK DUPLICATE STUDENT ID
    ================================================= */

    const [existingStudentId] = await db.execute(
      `SELECT userId
       FROM users
       WHERE ${bulkImport ? "LOWER(student_id)" : "student_id"} = ?
       LIMIT 1`,
      [bulkImport ? studentId.toLowerCase() : studentId],
    );

    if (existingStudentId.length > 0) {
      return res.status(409).json({
        success: false,
        message: "Student ID is already registered.",
      });
    }

    /* =================================================
       CREATE TEMPORARY PASSWORD
    ================================================= */

    const temporaryPassword = generateTemporaryPassword();

    const hashedPassword = await bcrypt.hash(temporaryPassword, 10);

    const mustChangePassword = await isPasswordChangeRequired();

    /* =================================================
       CREATE STUDENT
    ================================================= */

    const [result] = await db.execute(
      `INSERT INTO users (
        email,
        password,
        role,
        name,
        display_name,
        verification_id,
        student_id,
        gender,
        verification_status,
        is_verified,
        onboarding_completed,
        student_tutorial_pending,
        year_level,
        section_name,
        course,
        must_change_password,
        is_archived,
        is_temporary,
        temporary_expires_at
      )
      VALUES (
        ?,
        ?,
        'student',
        ?,
        ?,
        ?,
        ?,
        ?,
        'approved',
        0,
        0,
        1,
        ?,
        ?,
        ?,
        ?,
        0,
        ?,
        ?
      )`,
      [
        email,
        hashedPassword,
        name,
        name,
        studentId,
        studentId,
        gender,
        yearLevel,
        sectionName,
        course || null,
        Number(mustChangePassword),
        temporaryAccount.isTemporary,
        temporaryAccount.temporaryExpiresAt,
      ],
    );

    /* =================================================
       GET CREATED STUDENT
    ================================================= */

    const [rows] = await db.execute(
      `SELECT
        userId AS id,
        email,
        role,
        name,
        display_name,
        profile_image,
        year_level,
        section_name, course,
        onboarding_completed,
        is_verified,
        verification_id,
        student_id,
        gender,
        professor_id,
        professor_faculty_id,
        professor_department,
        professor_position,
        professor_specialization,
        professor_employment_proof,
        verification_status,
        is_archived,
        archived_at,
        must_change_password,
        is_temporary,
        temporary_expires_at,
        created_at
       FROM users
       WHERE userId = ?
       LIMIT 1`,
      [result.insertId],
    );

    /* =================================================
       SEND TEMPORARY PASSWORD EMAIL
    ================================================= */

    let credentialsEmailed = false;
    try {
      await sendStudentTemporaryPasswordEmail(email, temporaryPassword);
      credentialsEmailed = true;
    } catch (emailError) {
      console.error("Student temporary password email error:", emailError);
    }

    /* =================================================
       AUDIT LOG
    ================================================= */

    await logAuditFromRequest(req, {
      category: "User Management",
      action: "Created student account",
      target: name,
      status: "Success",
      details:
        `Student ID: ${studentId}; ` +
        `Email: ${email}; ` +
        `Gender: ${gender}; ` +
        `Year Level: ${yearLevel}; ` +
        `Section: ${sectionName}`,
    });

    /* =================================================
       RESPONSE
    ================================================= */

    return res.status(201).json({
      success: true,
      message: "Student account created. The verification code is sent when the student first signs in.",
      emailVerificationRequired: true,
      temporaryPassword,
      credentialsEmailed,
      user: rowToUser(rows[0]),
    });
  } catch (error) {
    if (bulkImport && ["23505", "ER_DUP_ENTRY"].includes(error.code)) {
      return res.status(409).json({
        success: false,
        message: "Email or student ID is already registered.",
      });
    }
    console.error("Create student account error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to create student account.",
    });
  }
}

export async function grantProfessorAdminAccess(req, res) {
  const professorId = Number(String(req.body?.professorId ?? ""));
  if (!Number.isSafeInteger(professorId) || professorId <= 0) {
    return res.status(400).json({
      success: false,
      message: "Select a professor to grant admin access.",
    });
  }

  try {
    const [[user]] = await db.execute(
      "SELECT * FROM users WHERE userId = ?",
      [professorId],
    );
    if (
      !isApprovedProfessor(user) ||
      Number(user.is_archived) === 1 ||
      isTemporaryAccountExpired(user)
    ) {
      return res.status(400).json({
        success: false,
        message: "Choose an active, approved professor with a verified email.",
      });
    }

    const [result] = await db.execute(
      `UPDATE users
       SET professor_admin_access = 1
       WHERE userId = ? AND role = 'professor' AND verification_status = 'approved'
         AND is_verified = 1 AND is_archived = 0 AND professor_admin_access = 0
         AND (is_temporary <> 1 OR temporary_expires_at IS NULL OR temporary_expires_at > NOW())`,
      [professorId],
    );

    if (result.affectedRows !== 1) {
      return res.status(409).json({
        success: false,
        message: "This professor already has admin access or is no longer eligible.",
      });
    }

    const name = user.display_name || user.name || user.email;
    await logAuditFromRequest(req, {
      category: "User Management",
      action: "Granted professor admin access",
      target: name,
      status: "Success",
      details: `Professor ID: ${professorId}; Email: ${user.email}`,
    });

    let emailSent = false;
    try {
      await sendProfessorAdminAccessEmail({ email: user.email, name });
      emailSent = true;
    } catch (error) {
      console.error(
        "Professor admin access email failed:",
        error.code || error.name,
      );
    }

    return res.status(201).json({
      success: true,
      message: emailSent
        ? "Admin access granted. The professor was notified by email."
        : "Admin access granted. The notification email could not be sent.",
      emailSent,
      user: rowToUser({ ...user, professor_admin_access: 1 }),
    });
  } catch (error) {
    console.error("Grant professor admin access error:", error.code || error.name);
    return res.status(500).json({
      success: false,
      message: "Could not grant admin access.",
    });
  }
}

export async function createProfessorAccount(req, res) {
  const email = cleanEmail(req.body.email);

  const name = cleanText(req.body.name || req.body.displayName);

  const facultyId = cleanText(
    req.body.facultyId ||
      req.body.faculty_id ||
      req.body.employeeId ||
      req.body.employee_id,
  );

  const department = cleanText(
    req.body.department ||
      req.body.professorDepartment ||
      req.body.professor_department,
  );

  const position = cleanText(
    req.body.position ||
      req.body.professorPosition ||
      req.body.professor_position,
  );

  const specialization = cleanText(
    req.body.specialization ||
      req.body.professorSpecialization ||
      req.body.professor_specialization,
  );

  const uploadedProofUrl = getUploadedProfessorProofUrl(req.file);
  const employmentProof = cleanText(
    uploadedProofUrl ||
      req.body.employmentProof ||
      req.body.proofOfEmployment ||
      req.body.professorEmploymentProof ||
      req.body.professor_employment_proof,
  );

  const temporaryAccount = getTemporaryAccountSettings(req.body);

  if (!name || !email || !department || !employmentProof) {
    await removeUploadedProfessorProof(req.file);

    return res.status(400).json({
      success: false,
      message:
        "Professor name, email, department, and employment proof are required.",
    });
  }

  if (facultyId.length > 100) {
    await removeUploadedProfessorProof(req.file);

    return res.status(400).json({
      success: false,
      message: "Employee or faculty ID must be 100 characters or fewer.",
    });
  }

  if (!department) {
    await removeUploadedProfessorProof(req.file);

    return res.status(400).json({
      success: false,
      message: "Department is required.",
    });
  }

  if (!employmentProof) {
    await removeUploadedProfessorProof(req.file);

    return res.status(400).json({
      success: false,
      message: "Faculty or employee ID photo is required.",
    });
  }

  if (temporaryAccount.error) {
    await removeUploadedProfessorProof(req.file);

    return res.status(400).json({
      success: false,
      message: temporaryAccount.error,
    });
  }

  try {
    const [existingEmail] = await db.execute(
      `SELECT userId
       FROM users
       WHERE email = ?
       LIMIT 1`,
      [email],
    );

    if (existingEmail.length > 0) {
      await removeUploadedProfessorProof(req.file);

      return res.status(409).json({
        success: false,
        message: "Email is already registered.",
      });
    }

    const temporaryPassword = generateTemporaryPassword();

    const hashedPassword = await bcrypt.hash(temporaryPassword, 10);
    const mustChangePassword = await isPasswordChangeRequired();

    const [result] = await db.execute(
      `INSERT INTO users (
        email,
        password,
        role,
        name,
        display_name,

        professor_id,
        professor_faculty_id,
        professor_department,
        professor_position,
        professor_specialization,
        professor_employment_proof,

        verification_status,
        is_verified,
        onboarding_completed,
        professor_tutorial_pending,
        must_change_password,
        is_archived,
        is_temporary,
        temporary_expires_at
      )
      VALUES (
        ?,
        ?,
        'professor',
        ?,
        ?,

        ?,
        ?,
        ?,
        ?,
        ?,
        ?,

        'approved',
        1,
        1,
        1,
        ?,
        0,
        ?,
        ?
      )`,
      [
        email,
        hashedPassword,
        name,
        name,

        facultyId || null,
        facultyId || null,
        department || null,
        position || null,
        specialization || null,
        employmentProof || null,

        Number(mustChangePassword),
        temporaryAccount.isTemporary,
        temporaryAccount.temporaryExpiresAt,
      ],
    );

    const [rows] = await db.execute(
      `SELECT
        userId AS id,
        email,
        role,
        name,
        display_name,
        profile_image,
        year_level,
        section_name, course,
        onboarding_completed,
        is_verified,
        verification_id,
        student_id,

        professor_id,
        professor_faculty_id,
        professor_department,
        professor_position,
        professor_specialization,
        professor_employment_proof,

        verification_status,
        is_archived,
        archived_at,
        must_change_password,
        is_temporary,
        temporary_expires_at,
        created_at

      FROM users
      WHERE userId = ?
      LIMIT 1`,
      [result.insertId],
    );

    /* =================================================
          AUDIT LOG
        ================================================= */

    await logAuditFromRequest(req, {
      category: "User Management",
      action: "Created professor account",
      target: name,
      status: "Success",
      details:
        `Professor ID: ${result.insertId}; ` +
        `Faculty ID: ${facultyId}; ` +
        `Email: ${email}; ` +
        `Department: ${department}; ` +
        `Position: ${position}; ` +
        `Specialization: ${specialization}`,
    });

    return res.status(201).json({
      success: true,
      message: "Professor account created.",
      temporaryPassword,
      user: rowToUser(rows[0]),
    });
  } catch (error) {
    console.error("Create professor error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to create professor account.",
    });
  }
}

export async function updateProfessorRegistration(req, res) {
  const { id } = req.params;
  const status = normalizeVerificationStatus(
    req.body.status || req.body.action,
  );
  const reason = status === "declined" ? cleanText(req.body.reason) : "";

  if (!status || status === "pending") {
    return res.status(400).json({
      success: false,
      message: "Choose approved or declined.",
    });
  }

  if (status === "declined" && (!reason || reason.length > 2000)) {
    return res.status(400).json({
      success: false,
      message: "Please provide a decline reason of 1 to 2000 characters.",
    });
  }

  try {
    const [existing] = await db.execute(
      `SELECT
          userId,
          role,
          name,
          display_name,
          email
        FROM users
        WHERE userId = ?
        LIMIT 1`,
      [id],
    );
    const user = existing[0];

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    if (user.role !== "professor") {
      return res.status(400).json({
        success: false,
        message: "Only professor registrations can be approved or declined.",
      });
    }

    const { professorApprovalNotification } = await getSystemSettingsConfig();

    await db.execute(
      `UPDATE users SET verification_status = ?,
       professor_declined_at = CASE WHEN ? = 'declined'
         THEN COALESCE(professor_declined_at, NOW()) ELSE NULL END
       WHERE userId = ?`,
      [status, status, id],
    );

    const [rows] = await db.execute(
      `SELECT userId AS id, email, role, name, display_name, year_level,
       section_name, course, onboarding_completed, is_verified, verification_id,
       student_id, professor_id, professor_faculty_id, professor_department,
       professor_position, professor_specialization,
       professor_employment_proof, verification_status, professor_admin_access, is_archived,
       archived_at, must_change_password, is_temporary, temporary_expires_at,
       created_at
       FROM users
       WHERE userId = ?
       LIMIT 1`,
      [id],
    );

    /* =================================================
          AUDIT LOG
        ================================================= */

    const targetName =
      user.name || user.display_name || user.email || `Professor #${id}`;

    await logAuditFromRequest(req, {
      category: "User Management",

      action:
        status === "approved"
          ? "Approved professor registration"
          : "Declined professor registration",

      target: targetName,

      status: "Success",

      details:
        `Professor ID: ${id}; ` +
        `Email: ${user.email || "N/A"}; ` +
        `Registration Status: ${status}` + (reason ? `; Decline Reason: ${reason}` : ""),
    });

    let emailSent = false;
    let message = `Professor registration ${status}.`;
    if (professorApprovalNotification) {
      try {
        await sendProfessorRegistrationDecisionEmail({
          email: user.email,
          name: targetName,
          status,
          reason,
        });
        emailSent = true;
        message += " Notification email sent to the registered address.";
      } catch (error) {
        console.error("Professor decision email failed:", error.code || "EMAIL_DELIVERY_FAILED");
        message += " The notification email could not be sent.";
      }

      try {
        await createNotification({
          recipientUserId: user.userId,
          title: `Professor Registration ${status === "approved" ? "Approved" : "Declined"}`,
          message: reason ? `Professor registration declined. Reason: ${reason}` : "Your professor registration has been approved.",
          target: "professor",
          type: "professor_registration_decision",
        });
      } catch (error) {
        console.error("Professor decision notification failed:", error);
      }
    }

    return res.json({
      success: true,
      message,
      emailSent,
      user: rowToUser(rows[0]),
    });
  } catch (error) {
    console.error("Update professor registration error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to update professor registration.",
    });
  }
}

export async function updateAccountArchive(req, res) {
  const { id } = req.params;
  const archive = req.body.archive === true || req.body.archive === "true";
  const reason = typeof req.body.reason === "string" ? req.body.reason.trim() : "";
  if (archive && (!reason || reason.length > 1000)) {
    return res.status(400).json({
      success: false,
      message: "Enter an archive reason of 1 to 1,000 characters.",
    });
  }

  try {
    const [existing] = await db.execute(
      `SELECT
        userId,
        role,
        name,
        display_name,
        email
      FROM users
      WHERE userId = ?
      LIMIT 1`,
      [id],
    );

    const user = existing[0];

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    if (user.role === "super_admin") {
      return res.status(400).json({
        success: false,
        message: "The Super Admin account cannot be archived.",
      });
    }

    const [update] = await db.execute(
      `UPDATE users
       SET is_archived = ?, archived_at = ?
       WHERE userId = ? AND COALESCE(is_archived, 0) <> ?`,
      [archive ? 1 : 0, archive ? new Date() : null, id, archive ? 1 : 0],
    );

    const [rows] = await db.execute(
      `SELECT userId AS id, email, role, name, display_name, year_level,
       section_name, course, onboarding_completed, is_verified, verification_id,
       student_id, professor_id, professor_faculty_id, professor_department,
       professor_position, professor_specialization,
       professor_employment_proof, verification_status, professor_admin_access, is_archived,
       archived_at, must_change_password, is_temporary, temporary_expires_at,
       created_at
       FROM users
       WHERE userId = ?
       LIMIT 1`,
      [id],
    );

    /* =================================================
          AUDIT LOG
        ================================================= */

    const targetName =
      user.name || user.display_name || user.email || `User #${id}`;

    if (!update.affectedRows) {
      return res.json({
        success: true,
        message: archive ? "Account is already archived." : "Account is already active.",
        user: rowToUser(rows[0]),
      });
    }

    let emailSent;
    if (archive) {
      emailSent = false;
      try {
        await sendAccountArchivedEmail({
          email: user.email,
          name: user.display_name || user.name,
          reason,
        });
        emailSent = true;
      } catch (error) {
        console.error("Account archive email error:", error);
      }
    }

    await logAuditFromRequest(req, {
      category: "User Management",

      action: archive ? "Archived user account" : "Restored user account",

      target: targetName,

      status: "Success",

      details:
        `User ID: ${id}; ` +
        `Role: ${user.role}; ` +
        `Email: ${user.email || "N/A"}` +
        (archive ? `; Reason: ${reason}; Email accepted: ${emailSent}` : ""),
    });

    return res.json({
      success: true,
      message: archive
        ? emailSent
          ? "Account archived. The notification email was sent."
          : "Account archived. The notification email could not be sent."
        : "Account restored.",
      emailSent,
      user: rowToUser(rows[0]),
    });
  } catch (error) {
    console.error("Update archive error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to update account archive status.",
    });
  }
}

export async function resetUserCredentials(req, res) {
  const { id } = req.params;

  try {
    const [existing] = await db.execute(
      `SELECT
        userId,
        role,
        email,
        name,
        display_name
      FROM users
      WHERE userId = ?
      LIMIT 1`,
      [id],
    );

    const user = existing[0];

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    if (user.role === "super_admin") {
      return res.status(400).json({
        success: false,
        message: "Super Admin credentials cannot be reset here.",
      });
    }

    const temporaryPassword = generateTemporaryPassword();
    const hashedPassword = await bcrypt.hash(temporaryPassword, 10);

    await db.execute(
      `UPDATE users
       SET password = ?, must_change_password = 1, is_verified = 1,
           password_reset_token = NULL, password_reset_expires = NULL
       WHERE userId = ?`,
      [hashedPassword, id],
    );

    /* =================================================
        AUDIT LOG
      ================================================= */

    const targetName =
      user.name || user.display_name || user.email || `User #${id}`;

    await logAuditFromRequest(req, {
      category: "Security",
      action: "Reset user credentials",
      target: targetName,
      status: "Success",
      details:
        `User ID: ${id}; ` + `Role: ${user.role}; ` + `Email: ${user.email}`,
    });

    return res.json({
      success: true,
      message: "Temporary credentials generated.",
      email: user.email,
      temporaryPassword,
    });
  } catch (error) {
    console.error("Reset credentials error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to reset credentials.",
    });
  }
}

export async function permanentlyRemoveArchivedAccount(req, res) {
  const { id } = req.params;

  try {
    /* =================================================
       GET USER BEFORE DELETION
    ================================================= */

    const [existing] = await db.execute(
      `SELECT
        userId,
        role,
        name,
        display_name,
        email,
        is_archived
       FROM users
       WHERE userId = ?
       LIMIT 1`,
      [id],
    );

    const user = existing[0];

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    /* =================================================
       PROTECT SUPER ADMIN
    ================================================= */

    if (user.role === "super_admin") {
      return res.status(400).json({
        success: false,
        message: "The Super Admin account cannot be removed.",
      });
    }

    /* =================================================
       ONLY ARCHIVED ACCOUNTS CAN BE DELETED
    ================================================= */

    if (Number(user.is_archived) !== 1) {
      return res.status(400).json({
        success: false,
        message: "Only archived accounts can be permanently removed.",
      });
    }

    /* =================================================
       SAVE INFORMATION FOR AUDIT LOG
    ================================================= */

    const targetName =
      user.name || user.display_name || user.email || `User #${id}`;

    const deletedUserDetails =
      `User ID: ${id}; ` +
      `Role: ${user.role}; ` +
      `Email: ${user.email || "N/A"}`;

    /* =================================================
       DELETE USER
    ================================================= */

    await db.execute("DELETE FROM users WHERE userId = ?", [id]);

    /* =================================================
       AUDIT LOG
    ================================================= */

    await logAuditFromRequest(req, {
      category: "User Management",
      action: "Permanently deleted user account",
      target: targetName,
      status: "Success",
      details: deletedUserDetails,
    });

    /* =================================================
       RESPONSE
    ================================================= */

    return res.json({
      success: true,
      message: "Archived account permanently removed.",
      userId: Number(id),
    });
  } catch (error) {
    console.error("Remove archived account error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to remove archived account.",
    });
  }
}

export async function changeUserPassword(req, res) {
  const currentPassword = String(
    req.body.currentPassword || req.body.current_password || "",
  );

  const newPassword = String(
    req.body.newPassword || req.body.new_password || "",
  );

  const authenticatedUserId = req.user?.id || req.user?.userId;
  const authenticatedEmail = cleanEmail(req.user?.email);

  if (!authenticatedUserId && !authenticatedEmail) {
    return res.status(401).json({
      success: false,
      message: "You are not authenticated.",
    });
  }

  if (!currentPassword || !newPassword) {
    return res.status(400).json({
      success: false,
      message: "Current password and new password are required.",
    });
  }

  if (
    newPassword.length < 12 ||
    !/[A-Z]/.test(newPassword) ||
    !/[a-z]/.test(newPassword) ||
    !/[0-9]/.test(newPassword) ||
    !/[^A-Za-z0-9]/.test(newPassword)
  ) {
    return res.status(400).json({
      success: false,
      message:
        "New password must be at least 12 characters and include uppercase, lowercase, number, and symbol.",
    });
  }

  if (currentPassword === newPassword) {
    return res.status(400).json({
      success: false,
      message:
        "Your new password must be different from your current password.",
    });
  }

  try {
    let rows = [];

    if (authenticatedUserId) {
      [rows] = await db.execute(
        `SELECT userId, email, role, password, is_archived, must_change_password,
                onboarding_completed, student_tutorial_pending
         FROM users
         WHERE userId = ?
         LIMIT 1`,
        [authenticatedUserId],
      );
    } else {
      [rows] = await db.execute(
        `SELECT userId, email, role, password, is_archived, must_change_password,
                onboarding_completed, student_tutorial_pending
         FROM users
         WHERE email = ?
         LIMIT 1`,
        [authenticatedEmail],
      );
    }

    const user = rows[0];

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User account was not found.",
      });
    }

    if (Number(user.is_archived) === 1) {
      return res.status(403).json({
        success: false,
        message: "This account has been archived.",
      });
    }

    if (hasPendingStudentTutorial(user)) {
      return res.status(409).json({
        success: false,
        code: "STUDENT_TUTORIAL_REQUIRED",
        message: "Finish or skip the student tutorial before changing your password.",
      });
    }

    const currentPasswordIsValid = await bcrypt.compare(
      currentPassword,
      user.password,
    );

    if (!currentPasswordIsValid) {
      return res.status(401).json({
        success: false,
        message: "Current password is incorrect.",
      });
    }

    const newPasswordMatchesOldPassword = await bcrypt.compare(
      newPassword,
      user.password,
    );

    if (newPasswordMatchesOldPassword) {
      return res.status(400).json({
        success: false,
        message:
          "Your new password must be different from your current password.",
      });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);

    const [result] = await db.execute(
      `UPDATE users
       SET password = ?,
           must_change_password = 0,
           password_reset_token = NULL,
           password_reset_expires = NULL
       WHERE userId = ? AND password = ? AND is_archived = 0`,
      [hashedPassword, user.userId, user.password],
    );

    if (result.affectedRows !== 1) {
      return res.status(409).json({
        success: false,
        message: "Your account changed while updating the password. Please try again.",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Password changed successfully.",
    });
  } catch (error) {
    console.error("Change password error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to update password.",
    });
  }
}

export async function getProfile(req, res) {
  const email = cleanEmail(req.user.email);

  if (!email) {
    return res.status(400).json({
      success: false,
      message: "Email is required.",
    });
  }

  try {
    return sendUpdatedProfile(email, res);
  } catch (error) {
    console.error("Get profile error:", error);

    return res.status(500).json({
      success: false,
      message: "Could not load profile.",
    });
  }
}

export async function getCurrentUser(req, res) {
  try {
    const authenticatedUserId = req.user?.id || req.user?.userId;

    const authenticatedEmail = cleanEmail(req.user?.email);

    let rows = [];

    if (authenticatedUserId) {
      [rows] = await db.execute(
        `SELECT
          userId,
          email,
          role,
          name,
          display_name,
          profile_image,
          year_level,
          section_name, course,
          onboarding_completed,
          student_tutorial_pending,
          professor_tutorial_pending,
          is_verified,
          verification_id,
          student_id,

          professor_id,
          professor_faculty_id,
          professor_department,
          professor_position,
          professor_specialization,
          professor_employment_proof,

          verification_status,
          professor_admin_access,
          is_archived,
          archived_at,
          must_change_password,
          is_temporary,
          temporary_expires_at,
          created_at

        FROM users
        WHERE userId = ?
        LIMIT 1`,
        [authenticatedUserId],
      );
    } else if (authenticatedEmail) {
      [rows] = await db.execute(
        `SELECT
          userId,
          email,
          role,
          name,
          display_name,
          profile_image,
          year_level,
          section_name, course,
          onboarding_completed,
          student_tutorial_pending,
          professor_tutorial_pending,
          is_verified,
          verification_id,
          student_id,

          professor_id,
          professor_faculty_id,
          professor_department,
          professor_position,
          professor_specialization,
          professor_employment_proof,

          verification_status,
          professor_admin_access,
          is_archived,
          archived_at,
          must_change_password,
          is_temporary,
          temporary_expires_at,
          created_at

        FROM users
        WHERE email = ?
        LIMIT 1`,
        [authenticatedEmail],
      );
    } else {
      return res.status(401).json({
        success: false,
        message: "You are not authenticated.",
      });
    }

    const user = rows[0];

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    if (Number(user.is_archived) === 1) {
      return res.status(403).json({
        success: false,
        message: "This account has been archived.",
      });
    }

    return res.json({
      success: true,
      user: rowToSessionUser(user, req.user.role),
    });
  } catch (error) {
    console.error("Get current user error:", error);

    return res.status(500).json({
      success: false,
      message: "Could not load the logged-in user.",
    });
  }
}

export async function updateOnboardingName(req, res) {
  const email = cleanEmail(req.user.email);
  const displayName = cleanText(
    req.body.displayName || req.body.display_name || req.body.name,
  );

  if (!email || !displayName) {
    return res.status(400).json({
      success: false,
      message: "Email and display name are required.",
    });
  }

  if (displayName.length > 255) {
    return res.status(400).json({
      success: false,
      message: "Display name is too long.",
    });
  }

  try {
    const [result] = await db.execute(
      `UPDATE users
       SET name = ?, display_name = ?
       WHERE email = ?`,
      [displayName, displayName, email],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    return sendUpdatedProfile(email, res);
  } catch (error) {
    console.error("Update onboarding name error:", error);

    return res.status(500).json({
      success: false,
      message: "Could not update your name.",
    });
  }
}

export async function updateOnboardingYear(req, res) {
  const email = cleanEmail(req.user.email);
  const yearLevel = normalizeYearLevel(
    req.body.yearLevel || req.body.year_level,
  );

  if (!email || !yearLevel) {
    return res.status(400).json({
      success: false,
      message: "Email and year level are required.",
    });
  }

  try {
    const [result] = await db.execute(
      `UPDATE users
       SET year_level = ?, section_name = NULL
       WHERE email = ?`,
      [yearLevel, email],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    return sendUpdatedProfile(email, res);
  } catch (error) {
    console.error("Update onboarding year error:", error);

    return res.status(500).json({
      success: false,
      message: "Could not update year level.",
    });
  }
}

export async function updateOnboardingSection(req, res) {
  const email = cleanEmail(req.user.email);
  const sectionName = normalizeSectionName(
    req.body.sectionName || req.body.section_name || req.body.section,
  );
  const requestedYear = normalizeYearLevel(
    req.body.yearLevel || req.body.year_level,
  );

  if (!email || !sectionName) {
    return res.status(400).json({
      success: false,
      message: "Email and section are required.",
    });
  }

  try {
    const user = await getUserByEmail(email);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    const yearLevel = requestedYear || normalizeYearLevel(user.year_level);
    const yearNumber = getYearNumber(yearLevel);

    if (!yearNumber) {
      return res.status(400).json({
        success: false,
        message: "Please select your year level first.",
      });
    }

    if (sectionName.charAt(0) !== yearNumber) {
      return res.status(400).json({
        success: false,
        message: `Please choose a ${yearNumber}A-${yearNumber}F section for ${yearLevel}.`,
      });
    }

    await db.execute(
      `UPDATE users
       SET year_level = ?, section_name = ?
       WHERE email = ?`,
      [yearLevel, sectionName, email],
    );

    return sendUpdatedProfile(email, res);
  } catch (error) {
    console.error("Update onboarding section error:", error);

    return res.status(500).json({
      success: false,
      message: "Could not update section.",
    });
  }
}

export async function completeUserTutorial(req, res) {
  try {
    if (req.user.role === "professor") {
      const [result] = await db.execute(
        `UPDATE users SET professor_tutorial_pending = 0
         WHERE userId = ? AND role = 'professor'
           AND verification_status = 'approved' AND is_archived = 0`,
        [req.user.userId],
      );
      if (!result.affectedRows) {
        return res.status(409).json({
          success: false,
          message: "Your account status changed. Refresh and try again.",
        });
      }
      return res.json({
        success: true,
        user: { professorTutorialPending: false },
      });
    }
    await db.execute(
      `UPDATE users
       SET onboarding_completed = 1, student_tutorial_pending = 0
       WHERE userId = ? AND onboarding_completed = 0
         AND (student_tutorial_pending = 1 OR must_change_password = 1)`,
      [req.user.userId],
    );
    return res.json({ success: true });
  } catch (error) {
    console.error("Complete user tutorial error:", error);
    return res.status(500).json({
      success: false,
      message: "Could not save the tutorial. Please try again.",
    });
  }
}

export async function completeOnboarding(req, res) {
  const email = cleanEmail(req.user.email);

  if (!email) {
    return res.status(400).json({
      success: false,
      message: "Email is required.",
    });
  }

  try {
    const user = await getUserByEmail(email);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    const yearLevel = normalizeYearLevel(user.year_level);
    const sectionName = normalizeSectionName(user.section_name);
    const yearNumber = getYearNumber(yearLevel);

    if (
      !cleanText(user.display_name || user.name) ||
      !yearLevel ||
      !sectionName
    ) {
      return res.status(400).json({
        success: false,
        message: "Please finish your name, year, and section first.",
      });
    }

    if (sectionName.charAt(0) !== yearNumber) {
      return res.status(400).json({
        success: false,
        message: "Your section does not match your selected year level.",
      });
    }

    await db.execute(
      "UPDATE users SET onboarding_completed = 1 WHERE email = ?",
      [email],
    );

    const updatedUser = await getUserByEmail(email);

    return res.json({
      success: true,
      message: "Onboarding complete.",
      redirectPath: getDashboardPath(updatedUser.role),
      user: rowToUser(updatedUser),
    });
  } catch (error) {
    console.error("Complete onboarding error:", error);

    return res.status(500).json({
      success: false,
      message: "Could not complete onboarding.",
    });
  }
}
export async function updateProfileImage(req, res) {
  try {
    const authenticatedUserId =
      req.user?.id || req.user?.userId || req.user?.user_id;

    const authenticatedEmail = cleanEmail(req.user?.email);

    if (!authenticatedUserId && !authenticatedEmail) {
      return res.status(401).json({
        success: false,
        message: "You are not authenticated.",
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Please select a profile picture.",
      });
    }

    const profileImage = `/uploads/profile-images/${req.file.filename}`;

    let result;

    if (authenticatedUserId) {
      [result] = await db.execute(
        `
          UPDATE users
          SET profile_image = ?
          WHERE userId = ?
        `,
        [profileImage, authenticatedUserId],
      );
    } else {
      [result] = await db.execute(
        `
          UPDATE users
          SET profile_image = ?
          WHERE email = ?
        `,
        [profileImage, authenticatedEmail],
      );
    }

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: "User account was not found.",
      });
    }

    let rows = [];

    if (authenticatedUserId) {
      [rows] = await db.execute(
        `
          SELECT
            userId,
            email,
            role,
            name,
            display_name,
            profile_image,
            year_level,
            section_name, course,
            onboarding_completed,
            is_verified,
            verification_id,
            student_id,
            professor_id,
            professor_faculty_id,
            professor_department,
            professor_position,
            professor_specialization,
            professor_employment_proof,
            verification_status,
            professor_admin_access,
            is_archived,
            archived_at,
            must_change_password,
            is_temporary,
            temporary_expires_at,
            created_at
          FROM users
          WHERE userId = ?
          LIMIT 1
        `,
        [authenticatedUserId],
      );
    } else {
      [rows] = await db.execute(
        `
          SELECT
            userId,
            email,
            role,
            name,
            display_name,
            profile_image,
            year_level,
            section_name, course,
            onboarding_completed,
            is_verified,
            verification_id,
            student_id,
            professor_id,
            professor_faculty_id,
            professor_department,
            professor_position,
            professor_specialization,
            professor_employment_proof,
            verification_status,
            professor_admin_access,
            is_archived,
            archived_at,
            must_change_password,
            is_temporary,
            temporary_expires_at,
            created_at
          FROM users
          WHERE email = ?
          LIMIT 1
        `,
        [authenticatedEmail],
      );
    }

    const updatedUser = rows[0];

    if (!updatedUser) {
      return res.status(404).json({
        success: false,
        message: "Updated user account could not be loaded.",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Profile picture updated successfully.",
      user: rowToSessionUser(updatedUser, req.user.role),
    });
  } catch (error) {
    console.error("Update profile image error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to update profile picture.",
    });
  }
}
export async function logBulkStudentImport(req, res) {
  const fileName = cleanText(req.body.fileName);
  const importedCount = Number(req.body.importedCount || 0);
  const failedCount = Number(req.body.failedCount || 0);
  const totalCount = Number(req.body.totalCount || 0);

  if (!fileName) {
    return res.status(400).json({
      success: false,
      message: "Import file name is required.",
    });
  }

  try {
    await logAuditFromRequest(req, {
      category: "User Management",
      action: "Bulk student import",
      target: fileName,
      status: failedCount > 0 ? "Partial Success" : "Success",
      details:
        `Total Records: ${totalCount}; ` +
        `Imported: ${importedCount}; ` +
        `Failed: ${failedCount}`,
    });

    return res.json({
      success: true,
      message: "Bulk student import recorded.",
    });
  } catch (error) {
    console.error("Bulk student import audit error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to record bulk student import.",
    });
  }
}
