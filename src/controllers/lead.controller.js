import asyncHandler from '../utils/asyncHandler.js';
import leadModel from '../models/Lead.model.js';
import userModel from '../models/User.model.js';
import callModel from '../models/Call.model.js';
import pool from '../config/db.js';
import { bustCache } from '../middlewares/cache.middleware.js';
import { read as xlsxRead, utils as xlsxUtils } from 'xlsx';
import fs from 'fs';
import { leadImportQueue } from '../utils/jobQueue.js';
import { uploadSingle } from '../utils/upload.js';

const VALID_STATUSES = ['NEW', 'CONTACTED', 'INTERESTED', 'SITE_VISIT', 'NEGOTIATION', 'BOOKED', 'LOST', 'INCOMING_OFF', 'SWITCH_OFF', 'NOT_ANSWERING'];

const getSiteId = async (userId, reqUser) => {
    if (reqUser && reqUser.site_id) return reqUser.site_id;
    const user = await userModel.findById(userId, pool);
    return user?.site_id;
};

const bustLeadCache = () => {
    bustCache('cache:*:/api/leads*');
    bustCache('cache:*:/api/site/leads*');
    bustCache('cache:*:/api/followups*');
};

// ────────────────────────────────────────────────────────────────────────────
// Idempotent schema guard — makes sure the import-batch columns exist before
// any bulk-upload or batch-listing code paths touch them. Cheap, runs once
// per process; safe to call on every request (DDL is IF NOT EXISTS).
// ────────────────────────────────────────────────────────────────────────────
let _importBatchColumnsReady = null;
const ensureImportBatchColumns = async () => {
    if (_importBatchColumnsReady) return _importBatchColumnsReady;
    _importBatchColumnsReady = (async () => {
        await pool.query(`
            ALTER TABLE IF EXISTS leads
              ADD COLUMN IF NOT EXISTS import_job_id UUID REFERENCES bulk_import_jobs(id) ON DELETE SET NULL
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_leads_import_job_id ON leads(import_job_id)`);
        await pool.query(`ALTER TABLE IF EXISTS bulk_import_jobs ADD COLUMN IF NOT EXISTS label TEXT`);
    })().catch((err) => {
        console.error('[ensureImportBatchColumns] failed:', err.message);
        _importBatchColumnsReady = null; // allow retry on next call
        throw err;
    });
    return _importBatchColumnsReady;
};

// ============================================================
// CREATE LEAD — owner_id = creator, assigned_to = self by default
// ============================================================
export const createLead = asyncHandler(async (req, res) => {
    const { name, phone, email, status, assigned_to, notes, lead_source } = req.body;

    if (!name || (!phone && !email)) {
        return res.status(400).json({ success: false, message: 'Name and either phone or email are required' });
    }

    const siteId = await getSiteId(req.user.id, req.user);
    if (!siteId) {
        return res.status(404).json({ success: false, message: 'No site assigned to this user' });
    }

    const effectiveAssignedTo = assigned_to || req.user.id;

    // Handle photo upload if provided
    let photoUrl = null;
    if (req.file) {
        try {
            const result = await uploadSingle(req.file, 's3');
            photoUrl = result.secure_url;
        } catch (err) {
            console.error('Lead photo upload error:', err);
        }
    }

    const leadData = {
        site_id: siteId,
        name,
        phone: phone || null,
        email: email || null,
        address: req.body.address || null,
        profession: req.body.profession || null,
        status: status || 'NEW',
        assigned_to: effectiveAssignedTo,
        owner_id: req.user.id,
        created_by: req.user.id,
        notes: notes || null,
        lead_source: lead_source || 'Other',
        photo_url: photoUrl,
    };

    const newLead = await leadModel.create(leadData, pool);

    if (assigned_to && assigned_to !== req.user.id) {
        await pool.query(
            `INSERT INTO lead_assignments (lead_id, assigned_from, assigned_to, assigned_by, reason)
             VALUES ($1, $2, $3, $4, $5)`,
            [newLead.id, null, assigned_to, req.user.id, 'Initial assignment on creation']
        );
    }

    bustLeadCache();

    res.status(201).json({
        success: true,
        message: 'Lead created successfully',
        lead: newLead
    });
});

// ============================================================
// GET LEAD STATUS COUNTS — accurate pipeline counts for dashboard
// ============================================================
export const getLeadStatusCounts = asyncHandler(async (req, res) => {
    const user = await userModel.findById(req.user.id, pool);
    // Trust the header-derived site (req.user.site_id) over the DB column —
    // see comment in site.controller.js for why this matters during a site switch.
    if (user && req.user?.site_id) user.site_id = req.user.site_id;
    if (!user?.site_id) {
        return res.status(404).json({ success: false, message: 'No site assigned' });
    }
    const filters = { site_id: user.site_id };
    if (user.role === 'AGENT') filters.owner_or_assigned = user.id;
    else if (user.role === 'TEAM_HEAD') {
        // team_head sees their team's leads — filter by assigned_to using team membership
        // For simplicity, filter by owner_or_assigned same as agent
        filters.owner_or_assigned = user.id;
    }
    const [rawCounts, matterCount] = await Promise.all([
        leadModel.getStatusCounts(filters, pool),
        leadModel.getMatterLeadsCount(filters, pool),
    ]);
    // Ensure all statuses are present with defaults
    const allStatuses = ['NEW', 'CONTACTED', 'INTERESTED', 'SITE_VISIT', 'NEGOTIATION', 'BOOKED', 'LOST', 'INCOMING_OFF', 'SWITCH_OFF', 'NOT_ANSWERING'];
    const counts = Object.fromEntries(allStatuses.map(s => [s, rawCounts[s] ?? 0]));
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    return res.json({ success: true, counts, total, matterCount });
});

// ============================================================
// GET MATTER LEADS — leads contacted at least once
// ============================================================
export const getMatterLeadsList = asyncHandler(async (req, res) => {
    const user = await userModel.findById(req.user.id, pool);
    if (user && req.user?.site_id) user.site_id = req.user.site_id;
    if (!user?.site_id) {
        return res.status(404).json({ success: false, message: 'No site assigned' });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const filters = { site_id: user.site_id, search: req.query.search };

    if (user.role === 'AGENT' || user.role === 'TEAM_HEAD') {
        filters.owner_or_assigned = user.id;
    } else if (req.query.assigned_to) {
        filters.assigned_to = req.query.assigned_to;
    }

    const result = await leadModel.getMatterLeads(filters, page, limit, pool);
    return res.json({
        success: true,
        leads: result.items,
        pagination: result.pagination,
    });
});

// ============================================================
// GET LEADS — ownership-aware filtering
// ============================================================
export const getLeads = asyncHandler(async (req, res) => {
    const siteId = await getSiteId(req.user.id, req.user);
    if (!siteId) {
        return res.status(404).json({ success: false, message: 'No site assigned' });
    }

    const page = parseInt(req.query.page) || 1;
    let limit = parseInt(req.query.limit) || 15;
    if (req.query.limit === 'all') limit = -1;

    const filters = {
        site_id: siteId,
        status: req.query.status,
        exclude_status: req.query.exclude_status,
        search: req.query.search,
        lead_category: req.query.lead_category,
        import_job_id: req.query.import_job_id,
    };

    // Agents & Team Heads see only leads they own or are assigned to
    if (req.user.role === 'AGENT' || req.user.role === 'TEAM_HEAD') {
        filters.owner_or_assigned = req.user.id;
    } else if (req.query.assigned_to) {
        filters.assigned_to = req.query.assigned_to;
    }

    const result = await leadModel.findWithDetails(filters, page, limit, pool);

    res.json({
        success: true,
        leads: result.items,
        pagination: result.pagination
    });
});

// ============================================================
// GET SINGLE LEAD
// ============================================================
export const getLead = asyncHandler(async (req, res) => {
    const siteId = await getSiteId(req.user.id, req.user);
    if (!siteId) {
        return res.status(404).json({ success: false, message: 'No site assigned' });
    }

    const lead = await leadModel.findById(req.params.id, pool);

    if (!lead || lead.site_id !== siteId) {
        return res.status(404).json({ success: false, message: 'Lead not found' });
    }

    if ((req.user.role === 'AGENT' || req.user.role === 'TEAM_HEAD') &&
        lead.owner_id !== req.user.id && lead.assigned_to !== req.user.id) {
        return res.status(403).json({ success: false, message: 'Not authorized to view this lead' });
    }

    const assignee = lead.assigned_to ? await userModel.findById(lead.assigned_to, pool) : null;
    const owner = lead.owner_id ? await userModel.findById(lead.owner_id, pool) : null;

    res.json({
        success: true,
        lead: {
            ...lead,
            assigned_to_name: assignee ? assignee.name : null,
            owner_name: owner ? owner.name : null,
        }
    });
});

// ============================================================
// UPDATE LEAD
// ============================================================
export const updateLead = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { name, phone, email, address, profession, status, assigned_to, notes, lead_category, lead_source } = req.body;

    const siteId = await getSiteId(req.user.id, req.user);
    const existingLead = await leadModel.findById(id, pool);

    if (!existingLead || existingLead.site_id !== siteId) {
        return res.status(404).json({ success: false, message: 'Lead not found' });
    }

    if ((req.user.role === 'AGENT' || req.user.role === 'TEAM_HEAD') &&
        existingLead.owner_id !== req.user.id && existingLead.assigned_to !== req.user.id) {
        return res.status(403).json({ success: false, message: 'Not authorized to update this lead' });
    }

    const VALID_CATEGORIES = ['PRIME', 'HOT', 'NORMAL', 'COLD', 'DEAD'];
    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (phone !== undefined) updateData.phone = phone || null;
    if (email !== undefined) updateData.email = email || null;
    if (address !== undefined) updateData.address = address || null;
    if (profession !== undefined) updateData.profession = profession || null;
    if (status !== undefined) updateData.status = status;
    if (notes !== undefined) updateData.notes = notes || null;
    if (lead_source !== undefined) updateData.lead_source = lead_source || 'Other';
    if (lead_category !== undefined) {
        updateData.lead_category = (lead_category && VALID_CATEGORIES.includes(lead_category)) ? lead_category : null;
    }

    // Handle photo upload
    if (req.file) {
        try {
            const result = await uploadSingle(req.file, 's3');
            updateData.photo_url = result.secure_url;
        } catch (err) {
            console.error('Lead photo upload error:', err);
        }
    }
    // Allow removing photo
    if (req.body.remove_photo === 'true') {
        updateData.photo_url = null;
    }

    // Only ADMIN/OWNER can reassign via update
    if (assigned_to !== undefined && (req.user.role === 'ADMIN' || req.user.role === 'OWNER')) {
        const newAssignedTo = (assigned_to === '' || assigned_to === null) ? null : assigned_to;
        if (newAssignedTo !== existingLead.assigned_to) {
            updateData.assigned_to = newAssignedTo;
            if (newAssignedTo) {
                await pool.query(
                    `INSERT INTO lead_assignments (lead_id, assigned_from, assigned_to, assigned_by, reason)
                     VALUES ($1, $2, $3, $4, $5)`,
                    [id, existingLead.assigned_to, newAssignedTo, req.user.id, 'Reassigned by admin']
                );
            }
        }
    }

    const updatedLead = await leadModel.update(id, updateData, pool);

    // Sync name/phone/status/category back to the linked contact (if any)
    const contactSyncFields = {};
    if (updateData.name) contactSyncFields.name = updateData.name;
    if (updateData.phone) contactSyncFields.phone = updateData.phone;
    if (updateData.status !== undefined) contactSyncFields.status = updateData.status;
    if (updateData.lead_category !== undefined) contactSyncFields.lead_category = updateData.lead_category;
    if (Object.keys(contactSyncFields).length > 0) {
        const setCols = Object.keys(contactSyncFields).map((k, i) => `${k} = $${i + 1}`).join(', ');
        const vals = [...Object.values(contactSyncFields), id];
        await pool.query(
            `UPDATE contacts SET ${setCols}, updated_at = NOW() WHERE converted_lead_id = $${vals.length}`,
            vals
        );
        bustCache('cache:*:/api/contacts*');
    }

    bustLeadCache();

    res.json({
        success: true,
        message: 'Lead updated successfully',
        lead: updatedLead
    });
});

// ============================================================
// DELETE LEAD
// ============================================================
export const deleteLead = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const siteId = await getSiteId(req.user.id, req.user);

    const existingLead = await leadModel.findById(id, pool);
    if (!existingLead || existingLead.site_id !== siteId) {
        return res.status(404).json({ success: false, message: 'Lead not found' });
    }

    await leadModel.delete(id, pool);
    bustLeadCache();

    res.json({ success: true, message: 'Lead deleted successfully' });
});

// ============================================================
// ASSIGN LEAD — any user can assign their own lead to another
// ============================================================
export const assignLead = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { assigned_to, reason } = req.body;

    if (!assigned_to) {
        return res.status(400).json({ success: false, message: 'assigned_to is required' });
    }

    const siteId = await getSiteId(req.user.id, req.user);
    const lead = await leadModel.findById(id, pool);

    if (!lead || lead.site_id !== siteId) {
        return res.status(404).json({ success: false, message: 'Lead not found' });
    }

    const isAdminOrOwner = req.user.role === 'ADMIN' || req.user.role === 'OWNER';
    if (!isAdminOrOwner && lead.owner_id !== req.user.id && lead.assigned_to !== req.user.id) {
        return res.status(403).json({ success: false, message: 'Not authorized to assign this lead' });
    }

    const targetUser = await userModel.findById(assigned_to, pool);
    if (!targetUser || targetUser.site_id !== siteId) {
        return res.status(404).json({ success: false, message: 'Target user not found in this site' });
    }

    const previousAssignedTo = lead.assigned_to;
    await leadModel.update(id, { assigned_to }, pool);

    await pool.query(
        `INSERT INTO lead_assignments (lead_id, assigned_from, assigned_to, assigned_by, reason)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, previousAssignedTo, assigned_to, req.user.id, reason || null]
    );

    bustLeadCache();

    res.json({
        success: true,
        message: `Lead assigned to ${targetUser.name} successfully`,
    });
});

// ============================================================
// BULK ASSIGN LEADS
// ============================================================
export const bulkAssignLeads = asyncHandler(async (req, res) => {
    const { lead_ids, assigned_to, reason } = req.body;

    if (!lead_ids?.length || !assigned_to) {
        return res.status(400).json({ success: false, message: 'lead_ids and assigned_to are required' });
    }

    const siteId = await getSiteId(req.user.id, req.user);
    const targetUser = await userModel.findById(assigned_to, pool);
    if (!targetUser || targetUser.site_id !== siteId) {
        return res.status(404).json({ success: false, message: 'Target user not found' });
    }

    const isAdminOrOwner = req.user.role === 'ADMIN' || req.user.role === 'OWNER';
    let assignedCount = 0;

    for (const leadId of lead_ids) {
        const lead = await leadModel.findById(leadId, pool);
        if (!lead || lead.site_id !== siteId) continue;
        if (!isAdminOrOwner && lead.owner_id !== req.user.id && lead.assigned_to !== req.user.id) continue;

        const previousAssignedTo = lead.assigned_to;
        await leadModel.update(leadId, { assigned_to }, pool);
        await pool.query(
            `INSERT INTO lead_assignments (lead_id, assigned_from, assigned_to, assigned_by, reason)
             VALUES ($1, $2, $3, $4, $5)`,
            [leadId, previousAssignedTo, assigned_to, req.user.id, reason || 'Bulk assignment']
        );
        assignedCount++;
    }

    bustLeadCache();

    res.json({
        success: true,
        message: `${assignedCount} leads assigned to ${targetUser.name}`,
        assignedCount,
    });
});

// ============================================================
// GET ASSIGNMENT HISTORY FOR A LEAD
// ============================================================
export const getLeadAssignmentHistory = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const siteId = await getSiteId(req.user.id, req.user);
    const lead = await leadModel.findById(id, pool);

    if (!lead || lead.site_id !== siteId) {
        return res.status(404).json({ success: false, message: 'Lead not found' });
    }

    const history = await leadModel.getAssignmentHistory(id, pool);
    res.json({ success: true, history });
});

// ============================================================
// GET ALL ASSIGNMENT HISTORY
// ============================================================
export const getAllAssignmentHistory = asyncHandler(async (req, res) => {
    const siteId = await getSiteId(req.user.id, req.user);
    if (!siteId) {
        return res.status(404).json({ success: false, message: 'No site assigned' });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const filters = { search: req.query.search };

    if (req.user.role === 'AGENT' || req.user.role === 'TEAM_HEAD') {
        filters.user_id = req.user.id;
    } else if (req.query.user_id) {
        filters.user_id = req.query.user_id;
    }

    const result = await leadModel.getAllAssignmentHistory(siteId, filters, page, limit, pool);

    res.json({
        success: true,
        history: result.items,
        pagination: result.pagination,
    });
});

// ============================================================
// GET ASSIGNABLE USERS (for dropdowns)
// ============================================================
export const getAssignableUsers = asyncHandler(async (req, res) => {
    const siteId = await getSiteId(req.user.id, req.user);
    if (!siteId) {
        return res.status(404).json({ success: false, message: 'No site assigned' });
    }

    const result = await pool.query(
        `SELECT id, name, email, role, phone FROM users
         WHERE site_id = $1 AND role IN ('AGENT', 'TEAM_HEAD', 'ADMIN', 'OWNER') AND is_active = true
         ORDER BY
            CASE role WHEN 'OWNER' THEN 1 WHEN 'ADMIN' THEN 2 WHEN 'TEAM_HEAD' THEN 3 WHEN 'AGENT' THEN 4 END,
            name ASC`,
        [siteId]
    );

    res.json({ success: true, users: result.rows });
});

// ============================================================
// GET LEAD FULL DETAILS (lead + call history + followups)
// ============================================================
export const getLeadFullDetails = asyncHandler(async (req, res) => {
    const siteId = await getSiteId(req.user.id, req.user);
    if (!siteId) {
        return res.status(404).json({ success: false, message: 'No site assigned' });
    }

    const lead = await leadModel.findById(req.params.id, pool);
    if (!lead || lead.site_id !== siteId) {
        return res.status(404).json({ success: false, message: 'Lead not found' });
    }

    if ((req.user.role === 'AGENT' || req.user.role === 'TEAM_HEAD') &&
        lead.owner_id !== req.user.id && lead.assigned_to !== req.user.id) {
        return res.status(403).json({ success: false, message: 'Not authorized to view this lead' });
    }

    const assignee = lead.assigned_to ? await userModel.findById(lead.assigned_to, pool) : null;
    const owner = lead.owner_id ? await userModel.findById(lead.owner_id, pool) : null;

    // Get call history
    const calls = await callModel.findByLead(req.params.id, pool);

    // Get followups/appointments
    const followupsResult = await pool.query(
        `SELECT f.*, u_agent.name as agent_name, co.label as outcome_label
         FROM followups f
         LEFT JOIN users u_agent ON f.assigned_to = u_agent.id
         LEFT JOIN calls c ON f.call_id = c.id
         LEFT JOIN call_outcomes co ON c.outcome_id = co.id
         WHERE f.lead_id = $1
         ORDER BY f.scheduled_at DESC`,
        [req.params.id]
    );

    res.json({
        success: true,
        lead: {
            ...lead,
            assigned_to_name: assignee ? assignee.name : null,
            owner_name: owner ? owner.name : null,
        },
        calls,
        followups: followupsResult.rows,
    });
});

// ============================================================
// BULK UPLOAD LEADS (Excel) — optimized with multi-row INSERT
// ============================================================
export const bulkUploadLeads = asyncHandler(async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, message: 'No Excel file uploaded' });
    }

    await ensureImportBatchColumns();

    const filePath = req.file.path;

    const siteId = await getSiteId(req.user.id, req.user);
    if (!siteId) {
        try { fs.unlinkSync(filePath); } catch { }
        return res.status(404).json({ success: false, message: 'No site assigned to this user' });
    }

    let workbook;
    try {
        const buffer = fs.readFileSync(filePath);
        workbook = xlsxRead(buffer, { type: 'buffer' });
    } catch (err) {
        console.error(`[BulkUpload] Parse error:`, err.message);
        return res.status(400).json({
            success: false,
            message: 'Could not parse file. Please upload a valid .xlsx or .csv file',
        });
    } finally {
        try { fs.unlinkSync(filePath); } catch { }
    }

    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
        return res.status(400).json({ success: false, message: 'Excel file has no sheets' });
    }

    const sheet = workbook.Sheets[sheetName];
    const rows = xlsxUtils.sheet_to_json(sheet, { defval: '' });

    if (!rows.length) {
        return res.status(400).json({ success: false, message: 'Excel file is empty or has no data rows' });
    }

    const normalise = (key) => key.toLowerCase().replace(/[\s_*()\[\]#@!?:;,.-]/g, '');
    const validatedLeads = [];
    const invalidRows = [];

    rows.forEach((rawRow, i) => {
        const row = {};
        for (const [k, v] of Object.entries(rawRow)) {
            row[normalise(k)] = String(v ?? '').trim();
        }

        const name = row['name'] || row['fullname'] || row['leadname'] || '';
        const phone = row['phone'] || row['mobile'] || row['contact'] || row['phonenumber'] || '';

        if (!phone) { invalidRows.push({ row: i + 2, reason: 'Phone is required', data: rawRow }); return; }

        const statusRaw = (row['status'] || '').toUpperCase();
        const status = VALID_STATUSES.includes(statusRaw) ? statusRaw : 'NEW';

        validatedLeads.push({
            name: name || 'Unknown',
            phone,
            email: row['email'] || row['emailaddress'] || null,
            address: row['address'] || row['location'] || null,
            profession: row['profession'] || row['occupation'] || null,
            status,
            notes: row['notes'] || row['remarks'] || row['comment'] || null,
        });
    });

    if (!validatedLeads.length) {
        return res.status(400).json({
            success: false,
            message: 'No valid rows found. Phone is required for every row.',
            invalidRows: invalidRows.slice(0, 20),
        });
    }

    const { rows: [job] } = await pool.query(
        `INSERT INTO bulk_import_jobs (site_id, created_by, status, total_rows, processed_rows, failed_rows)
         VALUES ($1, $2, 'QUEUED', $3, 0, 0)
         RETURNING id`,
        [siteId, req.user.id, validatedLeads.length]
    );
    const jobId = job.id;

    leadImportQueue.enqueue(() =>
        processLeadBulkJob(jobId, validatedLeads, siteId, req.user.id)
    );

    console.log(`[BulkLeads] Job ${jobId} enqueued — ${validatedLeads.length} rows. Queue depth: ${leadImportQueue.size}`);
    bustLeadCache();

    res.status(202).json({
        success: true,
        message: `${validatedLeads.length} leads queued for import`,
        jobId,
        totalRows: rows.length,
        validCount: validatedLeads.length,
        invalidCount: invalidRows.length,
        invalidRows: invalidRows.slice(0, 20),
    });
});

// ============================================================
// Background Processor — multi-row INSERT batches for speed
// ============================================================
async function processLeadBulkJob(jobId, leads, siteId, createdByUserId) {
    console.log(`[BulkLeads] Starting job ${jobId} — ${leads.length} leads`);

    await pool.query(
        `UPDATE bulk_import_jobs SET status = 'PROCESSING', started_at = NOW() WHERE id = $1`,
        [jobId]
    );

    let processedCount = 0;
    let failedCount = 0;
    const failedDetails = [];

    const BATCH_SIZE = 50;
    for (let i = 0; i < leads.length; i += BATCH_SIZE) {
        const batch = leads.slice(i, i + BATCH_SIZE);
        const values = [];
        const placeholders = [];
        let pIdx = 1;

        for (const lead of batch) {
            placeholders.push(
                `($${pIdx++},$${pIdx++},$${pIdx++},$${pIdx++},$${pIdx++},$${pIdx++},$${pIdx++},$${pIdx++},$${pIdx++},$${pIdx++},$${pIdx++},NOW(),NOW())`
            );
            values.push(
                lead.name,
                lead.phone || null,
                lead.email || null,
                lead.address || null,
                lead.profession || null,
                lead.status || 'NEW',
                siteId,
                createdByUserId,
                createdByUserId, // owner_id = uploader
                lead.notes || null,
                jobId,
            );
        }

        try {
            await pool.query(
                `INSERT INTO leads
                   (name, phone, email, address, profession, status, site_id, created_by, owner_id, notes, import_job_id, created_at, updated_at)
                 VALUES ${placeholders.join(',')}`,
                values
            );
            processedCount += batch.length;
        } catch (batchErr) {
            // Fallback: row-by-row to identify failures
            for (let j = 0; j < batch.length; j++) {
                const lead = batch[j];
                const rowNumber = i + j + 2;
                try {
                    await pool.query(
                        `INSERT INTO leads
                           (name, phone, email, address, profession, status, site_id, created_by, owner_id, notes, import_job_id, created_at, updated_at)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW())`,
                        [
                            lead.name, lead.phone || null, lead.email || null,
                            lead.address || null, lead.profession || null,
                            lead.status || 'NEW', siteId, createdByUserId, createdByUserId,
                            lead.notes || null, jobId,
                        ]
                    );
                    processedCount++;
                } catch (err) {
                    failedCount++;
                    failedDetails.push({
                        row: rowNumber, name: lead.name, phone: lead.phone,
                        error: err.message.substring(0, 120),
                    });
                }
            }
        }

        await pool.query(
            `UPDATE bulk_import_jobs
             SET processed_rows = $1, failed_rows = $2, failed_details = $3, updated_at = NOW()
             WHERE id = $4`,
            [processedCount, failedCount, JSON.stringify(failedDetails), jobId]
        );
    }

    await pool.query(
        `UPDATE bulk_import_jobs
         SET status = 'COMPLETED', completed_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [jobId]
    );

    console.log(`[BulkLeads] Job ${jobId} done — ${processedCount} inserted, ${failedCount} failed`);
}

// ============================================================
// BULK UPLOAD JOB STATUS
// ============================================================
export const getBulkJobStatus = asyncHandler(async (req, res) => {
    const { jobId } = req.params;

    const result = await pool.query(
        `SELECT id, status, total_rows, processed_rows, failed_rows, failed_details,
                error_message, started_at, completed_at, created_at
         FROM bulk_import_jobs WHERE id = $1`,
        [jobId]
    );

    if (!result.rows.length) {
        return res.status(404).json({ success: false, message: 'Job not found' });
    }

    const job = result.rows[0];
    const percent = job.total_rows > 0
        ? Math.round((job.processed_rows / job.total_rows) * 100)
        : 0;

    res.json({
        success: true,
        jobId: job.id,
        status: job.status,
        totalRows: job.total_rows,
        processedRows: job.processed_rows,
        failedRows: job.failed_rows,
        percent,
        failedDetails: job.failed_details || [],
        errorMessage: job.error_message,
        startedAt: job.started_at,
        completedAt: job.completed_at,
    });
});

// ============================================================
// IMPORT BATCHES — list + rename
// ------------------------------------------------------------
// Lists recent bulk import jobs for the caller's site so the UI can show a
// dropdown of "Import 1 · Apr 18", "Import 2 · Apr 19", etc. and filter leads
// by the selected batch. Labels default to "Import N" (most-recent = 1) and
// can be renamed via PATCH so the agent can give batches meaningful names.
// ============================================================
export const listImportBatches = asyncHandler(async (req, res) => {
    await ensureImportBatchColumns();

    const siteId = await getSiteId(req.user.id, req.user);
    if (!siteId) {
        return res.status(404).json({ success: false, message: 'No site assigned' });
    }

    const isAgentScoped = (req.user.role === 'AGENT' || req.user.role === 'TEAM_HEAD');
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);

    // Only surface jobs that still have leads the caller can see.
    const leadScopeClauses = ['l.import_job_id = j.id', 'l.site_id = $1'];
    const params = [siteId];
    let p = 2;

    if (isAgentScoped) {
        leadScopeClauses.push(`(l.owner_id = $${p} OR l.assigned_to = $${p})`);
        params.push(req.user.id);
        p++;
    }

    const { rows } = await pool.query(
        `
        SELECT j.id,
               j.label,
               j.status,
               j.total_rows,
               j.processed_rows,
               j.failed_rows,
               j.created_at,
               j.completed_at,
               COALESCE(lc.lead_count, 0)::int AS lead_count
        FROM bulk_import_jobs j
        LEFT JOIN LATERAL (
            SELECT COUNT(*)::int AS lead_count
            FROM leads l
            WHERE ${leadScopeClauses.join(' AND ')}
        ) lc ON TRUE
        WHERE j.site_id = $1
          AND COALESCE(lc.lead_count, 0) > 0
        ORDER BY j.created_at DESC
        LIMIT $${p}
        `,
        [...params, limit]
    );

    // Number newest = 1 so the default label matches the user's mental model.
    const batches = rows.map((row, idx) => ({
        id: row.id,
        label: row.label || `Import ${idx + 1}`,
        default_label: `Import ${idx + 1}`,
        lead_count: row.lead_count,
        total_rows: row.total_rows,
        status: row.status,
        created_at: row.created_at,
        completed_at: row.completed_at,
    }));

    res.json({ success: true, batches });
});

export const renameImportBatch = asyncHandler(async (req, res) => {
    await ensureImportBatchColumns();

    const siteId = await getSiteId(req.user.id, req.user);
    if (!siteId) {
        return res.status(404).json({ success: false, message: 'No site assigned' });
    }

    const { id } = req.params;
    const label = typeof req.body?.label === 'string' ? req.body.label.trim() : '';
    if (!label) {
        return res.status(400).json({ success: false, message: 'Label is required' });
    }
    if (label.length > 80) {
        return res.status(400).json({ success: false, message: 'Label must be 80 characters or less' });
    }

    const { rowCount } = await pool.query(
        `UPDATE bulk_import_jobs SET label = $1, updated_at = NOW() WHERE id = $2 AND site_id = $3`,
        [label, id, siteId]
    );
    if (!rowCount) {
        return res.status(404).json({ success: false, message: 'Import batch not found' });
    }

    bustLeadCache();
    res.json({ success: true, id, label });
});

// ============================================================
// SHIFT LEADS TO CALL — move leads to call queue
// ============================================================
const ensureShiftToCallTable = async (db) => {
    await db.query(`
        CREATE TABLE IF NOT EXISTS shift_to_call_queue (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
            contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
            lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
            queued_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'CALLED', 'REMOVED')),
            queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            called_at TIMESTAMPTZ,
            last_call_id UUID REFERENCES calls(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT uq_shift_to_call UNIQUE (site_id, contact_id, queued_by),
            CONSTRAINT uq_shift_to_call_lead UNIQUE (site_id, lead_id, queued_by)
        );
    `);

    // Ensure contact_id is nullable (in case table was created with NOT NULL by contact.controller.js)
    try {
        await db.query('ALTER TABLE shift_to_call_queue ALTER COLUMN contact_id DROP NOT NULL');
    } catch (err) {
        // Column might already be nullable, ignore error
    }

    await db.query('CREATE INDEX IF NOT EXISTS idx_shift_to_call_site_status ON shift_to_call_queue(site_id, status, queued_by)');
    await db.query('CREATE INDEX IF NOT EXISTS idx_shift_to_call_lead ON shift_to_call_queue(lead_id)');
};

export const shiftLeadsToCall = asyncHandler(async (req, res) => {
    const siteId = await getSiteId(req.user.id, req.user);
    if (!siteId) return res.status(404).json({ success: false, message: 'No site assigned' });

    const { lead_ids = [], select_all = false, search = '', status = '', lead_category = '' } = req.body || {};

    if (!select_all && (!Array.isArray(lead_ids) || lead_ids.length === 0)) {
        return res.status(400).json({ success: false, message: 'Select at least one lead' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await ensureShiftToCallTable(client);

        const role = req.user.role;
        const scopedToUser = role === 'AGENT' || role === 'TEAM_HEAD';

        const baseParams = [siteId];
        let where = 'WHERE l.site_id = $1';
        let idx = 2;

        if (scopedToUser) {
            where += ` AND l.assigned_to = $${idx++}`;
            baseParams.push(req.user.id);
        }

        if (select_all) {
            if (search && String(search).trim()) {
                where += ` AND (l.name ILIKE $${idx} OR l.phone ILIKE $${idx})`;
                baseParams.push(`%${String(search).trim()}%`);
                idx++;
            }
            if (status && String(status).trim()) {
                where += ` AND l.status = $${idx}`;
                baseParams.push(status);
                idx++;
            }
            if (lead_category && String(lead_category).trim()) {
                where += ` AND l.lead_category = $${idx}`;
                baseParams.push(lead_category);
                idx++;
            }
        } else {
            where += ` AND l.id = ANY($${idx}::uuid[])`;
            baseParams.push(lead_ids);
            idx++;
        }

        const leadsResult = await client.query(
            `SELECT l.id, l.name, l.phone, l.email
             FROM leads l
             ${where}
             ORDER BY l.created_at DESC`,
            baseParams
        );

        if (leadsResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'No leads found for shift' });
        }

        // Keep queue scoped to the latest shift action: any previously pending
        // entries not in current selection are marked removed.
        const selectedIds = leadsResult.rows.map((l) => l.id);
        await client.query(
            `UPDATE shift_to_call_queue
             SET status = 'REMOVED', updated_at = NOW()
             WHERE site_id = $1
               AND queued_by = $2
               AND status = 'PENDING'
               AND NOT (lead_id = ANY($3::uuid[]))`,
            [siteId, req.user.id, selectedIds]
        );

        let shiftedCount = 0;
        const shiftedItems = [];

        for (const lead of leadsResult.rows) {
            // Check if already exists and update, otherwise insert
            const existingResult = await client.query(
                `SELECT id FROM shift_to_call_queue
                 WHERE site_id = $1 AND lead_id = $2 AND queued_by = $3`,
                [siteId, lead.id, req.user.id]
            );

            let queueId;
            if (existingResult.rows[0]) {
                // Update existing entry
                queueId = existingResult.rows[0].id;
                await client.query(
                    `UPDATE shift_to_call_queue
                     SET status = 'PENDING', queued_at = NOW(), called_at = NULL, last_call_id = NULL, updated_at = NOW()
                     WHERE id = $1`,
                    [queueId]
                );
            } else {
                // Insert new entry
                const queueResult = await client.query(
                    `INSERT INTO shift_to_call_queue (site_id, contact_id, lead_id, queued_by, status, queued_at, called_at, last_call_id, updated_at)
                     VALUES ($1, NULL, $2, $3, 'PENDING', NOW(), NULL, NULL, NOW())
                     RETURNING id`,
                    [siteId, lead.id, req.user.id]
                );
                queueId = queueResult.rows[0].id;
            }

            shiftedCount++;
            shiftedItems.push({
                queue_id: queueId,
                lead_id: lead.id,
                name: lead.name,
                phone: lead.phone,
                email: lead.email,
            });
        }

        await client.query('COMMIT');

        bustLeadCache();
        bustCache('cache:*:/api/calls*');

        res.json({
            success: true,
            shifted_count: shiftedCount,
            items: shiftedItems,
            message: `${shiftedCount} lead${shiftedCount > 1 ? 's' : ''} shifted to call queue`,
        });
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
});
