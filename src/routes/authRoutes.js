import { loginLimiter, recoveryLimiter, signupLimiter } from "../middleware/authRateLimits.js";
import express from "express";
import {
  forgotPassword,
  signup,
  login,
  logout,
  recordSessionActivity,
  resetPassword,
  verifyEmail,
  resendOtp,
  switchProfessorRole,
} from "../controllers/authController.js";
import professorProofUpload from "../middleware/professorProofUpload.js";
import authenticateUser, { authenticateAccountSetup } from "../middleware/authMiddleware.js";

const router = express.Router();

function handleSignupUpload(req, res, next) {
  professorProofUpload.single("employmentProof")(req, res, (error) => {
    if (!error) {
      next();
      return;
    }

    let message = error.message || "ID photo upload failed.";

    if (error.code === "LIMIT_FILE_SIZE") {
      message = "The uploaded ID photo must not exceed 5 MB.";
    }

    res.status(error.statusCode || 400).json({
      success: false,
      message,
    });
  });
}

router.post("/signup", signupLimiter, handleSignupUpload, signup);
router.post("/login", loginLimiter, login);
router.post("/switch-role", authenticateUser, switchProfessorRole);
router.post("/logout", authenticateAccountSetup, logout);
router.post("/activity", authenticateAccountSetup, recordSessionActivity);
router.post("/verify-email", verifyEmail);
router.post("/resend-otp", resendOtp);
router.post("/forgot-password", forgotPassword);
router.post("/reset-password", resetPassword);
router.post("/forgot-password.php", forgotPassword);
router.post("/change-password.php", resetPassword);

export default router;
