import test from "node:test";
import assert from "node:assert/strict";
import mysql from "mysql2/promise";
import { studentMainQuizHistory } from "../src/services/studentQuizHistory.js";
import { db as defaultPool } from "../src/db.js";
test("non-students cannot access student quiz history", async () => {
  await assert.rejects(studentMainQuizHistory({ role: "professor", userId: 1 }), { statusCode: 403 });
});
test("history isolates students, sorts recent results, paginates and omits quiz answers", async () => {
  const schema = "puffy_history_test_" + process.pid;
  const connection = await mysql.createConnection({ host: process.env.DB_HOST || "127.0.0.1", user: process.env.DB_USER || "root", password: process.env.DB_PASSWORD || "" });
  try {
    await connection.query("CREATE DATABASE ??", [schema]);
    await connection.query("USE ??", [schema]);
    await connection.query("CREATE TABLE courses(course_id INT PRIMARY KEY,title VARCHAR(255))");
    await connection.query("CREATE TABLE personalized_main_quizzes(quiz_id INT PRIMARY KEY,course_id INT,user_id INT,config_json LONGTEXT)");
    await connection.query("CREATE TABLE main_quiz_results(result_id INT PRIMARY KEY,quiz_id INT,user_id INT,result_json LONGTEXT,created_at DATETIME)");
    await connection.execute("INSERT INTO courses VALUES(1,'Purposive Communication')");
    for (const id of [1,2,3]) {
      const user = id === 3 ? 2 : 1;
      await connection.execute("INSERT INTO personalized_main_quizzes VALUES(?,1,?,?)", [id, user, JSON.stringify({ moduleIndex: id - 1 })]);
      await connection.execute("INSERT INTO main_quiz_results VALUES(?,?,?,?,?)", [id,id,user,JSON.stringify({ score: id === 1 ? 18 : 9, total: 20, passed: id === 1, answers: [{ correctAnswer: 'private' }] }), '2026-10-18 10:00:00']);
    }
    const student = { role: "student", userId: 1 };
    const first = await studentMainQuizHistory(student, { pageSize: 1 }, connection);
    assert.equal(first.total, 2);
    assert.equal(first.records.length, 1);
    assert.equal(first.records[0].result_id, 2);
    assert.equal(first.records[0].passed, false);
    assert.equal(first.records[0].quiz_title, 'Main Quiz 2');
    assert.equal(first.records[0].course_title, 'Purposive Communication');
    assert.equal(first.records[0].answers, undefined);
    const second = await studentMainQuizHistory(student, { page: 2, pageSize: 1 }, connection);
    assert.equal(second.records[0].score, 18);
    assert.equal(second.records[0].passed, true);
    const capped = await studentMainQuizHistory(student, { page: -1, pageSize: 100 }, connection);
    assert.equal(capped.pageSize, 20);
    assert.equal(capped.page, 1);
  } finally {
    await connection.query("DROP DATABASE IF EXISTS ??", [schema]);
    await connection.end(); await defaultPool.end();
  }
});
