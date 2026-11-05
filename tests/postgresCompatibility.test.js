import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../src/config/security.js';
import { db, pgPool, createDatabase, bindParameters, postgresConfig } from '../src/database/postgres.js';
import { initDb } from '../src/db.js';
import { migrateApplication } from '../src/migrations/applicationMigration.js';
import { startApplication } from '../src/application.js';
import { mountApiAvailability } from '../src/middleware/apiAvailability.js';
import { createNotification } from '../src/utils/notification.js';

test('VPS connection uses PostgreSQL 5432 and supports same-host production without TLS', () => {
  const config = postgresConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/puffy?sslmode=disable' });
  assert.equal(config.ssl, false);
  assert.equal(new URL(config.connectionString).port, '5432');
  assert.throws(() => postgresConfig({ DATABASE_URL: 'postgresql://u:p@localhost:3306/puffy' }), /5432/);
  assert.deepEqual(bindParameters('SELECT $1::int AS value', [42]), { text: 'SELECT $1::int AS value', values: [42] });
});

test('application starts on populated PostgreSQL without modifying data; notifications and transactions work', { timeout: 180000 }, async () => {
  const engine = new PGlite();
  await engine.exec('CREATE SCHEMA puffybrain; SET search_path=puffybrain,public');
  const queries = [];
  const query = async (sql, values) => { queries.push(sql); return engine.query(sql, values); };
  const adapter = createDatabase({ query, connect: async () => ({ query, release() {} }), end: () => engine.close() });
  const original = { ...db };
  Object.assign(db, adapter);
  const savedEnv = { ...process.env };
  let server;
  try {
    process.env.ENABLE_BACKGROUND_JOBS = 'false';
    process.env.RUN_DB_MIGRATIONS = 'false';
    process.env.SUPER_ADMIN_PASSWORD = '';
    await migrateApplication(); // Disposable embedded database only, never the VPS.
    const [user] = await db.execute("INSERT INTO users(name,email,password,role) VALUES('Existing','existing@example.test','original-hash','student')");
    const [declined] = await db.execute("INSERT INTO users(name,email,password,role,verification_status,professor_declined_at) VALUES('Declined','declined@example.test','hash','professor','declined',NOW()-INTERVAL '2 days')");
    const [{ affectedRows }] = await db.execute('UPDATE users SET otp_expires=NOW()+?*INTERVAL \'1 second\' WHERE userId=?', [300, user.insertId]);
    assert.equal(affectedRows, 1);
    const [[timing]] = await db.query("SELECT GREATEST(CEIL(EXTRACT(EPOCH FROM (professor_declined_at+INTERVAL '24 hours'-NOW()))),1) AS retry_after_seconds FROM users WHERE userId=?", [declined.insertId]);
    assert.equal(Number(timing.retry_after_seconds), 1);
    const before = await engine.query('SELECT * FROM users ORDER BY userid');
    queries.length = 0;
    await initDb();
    assert.ok(queries.every(sql => /^\s*SELECT\b/i.test(sql)), 'normal initialization must be read-only');
    const app = express();
    const state = { ready: false, failed: false, stage: 'loading_application' };
    mountApiAvailability(app, state);
    await startApplication(app, state);
    assert.equal(state.ready, true);
    assert.ok(queries.every(sql => /^\s*SELECT\b/i.test(sql)), 'startup must not run migrations or workers');
    assert.deepEqual((await engine.query('SELECT * FROM users ORDER BY userid')).rows, before.rows);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const health = await fetch(`http://127.0.0.1:${server.address().port}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, 'ready');
    const { cleanupDeclinedRegistrations } = await import('../src/services/declinedRegistrationCleanup.js');
    delete process.env.ENABLE_DECLINED_REGISTRATION_CLEANUP;
    assert.equal(await cleanupDeclinedRegistrations(), 0);
    assert.equal((await db.query('SELECT userId FROM users WHERE userId=?', [declined.insertId]))[0].length, 1);
    const notification = await createNotification({ recipientUserId: user.insertId, title: 'Test', message: 'Preserve existing data', target: 'student' });
    assert.ok(notification.notificationId);
    const [[saved]] = await db.query('SELECT title,is_read FROM notifications WHERE notification_id=?', [notification.notificationId]);
    assert.equal(saved.title, 'Test');
    assert.equal(saved.is_read, 0);
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { Authorization: `Bearer ${jwt.sign({ userId: user.insertId, role: 'student' }, JWT_SECRET)}` };
    const [broadcast] = await db.execute("INSERT INTO notifications(title,message,target,is_read) VALUES('Broadcast','All students','student',0)");
    const list = await fetch(`${base}/api/notifications`, { headers });
    assert.equal(list.status, 200);
    assert.equal((await list.json()).success, true);
    const count = await fetch(`${base}/api/notifications/unread-count`, { headers });
    assert.equal(count.status, 200);
    assert.equal((await count.json()).unreadCount, 2);
    const mark = await fetch(`${base}/api/notifications/${broadcast.insertId}/read`, { method: 'PATCH', headers });
    assert.equal(mark.status, 200);
    const all = await fetch(`${base}/api/notifications/read-all`, { method: 'PATCH', headers });
    assert.equal(all.status, 200);
    const afterCount = await fetch(`${base}/api/notifications/unread-count`, { headers });
    assert.equal((await afterCount.json()).unreadCount, 0);

    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute('UPDATE users SET name=? WHERE userId=?', ['Rollback', user.insertId]);
      await connection.rollback();
    } finally { connection.release(); }
    const [[preserved]] = await db.query('SELECT name,password FROM users WHERE userId=?', [user.insertId]);
    assert.equal(preserved.name, 'Existing');
    assert.equal(preserved.password, 'original-hash');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    Object.assign(db, original);
    await engine.close();
    await pgPool.end();
  }
});
