import express from "express";
import {
  signup,
  login,
  verifyEmail,
  resendOtp,
} from "../controllers/authController.js";

const router = express.Router();

router.post("/signup", signup);
router.post("/login", login);
router.post("/verify-email", verifyEmail);
router.post("/resend-otp", resendOtp);

export default router;