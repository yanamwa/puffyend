import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config();

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
});

export const db = pool;

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

export async function initDb() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      userId INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      role VARCHAR(50) NOT NULL DEFAULT 'student',
      display_name VARCHAR(255) NULL,
      year_level VARCHAR(50) NULL,
      section_name VARCHAR(20) NULL,
      onboarding_completed TINYINT(1) NOT NULL DEFAULT 0,
      verification_id VARCHAR(100) NULL,
      student_id VARCHAR(100) NULL,
      professor_id VARCHAR(100) NULL,
      verification_status VARCHAR(50) NOT NULL DEFAULT 'pending',
      otp_code VARCHAR(10) NULL,
      otp_expires DATETIME NULL,
      is_verified TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await ensureColumn("otp_code", "otp_code VARCHAR(10) NULL");
  await ensureColumn("otp_expires", "otp_expires DATETIME NULL");
  await ensureColumn(
    "is_verified",
    "is_verified TINYINT(1) NOT NULL DEFAULT 0"
  );
  await ensureColumn("display_name", "display_name VARCHAR(255) NULL");
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
    "verification_status",
    "verification_status VARCHAR(50) NOT NULL DEFAULT 'pending'"
  );

  await initCourseTables();

  return db;
}
