export async function migrateModulePracticeJobs(database) {
  await database.execute(`CREATE TABLE IF NOT EXISTS module_practice_jobs (
    job_id UUID PRIMARY KEY,
    user_id INT NOT NULL,
    course_id INT NOT NULL,
    module_id VARCHAR(100) COLLATE "C" NOT NULL,
    question_format VARCHAR(5) NOT NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'queued'
      CHECK (status IN ('queued', 'running', 'ready', 'failed')),
    payload TEXT NOT NULL,
    result_json TEXT NULL,
    error_json TEXT NULL,
    run_token UUID NULL,
    lease_expires_at TIMESTAMP NULL,
    runs INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await database.execute(`CREATE UNIQUE INDEX IF NOT EXISTS module_practice_active_job
    ON module_practice_jobs (user_id, course_id, module_id, question_format)
    WHERE status IN ('queued', 'running')`);
}
