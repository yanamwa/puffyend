<<<<<<< HEAD
import { db, initializeDatabase } from "./database/postgres.js";
import bcrypt from "bcrypt";
export { db };
=======
import mysql from "mysql2/promise";
import dotenv from "dotenv";
import bcrypt from "bcrypt";

dotenv.config();

const dbConfig = {
  host: process.env.DB_HOST || "127.0.0.1",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "puffybrain",
};

const pool = mysql.createPool({
  host: dbConfig.host,
  user: dbConfig.user,
  password: dbConfig.password,
  database: dbConfig.database,
  waitForConnections: true,
  connectionLimit: 10,
});

export const db = pool;

async function ensureDatabaseExists() {
  const bootstrapPool = mysql.createPool({
    host: dbConfig.host,
    user: dbConfig.user,
    password: dbConfig.password,
    waitForConnections: true,
    connectionLimit: 1,
  });

  try {
    await bootstrapPool.execute(
      `CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\`
       CHARACTER SET utf8mb4
       COLLATE utf8mb4_general_ci`,
    );
  } finally {
    await bootstrapPool.end();
  }
}
>>>>>>> backend/main

async function ensureColumn(columnName, columnDefinition) {
  const [columns] = await db.execute(
    `SELECT COLUMN_NAME
<<<<<<< HEAD
     FROM information_schema.columns
     WHERE TABLE_SCHEMA = CURRENT_SCHEMA()
=======
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
>>>>>>> backend/main
       AND TABLE_NAME = 'users'
       AND COLUMN_NAME = ?`,
    [columnName],
  );

  if (columns.length === 0) {
    await db.execute(`ALTER TABLE users ADD COLUMN ${columnDefinition}`);
  }
}

async function ensureTableColumn(tableName, columnName, columnDefinition) {
  const [columns] = await db.execute(
    `SELECT COLUMN_NAME
<<<<<<< HEAD
     FROM information_schema.columns
     WHERE TABLE_SCHEMA = CURRENT_SCHEMA()
=======
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
>>>>>>> backend/main
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?`,
    [tableName, columnName],
  );

  if (columns.length === 0) {
    await db.execute(`ALTER TABLE ${tableName} ADD COLUMN ${columnDefinition}`);
  }
}

async function initCourseTables() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS courses (
<<<<<<< HEAD
      course_id SERIAL PRIMARY KEY,
=======
      course_id INT AUTO_INCREMENT PRIMARY KEY,
>>>>>>> backend/main
      title VARCHAR(255) NOT NULL,
      code VARCHAR(50) NOT NULL,
      summary TEXT NOT NULL,
      subject VARCHAR(255) NOT NULL,
      professor_id INT NULL,
      course_name VARCHAR(255) NULL,
      description TEXT NULL,
      course_code VARCHAR(50) NULL,
      learning_objectives TEXT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'draft',
      visibility VARCHAR(50) NOT NULL DEFAULT 'private',
<<<<<<< HEAD
      lesson_pages TEXT NULL,
      quiz_items TEXT NULL,
=======
      lesson_pages LONGTEXT NULL,
      quiz_items LONGTEXT NULL,
>>>>>>> backend/main
      students INT NOT NULL DEFAULT 0,
      modules INT NOT NULL DEFAULT 0,
      quizzes INT NOT NULL DEFAULT 0,
      join_link VARCHAR(500) NULL,
<<<<<<< HEAD
      archived SMALLINT NOT NULL DEFAULT 0,
=======
      archived TINYINT(1) NOT NULL DEFAULT 0,
>>>>>>> backend/main
      professor_name VARCHAR(255) NULL,
      professor_email VARCHAR(255) NULL,
      professor_department VARCHAR(255) NULL,
      professor_profile_image VARCHAR(500) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
<<<<<<< HEAD
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT courses_code_unique UNIQUE (code)
=======
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY courses_code_unique (code)
>>>>>>> backend/main
    )
  `);

  await ensureTableColumn("courses", "title", "title VARCHAR(255) NOT NULL");
  await ensureTableColumn("courses", "code", "code VARCHAR(50) NOT NULL");
  await ensureTableColumn("courses", "summary", "summary TEXT NOT NULL");
  await ensureTableColumn(
    "courses",
    "subject",
    "subject VARCHAR(255) NOT NULL",
  );
  await ensureTableColumn("courses", "professor_id", "professor_id INT NULL");
  await ensureTableColumn(
    "courses",
    "course_name",
    "course_name VARCHAR(255) NULL",
  );
  await ensureTableColumn("courses", "description", "description TEXT NULL");
  await ensureTableColumn(
    "courses",
    "course_code",
    "course_code VARCHAR(50) NULL",
  );
  await ensureTableColumn(
    "courses",
    "learning_objectives",
    "learning_objectives TEXT NULL",
  );
  await ensureTableColumn(
    "courses",
    "status",
    "status VARCHAR(50) NOT NULL DEFAULT 'draft'",
  );
  await ensureTableColumn(
    "courses",
    "visibility",
    "visibility VARCHAR(50) NOT NULL DEFAULT 'private'",
  );
  await ensureTableColumn(
    "courses",
    "lesson_pages",
<<<<<<< HEAD
    "lesson_pages TEXT NULL",
  );
  await ensureTableColumn("courses", "quiz_items", "quiz_items TEXT NULL");
=======
    "lesson_pages LONGTEXT NULL",
  );
  await ensureTableColumn("courses", "quiz_items", "quiz_items LONGTEXT NULL");
>>>>>>> backend/main
  await ensureTableColumn(
    "courses",
    "students",
    "students INT NOT NULL DEFAULT 0",
  );
  await ensureTableColumn(
    "courses",
    "modules",
    "modules INT NOT NULL DEFAULT 0",
  );
  await ensureTableColumn(
    "courses",
    "quizzes",
    "quizzes INT NOT NULL DEFAULT 0",
  );
  await ensureTableColumn(
    "courses",
    "join_link",
    "join_link VARCHAR(500) NULL",
  );
  await ensureTableColumn(
    "courses",
    "archived",
<<<<<<< HEAD
    "archived SMALLINT NOT NULL DEFAULT 0",
=======
    "archived TINYINT(1) NOT NULL DEFAULT 0",
>>>>>>> backend/main
  );
  await ensureTableColumn(
    "courses",
    "professor_name",
    "professor_name VARCHAR(255) NULL",
  );
  await ensureTableColumn(
    "courses",
    "professor_email",
    "professor_email VARCHAR(255) NULL",
  );
  await ensureTableColumn(
    "courses",
    "professor_department",
    "professor_department VARCHAR(255) NULL",
  );
  await ensureTableColumn(
    "courses",
    "professor_profile_image",
    "professor_profile_image VARCHAR(500) NULL",
  );

  const [courseIdColumns] = await db.execute(
    `SELECT COLUMN_NAME
<<<<<<< HEAD
     FROM information_schema.columns
     WHERE TABLE_SCHEMA = CURRENT_SCHEMA()
=======
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
>>>>>>> backend/main
       AND TABLE_NAME = 'courses'
       AND COLUMN_NAME IN ('course_id', 'id')`,
  );
  const courseIdColumnNames = new Set(
    courseIdColumns.map((column) => column.COLUMN_NAME),
  );
  const courseIdColumn = courseIdColumnNames.has("course_id")
    ? "course_id"
    : "id";

  await db.execute(`
    CREATE TABLE IF NOT EXISTS learning_modules (
<<<<<<< HEAD
      lesson_id SERIAL PRIMARY KEY,
=======
      lesson_id INT AUTO_INCREMENT PRIMARY KEY,
>>>>>>> backend/main
      course_id INT NOT NULL,
      title VARCHAR(255) NOT NULL,
      description TEXT NULL,
      subject VARCHAR(255) NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'draft',
<<<<<<< HEAD
      quiz_contents TEXT NULL,
      learning_objectives TEXT NULL,
      lesson_contents TEXT NULL,
      has_quiz SMALLINT NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
=======
      quiz_contents LONGTEXT NULL,
      learning_objectives TEXT NULL,
      lesson_contents LONGTEXT NULL,
      has_quiz TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX learning_modules_course_id_idx (course_id),
>>>>>>> backend/main
      CONSTRAINT learning_modules_course_fk
        FOREIGN KEY (course_id) REFERENCES courses(${courseIdColumn})
        ON DELETE CASCADE
    )
  `);

  await ensureTableColumn(
    "learning_modules",
    "course_id",
    "course_id INT NOT NULL",
  );
  await ensureTableColumn(
    "learning_modules",
    "title",
    "title VARCHAR(255) NOT NULL",
  );
  await ensureTableColumn(
    "learning_modules",
    "description",
    "description TEXT NULL",
  );
  await ensureTableColumn(
    "learning_modules",
    "subject",
    "subject VARCHAR(255) NULL",
  );
  await ensureTableColumn(
    "learning_modules",
    "status",
    "status VARCHAR(50) NOT NULL DEFAULT 'draft'",
  );
  await ensureTableColumn(
    "learning_modules",
    "quiz_contents",
<<<<<<< HEAD
    "quiz_contents TEXT NULL",
=======
    "quiz_contents LONGTEXT NULL",
>>>>>>> backend/main
  );
  await ensureTableColumn(
    "learning_modules",
    "learning_objectives",
    "learning_objectives TEXT NULL",
  );
  await ensureTableColumn(
    "learning_modules",
    "lesson_contents",
<<<<<<< HEAD
    "lesson_contents TEXT NULL",
=======
    "lesson_contents LONGTEXT NULL",
>>>>>>> backend/main
  );
  await ensureTableColumn(
    "learning_modules",
    "has_quiz",
<<<<<<< HEAD
    "has_quiz SMALLINT NOT NULL DEFAULT 0",
=======
    "has_quiz TINYINT(1) NOT NULL DEFAULT 0",
>>>>>>> backend/main
  );
}

async function initQuizModeTables() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS quiz_modes (
<<<<<<< HEAD
      quiz_id SERIAL PRIMARY KEY,
=======
      quiz_id INT AUTO_INCREMENT PRIMARY KEY,
>>>>>>> backend/main
      created_by INT NULL,
      mode_name VARCHAR(255) NOT NULL,
      title VARCHAR(255) NULL,
      description TEXT NULL,
      image VARCHAR(500) NULL,
      route VARCHAR(500) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
<<<<<<< HEAD
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
=======
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
>>>>>>> backend/main
    )
  `);

  await ensureTableColumn("quiz_modes", "created_by", "created_by INT NULL");
  await ensureTableColumn(
    "quiz_modes",
    "mode_name",
    "mode_name VARCHAR(255) NOT NULL",
  );
  await ensureTableColumn("quiz_modes", "title", "title VARCHAR(255) NULL");
  await ensureTableColumn("quiz_modes", "description", "description TEXT NULL");
  await ensureTableColumn("quiz_modes", "image", "image VARCHAR(500) NULL");
  await ensureTableColumn("quiz_modes", "route", "route VARCHAR(500) NOT NULL");

  const defaultQuizModes = [
    [
      "Flashcards",
      "Flashcards",
      "Review facts and test your memory in a fun and quick way. Perfect for learning on the go!",
      "/images/flashcard.png",
      "/flashcards-tutorial",
    ],
    [
      "Q & A",
      "Q & A",
      "Challenge your brain with interesting questions and discover something new every time you play!",
      "/images/qna.png",
      "/QandA-tutorial",
    ],
    [
      "Multiple Choice",
      "Multiple Choice",
      "Only one answer is correct. Trust your instincts, think carefully, and aim for that perfect score!",
      "/images/multiplechoice.png",
      "/multipleChoice-tutorial",
    ],
    [
      "Matching Type",
      "Matching Type",
      "Pair the terms, ideas, or clues correctly. It's a fun way to test your memory and logic!",
      "/images/matching.png",
      "/Matching-tutorial",
    ],
    [
      "Timed Quiz",
      "Timed Quiz",
      "Answer questions within a time limit and build speed while reviewing the lesson.",
      "/images/timedquiz.png",
      "/timedquiz-tutorial",
    ],
    [
      "Mixed Mode",
      "Mixed Mode",
      "Practice with matching type, multiple choice, and Q&A all at once.",
      "/images/needpractice.png",
      "/random-modes-tutorial",
    ],
  ];

  const [existingModes] = await db.execute(
    "SELECT mode_name, title, route FROM quiz_modes",
  );
  const existingKeys = new Set(
    existingModes.flatMap((mode) => [
      String(mode.mode_name || "").toLowerCase(),
      String(mode.title || "").toLowerCase(),
      String(mode.route || "").toLowerCase(),
    ]),
  );

  for (const mode of defaultQuizModes) {
    const [modeName, title, description, image, route] = mode;
    const hasMode =
      existingKeys.has(modeName.toLowerCase()) ||
      existingKeys.has(title.toLowerCase()) ||
      existingKeys.has(route.toLowerCase());

    if (hasMode) continue;

    await db.execute(
      `INSERT INTO quiz_modes (mode_name, title, description, image, route)
       VALUES (?, ?, ?, ?, ?)`,
      [modeName, title, description, image, route],
    );
  }
}

async function initMonitoringTables() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS course_enrollments (
<<<<<<< HEAD
      enrollment_id SERIAL PRIMARY KEY,
      course_id INT NOT NULL,
      user_id INT NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'pending',
      approved_at TIMESTAMP NULL,
      rejection_reason TEXT NULL,
      archived SMALLINT NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT course_enrollments_unique UNIQUE (course_id, user_id)
=======
      enrollment_id INT AUTO_INCREMENT PRIMARY KEY,
      course_id INT NOT NULL,
      user_id INT NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'pending',
      approved_at DATETIME NULL,
      rejection_reason TEXT NULL,
      archived TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY course_enrollments_unique (course_id, user_id),
      INDEX course_enrollments_course_idx (course_id),
      INDEX course_enrollments_user_idx (user_id)
>>>>>>> backend/main
    )
  `);
  await ensureTableColumn(
    "course_enrollments",
    "archived",
<<<<<<< HEAD
    "archived SMALLINT NOT NULL DEFAULT 0",
=======
    "archived TINYINT(1) NOT NULL DEFAULT 0",
>>>>>>> backend/main
  );
  await ensureTableColumn(
    "course_enrollments",
    "status",
    "status VARCHAR(50) NOT NULL DEFAULT 'pending'",
  );
  await ensureTableColumn(
    "course_enrollments",
    "approved_at",
<<<<<<< HEAD
    "approved_at TIMESTAMP NULL",
=======
    "approved_at DATETIME NULL",
>>>>>>> backend/main
  );
  await ensureTableColumn(
    "course_enrollments",
    "rejection_reason",
    "rejection_reason TEXT NULL",
  );

  await db.execute(`
    UPDATE course_enrollments
    SET status = 'pending'
    WHERE status IS NULL OR status = ''
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS saved_courses (
<<<<<<< HEAD
      saved_id SERIAL PRIMARY KEY,
      user_id INT NOT NULL,
      course_id INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT saved_courses_unique UNIQUE (user_id, course_id)
=======
      saved_id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      course_id INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY saved_courses_unique (user_id, course_id),
      INDEX saved_courses_course_idx (course_id),
      INDEX saved_courses_user_idx (user_id)
>>>>>>> backend/main
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS lesson_progress (
<<<<<<< HEAD
      progress_id SERIAL PRIMARY KEY,
=======
      progress_id INT AUTO_INCREMENT PRIMARY KEY,
>>>>>>> backend/main
      user_id INT NOT NULL,
      lesson_id INT NOT NULL,
      course_id INT NULL,
      total_cards INT NOT NULL DEFAULT 0,
      studied_cards INT NOT NULL DEFAULT 0,
      progress_percent DECIMAL(5,2) NOT NULL DEFAULT 0,
      last_viewed_card INT NOT NULL DEFAULT 0,
<<<<<<< HEAD
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT lesson_progress_unique UNIQUE (user_id, lesson_id)
=======
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY lesson_progress_unique (user_id, lesson_id),
      INDEX lesson_progress_course_idx (course_id),
      INDEX lesson_progress_user_idx (user_id)
>>>>>>> backend/main
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS quiz_attempts (
<<<<<<< HEAD
      attempts_id SERIAL PRIMARY KEY,
=======
      attempts_id INT AUTO_INCREMENT PRIMARY KEY,
>>>>>>> backend/main
      user_id INT NOT NULL,
      lesson_id INT NULL,
      course_id INT NULL,
      score INT NOT NULL DEFAULT 0,
      total INT NOT NULL DEFAULT 0,
      source VARCHAR(50) NOT NULL DEFAULT 'lesson',
      quiz_mode VARCHAR(50) NULL,
      time_spent INT NOT NULL DEFAULT 0,
<<<<<<< HEAD
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
=======
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX quiz_attempts_course_idx (course_id),
      INDEX quiz_attempts_user_idx (user_id),
      INDEX quiz_attempts_lesson_idx (lesson_id)
>>>>>>> backend/main
    )
  `);

  await db.execute(`CREATE TABLE IF NOT EXISTS quiz_attempt_details (
    attempts_id INT PRIMARY KEY, assessment_type VARCHAR(20) NOT NULL,
<<<<<<< HEAD
    answers_json TEXT NOT NULL, module_index INT NULL
=======
    answers_json LONGTEXT NOT NULL, module_index INT NULL
>>>>>>> backend/main
  )`);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS performance_analytics (
<<<<<<< HEAD
      analytics_id SERIAL PRIMARY KEY,
=======
      analytics_id INT AUTO_INCREMENT PRIMARY KEY,
>>>>>>> backend/main
      user_id INT NOT NULL,
      lesson_id INT NULL,
      course_id INT NOT NULL,
      average_score DECIMAL(5,2) NOT NULL DEFAULT 0,
      weakest_topic VARCHAR(255) NULL,
      strongest_topic VARCHAR(255) NULL,
      total_attempts INT NOT NULL DEFAULT 0,
<<<<<<< HEAD
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT performance_analytics_unique UNIQUE (user_id, course_id)
=======
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY performance_analytics_unique (user_id, course_id),
      INDEX performance_analytics_course_idx (course_id),
      INDEX performance_analytics_user_idx (user_id)
>>>>>>> backend/main
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS adaptive_feedback (
<<<<<<< HEAD
      feedback_id SERIAL PRIMARY KEY,
=======
      feedback_id INT AUTO_INCREMENT PRIMARY KEY,
>>>>>>> backend/main
      attempts_id INT NULL,
      user_id INT NOT NULL,
      strengths TEXT NULL,
      weaknesses TEXT NULL,
      recommendations TEXT NULL,
<<<<<<< HEAD
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
=======
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX adaptive_feedback_attempt_idx (attempts_id),
      INDEX adaptive_feedback_user_idx (user_id)
>>>>>>> backend/main
    )
  `);
}

async function initNotificationTables() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS managed_notifications (
<<<<<<< HEAD
      notification_id SERIAL PRIMARY KEY,
=======
      notification_id INT AUTO_INCREMENT PRIMARY KEY,
>>>>>>> backend/main
      title VARCHAR(255) NOT NULL,
      message TEXT NOT NULL,
      target VARCHAR(50) NOT NULL DEFAULT 'all',
      type VARCHAR(50) NOT NULL DEFAULT 'announcement',
      created_by_user_id INT NULL,
      created_by_name VARCHAR(255) NULL,
      created_by_role VARCHAR(50) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
<<<<<<< HEAD
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
=======
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX managed_notifications_created_at_idx (created_at),
      INDEX managed_notifications_target_idx (target)
>>>>>>> backend/main
    )
  `);

  await ensureTableColumn(
    "managed_notifications",
    "title",
    "title VARCHAR(255) NOT NULL",
  );
  await ensureTableColumn(
    "managed_notifications",
    "message",
    "message TEXT NOT NULL",
  );
  await ensureTableColumn(
    "managed_notifications",
    "target",
    "target VARCHAR(50) NOT NULL DEFAULT 'all'",
  );
  await ensureTableColumn(
    "managed_notifications",
    "type",
    "type VARCHAR(50) NOT NULL DEFAULT 'announcement'",
  );
  await ensureTableColumn(
    "managed_notifications",
    "created_by_user_id",
    "created_by_user_id INT NULL",
  );
  await ensureTableColumn(
    "managed_notifications",
    "created_by_name",
    "created_by_name VARCHAR(255) NULL",
  );
  await ensureTableColumn(
    "managed_notifications",
    "created_by_role",
    "created_by_role VARCHAR(50) NULL",
  );
  await ensureTableColumn(
    "managed_notifications",
    "created_at",
    "created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
  );
  await ensureTableColumn(
    "managed_notifications",
    "updated_at",
<<<<<<< HEAD
    "updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
  );


=======
    "updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP",
  );

  await db.execute(`
    DELETE older
    FROM managed_notifications older
    INNER JOIN managed_notifications newer
      ON newer.created_at > older.created_at
      OR (
        newer.created_at = older.created_at
        AND newer.notification_id > older.notification_id
      )
  `);
>>>>>>> backend/main
}

async function ensureSuperAdminUser() {
  const superAdminEmail = (
    process.env.SUPER_ADMIN_EMAIL || "superadmin@puffybrain.local"
  )
    .trim()
    .toLowerCase();
  const configuredSuperAdminPassword = process.env.SUPER_ADMIN_PASSWORD;
  const superAdminPassword = configuredSuperAdminPassword;
  const superAdminName = process.env.SUPER_ADMIN_NAME || "Super Admin";

  if (!superAdminEmail || !superAdminPassword) return;

  const [rows] = await db.execute(
    "SELECT userId FROM users WHERE email = ? LIMIT 1",
    [superAdminEmail],
  );

  if (rows.length > 0) {
    if (configuredSuperAdminPassword) {
      const hashedPassword = await bcrypt.hash(superAdminPassword, 10);

      await db.execute(
        `UPDATE users
         SET password = ?,
             role = 'super_admin',
             name = ?,
             display_name = ?,
             verification_status = 'approved',
             is_verified = 1,
             onboarding_completed = 1,
             is_archived = 0,
             archived_at = NULL,
             is_temporary = 0,
             temporary_expires_at = NULL
         WHERE email = ?`,
        [hashedPassword, superAdminName, superAdminName, superAdminEmail],
      );
      return;
    }

    await db.execute(
      `UPDATE users
       SET role = 'super_admin',
           name = ?,
           display_name = ?,
           verification_status = 'approved',
           is_verified = 1,
           onboarding_completed = 1,
           is_archived = 0,
           archived_at = NULL,
           is_temporary = 0,
           temporary_expires_at = NULL
       WHERE email = ?`,
      [superAdminName, superAdminName, superAdminEmail],
    );
    return;
  }

  const hashedPassword = await bcrypt.hash(superAdminPassword, 10);

  await db.execute(
    `INSERT INTO users
     (email, password, role, name, display_name, verification_status,
      is_verified, onboarding_completed, is_archived, is_temporary,
      temporary_expires_at)
     VALUES (?, ?, 'super_admin', ?, ?, 'approved', 1, 1, 0, 0, NULL)`,
    [superAdminEmail, hashedPassword, superAdminName, superAdminName],
  );
}

export async function initDb() {
<<<<<<< HEAD
  await initializeDatabase();

  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      userId SERIAL PRIMARY KEY,
=======
  await ensureDatabaseExists();

  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      userId INT AUTO_INCREMENT PRIMARY KEY,
>>>>>>> backend/main
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      role VARCHAR(50) NOT NULL DEFAULT 'student',
      gender VARCHAR(50) NULL,
      display_name VARCHAR(255) NULL,
      profile_image VARCHAR(500) NULL,
      year_level VARCHAR(50) NULL,
      section_name VARCHAR(20) NULL,
<<<<<<< HEAD
      onboarding_completed SMALLINT NOT NULL DEFAULT 0,
=======
      onboarding_completed TINYINT(1) NOT NULL DEFAULT 0,
>>>>>>> backend/main
      verification_id VARCHAR(100) NULL,
      student_id VARCHAR(100) NULL,
      professor_id VARCHAR(100) NULL,
      professor_faculty_id VARCHAR(100) NULL,
      professor_department VARCHAR(255) NULL,
      professor_position VARCHAR(255) NULL,
      professor_specialization VARCHAR(255) NULL,
      professor_employment_proof TEXT NULL,
      verification_status VARCHAR(50) NOT NULL DEFAULT 'pending',
<<<<<<< HEAD
      is_archived SMALLINT NOT NULL DEFAULT 0,
      archived_at TIMESTAMP NULL,
      must_change_password SMALLINT NOT NULL DEFAULT 0,
      is_temporary SMALLINT NOT NULL DEFAULT 0,
      temporary_expires_at TIMESTAMP NULL,
      otp_code VARCHAR(10) NULL,
      otp_expires TIMESTAMP NULL,
      password_reset_token VARCHAR(64) NULL,
      password_reset_expires TIMESTAMP NULL,
      is_verified SMALLINT NOT NULL DEFAULT 0,
=======
      is_archived TINYINT(1) NOT NULL DEFAULT 0,
      archived_at DATETIME NULL,
      must_change_password TINYINT(1) NOT NULL DEFAULT 0,
      is_temporary TINYINT(1) NOT NULL DEFAULT 0,
      temporary_expires_at DATETIME NULL,
      otp_code VARCHAR(10) NULL,
      otp_expires DATETIME NULL,
      password_reset_token VARCHAR(64) NULL,
      password_reset_expires DATETIME NULL,
      is_verified TINYINT(1) NOT NULL DEFAULT 0,
>>>>>>> backend/main
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

<<<<<<< HEAD
  await ensureColumn("last_active", "last_active TIMESTAMP NULL");
  await ensureColumn("otp_code", "otp_code VARCHAR(10) NULL");
  await ensureColumn("otp_expires", "otp_expires TIMESTAMP NULL");
=======
  await ensureColumn("otp_code", "otp_code VARCHAR(10) NULL");
  await ensureColumn("otp_expires", "otp_expires DATETIME NULL");
>>>>>>> backend/main
  await ensureColumn(
    "password_reset_token",
    "password_reset_token VARCHAR(64) NULL",
  );
  await ensureColumn(
    "password_reset_expires",
<<<<<<< HEAD
    "password_reset_expires TIMESTAMP NULL",
  );
  await ensureColumn(
    "is_verified",
    "is_verified SMALLINT NOT NULL DEFAULT 0",
=======
    "password_reset_expires DATETIME NULL",
  );
  await ensureColumn(
    "is_verified",
    "is_verified TINYINT(1) NOT NULL DEFAULT 0",
>>>>>>> backend/main
  );
  await ensureColumn("display_name", "display_name VARCHAR(255) NULL");
  await ensureColumn("gender", "gender VARCHAR(50) NULL");
  await ensureColumn("profile_image", "profile_image VARCHAR(500) NULL");
  await ensureColumn("year_level", "year_level VARCHAR(50) NULL");
  await ensureColumn("section_name", "section_name VARCHAR(20) NULL");
  await ensureColumn(
    "onboarding_completed",
<<<<<<< HEAD
    "onboarding_completed SMALLINT NOT NULL DEFAULT 0",
=======
    "onboarding_completed TINYINT(1) NOT NULL DEFAULT 0",
>>>>>>> backend/main
  );
  await ensureColumn("verification_id", "verification_id VARCHAR(100) NULL");
  await ensureColumn("student_id", "student_id VARCHAR(100) NULL");
  await ensureColumn("professor_id", "professor_id VARCHAR(100) NULL");
  await ensureColumn(
    "professor_faculty_id",
    "professor_faculty_id VARCHAR(100) NULL",
  );
  await ensureColumn(
    "professor_department",
    "professor_department VARCHAR(255) NULL",
  );
  await ensureColumn(
    "professor_position",
    "professor_position VARCHAR(255) NULL",
  );
  await ensureColumn(
    "professor_specialization",
    "professor_specialization VARCHAR(255) NULL",
  );
  await ensureColumn(
    "professor_employment_proof",
    "professor_employment_proof TEXT NULL",
  );
  await ensureColumn(
    "verification_status",
    "verification_status VARCHAR(50) NOT NULL DEFAULT 'pending'",
  );
  await ensureColumn(
    "is_archived",
<<<<<<< HEAD
    "is_archived SMALLINT NOT NULL DEFAULT 0",
  );
  await ensureColumn("archived_at", "archived_at TIMESTAMP NULL");
  await ensureColumn(
    "must_change_password",
    "must_change_password SMALLINT NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    "is_temporary",
    "is_temporary SMALLINT NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    "temporary_expires_at",
    "temporary_expires_at TIMESTAMP NULL",
=======
    "is_archived TINYINT(1) NOT NULL DEFAULT 0",
  );
  await ensureColumn("archived_at", "archived_at DATETIME NULL");
  await ensureColumn(
    "must_change_password",
    "must_change_password TINYINT(1) NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    "is_temporary",
    "is_temporary TINYINT(1) NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    "temporary_expires_at",
    "temporary_expires_at DATETIME NULL",
>>>>>>> backend/main
  );

  await ensureSuperAdminUser();

  await initCourseTables();
  await initQuizModeTables();
  await initMonitoringTables();
<<<<<<< HEAD
  const { initMainQuizTables } = await import("./services/quizzes/mainQuizService.js");
=======
  const { initMainQuizTables } = await import("./services/mainQuizService.js");
>>>>>>> backend/main
  await initMainQuizTables();
  await initNotificationTables();

  return db;
}
