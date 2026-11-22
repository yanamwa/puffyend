# PuffyBrain academic AI workflows

The backend and frontend implementations are on local branches named `feature/academic-ai-workflows`. The backend started at `d0831d5`. The frontend started at `e8f4510`. Its feature branch also contains a separate local professor analytics commit, `819e529`. The academic UI change is `ea09688`. To promote just this work, cherry-pick each repository’s academic feature commit onto its own current staging base.

## Changes and reasons

| Workflow | Limitation in the previous implementation | Behavior in this change |
| --- | --- | --- |
| Syllabus upload | The coverage parser returned mainly module titles and page numbers. The catalog job could generate teaching content from the syllabus, and the upload had no durable record of verified reference fields. | The existing CvSU header and identity checks precede extraction. Positioned PDF text identifies ordered coverage and associated objectives. The provider extracts source fields and drafts clearly labeled module summaries. Server checks and an independent review preserve exact labels, references, URLs and N/A. An explicit module description from the syllabus is stored separately from the generated summary. New versions retain verified context for the organizer. |
| Organize Learning Module | The numeric lesson identifier could not distinguish two UUID-based modules in one course. Regenerating from saved sources could replace draft edits. | The queue combines selected new and saved instructional files for one course and module. It uses the course’s pinned syllabus version for expected topics and the instructional files for page evidence. The professor sees verified passages, consulted filenames, syllabus-listed references and uncovered topics. Reviewed pages and outline checkpoints survive eligible job retries. The normal course builder adds pages to an unpublished draft and preserves edited text and quizzes. The legacy editor retains its explicit replacement confirmation. |
| Main Quiz | Raw source files could reintroduce material a professor had removed from a saved lesson. Generation could discard accepted questions. A single historical module index could misidentify Practice evidence after modules were reordered. | The generator uses the selected module’s saved lesson text and the professor’s TOS. It reconciles graded Practice answers with the student, course and stable module ID when available. Repeated mistakes may focus a question within its assignment. Empty or unusable Practice history permits a baseline. A server validator and a separate AI review must both pass before a question enters a student quiz. Only rejected or missing slots are redrafted. Results still use the existing assessment record and professor report. |

The three workflows share structured request transport, deadline tracking, provider error categories and bounded repair. They have separate prompts and validation. Syllabus citations are copied from the PDF. Lesson and quiz quotation text is copied by the server from the selected evidence. The Practice generator, its configured provider order, its queue, and the grading schema retain their existing implementation. The shared retrieval adapter can now read documents indexed by the organizer with OpenAI and handle mixed embedding models.

## Configuration and deadlines

| Backend variable | Default | Applies to |
| --- | --- | --- |
| `SYLLABUS_AI_PRIMARY` | `openai` | Syllabus extraction and review, 110 seconds for the AI workflow |
| `ORGANIZE_MODULE_AI_PRIMARY` | `openai` | Instructional document indexing, organization and review, 480 seconds per worker run |
| `MAIN_QUIZ_AI_PRIMARY` | `openai` | Main Quiz generation and review, 180 seconds plus 4 seconds per requested question. A 20-question quiz has 260 seconds. |

Set any one selector to `gemini` to reverse that workflow’s provider order. Both `OPENAI_API_KEY` and `GEMINI_API_KEY` enable full fallback. Existing `OPENAI_MODEL` and `GEMINI_MODEL` overrides are shared with existing callers. This change adds only example configuration to version control. Operational logs record provider, phase duration, approved and rejected counts, rejection categories, remaining time and the stop reason.

## PostgreSQL and API compatibility

| Addition | Purpose |
| --- | --- |
| `syllabus_uploads.extraction_json JSONB` | Caches the server-verified extraction across the upload, review and save requests. |
| `syllabus_versions.academic_context JSONB` | Preserves reference provenance and course outcomes on the exact uploaded version. Module topics, sources and summaries use the existing coverage JSON. |
| `lesson_source_documents.module_key VARCHAR(100)` | Associates newly uploaded files with course-builder IDs as well as numeric lesson IDs. |
| `lesson_sources_module_key (course_id, module_key)` | Supports module-scoped source lookups. |

The additive migration has been exercised twice on the same embedded PostgreSQL database. Existing versions and student submissions need no rewrites. Older source files qualify for a module through their numeric lesson ID or unambiguous saved-page citations. An old file with ambiguous ownership is omitted from a module’s eligible list. A professor can upload that file for the intended module.

URLs and existing success response fields are retained. The organizer accepts optional `client_module_key` and `saved_document_ids`. The saved-source listing accepts `module_key`. Draft results carry per-page evidence and `source_coverage`. Main Quiz configuration accepts optional `tos_slots`. Existing clients that omit TOS rows use the existing allocation path. The default passing grade remains 70%, which requires 14 correct answers on a 20-question Main Quiz.

## Verification

Tests used fake provider responses, real PDF/PPT/PPTX/TXT/DOCX fixtures and disposable PGlite databases. The PostgreSQL test exercised job submission, source indexing, worker execution, student start/resume, schedule checks, single submission and reading the professor’s report.

| Command | Result |
| --- | --- |
| Backend `npm test` before changes | 176 of 181 passed. Two catalog worker fixtures expected MySQL advisory locks, two professor tutorial tests failed, and the Main Quiz topic fallback test failed. |
| Backend `npm test` after changes | 193 of 195 passed. The two remaining failures are the same professor tutorial tests. |
| Backend `npm run test:academic` | 14 of 14 passed. This includes rejected reference repair, mixed new and saved instructional sources, seven accepted pages plus one repair, 18 accepted Main Quiz questions plus two Gemini repairs, answer privacy, and isolation from another module with the same historical index. |
| Backend Practice subset, command below | 96 of 96 passed, including the six-mode PostgreSQL test. |
| Frontend `npm test` | Before changes, 107 of 113 passed. After changes, 110 of 116 passed. The same six failures remain in catalog button colors, professor catalog selection, three lesson pagination cases and the Main Quiz report print fixture. |
| Frontend `node --test tests/lessons/academicDrafts.test.js` | 3 of 3 passed. |
| Frontend production build with Vite | Passed. Vite reported its large-chunk warning. |
| Changed-file checks | Node syntax checks passed for 24 backend and 7 frontend JavaScript files. Vite compiled the JSX. Both repository diffs passed the Git whitespace check. |
| Backend `npm run test:integration` | 2 of 7 passed. Five legacy test files import the unavailable `mysql2` dependency. |
| Additional PostgreSQL, security and startup command below | 15 of 29 passed. HTTP cases encountered the environment’s localhost connection denial. Startup scenarios also exposed missing-URL or certificate configuration errors. These checks require a rerun in staging. |

Run these commands in the respective repository with a dedicated local test database configuration. The backend test process requires `NODE_ENV=test`, a test-only `JWT_SECRET`, and a PostgreSQL-format `DATABASE_URL`. The verification run used `postgresql://test:test@127.0.0.254:5432/puffybrain_test?sslmode=disable`; the new database tests inject PGlite.

```sh
# Backend
npm test
npm run test:academic
node --test tests/quizzes/practiceQuiz.test.js tests/quizzes/practiceProviders.test.js tests/quizzes/practicePreparation.test.js tests/quizzes/practiceAnalysis.test.js tests/quizzes/modulePractice.test.js tests/quizzes/modulePracticePostgres.test.js
node --test tests/postgresCompatibility.test.js tests/postgresMigration.test.js tests/quizzes/modulePracticePostgres.test.js tests/security.test.js tests/startup.test.js
npm run test:integration

# Frontend
npm test
node --test tests/lessons/academicDrafts.test.js
npm run build
```

## Staging and VPS rollout

1. Record the current deployed frontend and backend SHAs, local VPS commits and working-tree status in each repository. Retain the current frontend build, backend release and a verified PostgreSQL backup. Preserve the VPS copies of its environment and service configuration.
2. Transfer the two feature commits through your normal reviewed Git workflow. Create the staging checkout from the **actual deployed tip** of each repository. Cherry-pick only its academic commit. The frontend feature branch also holds the separate analytics change described above. Review and resolve any conflicts with local VPS changes before promotion.

```sh
# In each repository, after the feature commit has been published to its remote
git status --short --branch
git rev-parse HEAD
git fetch origin feature/academic-ai-workflows
# Set ACADEMIC_COMMIT to the reviewed commit ID for this repository.
git show --stat --oneline "${ACADEMIC_COMMIT:?Supply the reviewed academic commit ID}"
staging_checkout="$(git rev-parse --show-toplevel)-academic-staging"
git worktree add -b staging/academic-ai "$staging_checkout" HEAD
git -C "$staging_checkout" cherry-pick "$ACADEMIC_COMMIT"
```

3. Install the locked dependencies in each staging checkout with `npm ci`. Provide staging-only provider credentials and a disposable or sanitized PostgreSQL 18 database. For a new staging database, initialize it with the existing `npm run migrate` command. For an existing installation with the current base schema, the feature-only migration below applies the four additions. Run the command from the backend checkout after verifying the database name and schema. The transaction rolls back if a statement fails.

```sh
node --input-type=module <<'NODE'
import { db } from "./src/db.js";
import { migrateAcademicWorkflows } from "./src/migrations/academicWorkflows.js";
const connection = await db.getConnection();
try {
  await connection.beginTransaction();
  await connection.query("SET LOCAL lock_timeout = '5s'");
  await migrateAcademicWorkflows(connection);
  await connection.commit();
} catch (error) {
  await connection.rollback();
  throw error;
} finally {
  connection.release();
  await db.end();
}
NODE
```

4. In staging, repeat the tests and build. Use a representative selectable-text CvSU syllabus with a bibliography. Organize a new handout with a saved source, check one deliberately uncovered topic, edit the draft and publish it explicitly. Use two test students, one with graded Practice and one without. Verify their TOS, the schedule, one submission, and the resulting professor report. Exercise each provider order with staging credentials. Confirm that the reverse proxy and client allow sufficient time for the synchronous syllabus and Main Quiz requests. A maximum-size Main Quiz has a 580-second AI budget.
5. After staging acceptance and production authorization, schedule the schema change and application releases together. Apply the feature-only migration against the verified production target, deploy the tested backend and matched frontend, and use the existing service-management procedure. Check health, one approved test course and the phase-duration logs.
6. For a provider-order rollback, reverse only the affected selector and reload configuration through the usual release procedure. For a code rollback, redeploy the recorded frontend and backend releases. The nullable additions can stay in place, preserving academic records created after the rollout.

The PDF extractor depends on selectable text and recognizable table headings. Scanned PDFs require a text layer. Existing syllabus versions retain their historical context until a new version is explicitly uploaded. Provider quality, costs, quota and latency under real campus traffic still need staging measurement. No paid provider request, production migration, production restart or external push was performed for this implementation.

## Exact files in the academic change

### Backend

```text
.env.example
package.json
src/controllers/lessonController.js
src/migrations/academicWorkflows.js
src/migrations/applicationMigration.js
src/routes/catalogRoutes.js
src/services/catalog/catalogLessonGeneration.js
src/services/catalog/syllabusContext.js
src/services/catalog/syllabusExtraction.js
src/services/quizzes/mainQuizAdaptive.js
src/services/quizzes/mainQuizGeneration.js
src/services/quizzes/mainQuizService.js
src/services/rag/academicEvidence.js
src/services/rag/academicWorkflow.js
src/services/rag/embeddingService.js
src/services/rag/groundingService.js
src/services/rag/lessonJobService.js
src/services/rag/lessonModuleScope.js
src/services/rag/lessonRagService.js
src/services/rag/openaiJson.js
src/services/rag/outlineService.js
src/services/rag/retrievalService.js
src/services/rag/vectorRepository.js
tests/academic/workflows.test.js
tests/catalog/catalogLessonGeneration.test.js
tests/quizzes/mainQuizShuffle.test.js
ACADEMIC_AI_ROLLOUT.md
```

### Frontend

```text
src/components/catalog/CoverageModules.jsx
src/components/catalog/SyllabusWizard.jsx
src/components/lesson/LessonSourceEvidence.jsx
src/components/lesson/LessonSourceManager.jsx
src/components/lesson/ModuleSourceCoverage.jsx
src/pages/professor/coursemanagement/AddModule.jsx
src/pages/professor/coursemanagement/CourseModuleEditor.jsx
src/pages/professor/coursemanagement/EditModule.jsx
src/services/catalogCourseDraft.js
src/services/lessonNotifications.js
src/services/lessonRagApi.js
src/services/mainQuizTosEditor.js
src/services/organizedLessonDraft.js
src/services/quizGenerationUi.js
tests/lessons/academicDrafts.test.js
```
