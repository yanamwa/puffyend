import { db } from "../db.js";

export async function cleanupDeclinedRegistrations(email = "") {
  const [rows] = await db.execute(
    `SELECT userId FROM users
     WHERE role = 'professor' AND verification_status = 'declined'
       AND professor_declined_at <= DATE_SUB(NOW(), INTERVAL 24 HOUR)
       ${email ? "AND email = ?" : ""}`,
    email ? [email] : [],
  );
  let removed = 0;
  for (const user of rows) {
    try {
      const [result] = await db.execute(
        `DELETE FROM users WHERE userId = ? AND role = 'professor'
         AND verification_status = 'declined'
         AND professor_declined_at <= DATE_SUB(NOW(), INTERVAL 24 HOUR)`,
        [user.userId],
      );
      removed += result.affectedRows;
    } catch (error) {
      console.error("Declined registration cleanup failed:", error.code || "DELETE_FAILED");
    }
  }
  return removed;
}
