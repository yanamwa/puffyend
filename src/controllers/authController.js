import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { db } from "../db.js";
import { sendOtpEmail } from "../utils/mailer.js";

const JWT_SECRET = process.env.JWT_SECRET || "puffybrain-secret";

function createOtp() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

function authUserPayload(user) {
  const displayName = user.display_name || user.name || "";

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
  };
}

export async function signup(req, res) {
  const {
    email,
    password,
    role,
    name,
    verificationId,
    studentId,
    professorId,
  } = req.body;
  const cleanEmail = email?.toString().trim().toLowerCase();
  const cleanName = name?.toString().trim();
  const requestedRole = role === "student" || role === "professor" ? role : "";
  const roleVerificationId = (
    requestedRole === "student"
      ? studentId || verificationId
      : professorId || verificationId
  )
    ?.toString()
    .trim();

  if (!cleanEmail || !password || !cleanName || !role) {
    return res.status(400).json({
      success: false,
      message: "Missing required fields.",
    });
  }

  if (!requestedRole) {
    return res.status(400).json({
      success: false,
      message: "Please choose Student or Professor.",
    });
  }

  if (!roleVerificationId) {
    return res.status(400).json({
      success: false,
      message:
        requestedRole === "student"
          ? "Student ID is required."
          : "Professor verification ID is required.",
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

    const [existingVerification] = await db.execute(
      "SELECT userId FROM users WHERE role = ? AND verification_id = ? LIMIT 1",
      [requestedRole, roleVerificationId]
    );

    if (existingVerification.length > 0) {
      return res.status(409).json({
        success: false,
        message:
          requestedRole === "student"
            ? "This Student ID is already registered."
            : "This Professor ID is already registered.",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const otp = createOtp();
    const otpExpires = new Date(Date.now() + 5 * 60 * 1000);
    const submittedStudentId =
      requestedRole === "student" ? roleVerificationId : null;
    const submittedProfessorId =
      requestedRole === "professor" ? roleVerificationId : null;

    const [result] = await db.execute(
      `INSERT INTO users 
      (email, password, role, name, display_name, verification_id, student_id,
       professor_id, verification_status, otp_code, otp_expires, is_verified,
       onboarding_completed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 0, 0)`,
      [
        cleanEmail,
        hashedPassword,
        requestedRole,
        cleanName,
        cleanName,
        roleVerificationId,
        submittedStudentId,
        submittedProfessorId,
        otp,
        otpExpires,
      ]
    );

    try {
      await sendOtpEmail(cleanEmail, cleanName, otp);

      return res.json({
        success: true,
        message: "Verification code sent to your email.",
        email: cleanEmail,
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

    const token = jwt.sign(
      {
        id: user.userId,
        userId: user.userId,
        email: user.email,
        role: user.role,
        name: user.name,
        verificationStatus: user.verification_status,
      },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.json({
      success: true,
      message: "Login successful.",
      token,
      email: user.email,
      username: user.name,
      isNewUser:
        (user.role === "student" || user.role === "professor") &&
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
