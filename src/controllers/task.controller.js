import asyncHandler from '../utils/asyncHandler.js';
import taskModel from '../models/Task.model.js';
import userModel from '../models/User.model.js';
import pool from '../config/db.js';
import { bustCache } from '../middlewares/cache.middleware.js';

const getSiteId = async (userId, reqUser) => {
    if (reqUser && reqUser.site_id) return reqUser.site_id;
    const user = await userModel.findById(userId, pool);
    return user?.site_id;
};

// Returns the cache-bust promise so callers can `await` it before responding,
// guaranteeing the next GET /tasks from the same client never sees stale data.
const bustTaskCache = () => bustCache('cache:*:/api/tasks*');

const isPrivileged = (role) => ['ADMIN', 'OWNER'].includes(String(role || '').toUpperCase());

// ── GET ALL TASKS ────────────────────────────────────────────────────────────
export const getTasks = asyncHandler(async (req, res) => {
    const siteId = await getSiteId(req.user.id, req.user);
    if (!siteId) return res.status(404).json({ success: false, message: 'No site assigned' });

    const { status, priority, due_date, search, overdue } = req.query;
    const filters = {};
    if (status) filters.status = status;
    if (priority) filters.priority = priority;
    if (due_date) filters.due_date = due_date;
    if (search) filters.search = search;
    if (overdue === 'true') filters.overdue = true;
    // Non-admin users only see tasks they created themselves
    if (!isPrivileged(req.user.role)) filters.created_by = req.user.id;

    const tasks = await taskModel.findBySite(siteId, filters, pool);
    res.json({ success: true, tasks });
});

// ── GET TASK STATS ───────────────────────────────────────────────────────────
export const getTaskStats = asyncHandler(async (req, res) => {
    const siteId = await getSiteId(req.user.id, req.user);
    if (!siteId) return res.status(404).json({ success: false, message: 'No site assigned' });

    const createdBy = isPrivileged(req.user.role) ? null : req.user.id;
    const stats = await taskModel.getStats(siteId, pool, createdBy);
    res.json({ success: true, stats });
});

// ── CREATE TASK ──────────────────────────────────────────────────────────────
export const createTask = asyncHandler(async (req, res) => {
    const { title, description, priority, due_date } = req.body;

    if (!title || !due_date) {
        return res.status(400).json({ success: false, message: 'Title and due date are required' });
    }

    const siteId = await getSiteId(req.user.id, req.user);
    if (!siteId) return res.status(404).json({ success: false, message: 'No site assigned' });

    const task = await taskModel.create({
        site_id: siteId,
        created_by: req.user.id,
        title: title.trim(),
        description: description?.trim() || null,
        priority: priority || 'MEDIUM',
        status: 'TODO',
        original_due_date: due_date,
        current_due_date: due_date,
    }, pool);

    await bustTaskCache();
    res.status(201).json({ success: true, task });
});

// ── UPDATE TASK ──────────────────────────────────────────────────────────────
export const updateTask = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { title, description, priority, status } = req.body;

    const existing = await taskModel.findById(id, pool);
    if (!existing) return res.status(404).json({ success: false, message: 'Task not found' });
    if (!isPrivileged(req.user.role) && String(existing.created_by) !== String(req.user.id)) {
        return res.status(403).json({ success: false, message: 'You can only modify tasks you created' });
    }

    const updates = { updated_at: new Date() };
    if (title !== undefined) updates.title = title.trim();
    if (description !== undefined) updates.description = description?.trim() || null;
    if (priority !== undefined) updates.priority = priority;
    if (status !== undefined) {
        updates.status = status;
        if (status === 'DONE') updates.completed_at = new Date();
        if (status !== 'DONE') updates.completed_at = null;
    }

    const task = await taskModel.update(id, updates, pool);
    await bustTaskCache();
    res.json({ success: true, task });
});

// ── DELETE TASK ──────────────────────────────────────────────────────────────
export const deleteTask = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const existing = await taskModel.findById(id, pool);
    if (!existing) return res.status(404).json({ success: false, message: 'Task not found' });
    if (!isPrivileged(req.user.role) && String(existing.created_by) !== String(req.user.id)) {
        return res.status(403).json({ success: false, message: 'You can only delete tasks you created' });
    }

    await taskModel.delete(id, pool);
    await bustTaskCache();
    res.json({ success: true, message: 'Task deleted' });
});

// ── SHIFT DUE DATE ───────────────────────────────────────────────────────────
export const shiftTaskDueDate = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { new_date, reason } = req.body;

    if (!new_date) {
        return res.status(400).json({ success: false, message: 'New date is required' });
    }

    const existing = await taskModel.findById(id, pool);
    if (!existing) return res.status(404).json({ success: false, message: 'Task not found' });
    if (!isPrivileged(req.user.role) && String(existing.created_by) !== String(req.user.id)) {
        return res.status(403).json({ success: false, message: 'You can only reschedule tasks you created' });
    }

    const task = await taskModel.shiftDueDate(id, new_date, reason, pool);
    await bustTaskCache();
    res.json({ success: true, task });
});

// ── GET SHIFT HISTORY ────────────────────────────────────────────────────────
export const getTaskShiftHistory = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const existing = await taskModel.findById(id, pool);
    if (!existing) return res.status(404).json({ success: false, message: 'Task not found' });
    if (!isPrivileged(req.user.role) && String(existing.created_by) !== String(req.user.id)) {
        return res.status(403).json({ success: false, message: 'You can only view history of tasks you created' });
    }
    const history = await taskModel.getShiftHistory(id, pool);
    res.json({ success: true, history });
});

// ── AUTO-SHIFT OVERDUE ───────────────────────────────────────────────────────
export const autoShiftOverdue = asyncHandler(async (req, res) => {
    const siteId = await getSiteId(req.user.id, req.user);
    if (!siteId) return res.status(404).json({ success: false, message: 'No site assigned' });

    const createdBy = isPrivileged(req.user.role) ? null : req.user.id;
    const shiftedIds = await taskModel.autoShiftOverdue(siteId, pool, createdBy);
    await bustTaskCache();
    res.json({ success: true, shifted: shiftedIds.length, ids: shiftedIds });
});
