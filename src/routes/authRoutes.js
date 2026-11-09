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

<<<<<<< HEAD
router.post("/signup", signupLimiter, handleSignupUpload, signup);
router.post("/login", loginLimiter, login);
router.post("/logout", authenticateUser, logout);
router.post("/verify-email", recoveryLimiter, verifyEmail);
router.post("/resend-otp", recoveryLimiter, resendOtp);
router.post("/forgot-password", recoveryLimiter, forgotPassword);
router.post("/reset-password", recoveryLimiter, resetPassword);
router.post("/forgot-password.php", recoveryLimiter, forgotPassword);
router.post("/change-password.php", recoveryLimiter, resetPassword);
=======
router.post("/signup", handleSignupUpload, signup);
router.post("/login", login);
router.post("/switch-role", authenticateUser, switchProfessorRole);
router.post("/logout", authenticateAccountSetup, logout);
router.post("/verify-email", verifyEmail);
router.post("/resend-otp", resendOtp);
router.post("/forgot-password", forgotPassword);
router.post("/reset-password", resetPassword);
router.post("/forgot-password.php", forgotPassword);
router.post("/change-password.php", resetPassword);
>>>>>>> a67d8a6b23d408c9b8f48f28f9262d50e3f80bff

export default router;
