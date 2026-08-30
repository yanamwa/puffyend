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
       COLLATE utf8mb4_general_ci`
    );
  } finally {
    await bootstrapPool.end();
  }
}

async function ensureColumn(columnName, columnDefinition) {
  const [columns] = await db.execute(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'users'
       AND COLUMN_NAME = ?`,
    [columnName]
  );

  if (columns.length === 0) {
    await db.execute(`ALTER TABLE users ADD COLUMN ${columnDefinition}`);
  }
}

async function ensureTableColumn(tableName, columnName, columnDefinition) {
  const [columns] = await db.execute(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?`,
    [tableName, columnName]
  );

  if (columns.length === 0) {
    await db.execute(`ALTER TABLE ${tableName} ADD COLUMN ${columnDefinition}`);
  }
}

async function initCourseTables() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS courses (
      course_id INT AUTO_INCREMENT PRIMARY KEY,
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
      lesson_pages LONGTEXT NULL,
      quiz_items LONGTEXT NULL,
      students INT NOT NULL DEFAULT 0,
      modules INT NOT NULL DEFAULT 0,
      quizzes INT NOT NULL DEFAULT 0,
      join_link VARCHAR(500) NULL,
      archived TINYINT(1) NOT NULL DEFAULT 0,
      professor_name VARCHAR(255) NULL,
      professor_email VARCHAR(255) NULL,
      professor_department VARCHAR(255) NULL,
      professor_profile_image VARCHAR(500) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY courses_code_unique (code)
    )
  `);

  await ensureTableColumn("courses", "title", "title VARCHAR(255) NOT NULL");
  await ensureTableColumn("courses", "code", "code VARCHAR(50) NOT NULL");
  await ensureTableColumn("courses", "summary", "summary TEXT NOT NULL");
  await ensureTableColumn("courses", "subject", "subject VARCHAR(255) NOT NULL");
  await ensureTableColumn("courses", "professor_id", "professor_id INT NULL");
  await ensureTableColumn("courses", "course_name", "course_name VARCHAR(255) NULL");
  await ensureTableColumn("courses", "description", "description TEXT NULL");
  await ensureTableColumn("courses", "course_code", "course_code VARCHAR(50) NULL");
  await ensureTableColumn(
    "courses",
    "learning_objectives",
    "learning_objectives TEXT NULL"
  );
  await ensureTableColumn(
    "courses",
    "status",
    "status VARCHAR(50) NOT NULL DEFAULT 'draft'"
  );
  await ensureTableColumn(
    "courses",
    "visibility",
    "visibility VARCHAR(50) NOT NULL DEFAULT 'private'"
  );
  await ensureTableColumn("courses", "lesson_pages", "lesson_pages LONGTEXT NULL");
  await ensureTableColumn("courses", "quiz_items", "quiz_items LONGTEXT NULL");
  await ensureTableColumn("courses", "students", "students INT NOT NULL DEFAULT 0");
  await ensureTableColumn("courses", "modules", "modules INT NOT NULL DEFAULT 0");
  await ensureTableColumn("courses", "quizzes", "quizzes INT NOT NULL DEFAULT 0");
  await ensureTableColumn("courses", "join_link", "join_link VARCHAR(500) NULL");
  await ensureTableColumn(
    "courses",
    "archived",
    "archived TINYINT(1) NOT NULL DEFAULT 0"
  );
  await ensureTableColumn(
    "courses",
    "professor_name",
    "professor_name VARCHAR(255) NULL"
  );
  await ensureTableColumn(
    "courses",
    "professor_email",
    "professor_email VARCHAR(255) NULL"
  );
  await ensureTableColumn(
    "courses",
    "professor_department",
    "professor_department VARCHAR(255) NULL"
  );
  await ensureTableColumn(
    "courses",
    "professor_profile_image",
    "professor_profile_image VARCHAR(500) NULL"
  );

  const [courseIdColumns] = await db.execute(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'courses'
       AND COLUMN_NAME IN ('course_id', 'id')`
  );
  const courseIdColumnNames = new Set(
    courseIdColumns.map((column) => column.COLUMN_NAME)
  );
  const courseIdColumn = courseIdColumnNames.has("course_id") ? "course_id" : "id";

  await db.execute(`
    CREATE TABLE IF NOT EXISTS learning_modules (
      lesson_id INT AUTO_INCREMENT PRIMARY KEY,
      course_id INT NOT NULL,
      title VARCHAR(255) NOT NULL,
      description TEXT NULL,
      subject VARCHAR(255) NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'draft',
      quiz_contents LONGTEXT NULL,
      learning_objectives TEXT NULL,
      lesson_contents LONGTEXT NULL,
      has_quiz TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX learning_modules_course_id_idx (course_id),
      CONSTRAINT learning_modules_course_fk
        FOREIGN KEY (course_id) REFERENCES courses(${courseIdColumn})
        ON DELETE CASCADE
    )
  `);

  await ensureTableColumn(
    "learning_modules",
    "course_id",
    "course_id INT NOT NULL"
  );
  await ensureTableColumn(
    "learning_modules",
    "title",
    "title VARCHAR(255) NOT NULL"
  );
  await ensureTableColumn(
    "learning_modules",
    "description",
    "description TEXT NULL"
  );
  await ensureTableColumn(
    "learning_modules",
    "subject",
    "subject VARCHAR(255) NULL"
  );
  await ensureTableColumn(
    "learning_modules",
    "status",
    "status VARCHAR(50) NOT NULL DEFAULT 'draft'"
  );
  await ensureTableColumn(
    "learning_modules",
    "quiz_contents",
    "quiz_contents LONGTEXT NULL"
  );
  await ensureTableColumn(
    "learning_modules",
    "learning_objectives",
    "learning_objectives TEXT NULL"
  );
  await ensureTableColumn(
    "learning_modules",
    "lesson_contents",
    "lesson_contents LONGTEXT NULL"
  );
  await ensureTableColumn(
    "learning_modules",
    "has_quiz",
    "has_quiz TINYINT(1) NOT NULL DEFAULT 0"
  );
}

async function initQuizModeTables() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS quiz_modes (
      quiz_id INT AUTO_INCREMENT PRIMARY KEY,
      created_by INT NULL,
      mode_name VARCHAR(255) NOT NULL,
      title VARCHAR(255) NULL,
      description TEXT NULL,
      image VARCHAR(500) NULL,
      route VARCHAR(500) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  await ensureTableColumn("quiz_modes", "created_by", "created_by INT NULL");
  await ensureTableColumn(
    "quiz_modes",
    "mode_name",
    "mode_name VARCHAR(255) NOT NULL"
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
    "SELECT mode_name, title, route FROM quiz_modes"
  );
  const existingKeys = new Set(
    existingModes.flatMap((mode) => [
      String(mode.mode_name || "").toLowerCase(),
      String(mode.title || "").toLowerCase(),
      String(mode.route || "").toLowerCase(),
    ])
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
      [modeName, title, description, image, route]
    );
  }
}

async function initMonitoringTables() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS course_enrollments (
      enrollment_id INT AUTO_INCREMENT PRIMARY KEY,
      course_id INT NOT NULL,
      user_id INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY course_enrollments_unique (course_id, user_id),
      INDEX course_enrollments_course_idx (course_id),
      INDEX course_enrollments_user_idx (user_id)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS saved_courses (
      saved_id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      course_id INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY saved_courses_unique (user_id, course_id),
      INDEX saved_courses_course_idx (course_id),
      INDEX saved_courses_user_idx (user_id)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS lesson_progress (
      progress_id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      lesson_id INT NOT NULL,
      course_id INT NULL,
      total_cards INT NOT NULL DEFAULT 0,
      studied_cards INT NOT NULL DEFAULT 0,
      progress_percent DECIMAL(5,2) NOT NULL DEFAULT 0,
      last_viewed_card INT NOT NULL DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY lesson_progress_unique (user_id, lesson_id),
      INDEX lesson_progress_course_idx (course_id),
      INDEX lesson_progress_user_idx (user_id)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS quiz_attempts (
      attempts_id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      lesson_id INT NULL,
      course_id INT NULL,
      score INT NOT NULL DEFAULT 0,
      total INT NOT NULL DEFAULT 0,
      source VARCHAR(50) NOT NULL DEFAULT 'lesson',
      quiz_mode VARCHAR(50) NULL,
      time_spent INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX quiz_attempts_course_idx (course_id),
      INDEX quiz_attempts_user_idx (user_id),
      INDEX quiz_attempts_lesson_idx (lesson_id)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS performance_analytics (
      analytics_id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      lesson_id INT NULL,
      course_id INT NOT NULL,
      average_score DECIMAL(5,2) NOT NULL DEFAULT 0,
      weakest_topic VARCHAR(255) NULL,
      strongest_topic VARCHAR(255) NULL,
      total_attempts INT NOT NULL DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY performance_analytics_unique (user_id, course_id),
      INDEX performance_analytics_course_idx (course_id),
      INDEX performance_analytics_user_idx (user_id)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS adaptive_feedback (
      feedback_id INT AUTO_INCREMENT PRIMARY KEY,
      attempts_id INT NULL,
      user_id INT NOT NULL,
      strengths TEXT NULL,
      weaknesses TEXT NULL,
      recommendations TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX adaptive_feedback_attempt_idx (attempts_id),
      INDEX adaptive_feedback_user_idx (user_id)
    )
  `);
}

async function ensureSuperAdminUser() {
  const superAdminEmail = (
    process.env.SUPER_ADMIN_EMAIL || "superadmin@puffybrain.local"
  )
    .trim()
    .toLowerCase();
  const configuredSuperAdminPassword = process.env.SUPER_ADMIN_PASSWORD;
  const superAdminPassword =
    configuredSuperAdminPassword || "SuperAdmin#2026!";
  const superAdminName = process.env.SUPER_ADMIN_NAME || "Super Admin";

  if (!superAdminEmail || !superAdminPassword) return;

  const [rows] = await db.execute(
    "SELECT userId FROM users WHERE email = ? LIMIT 1",
    [superAdminEmail]
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
        [hashedPassword, superAdminName, superAdminName, superAdminEmail]
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
      [superAdminName, superAdminName, superAdminEmail]
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
    [superAdminEmail, hashedPassword, superAdminName, superAdminName]
  );
}

export async function initDb() {
  await ensureDatabaseExists();

  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      userId INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      role VARCHAR(50) NOT NULL DEFAULT 'student',
      display_name VARCHAR(255) NULL,
      profile_image VARCHAR(500) NULL,
      year_level VARCHAR(50) NULL,
      section_name VARCHAR(20) NULL,
      onboarding_completed TINYINT(1) NOT NULL DEFAULT 0,
      verification_id VARCHAR(100) NULL,
      student_id VARCHAR(100) NULL,
      professor_id VARCHAR(100) NULL,
      professor_faculty_id VARCHAR(100) NULL,
      professor_department VARCHAR(255) NULL,
      professor_employment_proof TEXT NULL,
      verification_status VARCHAR(50) NOT NULL DEFAULT 'pending',
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
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await ensureColumn("otp_code", "otp_code VARCHAR(10) NULL");
  await ensureColumn("otp_expires", "otp_expires DATETIME NULL");
  await ensureColumn(
    "password_reset_token",
    "password_reset_token VARCHAR(64) NULL"
  );
  await ensureColumn(
    "password_reset_expires",
    "password_reset_expires DATETIME NULL"
  );
  await ensureColumn(
    "is_verified",
    "is_verified TINYINT(1) NOT NULL DEFAULT 0"
  );
  await ensureColumn("display_name", "display_name VARCHAR(255) NULL");
  await ensureColumn("profile_image", "profile_image VARCHAR(500) NULL");
  await ensureColumn("year_level", "year_level VARCHAR(50) NULL");
  await ensureColumn("section_name", "section_name VARCHAR(20) NULL");
  await ensureColumn(
    "onboarding_completed",
    "onboarding_completed TINYINT(1) NOT NULL DEFAULT 0"
  );
  await ensureColumn("verification_id", "verification_id VARCHAR(100) NULL");
  await ensureColumn("student_id", "student_id VARCHAR(100) NULL");
  await ensureColumn("professor_id", "professor_id VARCHAR(100) NULL");
  await ensureColumn(
    "professor_faculty_id",
    "professor_faculty_id VARCHAR(100) NULL"
  );
  await ensureColumn(
    "professor_department",
    "professor_department VARCHAR(255) NULL"
  );
  await ensureColumn(
    "professor_employment_proof",
    "professor_employment_proof TEXT NULL"
  );
  await ensureColumn(
    "verification_status",
    "verification_status VARCHAR(50) NOT NULL DEFAULT 'pending'"
  );
  await ensureColumn(
    "is_archived",
    "is_archived TINYINT(1) NOT NULL DEFAULT 0"
  );
  await ensureColumn("archived_at", "archived_at DATETIME NULL");
  await ensureColumn(
    "must_change_password",
    "must_change_password TINYINT(1) NOT NULL DEFAULT 0"
  );
  await ensureColumn(
    "is_temporary",
    "is_temporary TINYINT(1) NOT NULL DEFAULT 0"
  );
  await ensureColumn(
    "temporary_expires_at",
    "temporary_expires_at DATETIME NULL"
  );

  await ensureSuperAdminUser();

  await initCourseTables();
  await initQuizModeTables();
  await initMonitoringTables();

  return db;
}
