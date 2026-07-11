import express from "express";
import {
  completeOnboarding,
  getProfile,
  getUsers,
  getUserById,
  updateOnboardingName,
  updateOnboardingSection,
  updateOnboardingYear,
} from "../controllers/userController.js";

const router = express.Router();

router.get("/users", getUsers);
router.get("/users/:id", getUserById);
router.get("/", getUsers);
router.get("/:id", getUserById);

router.post("/profile", getProfile);
router.post("/onboarding/name", updateOnboardingName);
router.post("/onboarding/year", updateOnboardingYear);
router.post("/onboarding/section", updateOnboardingSection);
router.post("/onboarding/complete", completeOnboarding);

router.post("/get-profile.php", getProfile);
router.post("/update-name.php", updateOnboardingName);
router.post("/update-year.php", updateOnboardingYear);
router.post("/update-section.php", updateOnboardingSection);
router.post("/complete-onboarding.php", completeOnboarding);

export default router;
