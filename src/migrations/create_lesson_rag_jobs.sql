USE `puffybrain`;
CREATE TABLE IF NOT EXISTS `lesson_rag_jobs` (
  `job_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `course_id` INT NOT NULL,
  `lesson_id` INT DEFAULT NULL,
  `requester_id` INT DEFAULT NULL,
  `document_id` BIGINT UNSIGNED DEFAULT NULL,
  `job_type` ENUM('upload', 'generate', 'reindex') NOT NULL,
  `status` ENUM('queued', 'running', 'completed', 'failed') NOT NULL DEFAULT 'queued',
  `phase` VARCHAR(50) NOT NULL DEFAULT 'queued',
  `progress` INT UNSIGNED NOT NULL DEFAULT 0,
  `attempts` INT UNSIGNED NOT NULL DEFAULT 0,
  `input_path` VARCHAR(1024) DEFAULT NULL,
  `payload` JSON NOT NULL,
  `result` JSON DEFAULT NULL,
  `error_message` TEXT DEFAULT NULL,
  `worker_token` CHAR(36) DEFAULT NULL,
  `lease_expires_at` DATETIME DEFAULT NULL,
  `next_run_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`job_id`),
  KEY `lesson_rag_jobs_queue_idx` (`status`, `next_run_at`),
  KEY `lesson_rag_jobs_course_idx` (`course_id`, `created_at`),
  KEY `lesson_rag_jobs_document_idx` (`document_id`),
  CONSTRAINT `lesson_rag_jobs_course_fk` FOREIGN KEY (`course_id`) REFERENCES `courses` (`course_id`) ON DELETE CASCADE,
  CONSTRAINT `lesson_rag_jobs_lesson_fk` FOREIGN KEY (`lesson_id`) REFERENCES `learning_modules` (`lesson_id`) ON DELETE CASCADE,
  CONSTRAINT `lesson_rag_jobs_user_fk` FOREIGN KEY (`requester_id`) REFERENCES `users` (`userId`) ON DELETE SET NULL,
  CONSTRAINT `lesson_rag_jobs_document_fk` FOREIGN KEY (`document_id`) REFERENCES `lesson_source_documents` (`document_id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `lesson_rag_file_deletions` (
  `deletion_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `storage_path` VARCHAR(1024) NOT NULL,
  `attempts` INT UNSIGNED NOT NULL DEFAULT 0,
  `last_error` TEXT DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
