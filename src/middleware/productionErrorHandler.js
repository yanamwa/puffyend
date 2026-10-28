export function productionErrorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  console.error("Request failed:", error);
  const candidate = Number(error.statusCode || error.status);
  const status =
    Number.isInteger(candidate) && candidate >= 400 && candidate <= 599
      ? candidate
      : 500;
  res
    .status(status)
    .json({
      success: false,
      message:
        process.env.NODE_ENV === "production" && status >= 500
          ? "Internal Server Error"
          : error.message || "Request failed.",
    });
}
