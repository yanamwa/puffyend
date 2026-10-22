export default function requireOwnAccount(req, res, next) {
  if (!req.user?.email)
    return res
      .status(401)
      .json({ success: false, message: "Authentication required." });
  const email = req.user.email.trim().toLowerCase();
  for (const target of [req.body?.email, req.query?.email]) {
    if (
      target !== undefined &&
      (typeof target !== "string" || target.trim().toLowerCase() !== email)
    )
      return res
        .status(403)
        .json({
          success: false,
          message: "You can only access your own account.",
        });
  }
  req.body = { ...req.body, email };
  next();
}
