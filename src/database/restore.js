export { quoteIdentifier } from "./postgres.js";
import { quoteIdentifier } from "./postgres.js";

export async function prepareRestore(connection, tables) {
  // Defer, rather than disable, foreign keys. Invalid backups still roll back.
  const [constraints] =
    await connection.query(`SELECT t.relname AS table_name, c.conname
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE c.contype='f' AND n.nspname=CURRENT_SCHEMA()`);
  for (const row of constraints) {
    if (!tables.includes(row.TABLE_NAME)) continue;
    await connection.query(
      `ALTER TABLE ${quoteIdentifier(row.TABLE_NAME)} ALTER CONSTRAINT ${quoteIdentifier(row.conname)} DEFERRABLE INITIALLY IMMEDIATE`,
    );
  }
  await connection.query("SET CONSTRAINTS ALL DEFERRED");
}

export async function resetSequences(connection, tables) {
  const [columns] = await connection.query(`SELECT table_name,column_name,
    pg_get_serial_sequence(format('%I.%I',table_schema,table_name),column_name) AS sequence_name
    FROM information_schema.columns WHERE table_schema=CURRENT_SCHEMA()
    AND (column_default LIKE 'nextval(%' OR is_identity='YES')`);
  for (const row of columns) {
    if (!tables.includes(row.TABLE_NAME) || !row.sequence_name) continue;
    await connection.query(
      `SELECT setval(?::regclass, COALESCE(MAX(${quoteIdentifier(row.COLUMN_NAME)}),1), MAX(${quoteIdentifier(row.COLUMN_NAME)}) IS NOT NULL) FROM ${quoteIdentifier(row.TABLE_NAME)}`,
      [row.sequence_name],
    );
  }
}
