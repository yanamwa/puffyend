import { db } from "../db.js";

/**
 * Creates an in-app notification for one user.
 */
export async function createNotification({
  recipientUserId,
  courseId = null,
  enrollmentId = null,
  title,
  message,
  target,
  type,
  createdByUserId = null,
  createdByName = null,
  createdByRole = null,
}) {
  if (!recipientUserId) {
    throw new Error(
      "Notification recipient is required."
    );
  }

  if (!title || !message) {
    throw new Error(
      "Notification title and message are required."
    );
  }

  const [result] = await db.execute(
    `INSERT INTO notifications (
      recipient_user_id,
      course_id,
      enrollment_id,
      title,
      message,
      target,
      type,
      is_read,
      created_by_user_id,
      created_by_name,
      created_by_role
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    [
      recipientUserId,
      courseId,
      enrollmentId,
      title,
      message,
      target || "all",
      type || "announcement",
      createdByUserId,
      createdByName,
      createdByRole,
    ]
  );

  return {
    notificationId: result.insertId,
  };
}