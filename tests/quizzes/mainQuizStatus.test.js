import assert from "node:assert/strict";
import { db } from "../../src/db.js";
import { mainQuizStatus } from "../../src/services/quizzes/mainQuizService.js";

const originalExecute = db.execute;
let configured = false;
let manualQuestions = [];
let taken = false;
db.execute = async (sql) => {
  if (sql.includes("JOIN main_quiz_results"))
    return [taken ? [{ quiz_id: 1 }] : []];
  if (sql.includes("FROM course_enrollments")) return [[{ user_id: 8 }]];
  if (sql.includes("FROM courses"))
    return [
      [
        {
          lesson_contents: JSON.stringify([
            {
              moduleId: "module-1",
              mainQuizSettings: { enabled: true, manualQuestions },
            },
          ]),
          quiz_contents: "[]",
        },
      ],
    ];
  if (sql.includes("FROM main_quiz_configs"))
    return [configured ? [{ course_id: 1 }] : []];
  throw new Error(`Unexpected query: ${sql}`);
};

try {
  const user = { userId: 8, role: "student" };
  await assert.rejects(mainQuizStatus(user, 1, "module-1"), (error) => {
    assert.equal(error.statusCode, 409);
    assert.match(error.message, /professor has not created/);
    return true;
  });
  configured = true;
  assert.deepEqual(await mainQuizStatus(user, 1, "module-1"), { taken: false });
  configured = false;
  manualQuestions = [{ question: "A professor-authored question" }];
  assert.deepEqual(await mainQuizStatus(user, 1, "module-1"), { taken: false });
  taken = true;
  assert.deepEqual(await mainQuizStatus(user, 1, "module-1"), { taken: true });
} finally {
  db.execute = originalExecute;
  await db.end();
}
