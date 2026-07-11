import express from "express";
import {
  createCourse,
  createLearningModule,
  deleteCourse,
  deleteLearningModule,
  getCourseById,
  getCourses,
  getLearningModuleById,
  getLearningModules,
  handleLegacyLearningModule,
  updateCourse,
  updateLearningModule,
} from "../controllers/courseController.js";

const router = express.Router();

router.get("/courses", getCourses);
router.post("/courses", createCourse);
router.get("/courses/:id", getCourseById);
router.put("/courses/:id", updateCourse);
router.delete("/courses/:id", deleteCourse);

router.get("/modules", getLearningModules);
router.post("/modules", createLearningModule);
router.get("/modules/:id", getLearningModuleById);
router.put("/modules/:id", updateLearningModule);
router.delete("/modules/:id", deleteLearningModule);

router.get("/adminLearningModule.php", handleLegacyLearningModule);
router.post("/adminLearningModule.php", handleLegacyLearningModule);

export default router;
