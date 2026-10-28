import { rateLimit } from "express-rate-limit";
const options = {
  windowMs: 15 * 60 * 1000,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many attempts. Please try again later.",
  },
};
export const loginLimiter = rateLimit({ ...options, limit: 10 });
export const recoveryLimiter = rateLimit({ ...options, limit: 10 });
export const signupLimiter = rateLimit({ ...options, limit: 10 });
