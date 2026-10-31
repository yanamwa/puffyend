import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { rootCertificates } from "node:tls";
import {
  databaseTls,
  normalizeCertificate,
} from "../src/database/databaseTls.js";

const pem = readFileSync(
  new URL("../src/database/certs/supabase-root-2021.crt", import.meta.url),
  "utf8",
);
const fingerprint =
  "80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA";
test("bundled Supabase CA is valid and trusted without disabling TLS verification", () => {
  const cert = new X509Certificate(pem);
  assert.equal(cert.fingerprint256, fingerprint);
  assert.equal(cert.ca, true);
  assert.ok(Date.parse(cert.validTo) > Date.now());
  for (const host of [
    "aws-0-region.pooler.supabase.com",
    "db.project.supabase.co",
  ]) {
    const options = databaseTls(host);
    assert.equal(options.rejectUnauthorized, true);
    assert.ok(
      options.ca.some(
        (c) => new X509Certificate(c).fingerprint256 === fingerprint,
      ),
    );
    assert.ok(rootCertificates.every((c) => options.ca.includes(c)));
  }
});
test("Supabase CA is not automatically trusted for unrelated hosts", () => {
  for (const host of [
    "database.example.com",
    "supabase.com.attacker.example",
  ]) {
    assert.deepEqual(databaseTls(host).ca, [...new Set(rootCertificates)]);
  }
});
test("certificate parsing accepts multiline, escaped newline and collapsed paste formats", () => {
  for (const value of [
    pem,
    pem.replace(/\r?\n/g, "\\n"),
    pem.replace(/\s+/g, " "),
    pem.replace(/\r?\n/g, ""),
  ]) {
    assert.equal(
      new X509Certificate(normalizeCertificate(value)[0]).fingerprint256,
      fingerprint,
    );
  }
  assert.equal(
    databaseTls("db.project.supabase.co", pem).rejectUnauthorized,
    true,
  );
});
test("malformed certificate values identify DB_SSL_CA without leaking the input", () => {
  for (const value of [
    "prod-ca-2021.crt",
    "truncated-private-input",
    "-----BEGIN CERTIFICATE-----bad-----END CERTIFICATE-----",
  ]) {
    assert.throws(
      () => normalizeCertificate(value),
      (e) => e.message.includes("DB_SSL_CA") && !e.message.includes(value),
    );
  }
});
