import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "node:path";

import authRoutes from "./routes/authRoutes.js";
import courseRoutes from "./routes/courseRoutes.js";
import userRoutes from "./routes/userRoutes.js";
import lessonRoutes from "./routes/lessonRoutes.js";

import { initDb } from "./db.js";

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

const allowedOrigins = [
  "http://localhost",
  "http://127.0.0.1",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "https://puffybrain.fun",
  "https://www.puffybrain.fun",
];

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      console.error("Blocked CORS Origin:", origin);

      callback(
        new Error(`Origin not allowed: ${origin}`)
      );
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

app.use(express.json());
app.use(
  express.urlencoded({
    extended: true,
  })
);

/*
  Profile image uploads are saved here:

  C:\xampp\htdocs\server\uploads\profile-images

  and are available through:

  http://localhost:5000/uploads/profile-images/filename.jpg
*/
app.use(
  "/uploads",
  express.static(
    path.join(process.cwd(), "uploads")
  )
);

/*
  Keep this because your lesson upload files
  currently use src/uploads.
*/
app.use(
  "/api/uploads",
  express.static(
    path.resolve("src/uploads")
  )
);

// Request logger
app.use((req, res, next) => {
  console.log(
    `${req.method} ${req.originalUrl}`
  );

  next();
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "PuffyBrain API is running.",
  });
});

// Routes
app.use("/api", authRoutes);
app.use("/api/auth", authRoutes);
app.use("/api", courseRoutes);
app.use("/api", userRoutes);
app.use("/api/lessons", lessonRoutes);

// 404
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found.",
  });
});

// Invalid JSON
app.use((error, req, res, next) => {
  if (
    error instanceof SyntaxError &&
    "body" in error
  ) {
    return res.status(400).json({
      success: false,
      message: "Invalid JSON request body.",
    });
  }

  next(error);
});

// General error handler
app.use((error, req, res, next) => {
  console.error("Unhandled Server Error:");
  console.error(error);

  res.status(
    error.statusCode || 500
  ).json({
    success: false,
    message:
      error.message ||
      "Internal Server Error",
  });
});

async function startServer() {
  try {
    console.log("--------------------------------------");
    console.log("Starting PuffyBrain Backend...");
    console.log("--------------------------------------");

    console.log("Connecting to MySQL...");
    await initDb();

    console.log(
      "MySQL Connected Successfully."
    );

    app.listen(port, () => {
      console.log("--------------------------------------");
      console.log(
        `Server running on http://localhost:${port}`
      );
      console.log(
        `Health Check: http://localhost:${port}/api/health`
      );
      console.log(
        `Lesson Upload: http://localhost:${port}/api/lessons/process-file`
      );
      console.log("--------------------------------------");
    });
  } catch (error) {
    console.error("--------------------------------------");
    console.error("SERVER FAILED TO START");
    console.error("--------------------------------------");
    console.error(error);
  }
}

startServer();