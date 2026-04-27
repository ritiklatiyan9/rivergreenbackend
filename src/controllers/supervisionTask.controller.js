import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { bustCache } from '../middlewares/cache.middleware.js';
import fcmService from '../services/fcm.service.js';

const bustSupervisionCache = () => {
  // Cache keys are `cache:{userId}:{siteId}:{originalUrl}` — need two
  // wildcards between `cache:` and the URL, otherwise the bust never matches.
  bustCache('cache:*:*:/api/supervision-tasks*');
};

// Fire-and-forget FCM helper (same pattern as chat/booking).
const pushTaskNotification = (recipientIds, payload) => {
  const ids = (recipientIds || []).filter(Boolean);
  if (ids.length === 0) return;
  setImmediate(async () => {
    try {
      const res = await fcmService.sendToUsers(ids, payload);
      console.log(`[task] FCM push -> recipients=${ids.length} sent=${res?.sent ?? 0} failed=${res?.failed ?? 0} reason=${res?.reason ?? '-'}`);
    } catch (e) {
      console.error('[task] FCM notify failed:', e?.message || e);
    }
  });
};

// Normalize an attachment entry coming in from the client. We store a thin
// JSON record so the client only has to send the S3 url (+ optional key).
const normalizeAttachment = (att, userId) => {
  if (!att) return null;
  const url = typeof att === 'string' ? att : att.url;
  if (!url || typeof url !== 'string') return null;
  return {
    url,
    key: (att && att.key) || null,
    uploaded_at: (att && att.uploaded_at) || new Date().toISOString(),
    uploaded_by: (att && att.uploaded_by) || userId || null,
  };
};

const sanitizeAttachments = (list, userId) => {
  if (!Array.isArray(list)) return [];
  return list.map((a) => normalizeAttachment(a, userId)).filter(Boolean);
};

// Roles that can be assigned a supervision task (i.e. anyone non-admin who
// reports to admin/owner — supervisors, agents, team heads).
const ASSIGNABLE_ROLES = ['SUPERVISOR', 'AGENT', 'TEAM_HEAD'];
const isAssignee = (role) => ASSIGNABLE_ROLES.includes(String(role || '').toUpperCase());
const isPrivileged = (role) => ['ADMIN', 'OWNER'].includes(String(role || '').toUpperCase());

// ── CREATE TASK (Admin assigns to Supervisor) ─────────────────────────────
export const createSupervisionTask = asyncHandler(async (req, res) => {
  const { title, description, assigned_to, site_id, priority, due_date, admin_attachments } = req.body;
  if (!title || !assigned_to) {
    return res.status(400).json({ success: false, message: 'Title and assigned supervisor are required' });
  }

  // Verify assigned_to is an eligible assignee (supervisor, agent, team head)
  const supCheck = await pool.query('SELECT id, role FROM users WHERE id = $1', [assigned_to]);
  if (!supCheck.rows.length || !isAssignee(supCheck.rows[0].role)) {
    return res.status(400).json({ success: false, message: 'Assigned user must be a supervisor, agent, or team head' });
  }

  const cleanedAdminAttachments = sanitizeAttachments(admin_attachments, req.user.id);

  const result = await pool.query(
    `INSERT INTO supervision_tasks
       (title, description, assigned_to, assigned_by, site_id, priority, due_date, admin_attachments)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     RETURNING *`,
    [
      title,
      description || null,
      assigned_to,
      req.user.id,
      site_id || null,
      priority || 'MEDIUM',
      due_date || null,
      JSON.stringify(cleanedAdminAttachments),
    ]
  );

  bustSupervisionCache();

  // Notify the assigned supervisor on their device.
  const newTask = result.rows[0];
  pushTaskNotification([assigned_to], {
    title: 'New task assigned',
    body: (newTask?.title || title).slice(0, 140),
    data: {
      type: 'task',
      action: 'assigned',
      task_id: newTask?.id,
      priority: newTask?.priority || 'MEDIUM',
      route: '/supervision/tasks',
    },
  });

  res.status(201).json({ success: true, task: newTask });
});

// ── GET ALL TASKS ─────────────────────────────────────────────────────────
export const getSupervisionTasks = asyncHandler(async (req, res) => {
  const userRole = req.user.role;
  const userId = req.user.id;

  let query, params;

  if (!isPrivileged(userRole)) {
    // Any non-admin assignee (supervisor / agent / team head) sees only their tasks
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

  // Non-admin assignees can only see their own tasks
  if (!isPrivileged(req.user.role) && result.rows[0].assigned_to !== req.user.id) {
    return res.status(403).json({ success: false, message: 'Access denied' });
  }

  res.json({ success: true, task: result.rows[0] });
});

// ── UPDATE TASK (Admin updates details) ───────────────────────────────────
export const updateSupervisionTask = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const {
    title, description, assigned_to, site_id, priority, due_date, status,
    admin_attachments, proof_attachments,
  } = req.body;

  // Verify task exists
  const existing = await pool.query('SELECT * FROM supervision_tasks WHERE id = $1', [id]);
  if (!existing.rows.length) {
    return res.status(404).json({ success: false, message: 'Task not found' });
  }

  const task = existing.rows[0];

  // Non-admin assignees can only update status + proof_attachments on their own tasks
  if (!isPrivileged(req.user.role)) {
    if (task.assigned_to !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    const newStatus = status || task.status;
    const completedAt = newStatus === 'COMPLETED' ? new Date().toISOString() : task.completed_at;
    const proof = proof_attachments !== undefined
      ? sanitizeAttachments(proof_attachments, req.user.id)
      : task.proof_attachments;

    const result = await pool.query(
      `UPDATE supervision_tasks
         SET status = $1,
             completed_at = $2,
             proof_attachments = $3::jsonb,
             updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [newStatus, completedAt, JSON.stringify(proof), id]
    );
    bustSupervisionCache();

    // Notify the admin who created the task when status changes.
    const updatedTask = result.rows[0];
    if (task.assigned_by && updatedTask && updatedTask.status !== task.status) {
      pushTaskNotification([task.assigned_by], {
        title: updatedTask.status === 'COMPLETED' ? 'Task completed' : 'Task status changed',
        body: `${updatedTask.title}: ${updatedTask.status}`,
        data: {
          type: 'task',
          action: 'status_updated',
          task_id: id,
          new_status: updatedTask.status,
          route: '/supervision/tasks',
        },
      });
    }

    return res.json({ success: true, task: updatedTask });
  }

  // Admin/Owner full update
  const completedAt = (status === 'COMPLETED' && task.status !== 'COMPLETED')
    ? new Date().toISOString()
    : (status && status !== 'COMPLETED' ? null : task.completed_at);

  const nextAdminAttachments = admin_attachments !== undefined
    ? sanitizeAttachments(admin_attachments, req.user.id)
    : task.admin_attachments;
  const nextProofAttachments = proof_attachments !== undefined
    ? sanitizeAttachments(proof_attachments, req.user.id)
    : task.proof_attachments;

  const result = await pool.query(
    `UPDATE supervision_tasks
     SET title = $1, description = $2, assigned_to = $3, site_id = $4,
         priority = $5, due_date = $6, status = $7, completed_at = $8,
         admin_attachments = $9::jsonb, proof_attachments = $10::jsonb,
         updated_at = NOW()
     WHERE id = $11
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
      JSON.stringify(nextAdminAttachments),
      JSON.stringify(nextProofAttachments),
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

  if (!isPrivileged(userRole)) {
    // Non-admin assignees see only their own analytics
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

// ── GET ASSIGNEE LIST (for assignment dropdown) ────────────────────────
// Returns all eligible task assignees: supervisors + agents + team heads.
// Optional `?roles=AGENT,SUPERVISOR` query narrows the result.
export const getSupervisorsForAssignment = asyncHandler(async (req, res) => {
  const requested = String(req.query.roles || '')
    .split(',')
    .map((r) => r.trim().toUpperCase())
    .filter((r) => ASSIGNABLE_ROLES.includes(r));
  const roles = requested.length ? requested : ASSIGNABLE_ROLES;

  const result = await pool.query(
    `SELECT id, name, email, role
       FROM users
      WHERE role = ANY($1::text[]) AND is_active = true
      ORDER BY role, name`,
    [roles]
  );
  res.json({ success: true, supervisors: result.rows, assignees: result.rows });
});
