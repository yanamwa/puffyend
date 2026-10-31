CREATE TABLE IF NOT EXISTS system_settings (
  setting_id SERIAL PRIMARY KEY,
  system_name VARCHAR(255) NOT NULL DEFAULT 'PuffyBrain',
  academic_year VARCHAR(30) NOT NULL DEFAULT '', semester VARCHAR(30) NOT NULL DEFAULT '',
  maintenance_mode BOOLEAN NOT NULL DEFAULT FALSE,
  require_password_change BOOLEAN NOT NULL DEFAULT TRUE,
  professor_approval BOOLEAN NOT NULL DEFAULT TRUE,
  practice_quiz_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  main_quiz_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  record_practice_quiz BOOLEAN NOT NULL DEFAULT TRUE,
  record_main_quiz BOOLEAN NOT NULL DEFAULT TRUE,
  adaptive_quiz_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  quiz_analysis_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  enrollment_approval BOOLEAN NOT NULL DEFAULT TRUE,
  enrollment_accepted_email BOOLEAN NOT NULL DEFAULT TRUE,
  enrollment_declined_email BOOLEAN NOT NULL DEFAULT TRUE,
  enrollment_system_notification BOOLEAN NOT NULL DEFAULT TRUE,
  professor_approval_notification BOOLEAN NOT NULL DEFAULT TRUE,
  announcements_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  passing_percentage DECIMAL(5,2), semester_start_date DATE, semester_end_date DATE,
  school_year_start_date DATE, school_year_end_date DATE, updated_by INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO system_settings (system_name) SELECT 'PuffyBrain' WHERE NOT EXISTS (SELECT 1 FROM system_settings);
CREATE TABLE IF NOT EXISTS audit_logs (
  audit_id BIGSERIAL PRIMARY KEY, user_id INT, user_name VARCHAR(255), user_role VARCHAR(50),
  category VARCHAR(100), action VARCHAR(255), target TEXT, ip_address VARCHAR(100),
  status VARCHAR(50), details TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS notifications (
  notification_id SERIAL PRIMARY KEY, recipient_user_id INT, course_id INT, enrollment_id INT,
  title VARCHAR(255) NOT NULL, message TEXT NOT NULL, target VARCHAR(50) DEFAULT 'all',
  type VARCHAR(50) DEFAULT 'announcement', is_read SMALLINT NOT NULL DEFAULT 0, read_at TIMESTAMP,
  created_by_user_id INT, created_by_name VARCHAR(255), created_by_role VARCHAR(50),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS notification_reads (
  notification_id INT NOT NULL REFERENCES notifications(notification_id) ON DELETE CASCADE,
  user_id INT NOT NULL, read_at TIMESTAMP, PRIMARY KEY(notification_id,user_id)
);
