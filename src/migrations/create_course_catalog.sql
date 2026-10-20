CREATE TABLE IF NOT EXISTS course_catalog (
  catalog_id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(50) NOT NULL,
  normalized_code VARCHAR(50) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT NULL,
  units DECIMAL(5,2) NULL,
  programs JSON NOT NULL,
  status ENUM('draft','active') NOT NULL DEFAULT 'draft',
  reviewed_by INT NULL,
  reviewed_at DATETIME NULL,
  archived_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY catalog_normalized_code (normalized_code),
  KEY catalog_selection (archived_at, status),
  CONSTRAINT catalog_reviewer_fk FOREIGN KEY (reviewed_by) REFERENCES users(userId) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS syllabus_uploads (
  upload_id CHAR(36) NOT NULL PRIMARY KEY,
  uploader_id INT NOT NULL,
  filename VARCHAR(255) NOT NULL,
  storage_name CHAR(40) NOT NULL,
  file_size INT UNSIGNED NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  KEY uploads_expiry (expires_at),
  CONSTRAINT uploads_actor_fk FOREIGN KEY (uploader_id) REFERENCES users(userId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS syllabus_versions (
  version_id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  catalog_id INT NOT NULL,
  academic_year VARCHAR(30) NULL,
  semester VARCHAR(30) NULL,
  filename VARCHAR(255) NOT NULL,
  storage_name CHAR(40) NOT NULL,
  file_size INT UNSIGNED NOT NULL,
  uploaded_by INT NULL,
  uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY version_catalog_pair (version_id, catalog_id),
  KEY versions_catalog_date (catalog_id, uploaded_at),
  CONSTRAINT versions_catalog_fk FOREIGN KEY (catalog_id) REFERENCES course_catalog(catalog_id),
  CONSTRAINT versions_actor_fk FOREIGN KEY (uploaded_by) REFERENCES users(userId) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
