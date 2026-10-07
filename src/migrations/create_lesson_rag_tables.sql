USE `puffybrain`;

CREATE TABLE IF NOT EXISTS `lesson_source_documents` (
  `document_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `course_id` INT NOT NULL,
  `lesson_id` INT DEFAULT NULL,
  `uploader_id` INT DEFAULT NULL,
  `filename` VARCHAR(255) NOT NULL,
  `storage_path` VARCHAR(1024) NOT NULL,
  `mime_type` VARCHAR(127) NOT NULL,
  `file_size_bytes` BIGINT UNSIGNED NOT NULL,
  `content_hash` CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `processing_status` ENUM('pending', 'processing', 'ready', 'failed') NOT NULL DEFAULT 'pending',
  `processing_error` TEXT DEFAULT NULL,
  `chunk_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`document_id`),
  KEY `lesson_source_documents_course_idx` (`course_id`),
  KEY `lesson_source_documents_lesson_idx` (`lesson_id`),
  KEY `lesson_source_documents_uploader_idx` (`uploader_id`),
  KEY `lesson_source_documents_hash_idx` (`course_id`, `content_hash`),
  CONSTRAINT `lesson_source_documents_course_fk` FOREIGN KEY (`course_id`)
    REFERENCES `courses` (`course_id`) ON DELETE CASCADE,
  CONSTRAINT `lesson_source_documents_lesson_fk` FOREIGN KEY (`lesson_id`)
    REFERENCES `learning_modules` (`lesson_id`) ON DELETE CASCADE,
  CONSTRAINT `lesson_source_documents_uploader_fk` FOREIGN KEY (`uploader_id`)
    REFERENCES `users` (`userId`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `lesson_source_chunks` (
  `chunk_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `document_id` BIGINT UNSIGNED NOT NULL,
  `chunk_order` INT UNSIGNED NOT NULL,
  `source_start` INT UNSIGNED NOT NULL,
  `source_end` INT UNSIGNED NOT NULL,
  `source_position` JSON DEFAULT NULL,
  `chunk_text` LONGTEXT NOT NULL,
  `embedding` JSON NOT NULL,
  `embedding_model` VARCHAR(255) NOT NULL,
  `embedding_dimensions` INT UNSIGNED NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`chunk_id`),
  UNIQUE KEY `lesson_source_chunks_document_order_idx` (`document_id`, `chunk_order`),
  CONSTRAINT `lesson_source_chunks_document_fk` FOREIGN KEY (`document_id`)
    REFERENCES `lesson_source_documents` (`document_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
