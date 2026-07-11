import express from "express";
import cors from "cors";
import dotenv from "dotenv";

import authRoutes from "./routes/authRoutes.js";
import courseRoutes from "./routes/courseRoutes.js";
import userRoutes from "./routes/userRoutes.js";
import { initDb } from "./db.js";

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

app.use(cors({
  origin: [
    "http://localhost",
    "http://127.0.0.1",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "https://puffybrain.fun",
    "https://www.puffybrain.fun",
  ],
  credentials: true,
}));

app.use(express.json());

app.use("/api", authRoutes);
app.use("/api/auth", authRoutes);
app.use("/api", courseRoutes);
app.use("/api", userRoutes);

app.use((error, _req, res, next) => {
  if (error instanceof SyntaxError && "body" in error) {
    return res.status(400).json({
      success: false,
      message: "Invalid JSON request body.",
    });
  }

  return next(error);
});

async function startServer() {
  try {
    await initDb();

    app.listen(port, () => {
      console.log(`Auth server running at http://localhost:${port}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

startServer();
