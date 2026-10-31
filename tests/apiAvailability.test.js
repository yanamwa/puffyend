import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { apiCors, mountApiAvailability } from "../src/middleware/apiAvailability.js";
import { productionErrorHandler } from "../src/middleware/productionErrorHandler.js";

test("login preflight and health stay reachable before DB startup and after startup failure", async () => {
  const app = express();
  const state = { ready: false, failed: false };
  app.use(apiCors(["https://puffybrain.fun"]));
  mountApiAvailability(app, state);
  app.post("/api/login", (req, res) => res.json({ success: true }));
  app.use(productionErrorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Origin: "https://puffybrain.fun" };
  try {
    for (const failed of [false, true]) {
      state.failed = failed;
      const preflight = await fetch(`${base}/api/login`, {
        method: "OPTIONS",
        headers: {
          ...headers,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get("access-control-allow-origin"), headers.Origin);
      assert.equal(preflight.headers.get("access-control-allow-credentials"), "true");
      const login = await fetch(`${base}/api/login`, { method: "POST", headers });
      assert.equal(login.status, 503);
      assert.equal(login.headers.get("access-control-allow-origin"), headers.Origin);
      assert.equal((await login.json()).success, false);
      const health = await fetch(`${base}/api/health`, { headers });
      assert.equal(health.status, 503);
      assert.equal((await health.json()).status, failed ? "unavailable" : "starting");
    }
    state.ready = true;
    assert.equal((await fetch(`${base}/api/login`, { method: "POST", headers })).status, 200);
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, "ready");
    const blocked = await fetch(`${base}/api/login`, {
      method: "OPTIONS",
      headers: { Origin: "https://untrusted.example", "Access-Control-Request-Method": "POST" },
    });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.headers.get("access-control-allow-origin"), null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
