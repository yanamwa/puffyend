export async function archiveCatalogClasses(
  connection,
  catalogId,
  actorId = null,
  actorRole = "admin",
) {
  const normalizedActorRole = String(actorRole || "admin")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  const archiveRole = normalizedActorRole === "superadmin"
    ? "super_admin"
    : normalizedActorRole;
  const archiveLabel = archiveRole === "super_admin" ? "Super Admin" : "Admin";
  const [classes] = await connection.execute(
    `SELECT c.course_id,cc.code,c.title,c.professor_name,
            COALESCE(c.professor_id,u.userId) AS professor_id,
            COALESCE(NULLIF(u.email,''),NULLIF(c.professor_email,'')) AS professor_email,
            COALESCE(NULLIF(u.display_name,''),NULLIF(u.name,''),c.professor_name) AS professor_display_name
     FROM courses c JOIN course_catalog cc ON cc.catalog_id=c.catalog_id
     LEFT JOIN users u ON u.userId=c.professor_id OR (c.professor_id IS NULL AND u.email=c.professor_email)
     WHERE c.catalog_id=? AND c.archived=0 FOR UPDATE`,
    [catalogId],
  );
  const emailNotifications = new Map();
  for (const course of classes) {
    await connection.execute(
      "UPDATE courses SET archived=1, archived_by_role=? WHERE course_id=?",
      [archiveRole, course.course_id],
    );
    if (course.professor_id) {
      await connection.execute(
        `INSERT INTO notifications
         (recipient_user_id,course_id,title,message,target,type,is_read,created_by_user_id,created_by_role)
         VALUES (?,?,?,?,?,'course_archived',0,?,?)`,
        [course.professor_id, course.course_id, `Course archived by ${archiveLabel}`,
          `The ${course.code} course was archived by ${archiveLabel}. Only an administrator can restore it. You can find it under Archived in Course Management.`,
          "professor", actorId, archiveRole],
      );
    }
    if (course.professor_email) {
      const email = String(course.professor_email).trim();
      const emailKey = email.toLowerCase();
      const notice = emailNotifications.get(emailKey) || {
        email,
        professorName: course.professor_display_name || "Professor",
        courses: [],
        archiveRole,
        archiveLabel,
      };
      notice.courses.push({ code: course.code, title: course.title });
      emailNotifications.set(emailKey, notice);
    }
  }
  return {
    archivedCount: classes.length,
    emailNotifications: [...emailNotifications.values()],
  };
}

export async function reconcileArchivedCatalogClasses(db) {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [catalogs] = await connection.execute(
      "SELECT catalog_id FROM course_catalog WHERE archived_at IS NOT NULL FOR UPDATE",
    );
    for (const catalog of catalogs) await archiveCatalogClasses(connection, catalog.catalog_id);
    await connection.execute(
      `UPDATE courses c
       JOIN course_catalog cc ON cc.catalog_id=c.catalog_id
       SET c.archived_by_role='admin'
       WHERE cc.archived_at IS NOT NULL AND c.archived=1 AND c.archived_by_role IS NULL`,
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
