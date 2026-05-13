import asyncHandler from '../utils/asyncHandler.js';
import followupModel from '../models/Followup.model.js';
import userModel from '../models/User.model.js';
import pool from '../config/db.js';
import { bustCache } from '../middlewares/cache.middleware.js';

// ============================================================
// Helper: scope filters based on role
// Uses req.user directly (auth middleware populates site_id + team_id).
// Falls back to a DB lookup only for ADMIN/OWNER who need a site_id
// but somehow don't have one on the token (edge case).
// ============================================================
const getScopeFilters = async (user) => {
    if (!user.site_id) return null;

    const filters = { siteId: user.site_id };
    if (user.role === 'AGENT') {
        filters.assignedTo = user.id;
    } else if (user.role === 'TEAM_HEAD') {
        filters.teamId = user.team_id || null;
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

    if (!req.user.site_id) {
        return res.status(404).json({ success: false, message: 'No site assigned' });
    }

    const scheduledAt = scheduled_time
        ? new Date(`${scheduled_date}T${scheduled_time}`)
        : new Date(`${scheduled_date}T09:00:00`);

    const followup = await followupModel.create({
        site_id: req.user.site_id,
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
    if (!req.user.site_id) {
        return res.status(404).json({ success: false, message: 'No site assigned' });
    }

    const assignedTo = req.user.role === 'AGENT' ? req.user.id : null;
    const teamId = req.user.role === 'TEAM_HEAD' ? req.user.team_id : null;
    const counts = await followupModel.getCounts({
        siteId: req.user.site_id,
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
        const teamHeads = await pool.query(
            'SELECT user_id FROM team_heads WHERE team_id = $1 ORDER BY created_at LIMIT 1', [agent.team_id]
        );
        if (teamHeads.rows[0]?.user_id) {
            escalateTo = teamHeads.rows[0].user_id;
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

// ============================================================
// GET REMINDERS — unified followups + uncontacted leads, paginated
// ============================================================
export const getReminders = asyncHandler(async (req, res) => {
    const scope = await getScopeFilters(req.user);
    if (!scope) return res.status(404).json({ success: false, message: 'No site assigned' });

    const { filter = 'all', search, page = 1, limit = 30 } = req.query;
    const pg = parseInt(page) || 1;
    const lim = Math.min(parseInt(limit) || 30, 100);
    const offset = (pg - 1) * lim;

    // Build scope WHERE for followups
    const scopeWhere = [`f.site_id = $1`];
    const params = [scope.siteId];
    let idx = 2;
    if (scope.assignedTo) { scopeWhere.push(`f.assigned_to = $${idx}`); params.push(scope.assignedTo); idx++; }
    else if (scope.teamId) { scopeWhere.push(`f.assigned_to IN (SELECT id FROM users WHERE team_id = $${idx})`); params.push(scope.teamId); idx++; }

    // Build scope WHERE for leads (reuse $1 for site_id)
    const leadScopeWhere = [`l.site_id = $1`];
    if (scope.assignedTo) {
        const agentIdx = params.indexOf(scope.assignedTo) + 1;
        leadScopeWhere.push(`(l.owner_id = $${agentIdx} OR l.assigned_to = $${agentIdx})`);
    } else if (scope.teamId) {
        const teamIdx = params.indexOf(scope.teamId) + 1;
        leadScopeWhere.push(`(l.owner_id IN (SELECT id FROM users WHERE team_id = $${teamIdx}) OR l.assigned_to IN (SELECT id FROM users WHERE team_id = $${teamIdx}))`);
    }

    // Search filter
    let searchClause = '';
    if (search?.trim()) {
        params.push(`%${search.trim()}%`);
        searchClause = `AND (l.name ILIKE $${idx} OR l.phone ILIKE $${idx})`;
        idx++;
    }

    // Status filter on followups
    let statusFilter = '';
    if (filter === 'pending') statusFilter = `AND f.status = 'PENDING'`;
    else if (filter === 'completed') statusFilter = `AND f.status = 'COMPLETED'`;
    else if (filter === 'snoozed') statusFilter = `AND f.status = 'SNOOZED'`;

    const fWhere = scopeWhere.join(' AND ');
    const lWhere = leadScopeWhere.join(' AND ');

    // Counts query
    const countsQ = `
      SELECT
        COUNT(*) FILTER (WHERE src='followup' AND raw_status='PENDING') AS pending,
        COUNT(*) FILTER (WHERE src='followup' AND raw_status='COMPLETED') AS completed,
        COUNT(*) FILTER (WHERE src='followup' AND raw_status='SNOOZED') AS snoozed,
        COUNT(*) FILTER (WHERE src='lead') AS uncontacted,
        COUNT(*) FILTER (WHERE src='followup' AND raw_status='PENDING' AND due_date::date = CURRENT_DATE) AS due_today
      FROM (
        SELECT 'followup' AS src, f.status AS raw_status, f.scheduled_at AS due_date
        FROM followups f LEFT JOIN leads l ON f.lead_id = l.id
        WHERE ${fWhere} ${searchClause}
        UNION ALL
        SELECT 'lead', 'UNCONTACTED', l.created_at
        FROM leads l
        WHERE ${lWhere} AND l.status NOT IN ('BOOKED','LOST')
          AND NOT EXISTS (SELECT 1 FROM followups f2 WHERE f2.lead_id = l.id AND f2.status IN ('PENDING','SNOOZED'))
          ${searchClause}
      ) sub`;

    const countsRes = await pool.query(countsQ, params);
    const c = countsRes.rows[0] || {};

    // Data query
    const dataParams = [...params, lim, offset];
    const limIdx = idx;
    const offIdx = idx + 1;
    let dataQ;

    if (filter === 'uncontacted') {
        dataQ = `
          SELECT 'lead' AS source, l.id::text, 'NEW_LEAD' AS type, l.name AS client_name,
            l.phone AS client_phone, l.id AS lead_id, l.notes AS description, l.created_at AS due_date,
            'new_lead' AS status, 'UNCONTACTED' AS raw_status, l.status AS lead_status, NULL AS agent_name
          FROM leads l
          WHERE ${lWhere} AND l.status NOT IN ('BOOKED','LOST')
            AND NOT EXISTS (SELECT 1 FROM followups f2 WHERE f2.lead_id = l.id AND f2.status IN ('PENDING','SNOOZED'))
            ${searchClause}
          ORDER BY l.created_at ASC LIMIT $${limIdx} OFFSET $${offIdx}`;
    } else if (filter === 'all') {
        dataQ = `
          SELECT * FROM (
            SELECT 'lead' AS source, l.id::text, 'NEW_LEAD' AS type, l.name AS client_name,
              l.phone AS client_phone, l.id AS lead_id, l.notes AS description, l.created_at AS due_date,
              'new_lead' AS status, 'UNCONTACTED' AS raw_status, l.status AS lead_status, NULL AS agent_name
            FROM leads l
            WHERE ${lWhere} AND l.status NOT IN ('BOOKED','LOST')
              AND NOT EXISTS (SELECT 1 FROM followups f2 WHERE f2.lead_id = l.id AND f2.status IN ('PENDING','SNOOZED'))
              ${searchClause}
            UNION ALL
            SELECT 'followup', f.id::text, COALESCE(f.followup_type,'CALL'), COALESCE(l.name,'Unknown'),
              COALESCE(l.phone,'-'), f.lead_id, f.notes, f.scheduled_at,
              CASE WHEN f.status='COMPLETED' THEN 'completed' WHEN f.status='SNOOZED' THEN 'snoozed' ELSE 'pending' END,
              f.status, NULL, u.name
            FROM followups f LEFT JOIN leads l ON f.lead_id = l.id LEFT JOIN users u ON f.assigned_to = u.id
            WHERE ${fWhere} ${searchClause}
          ) sub ORDER BY due_date ASC LIMIT $${limIdx} OFFSET $${offIdx}`;
    } else {
        dataQ = `
          SELECT 'followup' AS source, f.id::text, COALESCE(f.followup_type,'CALL') AS type,
            COALESCE(l.name,'Unknown') AS client_name, COALESCE(l.phone,'-') AS client_phone,
            f.lead_id, f.notes AS description, f.scheduled_at AS due_date,
            CASE WHEN f.status='COMPLETED' THEN 'completed' WHEN f.status='SNOOZED' THEN 'snoozed' ELSE 'pending' END AS status,
            f.status AS raw_status, NULL AS lead_status, u.name AS agent_name
          FROM followups f LEFT JOIN leads l ON f.lead_id = l.id LEFT JOIN users u ON f.assigned_to = u.id
          WHERE ${fWhere} ${statusFilter} ${searchClause}
          ORDER BY f.scheduled_at ASC LIMIT $${limIdx} OFFSET $${offIdx}`;
    }

    const dataRes = await pool.query(dataQ, dataParams);

    const totalMap = {
        all: [c.pending, c.completed, c.snoozed, c.uncontacted].reduce((s, v) => s + parseInt(v || 0), 0),
        pending: parseInt(c.pending || 0), completed: parseInt(c.completed || 0),
        snoozed: parseInt(c.snoozed || 0), uncontacted: parseInt(c.uncontacted || 0),
    };

    res.json({
        success: true,
        reminders: dataRes.rows,
        counts: {
            pending: parseInt(c.pending || 0), completed: parseInt(c.completed || 0),
            snoozed: parseInt(c.snoozed || 0), uncontacted: parseInt(c.uncontacted || 0),
            dueToday: parseInt(c.due_today || 0),
        },
        pagination: { page: pg, limit: lim, total: totalMap[filter] ?? totalMap.all, totalPages: Math.ceil((totalMap[filter] ?? totalMap.all) / lim) },
    });
});
