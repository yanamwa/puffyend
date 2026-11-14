import express from "express";
import { sendContactMessageEmail } from "../utils/mailer.js";

const router = express.Router();
const MESSAGE_LIMIT = 3;
const MESSAGE_WINDOW_MS = 24 * 60 * 60 * 1000;
const submissionsByEmail = new Map();

router.post("/", async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const email = String(req.body?.email || "").trim();
  const message = String(req.body?.message || "").trim();

  if (!name || !email || !message) {
    return res.status(400).json({
      success: false,
      message: "Please fill out all fields.",
    });
  }
  if (name.length > 120 || email.length > 254 || message.length > 5000) {
    return res.status(400).json({
      success: false,
      message: "Please shorten your message and try again.",
    });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({
      success: false,
      message: "Please enter a valid email address.",
    });
  }

  const key = email.toLowerCase();
  const now = Date.now();
  const recentSubmissions = (submissionsByEmail.get(key) || []).filter(
    (submission) => now - submission.timestamp < MESSAGE_WINDOW_MS,
  );
  if (recentSubmissions.length >= MESSAGE_LIMIT) {
    return res.status(429).json({
      success: false,
      message: "You can only send 3 messages.",
    });
  }

  const submission = { timestamp: now };
  recentSubmissions.push(submission);
  submissionsByEmail.set(key, recentSubmissions);

  try {
    await sendContactMessageEmail({ name, email, message });
    return res.json({
      success: true,
      message: "Thank you for reaching out. We'll get back to you soon.",
    });
  } catch (error) {
    submissionsByEmail.set(
      key,
      recentSubmissions.filter((item) => item !== submission),
    );
    console.error("Contact message delivery failed:", error.message);
    return res.status(error.code === "SMTP_CONFIG_MISSING" ? 503 : 502).json({
      success: false,
      message: "We couldn't send your message. Please try again.",
    });
  }
});

export default router;
