import jwt from "jsonwebtoken";
import { authenticateAccountSetup } from "./authMiddleware.js";
import { isMaintenanceModeEnabled } from "../services/system/systemSettingsService.js";

export function sendMaintenanceResponse(res) {
  return res.set("Cache-Control", "no-store").status(503).json({
    success: false,
    code: "MAINTENANCE_MODE",
    message: "PuffyBrain is temporarily unavailable for maintenance.",
  });
}

export default async function enforceMaintenanceMode(req, res, next) {
  // Login checks the role before issuing a token. Let users end their sessions.
  if (req.method === "POST" && /^\/(auth\/)?(login|logout)\/?$/i.test(req.path)) {
    return next();
  }

  try {
    if (!(await isMaintenanceModeEnabled())) return next();
  } catch (error) {
    return next(error);
  }

  const header = req.headers.authorization || "";
  let role;
  try {
    if (header.startsWith("Bearer ")) {
      role = jwt.verify(header.slice(7), process.env.JWT_SECRET || "puffybrain-secret").role;
    }
  } catch {
    return sendMaintenanceResponse(res);
  }

  if (role !== "super_admin") return sendMaintenanceResponse(res);
  return authenticateAccountSetup(req, res, () =>
    req.user.role === "super_admin" ? next() : sendMaintenanceResponse(res),
  );
}
