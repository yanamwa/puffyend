CREATE TABLE IF NOT EXISTS "lesson_rag_jobs" (
  "job_id" CHAR(36) NOT NULL,
  "course_id" INT NOT NULL,
  "lesson_id" INT DEFAULT NULL,
  "requester_id" INT DEFAULT NULL,
  "document_id" BIGINT  DEFAULT NULL,
  "job_type" VARCHAR(50) NOT NULL,
  "status" VARCHAR(50) NOT NULL DEFAULT 'queued',
  "phase" VARCHAR(50) NOT NULL DEFAULT 'queued',
  "progress" INT  NOT NULL DEFAULT 0,
  "attempts" INT  NOT NULL DEFAULT 0,
  "input_path" VARCHAR(1024) DEFAULT NULL,
  "payload" JSONB NOT NULL,
  "result" JSONB DEFAULT NULL,
  "error_message" TEXT DEFAULT NULL,
  "worker_token" CHAR(36) DEFAULT NULL,
  "lease_expires_at" TIMESTAMP DEFAULT NULL,
  "next_run_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("job_id"),
  CONSTRAINT "lesson_rag_jobs_course_fk" FOREIGN KEY ("course_id") REFERENCES "courses" ("course_id") ON DELETE CASCADE,
  CONSTRAINT "lesson_rag_jobs_lesson_fk" FOREIGN KEY ("lesson_id") REFERENCES "learning_modules" ("lesson_id") ON DELETE CASCADE,
  CONSTRAINT "lesson_rag_jobs_user_fk" FOREIGN KEY ("requester_id") REFERENCES "users" (userid) ON DELETE SET NULL,
  CONSTRAINT "lesson_rag_jobs_document_fk" FOREIGN KEY ("document_id") REFERENCES "lesson_source_documents" ("document_id") ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS "lesson_rag_file_deletions" (
  "deletion_id" BIGSERIAL PRIMARY KEY,
  "storage_path" VARCHAR(1024) NOT NULL,
  "attempts" INT  NOT NULL DEFAULT 0,
  "last_error" TEXT DEFAULT NULL,
  "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
