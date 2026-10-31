import cors from "cors";

export function apiCors(origins) {
  return cors({
    origin(origin, callback) {
      if (!origin || origins.includes(origin)) return callback(null, true);
      const error = new Error("Origin not allowed.");
      error.statusCode = 403;
      callback(error);
    },
    credentials: true,
    // Finish approved preflight requests here, before readiness/auth middleware.
    preflightContinue: false,
    optionsSuccessStatus: 204,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  });
}

export function mountApiAvailability(app, state) {
  app.get("/api/health", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.status(state.ready ? 200 : 503).json({
      success: state.ready,
      status: state.ready ? "ready" : state.failed ? "unavailable" : "starting",
      stage: state.stage,
      errorCode: state.errorCode,
      message: state.ready
        ? "PuffyBrain API is running."
        : "The API is not ready. Check backend startup logs.",
    });
  });
  app.use((req, res, next) => {
    if (state.ready) return next();
    res.set("Retry-After", "30");
    res.status(503).json({
      success: false,
      message: "The server is temporarily unavailable. Please try again later.",
    });
  });
}

export function failStartup(state, error) {
  state.failed = true;
  state.ready = false;
  const configKey = [
    "JWT_SECRET",
    "DATABASE_URL",
    "SUPABASE_DB_URL",
    "FRONTEND_URL",
    "DB_SCHEMA",
  ].find((key) => String(error.message || "").includes(key));
  state.errorCode = configKey
    ? `${configKey}_INVALID`
    : /^[A-Z0-9_]{3,40}$/.test(String(error.code || ""))
      ? error.code
      : "STARTUP_FAILED";
  console.error("SERVER FAILED TO START:", state.errorCode, error.message);
  console.error(
    "HTTP remains available for CORS and health checks. Fix the startup configuration/error and restart.",
  );
}
