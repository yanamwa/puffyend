import { createHash, createHmac, randomInt } from "node:crypto";
import { JWT_SECRET } from "../../config/security.js";
import { db } from "../../db.js";
import { sendMainQuizOtpEmail } from "../../utils/mailer.js";
import { requestError } from "../rag/courseAccessService.js";

const RESEND_SECONDS = 60;
const MAX_GUESSES = 5;

export async function initMainQuizVerificationTable() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS main_quiz_verifications (
      course_id INT NOT NULL,
      module_id VARCHAR(100) NOT NULL,
      user_id INT NOT NULL,
      session_hash TEXT NOT NULL,
      code_hash TEXT,
      code_expires_at TIMESTAMPTZ,
      resend_after TIMESTAMPTZ NOT NULL,
      failed_guesses SMALLINT NOT NULL DEFAULT 0,
      verified_until TIMESTAMPTZ,
      PRIMARY KEY (course_id, module_id, user_id)
    )
  `);
}

export function mainQuizSessionHash(authorization) {
  return createHash("sha256").update(authorization).digest("hex");
}

function codeHash(scope, sessionHash, code) {
  return createHmac("sha256", JWT_SECRET)
    .update(JSON.stringify(["main-quiz-otp", ...scope, sessionHash, code]))
    .digest("hex");
}

export async function hasMainQuizVerification(scope, sessionHash) {
  if (!sessionHash) return false;
  const [rows] = await db.execute(
    `SELECT 1 FROM main_quiz_verifications
     WHERE course_id=? AND module_id=? AND user_id=? AND session_hash=?
       AND verified_until > NOW()`,
    [...scope, sessionHash],
  );
  return rows.length > 0;
}

export async function sendMainQuizCode(scope, sessionHash, email) {
  if (!sessionHash || !email) {
    throw requestError("Sign in again to verify your Main Quiz access.", 401);
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const hash = codeHash(scope, sessionHash, code);
  const [result] = await db.execute(
    `INSERT INTO main_quiz_verifications
       (course_id,module_id,user_id,session_hash,code_hash,code_expires_at,resend_after)
     VALUES (?,?,?,?,?,NOW()+INTERVAL '5 minutes',NOW()+?*INTERVAL '1 second')
     ON CONFLICT (course_id,module_id,user_id) DO UPDATE
     SET session_hash=EXCLUDED.session_hash, code_hash=EXCLUDED.code_hash,
         code_expires_at=EXCLUDED.code_expires_at, resend_after=EXCLUDED.resend_after,
         failed_guesses=0, verified_until=NULL
     WHERE main_quiz_verifications.resend_after <= NOW()
       AND (main_quiz_verifications.session_hash <> EXCLUDED.session_hash
         OR main_quiz_verifications.verified_until IS NULL
         OR main_quiz_verifications.verified_until <= NOW())`,
    [...scope, sessionHash, hash, RESEND_SECONDS],
  );
  if (!result.affectedRows) return readCodeAvailability(scope, sessionHash);

  try {
    await sendMainQuizOtpEmail(email, code);
    return { codeAvailable: true, retryAfterSeconds: RESEND_SECONDS };
  } catch (error) {
    console.error(
      "Main Quiz verification email failed:",
      error.code || error.name,
    );
    await db.execute(
      `UPDATE main_quiz_verifications SET code_hash=NULL, code_expires_at=NULL
       WHERE course_id=? AND module_id=? AND user_id=? AND session_hash=? AND code_hash=?`,
      [...scope, sessionHash, hash],
    );
    const deliveryError = requestError(
      "Could not send the verification email. Please try resending the code.",
      503,
    );
    deliveryError.retryAfterSeconds = RESEND_SECONDS;
    throw deliveryError;
  }
}

async function readCodeAvailability(scope, sessionHash) {
  const [[row]] = await db.execute(
    `SELECT session_hash=?
        AND code_hash IS NOT NULL AND code_expires_at > NOW() AND failed_guesses < ? AS code_available,
        session_hash=? AND verified_until > NOW() AS verified,
        GREATEST(0, CEIL(EXTRACT(EPOCH FROM (resend_after - NOW())))) AS retry_after_seconds
     FROM main_quiz_verifications WHERE course_id=? AND module_id=? AND user_id=?`,
    [sessionHash, MAX_GUESSES, sessionHash, ...scope],
  );
  return {
    codeAvailable: row?.code_available === true,
    verified: row?.verified === true,
    retryAfterSeconds: Number(row?.retry_after_seconds || 0),
  };
}

export async function confirmMainQuizCode(scope, sessionHash, code) {
  if (!sessionHash || typeof code !== "string" || !/^\d{6}$/.test(code)) {
    throw requestError("Enter the six-digit verification code.", 400);
  }

  const hash = codeHash(scope, sessionHash, code);
  const [[row]] = await db.execute(
    `WITH verified_code AS (
       UPDATE main_quiz_verifications
       SET verified_until=CASE WHEN code_hash=? THEN NOW()+INTERVAL '30 minutes' ELSE NULL END,
           failed_guesses=CASE WHEN code_hash=? THEN failed_guesses ELSE failed_guesses+1 END,
           code_hash=CASE WHEN code_hash=? THEN NULL ELSE code_hash END
       WHERE course_id=? AND module_id=? AND user_id=? AND session_hash=?
         AND code_hash IS NOT NULL AND code_expires_at > NOW() AND failed_guesses < ?
       RETURNING verified_until IS NOT NULL AS verified, failed_guesses
     )
     SELECT verified, failed_guesses FROM verified_code`,
    [hash, hash, hash, ...scope, sessionHash, MAX_GUESSES],
  );
  if (row?.verified) return { verified: true };
  if (row && Number(row.failed_guesses) < MAX_GUESSES) {
    throw requestError("That verification code is incorrect.", 400);
  }

  const availability = await readCodeAvailability(scope, sessionHash);
  if (availability.verified) return { verified: true };
  throw requestError("This code is no longer valid. Request a new code.", 400);
}
