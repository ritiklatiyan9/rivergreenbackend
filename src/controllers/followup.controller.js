import asyncHandler from '../utils/asyncHandler.js';
import followupModel from '../models/Followup.model.js';
import userModel from '../models/User.model.js';
import pool from '../config/db.js';
import { bustCache } from '../middlewares/cache.middleware.js';

// ============================================================
// Helper: scope filters based on role
// ============================================================
const getScopeFilters = async (user) => {
    const dbUser = await userModel.findById(user.id, pool);
    if (!dbUser || !dbUser.site_id) return null;

    const filters = { siteId: dbUser.site_id };
    if (user.role === 'AGENT') {
        filters.assignedTo = user.id;
    } else if (user.role === 'TEAM_HEAD') {
        filters.teamId = dbUser.team_id;
    }
    return filters;
};

// ============================================================
// CREATE FOLLOWUP
// ============================================================
export const createFollowup = asyncHandler(async (req, res) => {
    const { lead_id, followup_type, scheduled_date, scheduled_time, notes } = req.body;

    if (!lead_id || !scheduled_date) {
        return res.status(400).json({ success: false, message: 'Lead and scheduled date are required' });
    }

    const dbUser = await userModel.findById(req.user.id, pool);
    if (!dbUser || !dbUser.site_id) {
        return res.status(404).json({ success: false, message: 'No site assigned' });
    }

    const scheduledAt = scheduled_time
        ? new Date(`${scheduled_date}T${scheduled_time}`)
        : new Date(`${scheduled_date}T09:00:00`);

    const followup = await followupModel.create({
        site_id: dbUser.site_id,
        lead_id,
        assigned_to: req.user.id,
        created_by: req.user.id,
        followup_type: followup_type || 'CALL',
        status: 'PENDING',
        scheduled_at: scheduledAt.toISOString(),
        notes: notes || null,
    }, pool);

    bustCache('cache:*:/api/followups*');
    res.status(201).json({ success: true, followup });
});

// ============================================================
// GET FOLLOWUPS (paginated, role-scoped)
// ============================================================
export const getFollowups = asyncHandler(async (req, res) => {
    const scope = await getScopeFilters(req.user);
    if (!scope) {
        return res.status(404).json({ success: false, message: 'No site assigned' });
    }

    const { page, limit, status, followup_type, date_from, date_to, lead_category } = req.query;

    const result = await followupModel.findWithDetails({
        ...scope,
        status,
        followupType: followup_type,
        dateFrom: date_from,
        dateTo: date_to,
        leadCategory: lead_category,
        page: parseInt(page) || 1,
        limit: parseInt(limit) || 20,
    }, pool);

    res.json({ success: true, ...result });
});

// ============================================================
// GET SCHEDULED FOLLOWUPS
// ============================================================
export const getScheduledFollowups = asyncHandler(async (req, res) => {
    const scope = await getScopeFilters(req.user);
    if (!scope) {
        return res.status(404).json({ success: false, message: 'No site assigned' });
    }

    const { page, limit, lead_category, date_from, date_to } = req.query;
    const result = await followupModel.findScheduled({
        ...scope,
        leadCategory: lead_category,
        dateFrom: date_from,
        dateTo: date_to,
        page: parseInt(page) || 1,
        limit: parseInt(limit) || 20,
    }, pool);

    res.json({ success: true, ...result });
});

// ============================================================
// GET MISSED FOLLOWUPS
// ============================================================
export const getMissedFollowups = asyncHandler(async (req, res) => {
    const scope = await getScopeFilters(req.user);
    if (!scope) {
        return res.status(404).json({ success: false, message: 'No site assigned' });
    }

    const { page, limit, lead_category, date_from, date_to } = req.query;
    const result = await followupModel.findMissed({
        ...scope,
        leadCategory: lead_category,
        dateFrom: date_from,
        dateTo: date_to,
        page: parseInt(page) || 1,
        limit: parseInt(limit) || 20,
    }, pool);

    res.json({ success: true, ...result });
});

// ============================================================
// GET FOLLOWUP COUNTS (for dashboard)
// ============================================================
export const getFollowupCounts = asyncHandler(async (req, res) => {
    const dbUser = await userModel.findById(req.user.id, pool);
    if (!dbUser || !dbUser.site_id) {
        return res.status(404).json({ success: false, message: 'No site assigned' });
    }

    const assignedTo = req.user.role === 'AGENT' ? req.user.id : null;
    const teamId = req.user.role === 'TEAM_HEAD' ? dbUser.team_id : null;
    const counts = await followupModel.getCounts({
        siteId: dbUser.site_id,
        assignedTo,
        teamId,
    }, pool);
    res.json({ success: true, counts });
});

// ============================================================
// UPDATE FOLLOWUP
// ============================================================
export const updateFollowup = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const existing = await followupModel.findById(id, pool);
    if (!existing) {
        return res.status(404).json({ success: false, message: 'Followup not found' });
    }

    if (req.user.role === 'AGENT' && existing.assigned_to !== req.user.id) {
        return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const { status, notes, scheduled_date, scheduled_time, followup_type, assigned_to } = req.body;
    const updateData = {};

    if (status) updateData.status = status;
    if (notes !== undefined) updateData.notes = notes;
    if (assigned_to) updateData.assigned_to = assigned_to;
    if (followup_type) updateData.followup_type = followup_type;
    if (status === 'COMPLETED') updateData.completed_at = new Date().toISOString();

    if (scheduled_date) {
        const scheduledAt = scheduled_time
            ? new Date(`${scheduled_date}T${scheduled_time}`)
            : new Date(`${scheduled_date}T09:00:00`);
        updateData.scheduled_at = scheduledAt.toISOString();
    }

    if (Object.keys(updateData).length === 0) {
        return res.status(400).json({ success: false, message: 'No data to update' });
    }

    const updated = await followupModel.update(id, updateData, pool);
    bustCache('cache:*:/api/followups*');
    res.json({ success: true, followup: updated });
});

// ============================================================
// SNOOZE FOLLOWUP
// ============================================================
export const snoozeFollowup = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { snooze_until } = req.body;

    if (!snooze_until) {
        return res.status(400).json({ success: false, message: 'snooze_until is required' });
    }

    const existing = await followupModel.findById(id, pool);
    if (!existing) {
        return res.status(404).json({ success: false, message: 'Followup not found' });
    }

    const updated = await followupModel.update(id, {
        status: 'SNOOZED',
        snoozed_until: new Date(snooze_until).toISOString(),
        scheduled_at: new Date(snooze_until).toISOString(),
    }, pool);

    bustCache('cache:*:/api/followups*');
    res.json({ success: true, followup: updated });
});

// ============================================================
// ESCALATE FOLLOWUP
// ============================================================
export const escalateFollowup = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;

    const existing = await followupModel.findById(id, pool);
    if (!existing) {
        return res.status(404).json({ success: false, message: 'Followup not found' });
    }

    // Find the team head for escalation
    const agent = await userModel.findById(existing.assigned_to, pool);
    let escalateTo = null;
    if (agent && agent.team_id) {
        const teamHead = await pool.query(
            'SELECT head_id FROM teams WHERE id = $1', [agent.team_id]
        );
        if (teamHead.rows[0]?.head_id) {
            escalateTo = teamHead.rows[0].head_id;
        }
    }

    const updated = await followupModel.update(id, {
        status: 'ESCALATED',
        escalated_to: escalateTo,
        escalation_reason: reason || 'Not updated within scheduled time',
    }, pool);

    bustCache('cache:*:/api/followups*');
    res.json({ success: true, followup: updated });
});
