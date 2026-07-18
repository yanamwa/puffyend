import { db } from "../db.js";
import bcrypt from "bcrypt";
import crypto from "crypto";

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

function normalizeYearLevel(value) {
  const cleaned = cleanText(value);
  const alias = YEAR_ALIASES.get(cleaned.toLowerCase());

  if (alias) return alias;

  return YEAR_LEVELS.includes(cleaned) ? cleaned : "";
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
      body.expires_at
  );
  const rawDays = cleanText(
    body.temporaryDurationDays ||
      body.temporary_duration_days ||
      body.durationDays ||
      body.duration_days
  );
  let temporaryExpiresAt = null;

  if (rawExpiresAt) {
    temporaryExpiresAt = new Date(rawExpiresAt);
  } else {
    const durationDays = rawDays ? Number(rawDays) : DEFAULT_TEMPORARY_ACCOUNT_DAYS;

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
      Date.now() + durationDays * 24 * 60 * 60 * 1000
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

  const verificationStatus = normalizeVerificationStatus(user.verification_status);

  if (verificationStatus === "declined") return "Declined";
  if (user.role === "professor" && verificationStatus === "pending") {
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
      allCharacters[crypto.randomInt(allCharacters.length)]
    );
  }

  return requiredCharacters
    .sort(() => crypto.randomInt(3) - 1)
    .join("");
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
    name: user.name,
    displayName,
    display_name: displayName,
    yearLevel: user.year_level || "",
    year_level: user.year_level || "",
    sectionName: user.section_name || "",
    section_name: user.section_name || "",
    onboardingCompleted: Number(user.onboarding_completed) === 1,
    onboarding_completed: Number(user.onboarding_completed) === 1 ? 1 : 0,
    verified: user.is_verified === 1,
    is_verified: user.is_verified,
    verificationId: user.verification_id,
    verification_id: user.verification_id,
    studentId: user.student_id,
    student_id: user.student_id,
    professorId: user.professor_id,
    professor_id: user.professor_id,
    professorFacultyId: user.professor_faculty_id,
    professor_faculty_id: user.professor_faculty_id,
    professorDepartment: user.professor_department,
    professor_department: user.professor_department,
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
  };
}

async function getUserByEmail(email) {
  const [rows] = await db.execute(
    `SELECT userId, email, role, name, display_name, year_level, section_name,
            onboarding_completed, is_verified, verification_id, student_id,
            professor_id, professor_faculty_id, professor_department,
            professor_employment_proof, verification_status, is_archived,
            archived_at, must_change_password, is_temporary,
            temporary_expires_at, created_at
     FROM users
     WHERE email = ?
     LIMIT 1`,
    [email]
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
      `SELECT userId AS id, email, role, name, display_name, year_level,
       section_name, onboarding_completed, is_verified, verification_id,
       student_id, professor_id, professor_faculty_id, professor_department,
       professor_employment_proof, verification_status, is_archived,
       archived_at, must_change_password, is_temporary, temporary_expires_at,
       created_at
       FROM users
       ORDER BY userId DESC`
    );

    return res.json({
      success: true,
      users: rows.map(rowToUser),
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
       section_name, onboarding_completed, is_verified, verification_id,
       student_id, professor_id, professor_faculty_id, professor_department,
       professor_employment_proof, verification_status, is_archived,
       archived_at, must_change_password, is_temporary, temporary_expires_at,
       created_at
       FROM users
       WHERE userId = ?
       LIMIT 1`,
      [id]
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
  const email = cleanEmail(req.body.email);
  const name = cleanText(req.body.name || req.body.displayName);
  const studentId = cleanText(req.body.studentId || req.body.student_id);
  const yearLevel = normalizeYearLevel(req.body.yearLevel || req.body.year_level);
  const sectionName = normalizeSectionName(
    req.body.sectionName || req.body.section_name || req.body.section
  );
  const temporaryAccount = getTemporaryAccountSettings(req.body);

  if (!email || !name) {
    return res.status(400).json({
      success: false,
      message: "Student name and email are required.",
    });
  }

  if (temporaryAccount.error) {
    return res.status(400).json({
      success: false,
      message: temporaryAccount.error,
    });
  }

  if (studentId.length > 100) {
    return res.status(400).json({
      success: false,
      message: "Student ID is too long.",
    });
  }

  if (sectionName) {
    const yearNumber = getYearNumber(yearLevel);

    if (!yearNumber || sectionName.charAt(0) !== yearNumber) {
      return res.status(400).json({
        success: false,
        message: "Section must match the selected year level.",
      });
    }
  }

  try {
    const [existingEmail] = await db.execute(
      "SELECT userId FROM users WHERE email = ? LIMIT 1",
      [email]
    );

    if (existingEmail.length > 0) {
      return res.status(409).json({
        success: false,
        message: "Email is already registered.",
      });
    }

    if (studentId) {
      const [existingStudentId] = await db.execute(
        "SELECT userId FROM users WHERE role = 'student' AND student_id = ? LIMIT 1",
        [studentId]
      );

      if (existingStudentId.length > 0) {
        return res.status(409).json({
          success: false,
          message: "This Student ID is already registered.",
        });
      }
    }

    const temporaryPassword = generateTemporaryPassword();
    const hashedPassword = await bcrypt.hash(temporaryPassword, 10);
    const onboardingCompleted = yearLevel && sectionName ? 1 : 0;

    const [result] = await db.execute(
      `INSERT INTO users
       (email, password, role, name, display_name, verification_id, student_id,
        verification_status, is_verified, onboarding_completed, year_level,
        section_name, must_change_password, is_archived, is_temporary,
        temporary_expires_at)
       VALUES (?, ?, 'student', ?, ?, ?, ?, 'approved', 1, ?, ?, ?, 1, 0, ?, ?)`,
      [
        email,
        hashedPassword,
        name,
        name,
        studentId || null,
        studentId || null,
        onboardingCompleted,
        yearLevel || null,
        sectionName || null,
        temporaryAccount.isTemporary,
        temporaryAccount.temporaryExpiresAt,
      ]
    );

    const [rows] = await db.execute(
      `SELECT userId AS id, email, role, name, display_name, year_level,
       section_name, onboarding_completed, is_verified, verification_id,
       student_id, professor_id, professor_faculty_id, professor_department,
       professor_employment_proof, verification_status, is_archived,
       archived_at, must_change_password, is_temporary, temporary_expires_at,
       created_at
       FROM users
       WHERE userId = ?
       LIMIT 1`,
      [result.insertId]
    );

    return res.status(201).json({
      success: true,
      message: "Student account created.",
      temporaryPassword,
      user: rowToUser(rows[0]),
    });
  } catch (error) {
    console.error("Create student error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to create student account.",
    });
  }
}

export async function createAdminAccount(req, res) {
  const email = cleanEmail(req.body.email);
  const name = cleanText(req.body.name || req.body.displayName);
  const temporaryAccount = getTemporaryAccountSettings(req.body);

  if (!email || !name) {
    return res.status(400).json({
      success: false,
      message: "Admin name and email are required.",
    });
  }

  if (temporaryAccount.error) {
    return res.status(400).json({
      success: false,
      message: temporaryAccount.error,
    });
  }

  try {
    const [existingEmail] = await db.execute(
      "SELECT userId FROM users WHERE email = ? LIMIT 1",
      [email]
    );

    if (existingEmail.length > 0) {
      return res.status(409).json({
        success: false,
        message: "Email is already registered.",
      });
    }

    const temporaryPassword = generateTemporaryPassword();
    const hashedPassword = await bcrypt.hash(temporaryPassword, 10);

    const [result] = await db.execute(
      `INSERT INTO users
       (email, password, role, name, display_name, verification_status,
        is_verified, onboarding_completed, must_change_password, is_archived,
        is_temporary, temporary_expires_at)
       VALUES (?, ?, 'admin', ?, ?, 'approved', 1, 1, 1, 0, ?, ?)`,
      [
        email,
        hashedPassword,
        name,
        name,
        temporaryAccount.isTemporary,
        temporaryAccount.temporaryExpiresAt,
      ]
    );

    const [rows] = await db.execute(
      `SELECT userId AS id, email, role, name, display_name, year_level,
       section_name, onboarding_completed, is_verified, verification_id,
       student_id, professor_id, professor_faculty_id, professor_department,
       professor_employment_proof, verification_status, is_archived,
       archived_at, must_change_password, is_temporary, temporary_expires_at,
       created_at
       FROM users
       WHERE userId = ?
       LIMIT 1`,
      [result.insertId]
    );

    return res.status(201).json({
      success: true,
      message: "Admin account created.",
      temporaryPassword,
      user: rowToUser(rows[0]),
    });
  } catch (error) {
    console.error("Create admin error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to create admin account.",
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
      req.body.employee_id
  );
  const department = cleanText(
    req.body.department || req.body.professorDepartment
  );
  const employmentProof = cleanText(
    req.body.employmentProof ||
      req.body.proofOfEmployment ||
      req.body.professorEmploymentProof
  );
  const temporaryAccount = getTemporaryAccountSettings(req.body);

  if (!email || !name) {
    return res.status(400).json({
      success: false,
      message: "Professor name and email are required.",
    });
  }

  if (facultyId.length > 100) {
    return res.status(400).json({
      success: false,
      message: "Faculty ID is too long.",
    });
  }

  if (temporaryAccount.error) {
    return res.status(400).json({
      success: false,
      message: temporaryAccount.error,
    });
  }

  try {
    const [existingEmail] = await db.execute(
      "SELECT userId FROM users WHERE email = ? LIMIT 1",
      [email]
    );

    if (existingEmail.length > 0) {
      return res.status(409).json({
        success: false,
        message: "Email is already registered.",
      });
    }

    const temporaryPassword = generateTemporaryPassword();
    const hashedPassword = await bcrypt.hash(temporaryPassword, 10);

    const [result] = await db.execute(
      `INSERT INTO users
       (email, password, role, name, display_name, professor_id,
        professor_faculty_id, professor_department, professor_employment_proof,
        verification_status, is_verified, onboarding_completed,
        must_change_password, is_archived, is_temporary, temporary_expires_at)
       VALUES (?, ?, 'professor', ?, ?, ?, ?, ?, ?, 'approved', 1, 1, 1, 0, ?, ?)`,
      [
        email,
        hashedPassword,
        name,
        name,
        facultyId || null,
        facultyId || null,
        department || null,
        employmentProof || null,
        temporaryAccount.isTemporary,
        temporaryAccount.temporaryExpiresAt,
      ]
    );

    const [rows] = await db.execute(
      `SELECT userId AS id, email, role, name, display_name, year_level,
       section_name, onboarding_completed, is_verified, verification_id,
       student_id, professor_id, professor_faculty_id, professor_department,
       professor_employment_proof, verification_status, is_archived,
       archived_at, must_change_password, is_temporary, temporary_expires_at,
       created_at
       FROM users
       WHERE userId = ?
       LIMIT 1`,
      [result.insertId]
    );

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
  const status = normalizeVerificationStatus(req.body.status || req.body.action);

  if (!status || status === "pending") {
    return res.status(400).json({
      success: false,
      message: "Choose approved or declined.",
    });
  }

  try {
    const [existing] = await db.execute(
      "SELECT userId, role FROM users WHERE userId = ? LIMIT 1",
      [id]
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

    await db.execute(
      "UPDATE users SET verification_status = ? WHERE userId = ?",
      [status, id]
    );

    const [rows] = await db.execute(
      `SELECT userId AS id, email, role, name, display_name, year_level,
       section_name, onboarding_completed, is_verified, verification_id,
       student_id, professor_id, professor_faculty_id, professor_department,
       professor_employment_proof, verification_status, is_archived,
       archived_at, must_change_password, is_temporary, temporary_expires_at,
       created_at
       FROM users
       WHERE userId = ?
       LIMIT 1`,
      [id]
    );

    return res.json({
      success: true,
      message:
        status === "approved"
          ? "Professor registration approved."
          : "Professor registration declined.",
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

  try {
    const [existing] = await db.execute(
      "SELECT userId, role FROM users WHERE userId = ? LIMIT 1",
      [id]
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

    await db.execute(
      `UPDATE users
       SET is_archived = ?, archived_at = ?
       WHERE userId = ?`,
      [archive ? 1 : 0, archive ? new Date() : null, id]
    );

    const [rows] = await db.execute(
      `SELECT userId AS id, email, role, name, display_name, year_level,
       section_name, onboarding_completed, is_verified, verification_id,
       student_id, professor_id, professor_faculty_id, professor_department,
       professor_employment_proof, verification_status, is_archived,
       archived_at, must_change_password, is_temporary, temporary_expires_at,
       created_at
       FROM users
       WHERE userId = ?
       LIMIT 1`,
      [id]
    );

    return res.json({
      success: true,
      message: archive ? "Account archived." : "Account restored.",
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
      "SELECT userId, role, email FROM users WHERE userId = ? LIMIT 1",
      [id]
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
       SET password = ?, must_change_password = 1, is_verified = 1
       WHERE userId = ?`,
      [hashedPassword, id]
    );

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
    const [existing] = await db.execute(
      "SELECT userId, role, is_archived FROM users WHERE userId = ? LIMIT 1",
      [id]
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
        message: "The Super Admin account cannot be removed.",
      });
    }

    if (Number(user.is_archived) !== 1) {
      return res.status(400).json({
        success: false,
        message: "Only archived accounts can be permanently removed.",
      });
    }

    await db.execute("DELETE FROM users WHERE userId = ?", [id]);

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
  const email = cleanEmail(req.body.email);
  const currentPassword = cleanText(req.body.currentPassword || req.body.current_password);
  const newPassword = cleanText(req.body.newPassword || req.body.new_password);

  if (!email || !currentPassword || !newPassword) {
    return res.status(400).json({
      success: false,
      message: "Email, current password, and new password are required.",
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

  try {
    const [rows] = await db.execute(
      "SELECT userId, password FROM users WHERE email = ? LIMIT 1",
      [email]
    );

    const user = rows[0];

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    const validPassword = await bcrypt.compare(currentPassword, user.password);

    if (!validPassword) {
      return res.status(401).json({
        success: false,
        message: "Current password is incorrect.",
      });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await db.execute(
      "UPDATE users SET password = ?, must_change_password = 0 WHERE userId = ?",
      [hashedPassword, user.userId]
    );

    return res.json({
      success: true,
      message: "Password updated.",
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
  const email = cleanEmail(req.body.email || req.query.email);

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

export async function updateOnboardingName(req, res) {
  const email = cleanEmail(req.body.email);
  const displayName = cleanText(req.body.displayName || req.body.display_name || req.body.name);

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
      [displayName, displayName, email]
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
  const email = cleanEmail(req.body.email);
  const yearLevel = normalizeYearLevel(req.body.yearLevel || req.body.year_level);

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
      [yearLevel, email]
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
  const email = cleanEmail(req.body.email);
  const sectionName = normalizeSectionName(
    req.body.sectionName || req.body.section_name || req.body.section
  );
  const requestedYear = normalizeYearLevel(req.body.yearLevel || req.body.year_level);

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
      [yearLevel, sectionName, email]
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

export async function completeOnboarding(req, res) {
  const email = cleanEmail(req.body.email);

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

    if (!cleanText(user.display_name || user.name) || !yearLevel || !sectionName) {
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
      [email]
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
