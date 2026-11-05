import '../environment.js';
import { db, pgPool, postgresConfig } from './postgres.js';

// Read-only diagnostics: never run schema changes, migrations, or workers.
let connection;
try {
  const config = postgresConfig();
  if (!process.env.DATABASE_URL && !process.env.SUPABASE_DB_URL)
    throw new Error('DATABASE_URL is missing. Keep the tested connection string in the backend .env.');
  connection = await pgPool.connect();
  await connection.query('BEGIN READ ONLY');
  const { rows: [info] } = await connection.query('SELECT current_database() AS database, current_schema() AS schema, current_setting(\'server_version\') AS version');
  console.log('PostgreSQL connection OK:', JSON.stringify(info));
  const { rows } = await connection.query('SELECT table_name FROM information_schema.tables WHERE table_schema=$1 ORDER BY table_name', [config.schema]);
  console.log(`Tables in configured schema ${config.schema}: ${rows.map(row => row.table_name).join(', ') || '(none)'}`);
  const { rows: flags } = await connection.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 AND data_type='boolean' AND column_name IN ('is_verified','is_archived','is_temporary','onboarding_completed','archived','published','has_quiz','is_read')", [config.schema]);
  if (flags.length) throw new Error('Imported boolean flag columns require compatibility review before enabling writes: '+flags.map(row=>`${row.table_name}.${row.column_name}`).join(', '));
  await connection.query('ROLLBACK');
  connection.release();
  connection = null;
  // initDb/initializeDatabase default to SELECT-only schema validation.
  const { initializeDatabase } = await import('./postgres.js');
  await initializeDatabase();
  console.log('Read-only database validation passed. No rows or schema were changed.');
} catch (error) {
  console.error('Database validation failed:', error.code || 'CONFIGURATION', error.message);
  process.exitCode = 1;
} finally {
  if (connection) {
    await connection.query('ROLLBACK').catch(() => {});
    connection.release();
  }
  await db.end();
}
