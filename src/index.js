<<<<<<< HEAD
import "dotenv/config";
import express from "express";
import cors from "cors";
import {
  mountApiAvailability,
  failStartup,
} from "./middleware/apiAvailability.js";

// Keep this entry point independent of the database, configuration validators,
// and route imports: those can fail before Express has a chance to serve CORS.
const app = express();
app.disable("x-powered-by");
const availability = {
  ready: false,
  failed: false,
  stage: "loading_application",
};
const corsOptions = {
  origin: "https://puffybrain.fun",
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  optionsSuccessStatus: 204,
  preflightContinue: false,
};
if (process.env.NODE_ENV !== "production") {
  const origins = ["https://puffybrain.fun"];
  for (const host of ["localhost", "127.0.0.1"])
    for (const port of ["", ":3000", ":3001", ":3002", ":3003", ":5173"])
      origins.push(`http://${host}${port}`);
  corsOptions.origin = origins;
}
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
mountApiAvailability(app, availability);

const server = app.listen(process.env.PORT || 5000, "0.0.0.0", () => {
  console.log(
    `PuffyBrain HTTP server listening on port ${server.address().port}`,
  );
  void import("./application.js")
    .then(({ startApplication }) => startApplication(app, availability))
    .catch((error) => failStartup(availability, error));
});
server.on("error", (error) => {
  console.error("HTTP SERVER FAILED TO LISTEN:", error.code || "listen error");
  process.exit(1);
});
=======
import { mountUploads } from "./routes/uploadRoutes.js";
import helmet from "helmet";
import { security } from "./config/security.js";
import authenticateUser from "./middleware/authMiddleware.js";
import { requireRole } from "./middleware/roleMiddleware.js";
import { productionErrorHandler } from "./middleware/productionErrorHandler.js";
import academicCalendarRoutes from "./routes/academicCalendarRoutes.js";
import { migrateAcademicCalendar } from "./migrations/academicCalendarMigration.js";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

import authRoutes from "./routes/authRoutes.js";
import courseRoutes from "./routes/courseRoutes.js";
import catalogRoutes, { cleanupSyllabusUploads } from "./routes/catalogRoutes.js";
import { migrateCourseCatalog } from "./migrations/courseCatalogMigration.js";
import { db } from "./db.js";
import userRoutes from "./routes/userRoutes.js";
import lessonRoutes from "./routes/lessonRoutes.js";
import notificationRoutes from "./routes/notificationRoutes.js";
import systemAnalyticsRoutes from "./routes/systemAnalyticsRoutes.js";
import backupRoutes from "./routes/backupRoutes.js";
import systemSettingsRoutes from "./routes/systemSettingsRoutes.js";
import reportRoutes from "./routes/reportRoutes.js";

import { initDb } from "./db.js";
import { startLessonWorker } from "./services/rag/lessonJobService.js";

dotenv.config();

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", security.proxyHops);
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));

const port = process.env.PORT || 5000;

/* =========================================
   GET SERVER DIRECTORY
========================================= */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/*
  If index.js is located here:

  C:\xampp\htdocs\server\index.js

  this becomes:

  C:\xampp\htdocs\server\uploads
*/

const profileUploadsDirectory = path.join(__dirname, "uploads");

console.log("Profile uploads directory:", profileUploadsDirectory);

/* =========================================
   CORS
========================================= */

const allowedOrigins = security.origins;

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);

        return;
      }

      console.error("Blocked CORS Origin:", origin);

      const error = new Error(`Origin not allowed: ${origin}`);

      error.statusCode = 403;

      callback(error);
    },

    credentials: true,

    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],

    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  }),
);

/* =========================================
   BODY PARSERS
========================================= */

app.use(
  express.json({
    limit: "25mb",
  }),
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "25mb",
  }),
);

/* =========================================
   PROFILE IMAGE STATIC FOLDER

   DATABASE PATH EXAMPLE:

   /uploads/profile-images/profile-23-xxx.jpg

   PUBLIC URL:

   http://localhost:5000/uploads/profile-images/profile-23-xxx.jpg
========================================= */

mountUploads(app, profileUploadsDirectory);

/* =========================================
   REQUEST LOGGER
========================================= */

app.use((req, res, next) => {
  console.log(`${req.method} ${req.originalUrl}`);

  next();
});

/* =========================================
   HEALTH CHECK
========================================= */

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "PuffyBrain API is running.",
  });
});

/* =========================================
   TEST PROFILE UPLOAD STATIC FOLDER
========================================= */

app.get("/api/debug/uploads", authenticateUser, requireRole("super_admin"), (req, res) => {
  res.json({
    success: true,

    uploadsDirectory: profileUploadsDirectory,

    example: "http://localhost:5000/uploads/profile-images/filename.jpg",
  });
});

/* =========================================
   ROUTES
========================================= */

/*
  Dedicated notification routes first.
  This prevents broad /api routers from
  intercepting /api/notifications.
*/
app.use("/api/notifications", notificationRoutes);

/*
  Lesson routes
*/
app.use("/api/lessons", lessonRoutes);

/*
  Authentication routes
*/
app.use("/api/auth", authRoutes);

app.use("/api", authRoutes);

/*
  Course routes
*/
app.use("/api/academic-calendars", academicCalendarRoutes);
app.use("/api/catalog", catalogRoutes);
app.use("/api", courseRoutes);

/*
  User routes
*/
app.use("/api", userRoutes);
/* =========================================
   BACKUP & RESTORE
========================================= */

app.use("/api/backup", backupRoutes);
/* =========================================
   SYSTEM ANALYTICS
========================================= */

app.use("/api/analytics", systemAnalyticsRoutes);
/* =========================================
   SYSTEM SETTINGS
========================================= */

app.use(
  "/api/system-settings",
  systemSettingsRoutes
);

/* =========================================
   ADMIN REPORTS
========================================= */

app.use(
  "/api/reports",
  reportRoutes
);

/* =========================================
   404
========================================= */

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found.",
  });
});

/* =========================================
   INVALID JSON
========================================= */

app.use((error, req, res, next) => {
  if (error instanceof SyntaxError && "body" in error) {
    return res.status(400).json({
      success: false,
      message: "Invalid JSON request body.",
    });
  }

  next(error);
});

/* =========================================
   GENERAL ERROR HANDLER
========================================= */

app.use(productionErrorHandler);

/* =========================================
   START SERVER
========================================= */

async function startServer() {
  try {
    console.log("--------------------------------------");

    console.log("Starting PuffyBrain Backend...");

    console.log("--------------------------------------");

    console.log("Connecting to MySQL...");

    await initDb();
    await migrateCourseCatalog(db);
    await migrateAcademicCalendar(db);
    await cleanupSyllabusUploads();
    setInterval(() => cleanupSyllabusUploads().catch(console.error), 3600000).unref();
    startLessonWorker();

    console.log("MySQL Connected Successfully.");

    app.listen(port, () => {
      console.log("--------------------------------------");

      console.log(`Server running on http://localhost:${port}`);

      console.log(`Health Check: http://localhost:${port}/api/health`);

      console.log(`Uploads folder: ${profileUploadsDirectory}`);

      console.log(`Upload Debug: http://localhost:${port}/api/debug/uploads`);

      console.log(
        `Lesson Upload: http://localhost:${port}/api/lessons/process-file`,
      );

      console.log("--------------------------------------");
    });
  } catch (error) {
    console.error("--------------------------------------");

    console.error("SERVER FAILED TO START");

    console.error("--------------------------------------");

    console.error(error);
    process.exitCode = 1;
  }
}

startServer();
>>>>>>> backend/main
