import express from "express";
import authenticateUser from "../middleware/authMiddleware.js";
import uploadProfileImage from "../middleware/profileImageUpload.js";

import {
  changeUserPassword,
  completeOnboarding,
  createAdminAccount,
  createProfessorAccount,
  createStudentAccount,
  getCurrentUser,
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
  updateProfileImage,
} from "../controllers/userController.js";

const router = express.Router();

/* =========================
   USER MANAGEMENT
========================= */

router.get("/users", getUsers);

router.post(
  "/users/admin",
  createAdminAccount
);

router.post(
  "/users/professor",
  createProfessorAccount
);

router.post(
  "/users/student",
  createStudentAccount
);

/* =========================
   CURRENT USER
========================= */

router.get(
  "/users/me",
  authenticateUser,
  getCurrentUser
);

router.put(
  "/users/me/profile-image",
  authenticateUser,
  uploadProfileImage.single("profileImage"),
  updateProfileImage
);

router.put(
  "/users/change-password",
  authenticateUser,
  changeUserPassword
);

/* =========================
   USER BY ID
========================= */

router.get(
  "/users/:id",
  getUserById
);

router.patch(
  "/users/:id/registration",
  updateProfessorRegistration
);

router.patch(
  "/users/:id/archive",
  updateAccountArchive
);

router.post(
  "/users/:id/reset-credentials",
  resetUserCredentials
);

router.delete(
  "/users/:id/archived",
  permanentlyRemoveArchivedAccount
);

/* =========================
   LEGACY / GENERAL ROUTES
========================= */

router.get(
  "/",
  getUsers
);

router.get(
  "/:id",
  getUserById
);

/* =========================
   PROFILE
========================= */

router.post(
  "/profile",
  getProfile
);

/* =========================
   ONBOARDING
========================= */

router.post(
  "/onboarding/name",
  updateOnboardingName
);

router.post(
  "/onboarding/year",
  updateOnboardingYear
);

router.post(
  "/onboarding/section",
  updateOnboardingSection
);

router.post(
  "/onboarding/complete",
  completeOnboarding
);

/* =========================
   LEGACY PHP-COMPATIBLE ROUTES
========================= */

router.post(
  "/get-profile.php",
  getProfile
);

router.post(
  "/update-name.php",
  updateOnboardingName
);

router.post(
  "/update-year.php",
  updateOnboardingYear
);

router.post(
  "/update-section.php",
  updateOnboardingSection
);

router.post(
  "/complete-onboarding.php",
  completeOnboarding
);

export default router;