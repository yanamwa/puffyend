import { db } from '../../db.js';

export const requestError = (message, statusCode) => Object.assign(new Error(message), { statusCode });

export function canEditCourse(user, course) {
  if (!user) return false;
  if (['admin', 'super_admin', 'superadmin'].includes(user.role)) return true;
  return user.role === 'professor' && (String(course.professor_id) === String(user.userId) ||
    (!course.professor_id && !!course.professor_email && course.professor_email.toLowerCase() === user.email?.toLowerCase()));
}

export async function assertCourseAccess(user, courseId, lessonId = null) {
  if (!Number.isSafeInteger(Number(courseId)) || Number(courseId) < 1 ||
      (lessonId !== null && (!Number.isSafeInteger(Number(lessonId)) || Number(lessonId) < 1))) throw requestError('A saved numeric course_id and optional lesson_id are required.', 400);
  const [courses] = await db.execute('SELECT course_id, professor_id, professor_email FROM courses WHERE course_id = ?', [courseId]);
  if (!courses[0]) throw requestError('Course not found.', 404);
  if (!canEditCourse(user, courses[0])) throw requestError('You cannot edit this course.', 403);
  if (lessonId !== null) {
    const [modules] = await db.execute('SELECT lesson_id FROM learning_modules WHERE lesson_id = ? AND course_id = ?', [lessonId, courseId]);
    if (!modules.length) throw requestError('Module does not belong to this course.', 400);
  }
  return courses[0];
}

export async function assertWorkerAccess(requesterId, courseId, lessonId) {
  const [users] = await db.execute('SELECT userId, email, role, is_archived, verification_status, is_temporary, temporary_expires_at FROM users WHERE userId = ?', [requesterId]);
  const user = users[0];
  if (!user || user.is_archived || (user.is_temporary && user.temporary_expires_at && new Date(user.temporary_expires_at) <= new Date())) throw requestError('Requesting account is no longer active.', 403);
  user.role = user.role.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (user.role === 'professor' && user.verification_status !== 'approved') throw requestError('Professor is no longer approved.', 403);
  return assertCourseAccess(user, courseId, lessonId);
}
