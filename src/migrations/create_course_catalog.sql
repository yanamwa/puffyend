CREATE TABLE IF NOT EXISTS course_catalog (
  catalog_id SERIAL PRIMARY KEY,
  code VARCHAR(50) NOT NULL,
  normalized_code VARCHAR(50) NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT NULL,
  units DECIMAL(5,2) NULL,
  programs JSONB NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'draft',
  reviewed_by INT NULL,
  reviewed_at TIMESTAMP NULL,
  archived_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  available_normalized_code VARCHAR(50) GENERATED ALWAYS AS (CASE WHEN archived_at IS NULL THEN normalized_code ELSE NULL END) STORED,
  CONSTRAINT catalog_available_code UNIQUE (available_normalized_code),
  CONSTRAINT catalog_reviewer_fk FOREIGN KEY (reviewed_by) REFERENCES users(userId) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS syllabus_uploads (
  upload_id CHAR(36) NOT NULL PRIMARY KEY,
  uploader_id INT NOT NULL,
  filename VARCHAR(255) NOT NULL,
  storage_name CHAR(40) NOT NULL,
  file_size INT  NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,
  CONSTRAINT uploads_actor_fk FOREIGN KEY (uploader_id) REFERENCES users(userId)
);

CREATE TABLE IF NOT EXISTS syllabus_versions (
  version_id SERIAL PRIMARY KEY,
  catalog_id INT NOT NULL,
  academic_year VARCHAR(30) NULL,
  semester VARCHAR(30) NULL,
  filename VARCHAR(255) NOT NULL,
  storage_name CHAR(40) NOT NULL,
  file_size INT  NOT NULL,
  uploaded_by INT NULL,
  uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT version_catalog_pair UNIQUE (version_id, catalog_id),
  CONSTRAINT versions_catalog_fk FOREIGN KEY (catalog_id) REFERENCES course_catalog(catalog_id),
  CONSTRAINT versions_actor_fk FOREIGN KEY (uploaded_by) REFERENCES users(userId) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS catalog_lesson_jobs (
  version_id INT NOT NULL PRIMARY KEY,
  status VARCHAR(50) NOT NULL DEFAULT 'queued',
  completed_modules INT NOT NULL DEFAULT 0,
  error_message VARCHAR(500) NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (version_id) REFERENCES syllabus_versions(version_id)
);
