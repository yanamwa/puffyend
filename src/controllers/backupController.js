import { db } from "../db.js";
import { logAuditFromRequest } from "../services/auditLogService.js";

/* =====================================================
   HELPERS
===================================================== */

function cleanText(value) {
  return String(value ?? "").trim();
}

function quoteIdentifier(value) {
  return `\`${String(value).replace(/`/g, "``")}\``;
}

function getCurrentUser(req) {
  return req?.user || {};
}

function getCurrentUserName(req) {
  const user = getCurrentUser(req);

  return (
    user.displayName ||
    user.display_name ||
    user.name ||
    user.fullName ||
    user.full_name ||
    user.email ||
    "Super Admin"
  );
}

function getCurrentUserRole(req) {
  return getCurrentUser(req).role || "super_admin";
}

/*
 * Tables that should NOT be restored from
 * the backup file.
 *
 * audit_logs is intentionally excluded so
 * restoring an old backup does not erase
 * the current audit history.
 */
const EXCLUDED_TABLES = new Set(["audit_logs"]);

async function getDatabaseName() {
  const [rows] = await db.execute("SELECT DATABASE() AS database_name");

  return rows[0]?.database_name || "puffybrain";
}

async function getDatabaseTables() {
  const [rows] = await db.execute(`
    SELECT TABLE_NAME
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_TYPE = 'BASE TABLE'
    ORDER BY TABLE_NAME ASC
  `);

  return rows.map((row) => row.TABLE_NAME).filter(Boolean);
}

async function getTableColumns(connection, tableName) {
  const [rows] = await connection.execute(
    `
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION ASC
    `,
    [tableName],
  );

  return rows.map((row) => row.COLUMN_NAME);
}

/* =====================================================
   CREATE DATABASE BACKUP
===================================================== */

export async function createDatabaseBackup(req, res) {
  try {
    const databaseName = await getDatabaseName();

    const tableNames = await getDatabaseTables();

    const tables = {};

    for (const tableName of tableNames) {
      /*
       * Keep audit history outside backups.
       */
      if (EXCLUDED_TABLES.has(tableName)) {
        continue;
      }

      const safeTable = quoteIdentifier(tableName);

      const [rows] = await db.query(`SELECT * FROM ${safeTable}`);

      tables[tableName] = rows;
    }

    const createdAt = new Date().toISOString();

    const backup = {
      app: "PuffyBrain",
      format: "puffybrain-database-backup",
      version: 1,
      database: databaseName,
      createdAt,
      tableCount: Object.keys(tables).length,
      tables,
    };

    await logAuditFromRequest(req, {
      category: "Backup & Restore",
      action: "Created Database Backup",
      target: databaseName,
      status: "Success",
      details:
        `Created database backup containing ` +
        `${Object.keys(tables).length} tables.`,
      userName: getCurrentUserName(req),
      userRole: getCurrentUserRole(req),
    });

    const date = createdAt.slice(0, 10);

    res.setHeader("Content-Type", "application/json");

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="puffybrain-database-backup-${date}.json"`,
    );

    return res.status(200).send(JSON.stringify(backup, null, 2));
  } catch (error) {
    console.error("Create database backup error:", error);

    await logAuditFromRequest(req, {
      category: "Backup & Restore",
      action: "Create Database Backup",
      target: "PuffyBrain Database",
      status: "Failed",
      details: cleanText(error?.message) || "Database backup failed.",
      userName: getCurrentUserName(req),
      userRole: getCurrentUserRole(req),
    });

    return res.status(500).json({
      success: false,
      message: "Failed to create database backup.",
    });
  }
}

/* =====================================================
   RESTORE DATABASE BACKUP
===================================================== */

export async function restoreDatabaseBackup(req, res) {
  let connection;

  try {
    const backup = req.body;

    if (
      !backup ||
      backup.app !== "PuffyBrain" ||
      backup.format !== "puffybrain-database-backup" ||
      !backup.tables ||
      typeof backup.tables !== "object" ||
      Array.isArray(backup.tables)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid PuffyBrain database backup file.",
      });
    }

    const databaseName = await getDatabaseName();

    /*
     * Only restore tables that actually
     * exist in the current database.
     *
     * This prevents arbitrary table names
     * from the uploaded JSON being used.
     */
    const existingTables = new Set(await getDatabaseTables());

    const backupTables = Object.entries(backup.tables).filter(
      ([tableName, rows]) =>
        existingTables.has(tableName) &&
        !EXCLUDED_TABLES.has(tableName) &&
        Array.isArray(rows),
    );

    if (backupTables.length === 0) {
      return res.status(400).json({
        success: false,
        message:
          "The backup does not contain any restorable PuffyBrain tables.",
      });
    }

    connection = await db.getConnection();

    await connection.beginTransaction();

    /*
     * Temporarily disable FK checks because
     * tables depend on each other.
     */
    await connection.query("SET FOREIGN_KEY_CHECKS = 0");

    try {
      /*
       * Clear only the tables contained
       * in this backup.
       */
      for (const [tableName] of backupTables) {
        await connection.query(`DELETE FROM ${quoteIdentifier(tableName)}`);
      }

      /*
       * Restore table rows.
       */
      for (const [tableName, rows] of backupTables) {
        if (rows.length === 0) {
          continue;
        }

        const validColumns = new Set(
          await getTableColumns(connection, tableName),
        );

        for (const row of rows) {
          if (!row || typeof row !== "object" || Array.isArray(row)) {
            continue;
          }

          /*
           * Ignore backup properties that
           * no longer exist in the current
           * database schema.
           */
          const columns = Object.keys(row).filter((column) =>
            validColumns.has(column),
          );

          if (columns.length === 0) {
            continue;
          }

          const values = columns.map((column) => row[column]);

          const columnSql = columns.map(quoteIdentifier).join(", ");

          const placeholders = columns.map(() => "?").join(", ");

          await connection.execute(
            `
              INSERT INTO ${quoteIdentifier(tableName)}
              (${columnSql})
              VALUES (${placeholders})
            `,
            values,
          );
        }
      }

      await connection.query("SET FOREIGN_KEY_CHECKS = 1");

      await connection.commit();
    } catch (restoreError) {
      await connection.rollback();

      try {
        await connection.query("SET FOREIGN_KEY_CHECKS = 1");
      } catch {
        // Ignore cleanup failure.
      }

      throw restoreError;
    }

    await logAuditFromRequest(req, {
      category: "Backup & Restore",
      action: "Restored Database Backup",
      target: databaseName,
      status: "Success",
      details:
        `Restored ${backupTables.length} tables ` +
        `from PuffyBrain backup created at ` +
        `${cleanText(backup.createdAt) || "unknown time"}.`,
      userName: getCurrentUserName(req),
      userRole: getCurrentUserRole(req),
    });

    return res.json({
      success: true,
      message: "Database backup restored successfully.",
      restoredTables: backupTables.length,
    });
  } catch (error) {
    console.error("Restore database backup error:", error);

    await logAuditFromRequest(req, {
      category: "Backup & Restore",
      action: "Restore Database Backup",
      target: "PuffyBrain Database",
      status: "Failed",
      details: cleanText(error?.message) || "Database restore failed.",
      userName: getCurrentUserName(req),
      userRole: getCurrentUserRole(req),
    });

    return res.status(500).json({
      success: false,
      message: error?.message || "Failed to restore database backup.",
    });
  } finally {
    if (connection) {
      connection.release();
    }
  }
}
