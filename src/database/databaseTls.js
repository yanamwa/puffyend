import { readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { rootCertificates } from "node:tls";

export function normalizeCertificate(value) {
  const text = String(value)
    .trim()
    .replace(/\\r\\n|\\n|\\r/g, "\n");
  const blocks = [
    ...text.matchAll(
      /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g,
    ),
  ];
  if (
    !blocks.length ||
    text
      .replace(
        /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
        "",
      )
      .trim()
  )
    throw new Error(
      "DB_SSL_CA must contain complete PEM certificate contents, not a filename or incomplete text.",
    );
  return blocks.map((block) => {
    const body = block[1].replace(/\s/g, "");
    const pem = `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)?.join("\n") || ""}\n-----END CERTIFICATE-----\n`;
    try {
      return new X509Certificate(pem).toString();
    } catch {
      throw new Error(
        "DB_SSL_CA contains an invalid certificate. Paste the complete downloaded PEM certificate.",
      );
    }
  });
}

export function databaseTls(hostname, customCa) {
  const ca = [...rootCertificates];
  if (hostname.endsWith(".supabase.com") || hostname.endsWith(".supabase.co")) {
    // Public CA downloaded from the project's Supabase Database Settings.
    // Hostname and certificate verification remain enabled.
    ca.push(
      ...normalizeCertificate(
        readFileSync(
          new URL("./certs/supabase-root-2021.crt", import.meta.url),
          "utf8",
        ),
      ),
    );
  }
  if (customCa?.trim()) ca.push(...normalizeCertificate(customCa));
  return { rejectUnauthorized: true, ca: [...new Set(ca)] };
}
