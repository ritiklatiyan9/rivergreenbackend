import asyncHandler from '../utils/asyncHandler.js';
import leadModel from '../models/Lead.model.js';
import userModel from '../models/User.model.js';
import pool from '../config/db.js';
import { bustCache } from '../middlewares/cache.middleware.js';
import { read as xlsxRead, utils as xlsxUtils } from 'xlsx';
import fs from 'fs';
import { leadImportQueue } from '../utils/jobQueue.js';

const VALID_STATUSES = ['NEW', 'CONTACTED', 'INTERESTED', 'SITE_VISIT', 'NEGOTIATION', 'BOOKED', 'LOST'];

// Helper to get site_id safely
const getSiteId = async (userId) => {
    const user = await userModel.findById(userId, pool);
    return user?.site_id;
};

// ============================================================
// LOG LEAD
// ============================================================
export const createLead = asyncHandler(async (req, res) => {
    const { name, phone, email, status, assigned_to, notes } = req.body;

    if (!name || (!phone && !email)) {
        return res.status(400).json({ success: false, message: 'Name and either phone or email are required' });
    }

    const siteId = await getSiteId(req.user.id);
    if (!siteId) {
        return res.status(404).json({ success: false, message: 'No site assigned to this user' });
    }

    const leadData = {
        site_id: siteId,
        name,
        phone: phone || null,
        email: email || null,
        address: req.body.address || null,
        profession: req.body.profession || null,
        status: status || 'NEW',
        assigned_to: assigned_to || req.user.id,
        created_by: req.user.id,
        notes: notes || null,
    };

    const newLead = await leadModel.create(leadData, pool);

    // Bust cache related to leads and calls
    bustCache('cache:*:/api/leads*');
    bustCache('cache:*:/api/site/leads*');

    res.status(201).json({
        success: true,
        message: 'Lead created successfully',
        lead: newLead
    });
});

// ============================================================
// GET LEADS (Paginated & Filtered)
// ============================================================
export const getLeads = asyncHandler(async (req, res) => {
    const siteId = await getSiteId(req.user.id);
    if (!siteId) {
        return res.status(404).json({ success: false, message: 'No site assigned' });
    }

    const page = parseInt(req.query.page) || 1;
    let limit = parseInt(req.query.limit) || 15;

    if (req.query.limit === 'all') {
        limit = -1;
    }

    const filters = {
        site_id: siteId,
        status: req.query.status,
        search: req.query.search
    };

    // Role-based filtering
    if (req.user.role === 'AGENT') {
        filters.assigned_to = req.user.id;
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
    const siteId = await getSiteId(req.user.id);
    if (!siteId) {
        return res.status(404).json({ success: false, message: 'No site assigned' });
    }

    const lead = await leadModel.findById(req.params.id, pool);

    if (!lead || lead.site_id !== siteId) {
        return res.status(404).json({ success: false, message: 'Lead not found' });
    }

    // Optional: Get assignee details manually if needed, or just return lead
    // since we mainly need the name, status, etc.
    const assignee = lead.assigned_to
        ? await userModel.findById(lead.assigned_to, pool)
        : null;

    res.json({
        success: true,
        lead: {
            ...lead,
            assigned_to_name: assignee ? assignee.name : null
        }
    });
});

// ============================================================
// UPDATE LEAD
// ============================================================
export const updateLead = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { name, phone, email, address, profession, status, assigned_to, notes } = req.body;

    const siteId = await getSiteId(req.user.id);
    const existingLead = await leadModel.findById(id, pool);

    if (!existingLead || existingLead.site_id !== siteId) {
        return res.status(404).json({ success: false, message: 'Lead not found' });
    }

    // Basic permission check
    if (req.user.role === 'AGENT' && existingLead.assigned_to !== req.user.id) {
        return res.status(403).json({ success: false, message: 'Not authorized to update this lead' });
    }

    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (phone !== undefined) updateData.phone = phone || null;
    if (email !== undefined) updateData.email = email || null;
    if (address !== undefined) updateData.address = address || null;
    if (profession !== undefined) updateData.profession = profession || null;
    if (status !== undefined) updateData.status = status;
    if (assigned_to !== undefined && req.user.role !== 'AGENT') {
        updateData.assigned_to = (assigned_to === '' || assigned_to === null) ? null : assigned_to;
    }
    if (notes !== undefined) updateData.notes = notes || null;

    const updatedLead = await leadModel.update(id, updateData, pool);

    bustCache('cache:*:/api/leads*');
    bustCache('cache:*:/api/site/leads*');

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
    const siteId = await getSiteId(req.user.id);

    const existingLead = await leadModel.findById(id, pool);
    if (!existingLead || existingLead.site_id !== siteId) {
        return res.status(404).json({ success: false, message: 'Lead not found' });
    }

    await leadModel.delete(id, pool);

    bustCache('cache:*:/api/leads*');
    bustCache('cache:*:/api/site/leads*');

    res.json({ success: true, message: 'Lead deleted successfully' });
});

// ============================================================
// BULK UPLOAD LEADS (Excel) - Queue-backed, PostgreSQL job tracking
// ============================================================
export const bulkUploadLeads = asyncHandler(async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, message: 'No Excel file uploaded' });
    }

    const filePath = req.file.path;

    const siteId = await getSiteId(req.user.id);
    if (!siteId) {
        try { fs.unlinkSync(filePath); } catch { }
        return res.status(404).json({ success: false, message: 'No site assigned to this user' });
    }

    // Read file into buffer and parse — avoids all path/ESM issues with readFile
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

    // Normalise column names: lowercase, strip spaces/underscores
    const normalise = (key) => key.toLowerCase().replace(/[\s_]/g, '');
    const validatedLeads = [];
    const invalidRows = [];

    rows.forEach((rawRow, i) => {
        const row = {};
        for (const [k, v] of Object.entries(rawRow)) {
            row[normalise(k)] = String(v ?? '').trim();
        }

        const name = row['name'] || row['fullname'] || row['leadname'] || '';
        const phone = row['phone'] || row['mobile'] || row['contact'] || row['phonenumber'] || '';

        if (!name) { invalidRows.push({ row: i + 2, reason: 'Name is required', data: rawRow }); return; }
        if (!phone) { invalidRows.push({ row: i + 2, reason: 'Phone is required', data: rawRow }); return; }

        const statusRaw = (row['status'] || '').toUpperCase();
        const status = VALID_STATUSES.includes(statusRaw) ? statusRaw : 'NEW';

        validatedLeads.push({
            name,
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
            message: 'No valid rows found. Name and Phone are required for every row.',
            invalidRows: invalidRows.slice(0, 20),
        });
    }

    // Create a job record in PostgreSQL
    const { rows: [job] } = await pool.query(
        `INSERT INTO bulk_import_jobs (site_id, created_by, status, total_rows, processed_rows, failed_rows)
         VALUES ($1, $2, 'QUEUED', $3, 0, 0)
         RETURNING id`,
        [siteId, req.user.id, validatedLeads.length]
    );
    const jobId = job.id;

    // Enqueue background processing — non-blocking, FIFO, no Redis needed
    leadImportQueue.enqueue(() =>
        processLeadBulkJob(jobId, validatedLeads, siteId, req.user.id)
    );

    console.log(`[BulkLeads] Job ${jobId} enqueued — ${validatedLeads.length} rows. Queue depth: ${leadImportQueue.size}`);

    bustCache('cache:*:/api/leads*');
    bustCache('cache:*:/api/site/leads*');

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
// Background Processor — called exclusively by leadImportQueue
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

    const BATCH_SIZE = 25;
    for (let i = 0; i < leads.length; i += BATCH_SIZE) {
        const batch = leads.slice(i, i + BATCH_SIZE);

        for (let j = 0; j < batch.length; j++) {
            const lead = batch[j];
            const rowNumber = i + j + 2; // +2 for header row + 0-index offset
            try {
                await pool.query(
                    `INSERT INTO leads
                       (name, phone, email, address, profession, status, site_id, created_by, notes, created_at, updated_at)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW())`,
                    [
                        lead.name,
                        lead.phone || null,
                        lead.email || null,
                        lead.address || null,
                        lead.profession || null,
                        lead.status || 'NEW',
                        siteId,
                        createdByUserId,
                        lead.notes || null,
                    ]
                );
                processedCount++;
            } catch (err) {
                failedCount++;
                failedDetails.push({
                    row: rowNumber,
                    name: lead.name,
                    phone: lead.phone,
                    error: err.message.substring(0, 120),
                });
            }
        }

        // Flush progress to DB after every batch
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



