import helmet from "helmet";
import express from "express";
import { security } from "./config/security.js";
import { mountUploads } from "./routes/uploadRoutes.js";
import authenticateUser from "./middleware/authMiddleware.js";
import { requireRole } from "./middleware/roleMiddleware.js";
import { productionErrorHandler } from "./middleware/productionErrorHandler.js";
import { startModulePublicationNotifications } from "./services/modulePublicationNotifications.js";
import { startMainQuizAvailabilityNotifications } from "./services/mainQuizAvailabilityNotifications.js";
import { startCatalogLessonWorker } from "./services/catalog/catalogLessonGeneration.js";
import academicCalendarRoutes from "./routes/academicCalendarRoutes.js";
import { failStartup } from "./middleware/apiAvailability.js";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

import authRoutes from "./routes/authRoutes.js";
import courseRoutes from "./routes/courseRoutes.js";
import catalogRoutes, {
  cleanupSyllabusUploads,
} from "./routes/catalogRoutes.js";
import { db, initDb } from "./db.js";
import userRoutes from "./routes/userRoutes.js";
import lessonRoutes from "./routes/lessonRoutes.js";
import notificationRoutes from "./routes/notificationRoutes.js";
import systemAnalyticsRoutes from "./routes/systemAnalyticsRoutes.js";
import backupRoutes from "./routes/backupRoutes.js";
import systemSettingsRoutes from "./routes/systemSettingsRoutes.js";
import reportRoutes from "./routes/reportRoutes.js";

import { migrateApplication } from "./migrations/applicationMigration.js";
import { startLessonWorker } from "./services/rag/lessonJobService.js";

dotenv.config();

export async function startApplication(app, availability) {
  app.disable("x-powered-by");
  app.set("trust proxy", security.proxyHops);
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));

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
   TEST PROFILE UPLOAD STATIC FOLDER
========================================= */

  app.get(
    "/api/debug/uploads",
    authenticateUser,
    requireRole("super_admin"),
    (req, res) => {
      res.json({
        success: true,

        uploadsDirectory: profileUploadsDirectory,

        example: "http://localhost:5000/uploads/profile-images/filename.jpg",
      });
    },
  );

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

  app.use("/api/system-settings", systemSettingsRoutes);

  /* =========================================
   ADMIN REPORTS
========================================= */

  app.use("/api/reports", reportRoutes);

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

      console.log("Connecting to PostgreSQL...");

      availability.stage = "database_initialization";
      if (process.env.RUN_DB_MIGRATIONS === "true") await migrateApplication();
      else await initDb();
      // Workers are opt-in on a populated database and never run during validation.
      if (process.env.ENABLE_BACKGROUND_JOBS === "true") {
        if (process.env.ENABLE_UPLOAD_CLEANUP === "true") {
          await cleanupSyllabusUploads();
          setInterval(() => cleanupSyllabusUploads().catch(console.error), 3600000).unref();
        }
        startLessonWorker();
        startModulePublicationNotifications().catch((error) =>
          console.error(
            "Module publication worker:",
            error.code || error.message,
          ),
        );
        startMainQuizAvailabilityNotifications().catch((error) =>
          console.error(
            "Main Quiz notification worker:",
            error.code || error.message,
          ),
        );
        startCatalogLessonWorker(db);
      }

      console.log("PostgreSQL initialized successfully.");

      availability.stage = "ready";
      availability.ready = true;
    } catch (error) {
      failStartup(availability, error);
    }
  }

  await startServer();
}
