import { db } from "../db.js";
import { logAuditFromRequest } from "../services/auditLogService.js";

/* =====================================================
   HELPERS
===================================================== */

function cleanText(value) {
  return String(value || "").trim();
}

function getModeId(row) {
  return row?.quiz_id || row?.mode_id || row?.id;
}

function rowToMode(row) {
  const id = getModeId(row);

  const title = row.title || row.mode_name || "";

  return {
    id,
    mode_id: id,
    quiz_id: id,

    title,

    mode_name: row.mode_name || title,

    description: row.description || "",

    image: row.image || "",

    route: row.route || "",

    createdBy: row.created_by || null,

    created_by: row.created_by || null,

    createdAt: row.created_at || "",

    updatedAt: row.updated_at || "",
  };
}

function payloadToFields(body = {}) {
  const title = cleanText(body.title || body.mode_name);

  return {
    title,

    modeName: cleanText(body.mode_name || body.title),

    description: cleanText(body.description),

    image: cleanText(body.image),

    route: cleanText(body.route),

    createdBy: body.createdBy || body.created_by || null,
  };
}

function validateMode(fields) {
  if (!fields.title || !fields.description || !fields.route) {
    return "Mode title, description, and route are required.";
  }

  return "";
}

/* =====================================================
   GET QUIZ MODES
===================================================== */

export async function getModes(_req, res) {
  try {
    const [rows] = await db.execute(
      `SELECT *
       FROM quiz_modes
       ORDER BY updated_at DESC,
                quiz_id DESC`,
    );

    return res.json({
      success: true,
      modes: rows.map(rowToMode),
    });
  } catch (error) {
    console.error("Get modes error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch quiz modes.",
    });
  }
}

/* =====================================================
   CREATE QUIZ MODE
===================================================== */

export async function createMode(req, res) {
  const fields = payloadToFields(req.body);

  const validationMessage = validateMode(fields);

  if (validationMessage) {
    return res.status(400).json({
      success: false,
      message: validationMessage,
    });
  }

  try {
    const [result] = await db.execute(
      `INSERT INTO quiz_modes
       (
         created_by,
         mode_name,
         title,
         description,
         image,
         route
       )
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        fields.createdBy,
        fields.modeName || fields.title,
        fields.title,
        fields.description,
        fields.image,
        fields.route,
      ],
    );

    const [rows] = await db.execute(
      `SELECT *
       FROM quiz_modes
       WHERE quiz_id = ?
       LIMIT 1`,
      [result.insertId],
    );

    const mode = rowToMode(rows[0]);

    /* =================================================
       AUDIT LOG - CREATE QUIZ MODE
    ================================================= */

    await logAuditFromRequest(req, {
      category: "Quiz Mode Management",

      action: "Created Quiz Mode",

      target: mode.title || `Quiz Mode ${result.insertId}`,

      status: "Success",

      details: `Created quiz mode "${mode.title}".`,
    });

    return res.status(201).json({
      success: true,
      message: "Quiz mode added successfully.",
      mode,
    });
  } catch (error) {
    console.error("Create mode error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to add quiz mode.",
    });
  }
}

/* =====================================================
   UPDATE QUIZ MODE
===================================================== */

export async function updateMode(req, res) {
  const id =
    req.params.id || req.body?.id || req.body?.quiz_id || req.body?.mode_id;

  const fields = payloadToFields(req.body);

  const validationMessage = validateMode(fields);

  if (!id) {
    return res.status(400).json({
      success: false,
      message: "Mode ID is required.",
    });
  }

  if (validationMessage) {
    return res.status(400).json({
      success: false,
      message: validationMessage,
    });
  }

  try {
    const [result] = await db.execute(
      `UPDATE quiz_modes
       SET
         mode_name = ?,
         title = ?,
         description = ?,
         image = ?,
         route = ?
       WHERE quiz_id = ?`,
      [
        fields.modeName || fields.title,
        fields.title,
        fields.description,
        fields.image,
        fields.route,
        id,
      ],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: "Quiz mode not found.",
      });
    }

    const [rows] = await db.execute(
      `SELECT *
       FROM quiz_modes
       WHERE quiz_id = ?
       LIMIT 1`,
      [id],
    );

    const mode = rowToMode(rows[0]);

    /* =================================================
       AUDIT LOG - UPDATE QUIZ MODE
    ================================================= */

    await logAuditFromRequest(req, {
      category: "Quiz Mode Management",

      action: "Updated Quiz Mode",

      target: mode.title || `Quiz Mode ${id}`,

      status: "Success",

      details: `Updated quiz mode "${mode.title}".`,
    });

    return res.json({
      success: true,
      message: "Quiz mode updated successfully.",
      mode,
    });
  } catch (error) {
    console.error("Update mode error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to update quiz mode.",
    });
  }
}

/* =====================================================
   DELETE QUIZ MODE
===================================================== */

export async function deleteMode(req, res) {
  const id =
    req.params.id || req.body?.id || req.body?.quiz_id || req.body?.mode_id;

  if (!id) {
    return res.status(400).json({
      success: false,
      message: "Mode ID is required.",
    });
  }

  try {
    /*
     * Get the mode BEFORE deleting it.
     *
     * This lets us preserve its title
     * for the audit log.
     */
    const [rows] = await db.execute(
      `SELECT *
       FROM quiz_modes
       WHERE quiz_id = ?
       LIMIT 1`,
      [id],
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Quiz mode not found.",
      });
    }

    const mode = rowToMode(rows[0]);

    /*
     * Delete the quiz mode.
     */
    const [result] = await db.execute(
      `DELETE FROM quiz_modes
       WHERE quiz_id = ?`,
      [id],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: "Quiz mode not found.",
      });
    }

    /* =================================================
       AUDIT LOG - DELETE QUIZ MODE
    ================================================= */

    await logAuditFromRequest(req, {
      category: "Quiz Mode Management",

      action: "Deleted Quiz Mode",

      target: mode.title || `Quiz Mode ${id}`,

      status: "Success",

      details: `Deleted quiz mode "${mode.title}".`,
    });

    return res.json({
      success: true,
      message: "Quiz mode deleted successfully.",
    });
  } catch (error) {
    console.error("Delete mode error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to delete quiz mode.",
    });
  }
}
