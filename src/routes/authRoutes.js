import { loginLimiter, recoveryLimiter, signupLimiter } from "../middleware/authRateLimits.js";
import express from "express";
import {
  forgotPassword,
  signup,
  login,
  logout,
  resetPassword,
  verifyEmail,
  resendOtp,
} from "../controllers/authController.js";
import professorProofUpload from "../middleware/professorProofUpload.js";
import authenticateUser from "../middleware/authMiddleware.js";

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
router.post("/logout", authenticateUser, logout);
router.post("/verify-email", recoveryLimiter, verifyEmail);
router.post("/resend-otp", recoveryLimiter, resendOtp);
router.post("/forgot-password", recoveryLimiter, forgotPassword);
router.post("/reset-password", recoveryLimiter, resetPassword);
router.post("/forgot-password.php", recoveryLimiter, forgotPassword);
router.post("/change-password.php", recoveryLimiter, resetPassword);

export default router;
