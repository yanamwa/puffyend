import { Router } from 'express';
import authenticateUser from "../middleware/authMiddleware.js";
import {
  getReports,
  getReportConfig,
  getProfessorAssessmentSummary,
} from "../controllers/reportController.js";

const router = Router();
router.use(authenticateUser);
router.get("/professor/assessments", (req, res, next) => {
  if (req.user.role !== "professor") {
    return res.status(403).json({ success: false, message: "This assessment report is restricted to professors." });
  }
  return getProfessorAssessmentSummary(req, res, next);
});
router.use((req, res, next) => {
  if (!['admin', 'super_admin'].includes(req.user.role)) {
    return res.status(403).json({ success: false, message: 'Reports are restricted to administrators.' });
  }
  next();
});
router.get("/config", getReportConfig);
router.get('/', getReports);
export default router;
