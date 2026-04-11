import asyncHandler from '../utils/asyncHandler.js';
import taskModel from '../models/Task.model.js';
import userModel from '../models/User.model.js';
import pool from '../config/db.js';
import { bustCache } from '../middlewares/cache.middleware.js';

const getSiteId = async (userId) => {
    const user = await userModel.findById(userId, pool);
    return user?.site_id;
};

const bustTaskCache = () => {
    bustCache('cache:*:/api/tasks*');
};

// ── GET ALL TASKS ────────────────────────────────────────────────────────────
export const getTasks = asyncHandler(async (req, res) => {
    const siteId = await getSiteId(req.user.id);
    if (!siteId) return res.status(404).json({ success: false, message: 'No site assigned' });

    const { status, priority, due_date, search, overdue } = req.query;
    const filters = {};
    if (status) filters.status = status;
    if (priority) filters.priority = priority;
    if (due_date) filters.due_date = due_date;
    if (search) filters.search = search;
    if (overdue === 'true') filters.overdue = true;

    const tasks = await taskModel.findBySite(siteId, filters, pool);
    res.json({ success: true, tasks });
});

// ── GET TASK STATS ───────────────────────────────────────────────────────────
export const getTaskStats = asyncHandler(async (req, res) => {
    const siteId = await getSiteId(req.user.id);
    if (!siteId) return res.status(404).json({ success: false, message: 'No site assigned' });

    const stats = await taskModel.getStats(siteId, pool);
    res.json({ success: true, stats });
});

// ── CREATE TASK ──────────────────────────────────────────────────────────────
export const createTask = asyncHandler(async (req, res) => {
    const { title, description, priority, due_date } = req.body;

    if (!title || !due_date) {
        return res.status(400).json({ success: false, message: 'Title and due date are required' });
    }

    const siteId = await getSiteId(req.user.id);
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

    bustTaskCache();
    res.status(201).json({ success: true, task });
});

// ── UPDATE TASK ──────────────────────────────────────────────────────────────
export const updateTask = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { title, description, priority, status } = req.body;

    const existing = await taskModel.findById(id, pool);
    if (!existing) return res.status(404).json({ success: false, message: 'Task not found' });

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
    bustTaskCache();
    res.json({ success: true, task });
});

// ── DELETE TASK ──────────────────────────────────────────────────────────────
export const deleteTask = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const task = await taskModel.delete(id, pool);
    if (!task) return res.status(404).json({ success: false, message: 'Task not found' });

    bustTaskCache();
    res.json({ success: true, message: 'Task deleted' });
});

// ── SHIFT DUE DATE ───────────────────────────────────────────────────────────
export const shiftTaskDueDate = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { new_date, reason } = req.body;

    if (!new_date) {
        return res.status(400).json({ success: false, message: 'New date is required' });
    }

    const task = await taskModel.shiftDueDate(id, new_date, reason, pool);
    if (!task) return res.status(404).json({ success: false, message: 'Task not found' });

    bustTaskCache();
    res.json({ success: true, task });
});

// ── GET SHIFT HISTORY ────────────────────────────────────────────────────────
export const getTaskShiftHistory = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const history = await taskModel.getShiftHistory(id, pool);
    res.json({ success: true, history });
});

// ── AUTO-SHIFT OVERDUE ───────────────────────────────────────────────────────
export const autoShiftOverdue = asyncHandler(async (req, res) => {
    const siteId = await getSiteId(req.user.id);
    if (!siteId) return res.status(404).json({ success: false, message: 'No site assigned' });

    const shiftedIds = await taskModel.autoShiftOverdue(siteId, pool);
    bustTaskCache();
    res.json({ success: true, shifted: shiftedIds.length, ids: shiftedIds });
});
