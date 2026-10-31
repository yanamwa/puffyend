export async function migrateAcademicCalendar(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS academic_calendars (
    calendar_id SERIAL PRIMARY KEY,
    title VARCHAR(200) NOT NULL,
    academic_year VARCHAR(9) NOT NULL UNIQUE,
    events JSONB NOT NULL,
    published SMALLINT NOT NULL DEFAULT 0,
    filename VARCHAR(255) NOT NULL,
    mime_type VARCHAR(50) NOT NULL,
    document BYTEA NOT NULL,
    updated_by INT NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS academic_calendar_files (
    calendar_id INT  NOT NULL,
    file_index INT  NOT NULL,
    filename VARCHAR(255) NOT NULL,
    mime_type VARCHAR(50) NOT NULL,
    document BYTEA NOT NULL,
    PRIMARY KEY (calendar_id,file_index),
    FOREIGN KEY (calendar_id) REFERENCES academic_calendars(calendar_id) ON DELETE CASCADE
  )`);
}
