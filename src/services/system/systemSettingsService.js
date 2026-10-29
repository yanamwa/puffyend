import { db } from "../../db.js";

/* =====================================================
   DEFAULT SYSTEM SETTINGS

   These are fallback values only.
   The database remains the main source of truth.
===================================================== */

const DEFAULT_SYSTEM_SETTINGS = {
  systemName: "PuffyBrain",
  academicYear: "",
  semester: "",

  maintenanceMode: false,

  requirePasswordChange: true,
  professorApproval: true,

  practiceQuizEnabled: true,
  mainQuizEnabled: true,

  recordPracticeQuiz: true,
  recordMainQuiz: true,

  adaptiveQuizEnabled: true,
  quizAnalysisEnabled: true,

  enrollmentApproval: true,

  enrollmentAcceptedEmail: true,
  enrollmentDeclinedEmail: true,
  enrollmentSystemNotification: true,

  professorApprovalNotification: true,
  announcementsEnabled: true,
};

/* =====================================================
   CONVERT DATABASE ROW
===================================================== */

function rowToSystemSettings(row) {
  if (!row) {
    return {
      ...DEFAULT_SYSTEM_SETTINGS,
    };
  }

  return {
    systemName: row.system_name || DEFAULT_SYSTEM_SETTINGS.systemName,

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
  };
}

/* =====================================================
   GET ALL SYSTEM SETTINGS

   Use this from controllers/services when multiple
   settings are needed.
===================================================== */

export async function getSystemSettingsConfig() {
  try {
    const [rows] = await db.execute(
      `SELECT *
       FROM system_settings
       ORDER BY setting_id ASC
       LIMIT 1`,
    );

    if (!rows.length) {
      console.warn("System settings row was not found. Using defaults.");

      return {
        ...DEFAULT_SYSTEM_SETTINGS,
      };
    }

    return rowToSystemSettings(rows[0]);
  } catch (error) {
    console.error("Failed to load system settings:", error);

    throw error;
  }
}

/* =====================================================
   GET ONE SYSTEM SETTING

   Example:

   const enabled =
     await getSystemSetting(
       "practiceQuizEnabled"
     );
===================================================== */

export async function getSystemSetting(settingName) {
  if (!settingName) {
    throw new Error("System setting name is required.");
  }

  const settings = await getSystemSettingsConfig();

  if (!Object.prototype.hasOwnProperty.call(settings, settingName)) {
    throw new Error(`Unknown system setting: ${settingName}`);
  }

  return settings[settingName];
}

/* =====================================================
   CHECK BOOLEAN SETTING

   Example:

   if (
     await isSystemSettingEnabled(
       "mainQuizEnabled"
     )
   ) {
      ...
   }
===================================================== */

export async function isSystemSettingEnabled(settingName) {
  const value = await getSystemSetting(settingName);

  return value === true;
}

/* =====================================================
   SPECIALIZED HELPERS

   These keep controller code easy to read.
===================================================== */

export async function isMaintenanceModeEnabled() {
  return isSystemSettingEnabled("maintenanceMode");
}

export async function isPasswordChangeRequired() {
  return isSystemSettingEnabled("requirePasswordChange");
}

export async function isProfessorApprovalRequired() {
  return isSystemSettingEnabled("professorApproval");
}

export async function isPracticeQuizEnabled() {
  return isSystemSettingEnabled("practiceQuizEnabled");
}

export async function isMainQuizEnabled() {
  return isSystemSettingEnabled("mainQuizEnabled");
}

export async function shouldRecordPracticeQuiz() {
  return isSystemSettingEnabled("recordPracticeQuiz");
}

export async function shouldRecordMainQuiz() {
  return isSystemSettingEnabled("recordMainQuiz");
}

export async function isAdaptiveQuizEnabled() {
  return isSystemSettingEnabled("adaptiveQuizEnabled");
}

export async function isQuizAnalysisEnabled() {
  return isSystemSettingEnabled("quizAnalysisEnabled");
}

export async function isEnrollmentApprovalRequired() {
  return isSystemSettingEnabled("enrollmentApproval");
}

export async function shouldSendEnrollmentAcceptedEmail() {
  return isSystemSettingEnabled("enrollmentAcceptedEmail");
}

export async function shouldSendEnrollmentDeclinedEmail() {
  return isSystemSettingEnabled("enrollmentDeclinedEmail");
}

export async function shouldSendEnrollmentSystemNotification() {
  return isSystemSettingEnabled("enrollmentSystemNotification");
}

export async function shouldSendProfessorApprovalNotification() {
  return isSystemSettingEnabled("professorApprovalNotification");
}

export async function areAnnouncementsEnabled() {
  return isSystemSettingEnabled("announcementsEnabled");
}

/* =====================================================
   DEFAULT EXPORT
===================================================== */

export default {
  getSystemSettingsConfig,
  getSystemSetting,
  isSystemSettingEnabled,

  isMaintenanceModeEnabled,
  isPasswordChangeRequired,
  isProfessorApprovalRequired,

  isPracticeQuizEnabled,
  isMainQuizEnabled,
  shouldRecordPracticeQuiz,
  shouldRecordMainQuiz,
  isAdaptiveQuizEnabled,
  isQuizAnalysisEnabled,

  isEnrollmentApprovalRequired,
  shouldSendEnrollmentAcceptedEmail,
  shouldSendEnrollmentDeclinedEmail,
  shouldSendEnrollmentSystemNotification,

  shouldSendProfessorApprovalNotification,
  areAnnouncementsEnabled,
};
