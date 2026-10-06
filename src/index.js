import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

import authRoutes from "./routes/authRoutes.js";
import courseRoutes from "./routes/courseRoutes.js";
import userRoutes from "./routes/userRoutes.js";
import lessonRoutes from "./routes/lessonRoutes.js";
import notificationRoutes from "./routes/notificationRoutes.js";

import { initDb } from "./db.js";
import { startLessonWorker } from './services/rag/lessonJobService.js';
import privateLessonUploads from './middleware/privateLessonUploads.js';

dotenv.config();

const app = express();

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

const profileUploadsDirectory = path.join(
  __dirname,
  "uploads"
);

console.log(
  "Profile uploads directory:",
  profileUploadsDirectory
);

/* =========================================
   CORS
========================================= */

const allowedOrigins = [
  "http://localhost",
  "http://127.0.0.1",

  "http://localhost:3000",
  "http://127.0.0.1:3000",

  "http://localhost:3001",
  "http://127.0.0.1:3001",

  "http://localhost:3002",
  "http://127.0.0.1:3002",

  "http://localhost:3003",
  "http://127.0.0.1:3003",

  "http://localhost:5173",
  "http://127.0.0.1:5173",

  "https://puffybrain.fun",
  "https://www.puffybrain.fun",
];

app.use(
  cors({
    origin(origin, callback) {
      if (
        !origin ||
        allowedOrigins.includes(origin)
      ) {
        callback(null, true);

        return;
      }

      console.error(
        "Blocked CORS Origin:",
        origin
      );

      const error = new Error(
        `Origin not allowed: ${origin}`
      );

      error.statusCode = 403;

      callback(error);
    },

    credentials: true,

    methods: [
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS",
    ],

    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With",
    ],
  })
);

/* =========================================
   BODY PARSERS
========================================= */

app.use(
  express.json({
    limit: "25mb",
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "25mb",
  })
);

/* =========================================
   PROFILE IMAGE STATIC FOLDER

   DATABASE PATH EXAMPLE:

   /uploads/profile-images/profile-23-xxx.jpg

   PUBLIC URL:

   http://localhost:5000/uploads/profile-images/profile-23-xxx.jpg
========================================= */

app.use(
  "/uploads",
  privateLessonUploads,
  express.static(profileUploadsDirectory)
);

/* =========================================
   LESSON UPLOADS
========================================= */

app.use(
  "/api/uploads",
  privateLessonUploads,
  express.static(
    path.resolve(
      __dirname,
      "src",
      "uploads"
    )
  )
);

/* =========================================
   REQUEST LOGGER
========================================= */

app.use((req, res, next) => {
  console.log(
    `${req.method} ${req.originalUrl}`
  );

  next();
});

/* =========================================
   HEALTH CHECK
========================================= */

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      success: true,
      message:
        "PuffyBrain API is running.",
    });
  }
);

/* =========================================
   TEST PROFILE UPLOAD STATIC FOLDER
========================================= */

app.get(
  "/api/debug/uploads",
  (req, res) => {
    res.json({
      success: true,

      uploadsDirectory:
        profileUploadsDirectory,

      example:
        "http://localhost:5000/uploads/profile-images/filename.jpg",
    });
  }
);

/* =========================================
   ROUTES
========================================= */

/*
  Dedicated notification routes first.
  This prevents broad /api routers from
  intercepting /api/notifications.
*/
app.use(
  "/api/notifications",
  notificationRoutes
);

/*
  Lesson routes
*/
app.use(
  "/api/lessons",
  lessonRoutes
);

/*
  Authentication routes
*/
app.use(
  "/api/auth",
  authRoutes
);

app.use(
  "/api",
  authRoutes
);

/*
  Course routes
*/
app.use(
  "/api",
  courseRoutes
);

/*
  User routes
*/
app.use(
  "/api",
  userRoutes
);

/* =========================================
   404
========================================= */

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message:
      "Route not found.",
  });
});

/* =========================================
   INVALID JSON
========================================= */

app.use(
  (error, req, res, next) => {
    if (
      error instanceof SyntaxError &&
      "body" in error
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid JSON request body.",
      });
    }

    next(error);
  }
);

/* =========================================
   GENERAL ERROR HANDLER
========================================= */

app.use(
  (error, req, res, next) => {
    console.error(
      "Unhandled Server Error:"
    );

    console.error(error);

    res
      .status(
        error.statusCode || 500
      )
      .json({
        success: false,

        message:
          error.message ||
          "Internal Server Error",
      });
  }
);

/* =========================================
   START SERVER
========================================= */

async function startServer() {
  try {
    console.log(
      "--------------------------------------"
    );

    console.log(
      "Starting PuffyBrain Backend..."
    );

    console.log(
      "--------------------------------------"
    );

    console.log(
      "Connecting to MySQL..."
    );

    await initDb();
    startLessonWorker();

    console.log(
      "MySQL Connected Successfully."
    );

    app.listen(
      port,
      () => {
        console.log(
          "--------------------------------------"
        );

        console.log(
          `Server running on http://localhost:${port}`
        );

        console.log(
          `Health Check: http://localhost:${port}/api/health`
        );

        console.log(
          `Uploads folder: ${profileUploadsDirectory}`
        );

        console.log(
          `Upload Debug: http://localhost:${port}/api/debug/uploads`
        );

        console.log(
          `Lesson Upload: http://localhost:${port}/api/lessons/process-file`
        );

        console.log(
          "--------------------------------------"
        );
      }
    );
  } catch (error) {
    console.error(
      "--------------------------------------"
    );

    console.error(
      "SERVER FAILED TO START"
    );

    console.error(
      "--------------------------------------"
    );

    console.error(error);
  }
}

startServer();
