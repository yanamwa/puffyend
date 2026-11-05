import { db } from "../db.js";

export async function cleanupDeclinedRegistrations(email = "") {
  // Data retention must be explicitly enabled; migration/startup never deletes users.
  if (process.env.ENABLE_DECLINED_REGISTRATION_CLEANUP !== "true") return 0;
  const [rows] = await db.execute(
    `SELECT userId FROM users
     WHERE role = 'professor' AND verification_status = 'declined'
       AND professor_declined_at <= (NOW() - INTERVAL '24 hours')
       ${email ? "AND email = ?" : ""}`,
    email ? [email] : [],
  );
  let removed = 0;
  for (const user of rows) {
    try {
      const [result] = await db.execute(
        `DELETE FROM users WHERE userId = ? AND role = 'professor'
         AND verification_status = 'declined'
         AND professor_declined_at <= (NOW() - INTERVAL '24 hours')`,
        [user.userId],
      );
      removed += result.affectedRows;
    } catch (error) {
      console.error("Declined registration cleanup failed:", error.code || "DELETE_FAILED");
    }
  }
  return removed;
}
