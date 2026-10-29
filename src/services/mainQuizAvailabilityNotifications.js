import crypto from "node:crypto";
import { db } from "../db.js";
import { createNotification } from "../utils/notification.js";
import { sendMainQuizAvailableEmail } from "../utils/mailer.js";

const parseList = value => { try { const parsed = typeof value === "string" ? JSON.parse(value) : value; return Array.isArray(parsed) ? parsed : []; } catch { return []; } };
export function quizOpening(module, now = Date.now()) {
  const settings = module.mainQuizSettings || module.main_quiz_settings;
  if (!settings) return { available: false, schedule: "" };
  const enabled = ![false, 0, "0", "false"].includes(settings.enabled ?? settings.isEnabled ?? true);
  const unlock = settings.unlockAt || settings.unlock_at || "";
  const lock = settings.lockAt || settings.lock_at || "";
  const valid = (!unlock || Number.isFinite(Date.parse(unlock))) && (!lock || Number.isFinite(Date.parse(lock)));
  return { available: valid && enabled && (!unlock || Date.parse(unlock) <= now) && (!lock || Date.parse(lock) > now) && module.studentPublished !== false,
    schedule: `${unlock}|${lock}` };
}

async function initialize() {
  await db.query(`CREATE TABLE IF NOT EXISTS main_quiz_availability_state (
    course_id INT NOT NULL, module_id VARCHAR(100) NOT NULL, available BOOLEAN NOT NULL,
    schedule_key VARCHAR(255) NOT NULL, activation_id VARCHAR(36), PRIMARY KEY(course_id,module_id))`);
  await db.query(`CREATE TABLE IF NOT EXISTS main_quiz_availability_delivery (
    activation_id VARCHAR(36) NOT NULL, user_id INT NOT NULL, notification_id INT,
    email_sent BOOLEAN NOT NULL DEFAULT FALSE, PRIMARY KEY(activation_id,user_id))`);
}

export async function checkMainQuizOpenings({ database = db, notify = createNotification, sendEmail = sendMainQuizAvailableEmail } = {}) {
  const [courses] = await database.query("SELECT course_id,title,content_modules,lesson_pages,quiz_items,status FROM courses WHERE status='published'");
  for (const course of courses) {
    const modules = new Map();
    for (const item of [...parseList(course.lesson_pages), ...parseList(course.quiz_items), ...parseList(course.content_modules)]) {
      const id = item.moduleId || item.module_id || item.id;
      if (id && (item.mainQuizSettings || item.main_quiz_settings)) modules.set(String(id), item);
    }
    for (const [moduleId, module] of modules) {
      const opening = quizOpening(module);
      const [states] = await database.execute("SELECT * FROM main_quiz_availability_state WHERE course_id=? AND module_id=?", [course.course_id,moduleId]);
      const previous = states[0];
      // Establish a baseline so a restart never emails old, already-open quizzes.
      if (!previous) {
        await database.execute("INSERT IGNORE INTO main_quiz_availability_state(course_id,module_id,available,schedule_key) VALUES(?,?,?,?)", [course.course_id,moduleId,opening.available,opening.schedule]);
        continue;
      }
      let activationId = previous.activation_id;
      if (opening.available && !previous.available) activationId = crypto.randomUUID();
      await database.execute("UPDATE main_quiz_availability_state SET available=?,schedule_key=?,activation_id=? WHERE course_id=? AND module_id=?", [opening.available,opening.schedule,activationId,course.course_id,moduleId]);
      if (!opening.available || !activationId) continue;
      const [students] = await database.execute("SELECT DISTINCT u.userId,u.email FROM course_enrollments e JOIN users u ON u.userId=e.user_id WHERE e.course_id=? AND e.status='approved' AND COALESCE(e.archived,0)=0", [course.course_id]);
      const moduleTitle = module.title || module.moduleTitle || module.module_title || "Module";
      for (const student of students) {
        await database.execute("INSERT IGNORE INTO main_quiz_availability_delivery(activation_id,user_id) VALUES(?,?)", [activationId,student.userId]);
        const [[delivery]] = await database.execute("SELECT notification_id,email_sent FROM main_quiz_availability_delivery WHERE activation_id=? AND user_id=?", [activationId,student.userId]);
        if (!delivery.notification_id) {
          const notification = await notify({ recipientUserId: student.userId, courseId: course.course_id,
            title: "Main Quiz now available", message: `The Main Quiz for ${moduleTitle} in ${course.title} is now available. Open your course to view its requirements.`, target: "student", type: "announcement" });
          await database.execute("UPDATE main_quiz_availability_delivery SET notification_id=? WHERE activation_id=? AND user_id=?", [notification.notificationId,activationId,student.userId]);
        }
        if (!delivery.email_sent && student.email) {
          try {
            await sendEmail(student.email,course.title,moduleTitle,course.course_id);
            await database.execute("UPDATE main_quiz_availability_delivery SET email_sent=TRUE WHERE activation_id=? AND user_id=?", [activationId,student.userId]);
          } catch (error) { console.error("Main Quiz email delivery failed:", error.code || error.message); }
        }
      }
    }
  }
}

export async function startMainQuizAvailabilityNotifications() {
  await initialize();
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await checkMainQuizOpenings(); } catch (error) { console.error("Main Quiz availability check failed:", error.code || error.message); }
    finally { busy = false; }
  };
  await tick();
  return setInterval(tick, 10000).unref();
}
