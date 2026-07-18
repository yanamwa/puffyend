import express from "express";
import {
  changeUserPassword,
  completeOnboarding,
  createAdminAccount,
  createProfessorAccount,
  createStudentAccount,
  getProfile,
  getUsers,
  getUserById,
  permanentlyRemoveArchivedAccount,
  resetUserCredentials,
  updateAccountArchive,
  updateOnboardingName,
  updateOnboardingSection,
  updateOnboardingYear,
  updateProfessorRegistration,
} from "../controllers/userController.js";

const router = express.Router();

router.get("/users", getUsers);
router.post("/users/admin", createAdminAccount);
router.post("/users/professor", createProfessorAccount);
router.post("/users/student", createStudentAccount);
router.get("/users/:id", getUserById);
router.patch("/users/:id/registration", updateProfessorRegistration);
router.patch("/users/:id/archive", updateAccountArchive);
router.post("/users/:id/reset-credentials", resetUserCredentials);
router.delete("/users/:id/archived", permanentlyRemoveArchivedAccount);
router.post("/users/change-password", changeUserPassword);
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
