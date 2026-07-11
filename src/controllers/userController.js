import { db } from "../db.js";

const YEAR_LEVELS = ["1st Year", "2nd Year", "3rd Year", "4th Year"];
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

function getDashboardPath(role) {
  if (role === "admin") return "/admin";
  if (role === "professor") return "/professor";
  return "/student";
}

function rowToUser(user) {
  const displayName = user.display_name || user.name || "";

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
    verificationStatus: user.verification_status,
    verification_status: user.verification_status,
    status: "Active",
    joined: user.created_at,
    created_at: user.created_at,
  };
}

async function getUserByEmail(email) {
  const [rows] = await db.execute(
    `SELECT userId, email, role, name, display_name, year_level, section_name,
            onboarding_completed, is_verified, verification_id, student_id,
            professor_id, verification_status, created_at
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
       student_id, professor_id, verification_status, created_at
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
       student_id, professor_id, verification_status, created_at
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
