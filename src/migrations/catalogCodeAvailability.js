// Archived courses retain their code and relationships but release the code for reuse.
export async function migrateCatalogCodeAvailability(db) {
  const [columns] = await db.query("SHOW COLUMNS FROM course_catalog");
  if (!columns.some(column => column.Field === "available_normalized_code"))
    await db.query("ALTER TABLE course_catalog ADD COLUMN available_normalized_code VARCHAR(50) CHARACTER SET ascii COLLATE ascii_bin GENERATED ALWAYS AS (CASE WHEN archived_at IS NULL THEN normalized_code ELSE NULL END) STORED");
  const [indexes] = await db.query("SHOW INDEX FROM course_catalog");
  const changes = [];
  if (!indexes.some(index => index.Key_name === "catalog_available_code"))
    changes.push("ADD UNIQUE KEY catalog_available_code (available_normalized_code)");
  if (indexes.some(index => index.Key_name === "catalog_normalized_code"))
    changes.push("DROP INDEX catalog_normalized_code");
  if (changes.length) await db.query("ALTER TABLE course_catalog " + changes.join(", "));
}
