import { db } from "../db.js";
import { getSystemSettingsConfig } from "../services/system/systemSettingsService.js";
import { logAuditFromRequest } from "../services/system/auditLogService.js";
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
function validateSettings(settings, submitted) {
  if (!settings.systemName) {
    return "System name is required.";
  }
  if (Object.hasOwn(submitted, "academicYear")) {
    const [start, end] = settings.academicYear.split("-").map(Number);
    if (!/^\d{4}-\d{4}$/.test(settings.academicYear) || end !== start + 1) {
      return "Enter consecutive academic years, such as 2026-2027.";
    }
  }
  const allowedSemesters = ["1st Semester", "2nd Semester", "Summer"];
  if (!allowedSemesters.includes(settings.semester)) {
    return "Invalid semester.";
  }

  if (
    Object.hasOwn(submitted, "passingPercentage") &&
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
    if (!Object.hasOwn(submitted, startKey) && !Object.hasOwn(submitted, endKey)) {
      continue;
    }

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
    ["systemName", "system_name", "System Name"],
    ["academicYear", "academic_year", "Academic Year"],
    ["semester", "semester", "Semester"],
    ["maintenanceMode", "maintenance_mode", "Maintenance Mode"],
    ["requirePasswordChange", "require_password_change", "Require Password Change"],
    ["professorApproval", "professor_approval", "Professor Approval"],
    ["practiceQuizEnabled", "practice_quiz_enabled", "Practice Quiz"],
    ["mainQuizEnabled", "main_quiz_enabled", "Main Quiz"],
    ["recordPracticeQuiz", "record_practice_quiz", "Record Practice Quiz"],
    ["recordMainQuiz", "record_main_quiz", "Record Main Quiz"],
    ["adaptiveQuizEnabled", "adaptive_quiz_enabled", "Adaptive Quiz"],
    ["quizAnalysisEnabled", "quiz_analysis_enabled", "Quiz Analysis"],
    ["enrollmentApproval", "enrollment_approval", "Enrollment Approval"],
    ["enrollmentAcceptedEmail", "enrollment_accepted_email", "Enrollment Accepted Email"],
    ["enrollmentDeclinedEmail", "enrollment_declined_email", "Enrollment Declined Email"],
    ["enrollmentSystemNotification", "enrollment_system_notification", "Enrollment System Notification"],
    ["professorApprovalNotification", "professor_approval_notification", "Professor Approval Notification"],
    ["announcementsEnabled", "announcements_enabled", "System Announcements"],
  ];
  for (const [key, column, label] of fields) {
    if (previous[key] !== next[key]) {
      changes.push({
        key,
        column,
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
export async function getPublicSystemStatus(req, res, next) {
  try {
    const { academicYear, semester, enrollmentApproval, maintenanceMode } =
      await getSystemSettingsConfig();
    res.set("Cache-Control", "no-store").json({
      academicYear,
      semester,
      enrollmentApproval,
      maintenanceMode,
    });
  } catch (error) {
    next(error);
  }
}

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
    const submitted = req.body ?? {};
    const updates = Object.entries(payloadToSettings(submitted)).filter(
      ([key]) => Object.hasOwn(submitted, key),
    );
    const settings = { ...currentSettings, ...Object.fromEntries(updates) };
    const validationMessage = validateSettings(settings, submitted);
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
    const assignments = changes.map(({ column }) => `${column} = ?`);
    await db.execute(
      `UPDATE system_settings
       SET ${assignments.join(", ")}, updated_by = ?
       WHERE setting_id = ?`,
      [
        ...changes.map(({ to }) => (typeof to === "boolean" ? Number(to) : to)),
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
