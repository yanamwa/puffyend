import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { unlink } from "node:fs/promises";
import express from "express";
import professorProofUpload from "../src/middleware/professorProofUpload.js";
import publicUploads, { uploadsDirectory } from "../src/middleware/publicUploads.js";

test("uploaded professor proof is readable through both upload URL prefixes", async (context) => {
  const app = express();
  app.post("/proof", professorProofUpload.single("employmentProof"), (req, res) => {
    res.json({ filename: req.file.filename });
  });
  app.use("/api/uploads", publicUploads);
  app.use("/uploads", publicUploads);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  context.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const image = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4ZkAAAAASUVORK5CYII=",
    "base64",
  );
  const form = new FormData();
  form.append("employmentProof", new Blob([image], { type: "image/png" }), "proof.png");
  const upload = await fetch(`${base}/proof`, { method: "POST", body: form });
  assert.equal(upload.status, 200);
  const { filename } = await upload.json();
  context.after(() => unlink(path.join(uploadsDirectory, "professor-ids", filename)));

  for (const prefix of ["/api/uploads", "/uploads"]) {
    const response = await fetch(`${base}${prefix}/professor-ids/${filename}`);
    assert.equal(response.status, 200, prefix);
    assert.match(response.headers.get("content-type"), /image\/png/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), image);
  }
});
