import asyncHandler from '../utils/asyncHandler.js';
import callModel from '../models/Call.model.js';
import followupModel from '../models/Followup.model.js';
import callOutcomeModel from '../models/CallOutcome.model.js';
import userModel from '../models/User.model.js';
import pool from '../config/db.js';
import { bustCache } from '../middlewares/cache.middleware.js';
import redisClient from '../config/redis.js';

// ============================================================
// Helper: Get requester's site_id
// ============================================================
const getSiteId = async (userId) => {
    const user = await userModel.findById(userId, pool);
    if (!user || !user.site_id) return null;
    return user.site_id;
};

// Helper: Build scope filters based on role
const getScopeFilters = (user, dbUser) => {
    const filters = { siteId: dbUser.site_id };
    if (user.role === 'AGENT') {
        filters.assignedTo = user.id;
    } else if (user.role === 'TEAM_HEAD') {
        filters.teamId = dbUser.team_id;
    }
    // ADMIN and OWNER see all within site
    return filters;
};

// ============================================================
// LOG A CALL
// ============================================================
export const logCall = asyncHandler(async (req, res) => {
    const {
        lead_id, call_type, call_start, call_end,
        outcome_id, next_action,
        customer_notes, buying_timeline, budget_confirmation,
        visit_preference_date, specific_requests, rejection_reason,
        // Followup fields (if next_action requires it)
        followup_date, followup_time, followup_type, followup_notes,
    } = req.body;

    if (!lead_id) {
        return res.status(400).json({ success: false, message: 'Lead is required' });
    }

    const siteId = await getSiteId(req.user.id);
    if (!siteId) {
        return res.status(404).json({ success: false, message: 'No site assigned' });
    }

    // Calculate duration
    let duration_seconds = 0;
    if (call_start && call_end) {
        duration_seconds = Math.max(0, Math.floor((new Date(call_end) - new Date(call_start)) / 1000));
    }

    const callData = {
        site_id: siteId,
        lead_id,
        assigned_to: req.body.assigned_to || req.user.id,
        created_by: req.user.id,
        call_type: call_type || 'OUTGOING',
        call_start: call_start || new Date().toISOString(),
        call_end: call_end || null,
        duration_seconds,
        outcome_id: outcome_id || null,
        next_action: next_action || 'NONE',
        customer_notes: customer_notes || null,
        buying_timeline: buying_timeline || null,
        budget_confirmation: budget_confirmation || null,
        visit_preference_date: visit_preference_date || null,
        specific_requests: specific_requests || null,
        rejection_reason: rejection_reason || null,
        is_manual_log: true,
    };

    const call = await callModel.create(callData, pool);

    // Auto-create followup if needed
    let followup = null;
    if (outcome_id) {
        const outcome = await callOutcomeModel.findById(outcome_id, pool);
        if (outcome && outcome.requires_followup && followup_date) {
            const scheduledAt = followup_time
                ? new Date(`${followup_date}T${followup_time}`)
                : new Date(`${followup_date}T09:00:00`);

            followup = await followupModel.create({
                site_id: siteId,
                lead_id,
                call_id: call.id,
                assigned_to: req.user.id,
                created_by: req.user.id,
                followup_type: followup_type || 'CALL',
                status: 'PENDING',
                scheduled_at: scheduledAt.toISOString(),
                notes: followup_notes || null,
            }, pool);
        }
    }

    // Update lead status based on outcome
    if (next_action === 'VISIT') {
        await pool.query('UPDATE leads SET status = $1, updated_at = NOW() WHERE id = $2', ['SITE_VISIT', lead_id]);
    } else if (next_action === 'CLOSE') {
        await pool.query('UPDATE leads SET status = $1, updated_at = NOW() WHERE id = $2', ['BOOKED', lead_id]);
    } else if (call_type && call.outcome_id) {
        // If lead is NEW and we called, mark as CONTACTED at minimum
        const lead = await pool.query('SELECT status FROM leads WHERE id = $1', [lead_id]);
        if (lead.rows[0]?.status === 'NEW') {
            await pool.query('UPDATE leads SET status = $1, updated_at = NOW() WHERE id = $2', ['CONTACTED', lead_id]);
        }
    }

    bustCache('cache:*:/api/calls*');
    bustCache('cache:*:/api/followups*');

    res.status(201).json({ success: true, call, followup });
});

// ============================================================
// GET CALLS (paginated, filtered, role-scoped)
// ============================================================
export const getCalls = asyncHandler(async (req, res) => {
    const dbUser = await userModel.findById(req.user.id, pool);
    if (!dbUser || !dbUser.site_id) {
        return res.status(404).json({ success: false, message: 'No site assigned' });
    }

    const scope = getScopeFilters(req.user, dbUser);
    const { page, limit, lead_id, outcome_id, lead_category, date_from, date_to } = req.query;

    const result = await callModel.findWithDetails({
        ...scope,
        leadId: lead_id,
        outcomeId: outcome_id,
        leadCategory: lead_category,
        dateFrom: date_from,
        dateTo: date_to,
        page: parseInt(page) || 1,
        limit: parseInt(limit) || 20,
    }, pool);

    res.json({ success: true, ...result });
});

// ============================================================
// GET SINGLE CALL
// ============================================================
export const getCall = asyncHandler(async (req, res) => {
    const call = await callModel.findByIdWithDetails(req.params.id, pool);
    if (!call) {
        return res.status(404).json({ success: false, message: 'Call not found' });
    }
    res.json({ success: true, call });
});

// ============================================================
// UPDATE CALL
// ============================================================
export const updateCall = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const existing = await callModel.findById(id, pool);
    if (!existing) {
        return res.status(404).json({ success: false, message: 'Call not found' });
    }

    // Agents can only edit their own calls
    if (req.user.role === 'AGENT' && existing.assigned_to !== req.user.id) {
        return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const allowedFields = [
        'call_type', 'call_start', 'call_end', 'outcome_id', 'next_action',
        'customer_notes', 'buying_timeline', 'budget_confirmation',
        'visit_preference_date', 'specific_requests', 'rejection_reason',
    ];

    const updateData = {};
    for (const field of allowedFields) {
        if (req.body[field] !== undefined) updateData[field] = req.body[field];
    }

    // Recalc duration
    if (updateData.call_start || updateData.call_end) {
        const start = new Date(updateData.call_start || existing.call_start);
        const end = updateData.call_end ? new Date(updateData.call_end) : existing.call_end ? new Date(existing.call_end) : null;
        if (end) {
            updateData.duration_seconds = Math.max(0, Math.floor((end - start) / 1000));
        }
    }

    if (Object.keys(updateData).length === 0) {
        return res.status(400).json({ success: false, message: 'No data to update' });
    }

    const updated = await callModel.update(id, updateData, pool);
    bustCache('cache:*:/api/calls*');
    res.json({ success: true, call: updated });
});

// ============================================================
// DELETE CALL (Admin only)
// ============================================================
export const deleteCall = asyncHandler(async (req, res) => {
    const call = await callModel.findById(req.params.id, pool);
    if (!call) {
        return res.status(404).json({ success: false, message: 'Call not found' });
    }

    await callModel.delete(req.params.id, pool);
    bustCache('cache:*:/api/calls*');
    res.json({ success: true, message: 'Call deleted successfully' });
});

// ============================================================
// GET CALLS BY LEAD (timeline)
// ============================================================
export const getCallsByLead = asyncHandler(async (req, res) => {
    const calls = await callModel.findByLead(req.params.leadId, pool);
    res.json({ success: true, calls });
});

// ============================================================
// CALL ANALYTICS (Redis-cached)
// ============================================================
export const getCallAnalytics = asyncHandler(async (req, res) => {
    const dbUser = await userModel.findById(req.user.id, pool);
    if (!dbUser || !dbUser.site_id) {
        return res.status(404).json({ success: false, message: 'No site assigned' });
    }

    const scope = getScopeFilters(req.user, dbUser);
    const { date_from, date_to, agent_id, team_id } = req.query;

    // Build cache key
    const cacheKey = `analytics:calls:${dbUser.site_id}:${agent_id || 'all'}:${team_id || 'all'}:${date_from || 'all'}:${date_to || 'all'}`;

    try {
        const cached = await redisClient.get(cacheKey);
        if (cached) {
            return res.json({ success: true, ...JSON.parse(cached), cached: true });
        }
    } catch (err) {
        // Redis down — skip
    }

    const analytics = await callModel.getAnalytics({
        ...scope,
        assignedTo: agent_id || scope.assignedTo,
        teamId: team_id || scope.teamId,
        dateFrom: date_from,
        dateTo: date_to,
    }, pool);

    // Cache for 60 seconds
    try {
        await redisClient.setEx(cacheKey, 60, JSON.stringify(analytics));
    } catch (err) {
        // ignore
    }

    res.json({ success: true, ...analytics });
});

// ============================================================
// GET CALL OUTCOMES (master list)
// ============================================================
export const getCallOutcomes = asyncHandler(async (req, res) => {
    const siteId = await getSiteId(req.user.id);
    if (!siteId) {
        return res.status(404).json({ success: false, message: 'No site assigned' });
    }

    // Auto-seed on first fetch
    const outcomes = await callOutcomeModel.seedDefaults(siteId, pool);
    res.json({ success: true, outcomes });
});

// ============================================================
// BULK LOG CALLS (Daily Entry page)
// ============================================================
export const bulkLogCalls = asyncHandler(async (req, res) => {
    const { calls: callEntries } = req.body;

    if (!Array.isArray(callEntries) || callEntries.length === 0) {
        return res.status(400).json({ success: false, message: 'calls array is required' });
    }
    if (callEntries.length > 50) {
        return res.status(400).json({ success: false, message: 'Maximum 50 calls per batch' });
    }

    const siteId = await getSiteId(req.user.id);
    if (!siteId) {
        return res.status(404).json({ success: false, message: 'No site assigned' });
    }

    // Validate each entry
    for (let i = 0; i < callEntries.length; i++) {
        if (!callEntries[i].lead_id) {
            return res.status(400).json({
                success: false,
                message: `Row ${i + 1}: Lead is required`,
            });
        }
    }

    // Build call data array
    const callDataArray = callEntries.map(entry => {
        let duration_seconds = 0;
        if (entry.call_start && entry.call_end) {
            duration_seconds = Math.max(0, Math.floor(
                (new Date(entry.call_end) - new Date(entry.call_start)) / 1000
            ));
        }

        return {
            site_id: siteId,
            lead_id: entry.lead_id,
            assigned_to: entry.assigned_to || req.user.id,
            created_by: req.user.id,
            call_type: entry.call_type || 'OUTGOING',
            call_start: entry.call_start || new Date().toISOString(),
            call_end: entry.call_end || null,
            duration_seconds,
            outcome_id: entry.outcome_id || null,
            next_action: entry.next_action || 'NONE',
            customer_notes: entry.customer_notes || null,
            customer_words: entry.customer_words || null,
            agent_action: entry.agent_action || null,
            is_manual_log: true,
        };
    });

    // Use a transaction for atomicity
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Bulk insert calls
        const createdCalls = await callModel.bulkCreate(callDataArray, client);

        // Process follow-ups and lead status updates per call
        const followups = [];
        for (let i = 0; i < createdCalls.length; i++) {
            const call = createdCalls[i];
            const entry = callEntries[i];

            // Auto-create followup if needed
            if (call.outcome_id && entry.followup_date) {
                const outcome = await callOutcomeModel.findById(call.outcome_id, client);
                if (outcome && outcome.requires_followup) {
                    const scheduledAt = entry.followup_time
                        ? new Date(`${entry.followup_date}T${entry.followup_time}`)
                        : new Date(`${entry.followup_date}T09:00:00`);

                    const followup = await followupModel.create({
                        site_id: siteId,
                        lead_id: call.lead_id,
                        call_id: call.id,
                        assigned_to: entry.assigned_to || req.user.id,
                        created_by: req.user.id,
                        followup_type: entry.followup_type || 'CALL',
                        status: 'PENDING',
                        scheduled_at: scheduledAt.toISOString(),
                        notes: entry.followup_notes || null,
                    }, client);
                    followups.push(followup);
                }
            }

            // Update lead status
            if (entry.next_action === 'VISIT') {
                await client.query('UPDATE leads SET status = $1, updated_at = NOW() WHERE id = $2', ['SITE_VISIT', call.lead_id]);
            } else if (entry.next_action === 'CLOSE') {
                await client.query('UPDATE leads SET status = $1, updated_at = NOW() WHERE id = $2', ['BOOKED', call.lead_id]);
            } else if (call.outcome_id) {
                const lead = await client.query('SELECT status FROM leads WHERE id = $1', [call.lead_id]);
                if (lead.rows[0]?.status === 'NEW') {
                    await client.query('UPDATE leads SET status = $1, updated_at = NOW() WHERE id = $2', ['CONTACTED', call.lead_id]);
                }
            }
        }

        await client.query('COMMIT');

        bustCache('cache:*:/api/calls*');
        bustCache('cache:*:/api/followups*');

        res.status(201).json({
            success: true,
            message: `${createdCalls.length} calls logged successfully`,
            calls: createdCalls,
            followups,
        });
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
});

// ============================================================
// GET FOLLOW-UP COMPLIANCE
// ============================================================
export const getFollowupCompliance = asyncHandler(async (req, res) => {
    const dbUser = await userModel.findById(req.user.id, pool);
    if (!dbUser || !dbUser.site_id) {
        return res.status(404).json({ success: false, message: 'No site assigned' });
    }

    const assignedTo = req.user.role === 'AGENT' ? req.user.id : null;
    const compliance = await callModel.getFollowupCompliance(dbUser.site_id, assignedTo, pool);
    res.json({ success: true, compliance });
});

// ============================================================
// LEADS DIALER — All leads with phone & last call info
// ============================================================
export const getLeadsForDialer = asyncHandler(async (req, res) => {
    const dbUser = await userModel.findById(req.user.id, pool);
    if (!dbUser || !dbUser.site_id) {
        return res.status(404).json({ success: false, message: 'No site assigned' });
    }

    const scope = getScopeFilters(req.user, dbUser);
    const { page, limit, search, status, lead_category } = req.query;

    const result = await callModel.getLeadsForDialer({
        siteId: scope.siteId,
        assignedTo: scope.assignedTo,
        teamId: scope.teamId,
        search,
        status,
        leadCategory: lead_category,
        page: parseInt(page) || 1,
        limit: parseInt(limit) || 25,
    }, pool);

    res.json({ success: true, ...result });
});

// ============================================================
// QUICK LOG — Agent taps call icon, system captures start time
// ============================================================
export const quickLogCall = asyncHandler(async (req, res) => {
    const { lead_id, call_source } = req.body;

    if (!lead_id) {
        return res.status(400).json({ success: false, message: 'Lead is required' });
    }

    const siteId = await getSiteId(req.user.id);
    if (!siteId) {
        return res.status(404).json({ success: false, message: 'No site assigned' });
    }

    // Get lead phone number
    const leadResult = await pool.query('SELECT phone FROM leads WHERE id = $1', [lead_id]);
    if (!leadResult.rows[0]) {
        return res.status(404).json({ success: false, message: 'Lead not found' });
    }

    const call = await callModel.quickLog({
        site_id: siteId,
        lead_id,
        assigned_to: req.user.id,
        created_by: req.user.id,
        call_type: 'OUTGOING',
        call_start: new Date().toISOString(),
        call_status: 'ACTIVE',
        call_source: call_source || 'WEB',
        phone_number_dialed: leadResult.rows[0].phone,
        is_manual_log: false,
    }, pool);

    // Mark lead as CONTACTED if NEW
    const lead = await pool.query('SELECT status FROM leads WHERE id = $1', [lead_id]);
    if (lead.rows[0]?.status === 'NEW') {
        await pool.query('UPDATE leads SET status = $1, updated_at = NOW() WHERE id = $2', ['CONTACTED', lead_id]);
    }

    bustCache('cache:*:/api/calls*');

    res.status(201).json({
        success: true,
        call,
        phone: leadResult.rows[0].phone,
    });
});

// ============================================================
// END CALL — End an active call session
// ============================================================
export const endCallSession = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { outcome_id, next_action, customer_notes, lead_category, duration_seconds } = req.body;

    const existing = await callModel.findById(id, pool);
    if (!existing) {
        return res.status(404).json({ success: false, message: 'Call not found' });
    }

    if (existing.assigned_to !== req.user.id && !['ADMIN', 'OWNER'].includes(req.user.role)) {
        return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const callEnd = new Date();
    const callStart = new Date(existing.call_start);
    const parsedDuration = Number(duration_seconds);
    const durationSeconds = Number.isFinite(parsedDuration) && parsedDuration >= 0
        ? Math.floor(parsedDuration)
        : Math.max(0, Math.floor((callEnd - callStart) / 1000));

    const updatedCall = await callModel.endCall(id, {
        call_end: callEnd.toISOString(),
        duration_seconds: durationSeconds,
        outcome_id: outcome_id || null,
        next_action: next_action || 'NONE',
        customer_notes: customer_notes || null,
        call_status: 'COMPLETED',
    }, pool);

    // Update lead_category if provided
    const VALID_CATEGORIES = ['PRIME', 'HOT', 'NORMAL', 'COLD', 'DEAD'];
    if (lead_category !== undefined && existing.lead_id) {
        const catValue = (lead_category && VALID_CATEGORIES.includes(lead_category)) ? lead_category : null;
        await pool.query('UPDATE leads SET lead_category = $1, updated_at = NOW() WHERE id = $2', [catValue, existing.lead_id]);
    }

    bustCache('cache:*:/api/calls*');
    bustCache('cache:*:/api/leads*');

    res.json({ success: true, call: updatedCall });
});

// ============================================================
// AGENT CALL DETAILS — Full call history for an agent
// ============================================================
export const getAgentCallDetails = asyncHandler(async (req, res) => {
    const dbUser = await userModel.findById(req.user.id, pool);
    if (!dbUser || !dbUser.site_id) {
        return res.status(404).json({ success: false, message: 'No site assigned' });
    }

    const { agent_id } = req.params;
    const { page, limit, date_from, date_to } = req.query;

    // Agents can only see own data
    if (req.user.role === 'AGENT' && agent_id !== req.user.id) {
        return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const result = await callModel.getAgentCallDetails({
        siteId: dbUser.site_id,
        agentId: agent_id,
        dateFrom: date_from,
        dateTo: date_to,
        page: parseInt(page) || 1,
        limit: parseInt(limit) || 20,
    }, pool);

    res.json({ success: true, ...result });
});

// ============================================================
// ADVANCED ANALYTICS — Hourly heatmap, peak hours, source breakdown
// ============================================================
export const getAdvancedAnalytics = asyncHandler(async (req, res) => {
    const dbUser = await userModel.findById(req.user.id, pool);
    if (!dbUser || !dbUser.site_id) {
        return res.status(404).json({ success: false, message: 'No site assigned' });
    }

    const scope = getScopeFilters(req.user, dbUser);
    const { date_from, date_to, agent_id, team_id } = req.query;

    // Build cache key
    const cacheKey = `analytics:advanced:${dbUser.site_id}:${agent_id || 'all'}:${team_id || 'all'}:${date_from || 'all'}:${date_to || 'all'}`;

    try {
        const cached = await redisClient.get(cacheKey);
        if (cached) {
            return res.json({ success: true, ...JSON.parse(cached), cached: true });
        }
    } catch (err) { /* Redis down — skip */ }

    const analytics = await callModel.getAdvancedAnalytics({
        ...scope,
        assignedTo: agent_id || scope.assignedTo,
        teamId: team_id || scope.teamId,
        dateFrom: date_from,
        dateTo: date_to,
    }, pool);

    // Cache for 120 seconds
    try {
        await redisClient.setEx(cacheKey, 120, JSON.stringify(analytics));
    } catch (err) { /* ignore */ }

    res.json({ success: true, ...analytics });
});
