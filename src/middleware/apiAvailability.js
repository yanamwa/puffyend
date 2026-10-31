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
      message: state.ready
        ? "PuffyBrain API is running."
        : "The API database is not ready. Check backend startup logs.",
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
