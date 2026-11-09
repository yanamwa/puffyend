import express from "express";
import authenticateUser, { authenticateAccountSetup } from "../middleware/authMiddleware.js";
import professorProofUpload from "../middleware/professorProofUpload.js";
import uploadProfileImage from "../middleware/profileImageUpload.js";
import { requireRole } from "../middleware/roleMiddleware.js";

import {
  changeUserPassword,
  completeOnboarding,
  completeStudentTutorial,
  grantProfessorAdminAccess,
  createProfessorAccount,
  createStudentAccount,
  logBulkStudentImport,
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

function handleProfessorProofUpload(req, res, next) {
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

/* =========================
   USER MANAGEMENT
========================= */

router.get(
  "/users",
  authenticateUser,
  requireRole("super_admin", "admin"),
  getUsers,
);

router.post(
  "/users/admin",
  authenticateUser,
  requireRole("super_admin"),
  grantProfessorAdminAccess,
);

router.post(
  "/users/professor",
  authenticateUser,
  requireRole("super_admin", "admin"),
  handleProfessorProofUpload,
  createProfessorAccount,
);

router.post(
  "/users/student",
  authenticateUser,
  requireRole("super_admin", "admin"),
  createStudentAccount,
);

/* =========================
   CURRENT USER
========================= */

router.get("/users/me", authenticateAccountSetup, getCurrentUser);

router.post(
  "/users/me/complete-tutorial",
  authenticateAccountSetup,
  requireRole("student"),
  completeStudentTutorial,
);

router.put(
  "/users/me/profile-image",
  authenticateUser,
  uploadProfileImage.single("profileImage"),
  updateProfileImage,
);

router.put("/users/change-password", authenticateAccountSetup, changeUserPassword);

/* =========================
   USER BY ID
========================= */
router.post(
  "/users/student/bulk-import-audit",
  authenticateUser,
  requireRole("super_admin", "admin"),
  logBulkStudentImport,
);

router.get(
  "/users/:id",
  authenticateUser,
  requireRole("super_admin", "admin"),
  getUserById,
);

router.patch(
  "/users/:id/registration",
  authenticateUser,
  requireRole("super_admin"),
  updateProfessorRegistration,
);

router.patch(
  "/users/:id/archive",
  authenticateUser,
  requireRole("super_admin", "admin"),
  updateAccountArchive,
);

router.post(
  "/users/:id/reset-credentials",
  authenticateUser,
  requireRole("super_admin", "admin"),
  resetUserCredentials,
);

router.delete(
  "/users/:id/archived",
  authenticateUser,
  requireRole("super_admin", "admin"),
  permanentlyRemoveArchivedAccount,
);

/* =========================
   PROFILE
========================= */

router.post("/profile", authenticateUser, getProfile);

/* =========================
   ONBOARDING
========================= */

router.post("/onboarding/name", authenticateUser, updateOnboardingName);

router.post("/onboarding/year", authenticateUser, updateOnboardingYear);

router.post("/onboarding/section", authenticateUser, updateOnboardingSection);

router.post("/onboarding/complete", authenticateUser, completeOnboarding);

/* =========================
   LEGACY PHP-COMPATIBLE ROUTES
========================= */

router.post("/get-profile.php", authenticateUser, getProfile);

router.post("/update-name.php", authenticateUser, updateOnboardingName);

router.post("/update-year.php", authenticateUser, updateOnboardingYear);

router.post("/update-section.php", authenticateUser, updateOnboardingSection);

router.post("/complete-onboarding.php", authenticateUser, completeOnboarding);

export default router;
