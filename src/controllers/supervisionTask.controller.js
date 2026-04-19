import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { bustCache } from '../middlewares/cache.middleware.js';

const bustSupervisionCache = () => {
  bustCache('cache:*:/api/supervision-tasks*');
};

// ── CREATE TASK (Admin assigns to Supervisor) ─────────────────────────────
export const createSupervisionTask = asyncHandler(async (req, res) => {
  const { title, description, assigned_to, site_id, priority, due_date } = req.body;
  if (!title || !assigned_to) {
    return res.status(400).json({ success: false, message: 'Title and assigned supervisor are required' });
  }

  // Verify assigned_to is a SUPERVISOR
  const supCheck = await pool.query('SELECT id, role FROM users WHERE id = $1', [assigned_to]);
  if (!supCheck.rows.length || supCheck.rows[0].role !== 'SUPERVISOR') {
    return res.status(400).json({ success: false, message: 'Assigned user is not a supervisor' });
  }

  const result = await pool.query(
    `INSERT INTO supervision_tasks (title, description, assigned_to, assigned_by, site_id, priority, due_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [title, description || null, assigned_to, req.user.id, site_id || null, priority || 'MEDIUM', due_date || null]
  );

  bustSupervisionCache();
  res.status(201).json({ success: true, task: result.rows[0] });
});

// ── GET ALL TASKS ─────────────────────────────────────────────────────────
export const getSupervisionTasks = asyncHandler(async (req, res) => {
  const userRole = req.user.role;
  const userId = req.user.id;

  let query, params;

  if (userRole === 'SUPERVISOR') {
    // Supervisor sees only their tasks
    query = `
      SELECT st.*,
             u_assigned.name AS assigned_to_name,
             u_assigned.email AS assigned_to_email,
             u_by.name AS assigned_by_name,
             s.name AS site_name
      FROM supervision_tasks st
      LEFT JOIN users u_assigned ON st.assigned_to = u_assigned.id
      LEFT JOIN users u_by ON st.assigned_by = u_by.id
      LEFT JOIN sites s ON st.site_id = s.id
      WHERE st.assigned_to = $1
      ORDER BY
        CASE st.status WHEN 'OVERDUE' THEN 0 WHEN 'PENDING' THEN 1 WHEN 'IN_PROGRESS' THEN 2 WHEN 'COMPLETED' THEN 3 END,
        CASE st.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 WHEN 'LOW' THEN 3 END,
        st.due_date ASC NULLS LAST
    `;
    params = [userId];
  } else {
    // Admin/Owner sees all tasks
    query = `
      SELECT st.*,
             u_assigned.name AS assigned_to_name,
             u_assigned.email AS assigned_to_email,
             u_by.name AS assigned_by_name,
             s.name AS site_name
      FROM supervision_tasks st
      LEFT JOIN users u_assigned ON st.assigned_to = u_assigned.id
      LEFT JOIN users u_by ON st.assigned_by = u_by.id
      LEFT JOIN sites s ON st.site_id = s.id
      ORDER BY
        CASE st.status WHEN 'OVERDUE' THEN 0 WHEN 'PENDING' THEN 1 WHEN 'IN_PROGRESS' THEN 2 WHEN 'COMPLETED' THEN 3 END,
        CASE st.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 WHEN 'LOW' THEN 3 END,
        st.due_date ASC NULLS LAST
    `;
    params = [];
  }

  const result = await pool.query(query, params);
  res.json({ success: true, tasks: result.rows });
});

// ── GET SINGLE TASK ───────────────────────────────────────────────────────
export const getSupervisionTask = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await pool.query(
    `SELECT st.*,
            u_assigned.name AS assigned_to_name,
            u_assigned.email AS assigned_to_email,
            u_by.name AS assigned_by_name,
            s.name AS site_name
     FROM supervision_tasks st
     LEFT JOIN users u_assigned ON st.assigned_to = u_assigned.id
     LEFT JOIN users u_by ON st.assigned_by = u_by.id
     LEFT JOIN sites s ON st.site_id = s.id
     WHERE st.id = $1`,
    [id]
  );

  if (!result.rows.length) {
    return res.status(404).json({ success: false, message: 'Task not found' });
  }

  // Supervisors can only see their own tasks
  if (req.user.role === 'SUPERVISOR' && result.rows[0].assigned_to !== req.user.id) {
    return res.status(403).json({ success: false, message: 'Access denied' });
  }

  res.json({ success: true, task: result.rows[0] });
});

// ── UPDATE TASK (Admin updates details) ───────────────────────────────────
export const updateSupervisionTask = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { title, description, assigned_to, site_id, priority, due_date, status } = req.body;

  // Verify task exists
  const existing = await pool.query('SELECT * FROM supervision_tasks WHERE id = $1', [id]);
  if (!existing.rows.length) {
    return res.status(404).json({ success: false, message: 'Task not found' });
  }

  const task = existing.rows[0];

  // Supervisors can only update status (mark progress/complete)
  if (req.user.role === 'SUPERVISOR') {
    if (task.assigned_to !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    // Only allow status change
    const newStatus = status || task.status;
    const completedAt = newStatus === 'COMPLETED' ? new Date().toISOString() : task.completed_at;

    const result = await pool.query(
      `UPDATE supervision_tasks SET status = $1, completed_at = $2, updated_at = NOW() WHERE id = $3 RETURNING *`,
      [newStatus, completedAt, id]
    );
    bustSupervisionCache();
    return res.json({ success: true, task: result.rows[0] });
  }

  // Admin/Owner full update
  const completedAt = (status === 'COMPLETED' && task.status !== 'COMPLETED') ? new Date().toISOString() : (status !== 'COMPLETED' ? null : task.completed_at);

  const result = await pool.query(
    `UPDATE supervision_tasks
     SET title = $1, description = $2, assigned_to = $3, site_id = $4,
         priority = $5, due_date = $6, status = $7, completed_at = $8, updated_at = NOW()
     WHERE id = $9
     RETURNING *`,
    [
      title || task.title,
      description !== undefined ? description : task.description,
      assigned_to || task.assigned_to,
      site_id !== undefined ? site_id : task.site_id,
      priority || task.priority,
      due_date !== undefined ? due_date : task.due_date,
      status || task.status,
      completedAt,
      id
    ]
  );

  bustSupervisionCache();
  res.json({ success: true, task: result.rows[0] });
});

// ── DELETE TASK ───────────────────────────────────────────────────────────
export const deleteSupervisionTask = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await pool.query('DELETE FROM supervision_tasks WHERE id = $1 RETURNING id', [id]);
  if (!result.rows.length) {
    return res.status(404).json({ success: false, message: 'Task not found' });
  }
  bustSupervisionCache();
  res.json({ success: true, message: 'Task deleted' });
});

// ── GET ANALYTICS ─────────────────────────────────────────────────────────
export const getSupervisionAnalytics = asyncHandler(async (req, res) => {
  const userRole = req.user.role;
  const userId = req.user.id;

  if (userRole === 'SUPERVISOR') {
    // Supervisor sees only their own analytics
    const stats = await pool.query(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE status = 'PENDING') AS pending,
         COUNT(*) FILTER (WHERE status = 'IN_PROGRESS') AS in_progress,
         COUNT(*) FILTER (WHERE status = 'COMPLETED') AS completed,
         COUNT(*) FILTER (WHERE status = 'OVERDUE') AS overdue,
         COUNT(*) FILTER (WHERE status = 'COMPLETED' AND completed_at IS NOT NULL) AS completed_with_time,
         AVG(EXTRACT(EPOCH FROM (completed_at - created_at)) / 3600)
           FILTER (WHERE status = 'COMPLETED' AND completed_at IS NOT NULL) AS avg_completion_hours,
         COUNT(*) FILTER (WHERE due_date IS NOT NULL AND status = 'COMPLETED' AND completed_at <= due_date) AS on_time,
         COUNT(*) FILTER (WHERE due_date IS NOT NULL AND status = 'COMPLETED' AND completed_at > due_date) AS late
       FROM supervision_tasks
       WHERE assigned_to = $1`,
      [userId]
    );

    const recentCompleted = await pool.query(
      `SELECT st.*, s.name AS site_name
       FROM supervision_tasks st
       LEFT JOIN sites s ON st.site_id = s.id
       WHERE st.assigned_to = $1 AND st.status = 'COMPLETED'
       ORDER BY st.completed_at DESC LIMIT 5`,
      [userId]
    );

    return res.json({
      success: true,
      analytics: {
        ...stats.rows[0],
        recent_completed: recentCompleted.rows
      }
    });
  }

  // Admin/Owner: all supervisors analytics
  const overallStats = await pool.query(
    `SELECT
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE status = 'PENDING') AS pending,
       COUNT(*) FILTER (WHERE status = 'IN_PROGRESS') AS in_progress,
       COUNT(*) FILTER (WHERE status = 'COMPLETED') AS completed,
       COUNT(*) FILTER (WHERE status = 'OVERDUE') AS overdue,
       AVG(EXTRACT(EPOCH FROM (completed_at - created_at)) / 3600)
         FILTER (WHERE status = 'COMPLETED' AND completed_at IS NOT NULL) AS avg_completion_hours,
       COUNT(*) FILTER (WHERE due_date IS NOT NULL AND status = 'COMPLETED' AND completed_at <= due_date) AS on_time,
       COUNT(*) FILTER (WHERE due_date IS NOT NULL AND status = 'COMPLETED' AND completed_at > due_date) AS late
     FROM supervision_tasks`
  );

  const perSupervisor = await pool.query(
    `SELECT
       u.id AS supervisor_id,
       u.name AS supervisor_name,
       u.email AS supervisor_email,
       COUNT(st.id) AS total,
       COUNT(st.id) FILTER (WHERE st.status = 'PENDING') AS pending,
       COUNT(st.id) FILTER (WHERE st.status = 'IN_PROGRESS') AS in_progress,
       COUNT(st.id) FILTER (WHERE st.status = 'COMPLETED') AS completed,
       COUNT(st.id) FILTER (WHERE st.status = 'OVERDUE') AS overdue,
       AVG(EXTRACT(EPOCH FROM (st.completed_at - st.created_at)) / 3600)
         FILTER (WHERE st.status = 'COMPLETED' AND st.completed_at IS NOT NULL) AS avg_completion_hours
     FROM users u
     LEFT JOIN supervision_tasks st ON st.assigned_to = u.id
     WHERE u.role = 'SUPERVISOR'
     GROUP BY u.id, u.name, u.email
     ORDER BY u.name`
  );

  const recentActivity = await pool.query(
    `SELECT st.*,
            u.name AS assigned_to_name,
            s.name AS site_name
     FROM supervision_tasks st
     LEFT JOIN users u ON st.assigned_to = u.id
     LEFT JOIN sites s ON st.site_id = s.id
     ORDER BY st.updated_at DESC
     LIMIT 10`
  );

  res.json({
    success: true,
    analytics: {
      overall: overallStats.rows[0],
      per_supervisor: perSupervisor.rows,
      recent_activity: recentActivity.rows
    }
  });
});

// ── GET SUPERVISORS LIST (for assignment dropdown) ────────────────────────
export const getSupervisorsForAssignment = asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT id, name, email FROM users WHERE role = 'SUPERVISOR' AND is_active = true ORDER BY name`
  );
  res.json({ success: true, supervisors: result.rows });
});
