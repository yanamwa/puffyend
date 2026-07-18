import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { db } from "../db.js";
import { sendOtpEmail } from "../utils/mailer.js";

const JWT_SECRET = process.env.JWT_SECRET || "puffybrain-secret";

function createOtp() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

function isTemporaryAccountExpired(user) {
  if (Number(user.is_temporary) !== 1 || !user.temporary_expires_at) {
    return false;
  }

  const expiresAt = new Date(user.temporary_expires_at);
  return !Number.isNaN(expiresAt.getTime()) && expiresAt <= new Date();
}

function authUserPayload(user) {
  const displayName = user.display_name || user.name || "";
  const isTemporary = Number(user.is_temporary) === 1;
  const temporaryExpired = isTemporaryAccountExpired(user);

  return {
    id: user.userId,
    userId: user.userId,
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
  } = req.body;
  const cleanEmail = email?.toString().trim().toLowerCase();
  const cleanName = name?.toString().trim();
  const cleanFacultyId = (facultyId || employeeId || "").toString().trim();
  const cleanDepartment = (department || "").toString().trim();
  const cleanEmploymentProof = (employmentProof || proofOfEmployment || "")
    .toString()
    .trim();
  const requestedRole = role === "professor" ? "professor" : "";

  if (!cleanEmail || !password || !cleanName) {
    return res.status(400).json({
      success: false,
      message: "Missing required fields.",
    });
  }

  if (!requestedRole) {
    return res.status(400).json({
      success: false,
      message: "Public sign up is only available for professors.",
    });
  }

  try {
    const [existing] = await db.execute(
      "SELECT userId FROM users WHERE email = ? LIMIT 1",
      [cleanEmail]
    );

    if (existing.length > 0) {
      return res.status(409).json({
        success: false,
        message: "Email is already registered.",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const otp = createOtp();
    const otpExpires = new Date(Date.now() + 5 * 60 * 1000);

    const [result] = await db.execute(
      `INSERT INTO users 
      (email, password, role, name, display_name, verification_id, student_id,
       professor_id, professor_faculty_id, professor_department,
       professor_employment_proof, verification_status, otp_code, otp_expires,
       is_verified, onboarding_completed)
      VALUES (?, ?, 'professor', ?, ?, NULL, NULL, NULL, ?, ?, ?, 'pending', ?, ?, 0, 1)`,
      [
        cleanEmail,
        hashedPassword,
        cleanName,
        cleanName,
        cleanFacultyId || null,
        cleanDepartment || null,
        cleanEmploymentProof || null,
        otp,
        otpExpires,
      ]
    );

    try {
      await sendOtpEmail(cleanEmail, cleanName, otp);

      return res.json({
        success: true,
        message:
          "Verification code sent to your email. Your professor account will be reviewed by the Super Admin after email verification.",
        email: cleanEmail,
        requiresApproval: true,
      });
    } catch (emailError) {
      await db.execute(
        "DELETE FROM users WHERE userId = ? AND is_verified = 0",
        [result.insertId]
      );

      return res.status(500).json({
        success: false,
        message: "Email failed: " + emailError.message,
      });
    }
  } catch (error) {
    console.error("Signup error:", error);

    return res.status(500).json({
      success: false,
      message: "Signup failed.",
    });
  }
}

export async function verifyEmail(req, res) {
  const { email, otp } = req.body;

  if (!email || !otp) {
    return res.status(400).json({
      success: false,
      message: "Email and OTP are required.",
    });
  }

  try {
    const [rows] = await db.execute(
      "SELECT * FROM users WHERE email = ? LIMIT 1",
      [email]
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
      });
    }

    if (user.otp_code !== otp) {
      return res.status(400).json({
        success: false,
        message: "Wrong OTP. Make sure to input the correct code.",
      });
    }

    if (new Date(user.otp_expires) < new Date()) {
      return res.status(400).json({
        success: false,
        message: "OTP has expired.",
      });
    }

    await db.execute(
      `UPDATE users 
       SET is_verified = 1, otp_code = NULL, otp_expires = NULL 
       WHERE userId = ?`,
      [user.userId]
    );

    return res.json({
      success: true,
      message: "Email verified successfully.",
    });
  } catch (error) {
    console.error("Verify email error:", error);

    return res.status(500).json({
      success: false,
      message: "Verification failed.",
    });
  }
}

export async function resendOtp(req, res) {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({
      success: false,
      message: "Email is required.",
    });
  }

  try {
    const [rows] = await db.execute(
      "SELECT * FROM users WHERE email = ? LIMIT 1",
      [email]
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

    const otp = createOtp();
    const otpExpires = new Date(Date.now() + 5 * 60 * 1000);

    await db.execute(
      "UPDATE users SET otp_code = ?, otp_expires = ? WHERE userId = ?",
      [otp, otpExpires, user.userId]
    );

    await sendOtpEmail(user.email, user.name, otp);

    return res.json({
      success: true,
      message: "New verification code sent.",
    });
  } catch (error) {
    console.error("Resend OTP error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to resend OTP.",
    });
  }
}

export async function login(req, res) {
  const { email, username, password } = req.body;
  const loginEmail = (email || username || "").trim().toLowerCase();

  if (!loginEmail || !password) {
    return res.status(400).json({
      success: false,
      message: "Missing required fields.",
    });
  }

  try {
    const [rows] = await db.execute(
      "SELECT * FROM users WHERE email = ? LIMIT 1",
      [loginEmail]
    );

    const user = rows[0];

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials.",
      });
    }

    const validPassword = await bcrypt.compare(password, user.password);

    if (!validPassword) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials.",
      });
    }

    if (user.is_verified !== 1) {
      return res.status(403).json({
        success: false,
        message: "Please verify your email first.",
        email: user.email,
      });
    }

    if (Number(user.is_archived) === 1) {
      return res.status(403).json({
        success: false,
        message: "This account is archived. Please contact the Super Admin.",
      });
    }

    if (isTemporaryAccountExpired(user)) {
      return res.status(403).json({
        success: false,
        message: "This temporary account has expired. Please contact the Super Admin.",
      });
    }

    const verificationStatus = String(
      user.verification_status || "pending"
    ).toLowerCase();

    if (user.role === "professor" && verificationStatus !== "approved") {
      const isDeclined = verificationStatus === "declined";

      return res.status(403).json({
        success: false,
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
            Math.floor((temporaryExpiresAt.getTime() - Date.now()) / 1000)
          )
        : tokenMaxAgeSeconds;

    const token = jwt.sign(
      {
        id: user.userId,
        userId: user.userId,
        email: user.email,
        role: user.role,
        name: user.name,
        verificationStatus: user.verification_status,
        verification_status: user.verification_status,
      },
      JWT_SECRET,
      { expiresIn: Math.min(tokenMaxAgeSeconds, temporaryRemainingSeconds) }
    );

    return res.json({
      success: true,
      message: "Login successful.",
      token,
      email: user.email,
      username: user.name,
      isNewUser:
        user.role === "student" &&
        Number(user.onboarding_completed) !== 1,
      user: authUserPayload(user),
    });
  } catch (error) {
    console.error("Login error:", error);

    return res.status(500).json({
      success: false,
      message: "Login failed.",
    });
  }
}
