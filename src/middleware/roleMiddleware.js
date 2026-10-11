export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    const role = String(req.user?.role || "")
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_");

    if (!role) {
      return res.status(401).json({
        success: false,
        message: "Authentication is required.",
      });
    }

    if (!allowedRoles.includes(role)) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to perform this action.",
      });
    }

    next();
  };
}
