import courseRoutes from "../src/routes/courseRoutes.js";
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { securityConfig } from "../src/config/security.js";
import requireOwnAccount from "../src/middleware/requireOwnAccount.js";
import { mountUploads } from "../src/routes/uploadRoutes.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import uploadProfileImage from "../src/middleware/profileImageUpload.js";
import { productionErrorHandler } from "../src/middleware/productionErrorHandler.js";
import authRoutes from "../src/routes/authRoutes.js";
import userRoutes from "../src/routes/userRoutes.js";
import { requireRole } from "../src/middleware/roleMiddleware.js";

async function serve(app, run) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
const prod = {
  NODE_ENV: "production",
  JWT_SECRET: "x".repeat(48),
<<<<<<< HEAD
  DATABASE_URL: "postgresql://app:private@db:5432/postgres",
=======
  DB_HOST: "db",
  DB_USER: "app",
  DB_PASSWORD: "private",
  DB_NAME: "app",
>>>>>>> backend/main
  FRONTEND_URL: "https://puffybrain.fun",
};
test("production rejects missing secrets, DB settings, insecure frontend and invalid proxy hops", () => {
  for (const key of [
    "JWT_SECRET",
<<<<<<< HEAD
    "DATABASE_URL",
=======
    "DB_HOST",
    "DB_USER",
    "DB_PASSWORD",
    "DB_NAME",
>>>>>>> backend/main
    "FRONTEND_URL",
  ])
    assert.throws(() => securityConfig({ ...prod, [key]: "" }));
  assert.throws(() =>
    securityConfig({ ...prod, FRONTEND_URL: "http://puffybrain.fun" }),
  );
  assert.throws(() => securityConfig({ ...prod, TRUST_PROXY_HOPS: "true" }));
  assert.deepEqual(securityConfig(prod).origins, ["https://puffybrain.fun"]);
<<<<<<< HEAD
  assert.ok(securityConfig({ ...prod, FRONTEND_URL: "https://www.puffybrain.fun/" }).origins.includes("https://puffybrain.fun"));
=======
>>>>>>> backend/main
});
test("real protected account routes reject anonymous access before querying DB", async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", userRoutes);
  await serve(app, async (base) => {
    for (const route of [
      "users",
      "profile",
      "get-profile.php",
      "onboarding/name",
      "onboarding/year",
      "onboarding/section",
      "onboarding/complete",
      "update-name.php",
      "update-year.php",
      "update-section.php",
      "complete-onboarding.php",
    ]) {
      const response = await fetch(`${base}/api/${route}`, {
        method: route === "users" ? "GET" : "POST",
        headers: { "Content-Type": "application/json" },
        body:
          route === "users"
            ? undefined
            : JSON.stringify({ email: "victim@example.com" }),
      });
      assert.equal(response.status, 401, route);
    }
  });
});
test("own-account middleware rejects forged email and fills authenticated identity", async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { email: "student@example.com", role: "student" };
    next();
  });
  app.post("/profile", requireOwnAccount, (req, res) => res.json(req.body));
  app.get("/admin", requireRole("super_admin"), (req, res) =>
    res.sendStatus(200),
  );
  await serve(app, async (base) => {
    assert.equal((await fetch(`${base}/admin`)).status, 403);
    for (const body of [{ email: "victim@example.com" }, { email: {} }])
      assert.equal(
        (
          await fetch(`${base}/profile`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          })
        ).status,
        403,
      );
    const response = await fetch(`${base}/profile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal((await response.json()).email, "student@example.com");
  });
});
test("login budget is shared across auth route aliases and returns 429", async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRoutes);
  app.use("/api", authRoutes);
  await serve(app, async (base) => {
    for (let i = 0; i < 10; i++)
      assert.equal(
        (
          await fetch(`${base}/api/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          })
        ).status,
        400,
      );
    const response = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 429);
    assert.ok(response.headers.get("retry-after"));
  });
});
test("production errors conceal internal details", async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const app = express();
    app.get("/fail", () => {
      throw new Error("private database details");
    });
    app.use(productionErrorHandler);
    await serve(app, async (base) => {
      const response = await fetch(`${base}/fail`);
      assert.equal(response.status, 500);
      assert.equal((await response.json()).message, "Internal Server Error");
    });
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test("private uploads and backups never fall through static serving", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "puffy-security-"));
  try {
    for (const folder of [
      "profile-images",
      "lessons",
      "professor-ids",
      "backups",
    ]) {
      await fs.mkdir(path.join(directory, folder));
      await fs.writeFile(
        path.join(directory, folder, "private.txt"),
        "test content",
      );
    }
    const app = express();
    mountUploads(app, directory);
    await serve(app, async (base) => {
      assert.equal(
        (await fetch(`${base}/uploads/profile-images/private.txt`)).status,
        200,
      );
      for (const root of ["/uploads", "/api/uploads"]) {
        assert.equal(
          (await fetch(`${base}${root}/professor-ids/private.txt`)).status,
          401,
        );
        for (const folder of ["lessons", "backups"])
          assert.equal(
            (await fetch(`${base}${root}/${folder}/private.txt`)).status,
            404,
          );
      }
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
test("profile upload rejects executable extensions with spoofed image MIME", async () => {
  const app = express();
  app.post("/upload", uploadProfileImage.single("profileImage"), (req, res) =>
    res.sendStatus(200),
  );
  app.use((error, req, res, next) =>
    res.status(error.statusCode || 400).json({ message: error.message }),
  );
  await serve(app, async (base) => {
    const form = new FormData();
    form.append(
      "profileImage",
      new Blob(["<script>test</script>"], { type: "image/png" }),
      "payload.html",
    );
    assert.equal(
      (await fetch(`${base}/upload`, { method: "POST", body: form })).status,
      400,
    );
  });
});

test("legacy progress, monitoring and course reads reject anonymous requests", async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", courseRoutes);
  await serve(app, async (base) => {
    for (const [method, route] of [
      ["GET", "courses"],
      ["GET", "courses/join"],
      ["POST", "courses/join"],
      ["GET", "courses/1"],
      ["GET", "modules"],
      ["GET", "modules/1"],
      ["GET", "monitoring/1"],
      ["GET", "getLessonProgress.php"],
      ["POST", "saveLessonProgress.php"],
      ["POST", "generateAdaptiveFeedback.php"],
    ]) {
      assert.equal(
        (await fetch(`${base}/api/${route}`, { method })).status,
        401,
        route,
      );
    }
  });
});
