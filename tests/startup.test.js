import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

for (const scenario of [
  {
    name: "invalid production JWT secret",
    env: { JWT_SECRET: "puffybrain-secret" },
    code: "JWT_SECRET_INVALID",
  },
  {
    name: "missing production database URL",
    env: { DATABASE_URL: "" },
    code: "DATABASE_URL_INVALID",
  },
  {
    name: "database connection refused",
    env: {},
    code: "ECONNREFUSED",
    stage: "database_initialization",
  },
]) {
  test(
    `real entry point serves CORS and safe health errors despite ${scenario.name}`,
    { timeout: 30000 },
    async () => {
      const child = spawn(process.execPath, ["src/index.js"], {
        cwd: new URL("..", import.meta.url),
        env: {
          ...process.env,
          NODE_ENV: "production",
          PORT: "0",
          FRONTEND_URL: "https://puffybrain.fun",
          JWT_SECRET: "x".repeat(48),
          DATABASE_URL: "postgresql://test:test@127.0.0.1:1/postgres",
          SUPABASE_DB_URL: "",
          DB_SCHEMA: "puffybrain",
          SUPER_ADMIN_PASSWORD: "",
          ...scenario.env,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      try {
        let port;
        for (let i = 0; i < 150; i++) {
          port = /HTTP server listening on port (\d+)/.exec(output)?.[1];
          if (port) break;
          if (child.exitCode !== null)
            throw new Error(`Entry point exited before listening: ${output}`);
          await delay(50);
        }
        assert.ok(
          port,
          "HTTP listener must start even with invalid configuration",
        );
        const base = `http://127.0.0.1:${port}`;
        const origin = { Origin: "https://puffybrain.fun" };
        const preflight = await fetch(`${base}/api/login`, {
          method: "OPTIONS",
          headers: {
            ...origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
          },
        });
        assert.equal(preflight.status, 204);
        assert.equal(
          preflight.headers.get("access-control-allow-origin"),
          origin.Origin,
        );
        assert.equal(
          preflight.headers.get("access-control-allow-credentials"),
          "true",
        );
        let body;
        for (let i = 0; i < 150; i++) {
          const health = await fetch(`${base}/api/health`, { headers: origin });
          assert.equal(health.status, 503);
          assert.equal(
            health.headers.get("access-control-allow-origin"),
            origin.Origin,
          );
          body = await health.json();
          if (body.status === "unavailable") break;
          await delay(50);
        }
        assert.equal(body.status, "unavailable");
        assert.equal(body.errorCode, scenario.code, output);
        if (scenario.stage) assert.equal(body.stage, scenario.stage);
        assert.equal(JSON.stringify(body).includes("postgresql://"), false);
        const login = await fetch(`${base}/api/login`, {
          method: "POST",
          headers: { ...origin, "Content-Type": "application/json" },
          body: "{}",
        });
        assert.equal(login.status, 503);
        assert.equal(
          login.headers.get("access-control-allow-origin"),
          origin.Origin,
        );
        assert.equal((await login.json()).success, false);
        assert.equal(child.exitCode, null);
      } finally {
        child.kill();
        await new Promise((resolve) => {
          if (child.exitCode !== null) resolve();
          else child.once("exit", resolve);
        });
      }
    },
  );
}
