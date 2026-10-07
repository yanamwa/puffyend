USE `puffybrain`;
CREATE TABLE IF NOT EXISTS lesson_rag_job_inputs (
  job_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  file_order INT UNSIGNED NOT NULL,
  storage_path VARCHAR(1024) NOT NULL,
  PRIMARY KEY (job_id, file_order),
  CONSTRAINT lesson_rag_job_inputs_job_fk FOREIGN KEY (job_id) REFERENCES lesson_rag_jobs(job_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS lesson_rag_job_documents (
  job_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  document_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (job_id, document_id),
  KEY lesson_rag_job_documents_source_idx (document_id),
  CONSTRAINT lesson_rag_job_documents_job_fk FOREIGN KEY (job_id) REFERENCES lesson_rag_jobs(job_id) ON DELETE CASCADE,
  CONSTRAINT lesson_rag_job_documents_source_fk FOREIGN KEY (document_id) REFERENCES lesson_source_documents(document_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
