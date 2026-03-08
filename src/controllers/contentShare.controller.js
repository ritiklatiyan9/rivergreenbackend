import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { uploadSingle } from '../utils/upload.js';
import { cleanupFile } from '../middlewares/multer.middleware.js';

// ──────────────────────────────────────────────
// CREATE CONTENT (message and/or PDF)
// ──────────────────────────────────────────────
export const createContent = asyncHandler(async (req, res) => {
  const { message, title } = req.body;
  let fileUrl = null;
  let fileName = null;

  if (req.file) {
    const result = await uploadSingle(req.file, 's3');
    fileUrl = result.secure_url;
    fileName = req.file.originalname;
  }

  if (!message && !fileUrl) {
    return res.status(400).json({ success: false, message: 'Either message or file is required' });
  }

  const { rows } = await pool.query(
    `INSERT INTO content_shares (user_id, title, message, file_url, file_name, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     RETURNING *`,
    [req.user.id, title || null, message || null, fileUrl, fileName]
  );

  res.status(201).json({ success: true, content: rows[0] });
});

// ──────────────────────────────────────────────
// GET MY CONTENTS
// ──────────────────────────────────────────────
export const getMyContents = asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM content_shares WHERE user_id = $1 ORDER BY created_at DESC`,
    [req.user.id]
  );
  res.json({ success: true, contents: rows });
});

// ──────────────────────────────────────────────
// DELETE CONTENT
// ──────────────────────────────────────────────
export const deleteContent = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { rowCount } = await pool.query(
    `DELETE FROM content_shares WHERE id = $1 AND user_id = $2`,
    [id, req.user.id]
  );
  if (rowCount === 0) {
    return res.status(404).json({ success: false, message: 'Content not found' });
  }
  res.json({ success: true, message: 'Content deleted' });
});

// ──────────────────────────────────────────────
// GET MY LEADS (lightweight for share list)
// ──────────────────────────────────────────────
export const getMyLeadsForShare = asyncHandler(async (req, res) => {
  const siteId = await getSiteId(req.user.id);
  if (!siteId) {
    return res.status(404).json({ success: false, message: 'No site assigned' });
  }

  const search = req.query.search || '';
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 50;
  const offset = (page - 1) * limit;

  let whereClause = `WHERE (l.owner_id = $1 OR l.assigned_to = $1) AND l.site_id = $2`;
  const params = [req.user.id, siteId];
  let paramIndex = 3;

  if (search) {
    whereClause += ` AND (l.name ILIKE $${paramIndex} OR l.phone ILIKE $${paramIndex})`;
    params.push(`%${search}%`);
    paramIndex++;
  }

  // Only leads that have a phone number
  whereClause += ` AND l.phone IS NOT NULL AND l.phone != ''`;

  const countRes = await pool.query(
    `SELECT COUNT(*) FROM leads l ${whereClause}`,
    params
  );
  const total = parseInt(countRes.rows[0].count);

  params.push(limit, offset);
  const { rows } = await pool.query(
    `SELECT l.id, l.name, l.phone, l.email, l.status, l.address
     FROM leads l
     ${whereClause}
     ORDER BY l.name ASC
     LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    params
  );

  res.json({
    success: true,
    leads: rows,
    pagination: { total, page, totalPages: Math.ceil(total / limit) },
  });
});

// Helper
async function getSiteId(userId) {
  const { rows } = await pool.query('SELECT site_id FROM users WHERE id = $1', [userId]);
  return rows[0]?.site_id;
}
