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
  }
  await db.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS catalog_available_code ON course_catalog(available_normalized_code)",
  );
  // Keep existing constraints and indexes. Releasing legacy uniqueness requires
  // a separately reviewed migration; never drop constraints on populated data.
}
