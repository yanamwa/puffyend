import { quoteIdentifier } from "../database/postgres.js";

// Archived records keep their relationships while releasing the code for reuse.
export async function migrateCatalogCodeAvailability(db) {
  await db.query(
    "ALTER TABLE course_catalog ADD COLUMN IF NOT EXISTS available_normalized_code VARCHAR(50) GENERATED ALWAYS AS (CASE WHEN archived_at IS NULL THEN normalized_code ELSE NULL END) STORED",
  );
  const [columns] = await db.query(
    "SELECT is_generated FROM information_schema.columns WHERE table_schema=CURRENT_SCHEMA() AND table_name='course_catalog' AND column_name='available_normalized_code'",
  );
  // pgloader imports generated values as ordinary columns. Maintain those values
  // using a trigger so new/archived records keep the same uniqueness guarantees.
  if (columns[0]?.is_generated === "NEVER") {
    await db.query(`CREATE OR REPLACE FUNCTION puffy_catalog_available_code() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.available_normalized_code = CASE WHEN NEW.archived_at IS NULL THEN NEW.normalized_code ELSE NULL END; RETURN NEW; END $$`);
    await db.query(
      "CREATE OR REPLACE TRIGGER puffy_catalog_code BEFORE INSERT OR UPDATE ON course_catalog FOR EACH ROW EXECUTE FUNCTION puffy_catalog_available_code()",
    );
    await db.query(
      "UPDATE course_catalog SET available_normalized_code=CASE WHEN archived_at IS NULL THEN normalized_code ELSE NULL END",
    );
  }
  await db.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS catalog_available_code ON course_catalog(available_normalized_code)",
  );
  const [legacy] = await db.query(`SELECT idx.relname AS index_name, con.conname
    FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace JOIN pg_class idx ON idx.oid=i.indexrelid
    JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=i.indkey[0]
    LEFT JOIN pg_constraint con ON con.conindid=i.indexrelid
    WHERE n.nspname=CURRENT_SCHEMA() AND t.relname='course_catalog'
      AND i.indisunique AND i.indnatts=1 AND a.attname='normalized_code'`);
  for (const index of legacy) {
    if (index.conname)
      await db.query(
        `ALTER TABLE course_catalog DROP CONSTRAINT ${quoteIdentifier(index.conname)}`,
      );
    else await db.query(`DROP INDEX ${quoteIdentifier(index.index_name)}`);
  }
}
