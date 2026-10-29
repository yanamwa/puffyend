// Run inside the caller's transaction so course state and notifications commit together.
export async function archiveCatalogClasses(connection, catalogId, actorId = null) {
  const [classes] = await connection.execute(
    `SELECT c.course_id,cc.code,c.title,COALESCE(c.professor_id,u.userId) AS professor_id
     FROM courses c JOIN course_catalog cc ON cc.catalog_id=c.catalog_id
     LEFT JOIN users u ON u.email=c.professor_email
     WHERE c.catalog_id=? AND c.archived=0 FOR UPDATE`,
    [catalogId],
  );
  for (const course of classes) {
    await connection.execute("UPDATE courses SET archived=1 WHERE course_id=?", [course.course_id]);
    if (!course.professor_id) continue;
    await connection.execute(
      `INSERT INTO notifications
       (recipient_user_id,course_id,title,message,target,type,is_read,created_by_user_id,created_by_role)
       VALUES (?,?,?,?,?,'course_archived',0,?,'admin')`,
      [course.professor_id, course.course_id, "Course archived by admin",
        `The ${course.code} course was archived by the admin. You can find it under Archived in Course Management.`,
        "professor", actorId],
    );
  }
  return classes.length;
}

export async function reconcileArchivedCatalogClasses(db) {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [catalogs] = await connection.execute(
      "SELECT catalog_id FROM course_catalog WHERE archived_at IS NOT NULL FOR UPDATE",
    );
    for (const catalog of catalogs) await archiveCatalogClasses(connection, catalog.catalog_id);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
