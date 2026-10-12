import { Router } from 'express';
import authenticateUser from "../middleware/authMiddleware.js";
import {
  getReports,
  getReportConfig,
} from "../controllers/reportController.js";

const router = Router();
router.use(authenticateUser);
router.use((req, res, next) => {
  if (!['admin', 'super_admin'].includes(req.user.role)) {
    return res.status(403).json({ success: false, message: 'Reports are restricted to administrators.' });
  }
  next();
});
router.get("/config", getReportConfig);
router.get('/', getReports);
export default router;
