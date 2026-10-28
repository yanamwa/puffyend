export async function migrateAcademicCalendar(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS academic_calendars (
    calendar_id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(200) NOT NULL,
    academic_year VARCHAR(9) NOT NULL UNIQUE,
    events JSON NOT NULL,
    published TINYINT(1) NOT NULL DEFAULT 0,
    filename VARCHAR(255) NOT NULL,
    mime_type VARCHAR(50) NOT NULL,
    document LONGBLOB NOT NULL,
    updated_by INT NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB`);
  await db.query(`CREATE TABLE IF NOT EXISTS academic_calendar_files (
    calendar_id INT UNSIGNED NOT NULL,
    file_index INT UNSIGNED NOT NULL,
    filename VARCHAR(255) NOT NULL,
    mime_type VARCHAR(50) NOT NULL,
    document LONGBLOB NOT NULL,
    PRIMARY KEY (calendar_id,file_index),
    FOREIGN KEY (calendar_id) REFERENCES academic_calendars(calendar_id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);
}
