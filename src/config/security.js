import "dotenv/config";
import crypto from "node:crypto";

export function securityConfig(env = process.env) {
  const production = env.NODE_ENV === "production";
  const secret = env.JWT_SECRET;
  if (
    production &&
    (!secret || secret.length < 32 || secret === "puffybrain-secret")
  )
    throw new Error(
      "Production requires a random JWT_SECRET of at least 32 characters.",
    );
  if (production) {
    for (const key of [
      "FRONTEND_URL",
    ])
      if (!env[key]) throw new Error(`Production requires ${key}.`);
    if (!env.DATABASE_URL && !env.SUPABASE_DB_URL)
      throw new Error("Production requires DATABASE_URL (PostgreSQL connection string).");
  }
  const frontend = new URL(env.FRONTEND_URL || "https://puffybrain.fun");
  if (
    production &&
    (frontend.protocol !== "https:" || frontend.username || frontend.password)
  )
    throw new Error("FRONTEND_URL must be an HTTPS URL without credentials.");
  const proxyHops = Number(env.TRUST_PROXY_HOPS || 0);
  if (!Number.isSafeInteger(proxyHops) || proxyHops < 0)
    throw new Error("TRUST_PROXY_HOPS must be a nonnegative integer.");
  const origins = [...new Set(["https://puffybrain.fun", frontend.origin])];
  if (!production) {
    for (const host of ["localhost", "127.0.0.1"])
      for (const port of ["", ":3000", ":3001", ":3002", ":3003", ":5173"])
        origins.push(`http://${host}${port}`);
  }
  return {
    production,
    jwtSecret: secret || crypto.randomBytes(48).toString("hex"),
    frontendUrl: frontend.origin,
    origins,
    proxyHops,
  };
}
export const security = securityConfig();
export const JWT_SECRET = security.jwtSecret;
