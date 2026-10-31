import { db } from "../db.js";
<<<<<<< HEAD
import { logAuditFromRequest } from "../services/system/auditLogService.js";
=======
import { logAuditFromRequest } from "../services/auditLogService.js";
>>>>>>> backend/main
/* =====================================================
   HELPERS
===================================================== */
function cleanText(value) {
  return String(value ?? "").trim();
}
function toBoolean(value) {
  return (
    value === true ||
    value === 1 ||
    value === "1" ||
    String(value).toLowerCase() === "true"
  );
}
function rowToSettings(row) {
  if (!row) {
    return null;
  }
  return {
    settingId: row.setting_id,
    systemName: row.system_name || "PuffyBrain",
    academicYear: row.academic_year || "",
    semester: row.semester || "",
    maintenanceMode: Boolean(row.maintenance_mode),
    requirePasswordChange: Boolean(row.require_password_change),
    professorApproval: Boolean(row.professor_approval),
    practiceQuizEnabled: Boolean(row.practice_quiz_enabled),
    mainQuizEnabled: Boolean(row.main_quiz_enabled),
    recordPracticeQuiz: Boolean(row.record_practice_quiz),
    recordMainQuiz: Boolean(row.record_main_quiz),
    adaptiveQuizEnabled: Boolean(row.adaptive_quiz_enabled),
    quizAnalysisEnabled: Boolean(row.quiz_analysis_enabled),
    enrollmentApproval: Boolean(row.enrollment_approval),
    enrollmentAcceptedEmail: Boolean(row.enrollment_accepted_email),
    enrollmentDeclinedEmail: Boolean(row.enrollment_declined_email),
    enrollmentSystemNotification: Boolean(row.enrollment_system_notification),
    professorApprovalNotification: Boolean(row.professor_approval_notification),
    announcementsEnabled: Boolean(row.announcements_enabled),
    updatedBy: row.updated_by || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,

    passingPercentage:
      row.passing_percentage == null ? null : Number(row.passing_percentage),

    semesterStartDate: row.semester_start_date || null,

    semesterEndDate: row.semester_end_date || null,

    schoolYearStartDate: row.school_year_start_date || null,

    schoolYearEndDate: row.school_year_end_date || null,
  };
}
function payloadToSettings(body = {}) {
  return {
    systemName: cleanText(body.systemName) || "PuffyBrain",
    academicYear: cleanText(body.academicYear),
    semester: cleanText(body.semester),
    maintenanceMode: toBoolean(body.maintenanceMode),
    requirePasswordChange: toBoolean(body.requirePasswordChange),
    professorApproval: toBoolean(body.professorApproval),
    practiceQuizEnabled: toBoolean(body.practiceQuizEnabled),
    mainQuizEnabled: toBoolean(body.mainQuizEnabled),
    recordPracticeQuiz: toBoolean(body.recordPracticeQuiz),
    recordMainQuiz: toBoolean(body.recordMainQuiz),
    adaptiveQuizEnabled: toBoolean(body.adaptiveQuizEnabled),
    quizAnalysisEnabled: toBoolean(body.quizAnalysisEnabled),
    enrollmentApproval: toBoolean(body.enrollmentApproval),
    enrollmentAcceptedEmail: toBoolean(body.enrollmentAcceptedEmail),
    enrollmentDeclinedEmail: toBoolean(body.enrollmentDeclinedEmail),
    enrollmentSystemNotification: toBoolean(body.enrollmentSystemNotification),
    professorApprovalNotification: toBoolean(
      body.professorApprovalNotification,
    ),
    announcementsEnabled: toBoolean(body.announcementsEnabled),

    passingPercentage:
      body.passingPercentage === "" || body.passingPercentage == null
        ? null
        : Number(body.passingPercentage),

    semesterStartDate: cleanText(body.semesterStartDate) || null,

    semesterEndDate: cleanText(body.semesterEndDate) || null,

    schoolYearStartDate: cleanText(body.schoolYearStartDate) || null,

    schoolYearEndDate: cleanText(body.schoolYearEndDate) || null,
  };
}
function validateSettings(settings) {
  if (!settings.systemName) {
    return "System name is required.";
  }
  if (!settings.academicYear) {
    return "Academic year is required.";
  }
  const allowedSemesters = ["1st Semester", "2nd Semester", "Summer"];
  if (!allowedSemesters.includes(settings.semester)) {
    return "Invalid semester.";
  }

  if (
    settings.passingPercentage !== null &&
    (!Number.isFinite(settings.passingPercentage) ||
      settings.passingPercentage < 0 ||
      settings.passingPercentage > 100)
  ) {
    return "Passing percentage must be between 0 and 100.";
  }

  const dateFields = [
    ["semesterStartDate", "semesterEndDate"],
    ["schoolYearStartDate", "schoolYearEndDate"],
  ];

  for (const [startKey, endKey] of dateFields) {
    const start = settings[startKey];
    const end = settings[endKey];

    if (Boolean(start) !== Boolean(end)) {
      return "Both start and end dates are required.";
    }

    for (const value of [start, end]) {
      if (!value) continue;

      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ||
        new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
      ) {
        return "Invalid academic calendar date.";
      }
    }

    if (start && end && start > end) {
      return "Academic calendar start date must be before end date.";
    }
  }

  return "";
}
/* =====================================================
   GET CHANGED SETTINGS
===================================================== */
function getChangedSettings(previous, next) {
  const changes = [];
  const fields = [
    ["systemName", "System Name"],
    ["academicYear", "Academic Year"],
    ["semester", "Semester"],
    ["maintenanceMode", "Maintenance Mode"],
    ["requirePasswordChange", "Require Password Change"],
    ["professorApproval", "Professor Approval"],
    ["practiceQuizEnabled", "Practice Quiz"],
    ["mainQuizEnabled", "Main Quiz"],
    ["recordPracticeQuiz", "Record Practice Quiz"],
    ["recordMainQuiz", "Record Main Quiz"],
    ["adaptiveQuizEnabled", "Adaptive Quiz"],
    ["quizAnalysisEnabled", "Quiz Analysis"],
    ["enrollmentApproval", "Enrollment Approval"],
    ["enrollmentAcceptedEmail", "Enrollment Accepted Email"],
    ["enrollmentDeclinedEmail", "Enrollment Declined Email"],
    ["enrollmentSystemNotification", "Enrollment System Notification"],
    ["professorApprovalNotification", "Professor Approval Notification"],
    ["announcementsEnabled", "System Announcements"],
  ];
  for (const [key, label] of fields) {
    if (previous[key] !== next[key]) {
      changes.push({
        key,
        label,
        from: previous[key],
        to: next[key],
      });
    }
  }
  return changes;
}
/* =====================================================
   FORMAT AUDIT DETAILS
===================================================== */
function formatAuditDetails(changes) {
  if (!changes.length) {
    return "No system setting values changed.";
  }
  return changes
    .map((change) => {
      return (
        `${change.label}: ` +
        `${JSON.stringify(change.from)} → ` +
        `${JSON.stringify(change.to)}`
      );
    })
    .join("; ");
}
/* =====================================================
   GET SYSTEM SETTINGS
===================================================== */
export async function getSystemSettings(req, res) {
  try {
    const [rows] = await db.execute(`SELECT *
       FROM system_settings
       ORDER BY setting_id ASC
       LIMIT 1`);
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "System settings were not found.",
      });
    }
    return res.json({
      success: true,
      settings: rowToSettings(rows[0]),
    });
  } catch (error) {
    console.error("Get system settings error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch system settings.",
    });
  }
}
/* =====================================================
   UPDATE SYSTEM SETTINGS
===================================================== */
export async function updateSystemSettings(req, res) {
  try {
    /* -----------------------------------------
       Get current settings first
    ----------------------------------------- */
    const [currentRows] = await db.execute(`SELECT *
         FROM system_settings
         ORDER BY setting_id ASC
         LIMIT 1`);
    if (currentRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "System settings were not found.",
      });
    }
    const currentRow = currentRows[0];
    const currentSettings =
      rowToSettings(currentRow); /* -----------------------------------------
       Validate incoming settings
    ----------------------------------------- */
    const settings = payloadToSettings(req.body);
    const validationMessage = validateSettings(settings);
    if (validationMessage) {
      return res.status(400).json({
        success: false,
        message: validationMessage,
      });
    }
    const changes = getChangedSettings(currentSettings, settings); /*
     * Nothing changed.
     *
     * Don't create meaningless audit rows.
     */
    if (changes.length === 0) {
      return res.json({
        success: true,
        changed: false,
        message: "No system setting changes were detected.",
        settings: currentSettings,
      });
    } /* -----------------------------------------
       Resolve authenticated Super Admin
    ----------------------------------------- */
    const currentUser = req.user || {};
    const userId =
      currentUser.userId ||
      currentUser.user_id ||
      currentUser.id ||
      null; /* -----------------------------------------
       Update database
    ----------------------------------------- */
    await db.execute(
      `UPDATE system_settings
       SET
         system_name = ?,
         academic_year = ?,
         semester = ?,
         maintenance_mode = ?,
         require_password_change = ?,
         professor_approval = ?,
         practice_quiz_enabled = ?,
         main_quiz_enabled = ?,
         record_practice_quiz = ?,
         record_main_quiz = ?,
         adaptive_quiz_enabled = ?,
         quiz_analysis_enabled = ?,
         enrollment_approval = ?,
         enrollment_accepted_email = ?,
         enrollment_declined_email = ?,
         enrollment_system_notification = ?,
         professor_approval_notification = ?,
         announcements_enabled = ?,
         updated_by = ?
       WHERE setting_id = ?`,
      [
        settings.systemName,
        settings.academicYear,
        settings.semester,
        settings.maintenanceMode ? 1 : 0,
        settings.requirePasswordChange ? 1 : 0,
        settings.professorApproval ? 1 : 0,
        settings.practiceQuizEnabled ? 1 : 0,
        settings.mainQuizEnabled ? 1 : 0,
        settings.recordPracticeQuiz ? 1 : 0,
        settings.recordMainQuiz ? 1 : 0,
        settings.adaptiveQuizEnabled ? 1 : 0,
        settings.quizAnalysisEnabled ? 1 : 0,
        settings.enrollmentApproval ? 1 : 0,
        settings.enrollmentAcceptedEmail ? 1 : 0,
        settings.enrollmentDeclinedEmail ? 1 : 0,
        settings.enrollmentSystemNotification ? 1 : 0,
        settings.professorApprovalNotification ? 1 : 0,
        settings.announcementsEnabled ? 1 : 0,
        userId,
        currentRow.setting_id,
      ],
    ); /* -----------------------------------------
       Read updated record
    ----------------------------------------- */
    const [updatedRows] = await db.execute(
      `SELECT *
         FROM system_settings
         WHERE setting_id = ?
         LIMIT 1`,
      [currentRow.setting_id],
    );
    const updatedSettings = rowToSettings(
      updatedRows[0],
    ); /* -----------------------------------------
       Audit
    ----------------------------------------- */
    await logAuditFromRequest(req, {
      category: "System Settings",
      action: "Updated System Settings",
      target: "PuffyBrain System Settings",
      status: "Success",
      details: formatAuditDetails(changes),
    });
    return res.json({
      success: true,
      changed: true,
      message: "System settings updated successfully.",
      settings: updatedSettings,
      changedFields: changes.map((change) => change.key),
    });
  } catch (error) {
    console.error("Update system settings error:", error); /*
     * Record failed attempts as well.
     */
    await logAuditFromRequest(req, {
      category: "System Settings",
      action: "Update System Settings",
      target: "PuffyBrain System Settings",
      status: "Failed",
      details: error?.message || "Failed to update system settings.",
    });
    return res.status(500).json({
      success: false,
      message: "Failed to update system settings.",
    });
  }
}
