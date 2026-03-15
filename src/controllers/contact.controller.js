import asyncHandler from '../utils/asyncHandler.js';
import contactModel from '../models/Contact.model.js';
import leadModel from '../models/Lead.model.js';
import userModel from '../models/User.model.js';
import pool from '../config/db.js';
import { bustCache } from '../middlewares/cache.middleware.js';
import { read as xlsxRead, utils as xlsxUtils } from 'xlsx';
import fs from 'fs';

const getSiteId = async (userId) => {
    const user = await userModel.findById(userId, pool);
    if (!user || !user.site_id) return null;
    return user.site_id;
};

const bustContactCache = () => {
    bustCache('cache:*:/api/contacts*');
};

// ============================================================
// CREATE CONTACT — single manual add
// ============================================================
export const createContact = asyncHandler(async (req, res) => {
    const { name, phone } = req.body;

    if (!name || !phone) {
        return res.status(400).json({ success: false, message: 'Name and phone are required' });
    }

    const siteId = await getSiteId(req.user.id);
    if (!siteId) return res.status(404).json({ success: false, message: 'No site assigned' });

    // Check duplicate
    const existing = await contactModel.findByPhone(siteId, phone, pool);
    if (existing) {
        return res.status(409).json({ success: false, message: 'A contact with this phone already exists' });
    }

    const contact = await contactModel.create({
        site_id: siteId,
        name: name.trim(),
        phone: phone.trim(),
        created_by: req.user.id,
    }, pool);

    bustContactCache();
    res.status(201).json({ success: true, contact });
});

// ============================================================
// GET CONTACTS — paginated list (non-converted only)
// ============================================================
export const getContacts = asyncHandler(async (req, res) => {
    const siteId = await getSiteId(req.user.id);
    if (!siteId) return res.status(404).json({ success: false, message: 'No site assigned' });

    const { page = 1, limit = 25, search } = req.query;
    const role = req.user.role;
    const scopedToUser = role === 'AGENT' || role === 'TEAM_HEAD';

    const result = await contactModel.findWithDetails(
        { site_id: siteId, search, created_by: scopedToUser ? req.user.id : undefined },
        parseInt(page),
        parseInt(limit),
        pool
    );

    res.json({ success: true, contacts: result.items, pagination: result.pagination });
});

// ============================================================
// DELETE CONTACT
// ============================================================
export const deleteContact = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const contact = await contactModel.findById(id, pool);
    if (!contact) return res.status(404).json({ success: false, message: 'Contact not found' });

    const role = req.user.role;
    if (
        (role === 'AGENT' || role === 'TEAM_HEAD') &&
        contact.created_by !== req.user.id
    ) {
        return res.status(403).json({ success: false, message: 'You can only delete your own contacts' });
    }

    await contactModel.delete(id, pool);
    bustContactCache();
    res.json({ success: true, message: 'Contact deleted' });
});

// ============================================================
// CONVERT CONTACT TO LEAD — called when making a call
// ============================================================
export const convertContactToLead = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const siteId = await getSiteId(req.user.id);
    if (!siteId) return res.status(404).json({ success: false, message: 'No site assigned' });

    const contact = await contactModel.findById(id, pool);
    if (!contact) return res.status(404).json({ success: false, message: 'Contact not found' });
    if (contact.is_converted) {
        return res.status(400).json({ success: false, message: 'Contact already converted', lead_id: contact.converted_lead_id });
    }

    // Check if a lead with this phone already exists
    const existingLead = await pool.query(
        'SELECT id FROM leads WHERE site_id = $1 AND phone = $2', [siteId, contact.phone]
    );

    let leadId;
    if (existingLead.rows.length > 0) {
        leadId = existingLead.rows[0].id;
    } else {
        const lead = await leadModel.create({
            site_id: siteId,
            name: contact.name,
            phone: contact.phone,
            status: 'NEW',
            owner_id: req.user.id,
            created_by: req.user.id,
            assigned_to: req.user.id,
        }, pool);
        leadId = lead.id;
    }

    // Mark as converted
    await contactModel.update(id, {
        is_converted: true,
        converted_lead_id: leadId,
    }, pool);

    bustContactCache();
    bustCache('cache:*:/api/leads*');

    res.json({ success: true, lead_id: leadId, message: 'Contact converted to lead' });
});

// ============================================================
// BULK UPLOAD CONTACTS — parse Excel inline (name + phone only)
// ============================================================
export const bulkUploadContacts = asyncHandler(async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, message: 'No Excel file uploaded' });
    }

    const filePath = req.file.path;

    const siteId = await getSiteId(req.user.id);
    if (!siteId) {
        try { fs.unlinkSync(filePath); } catch { }
        return res.status(404).json({ success: false, message: 'No site assigned' });
    }

    let workbook;
    try {
        const buffer = fs.readFileSync(filePath);
        workbook = xlsxRead(buffer, { type: 'buffer' });
    } catch {
        return res.status(400).json({ success: false, message: 'Could not parse file. Upload a valid .xlsx or .csv' });
    } finally {
        try { fs.unlinkSync(filePath); } catch { }
    }

    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) return res.status(400).json({ success: false, message: 'Excel file has no sheets' });

    const rows = xlsxUtils.sheet_to_json(sheet, { defval: '' });
    if (!rows.length) return res.status(400).json({ success: false, message: 'File is empty' });

    const normalise = (key) => key.toLowerCase().replace(/[\s_*()\[\]#@!?:;,.-]/g, '');

    // Create a job record
    const { rows: [job] } = await pool.query(
        `INSERT INTO contact_import_jobs (site_id, created_by, status, total_rows)
         VALUES ($1, $2, 'PROCESSING', $3) RETURNING id`,
        [siteId, req.user.id, rows.length]
    );

    let imported = 0;
    let failed = 0;
    const errors = [];

    for (let i = 0; i < rows.length; i++) {
        const rawRow = rows[i];
        const row = {};
        for (const [k, v] of Object.entries(rawRow)) {
            row[normalise(k)] = String(v ?? '').trim();
        }

        const name = row['name'] || row['fullname'] || row['contactname'] || '';
        const phone = row['phone'] || row['mobile'] || row['number'] || row['contact'] || row['phonenumber'] || '';

        if (!phone) {
            failed++;
            errors.push({ row: i + 2, reason: 'Phone is required', data: rawRow });
            continue;
        }

        try {
            const existing = await contactModel.findByPhone(siteId, phone, pool);
            // Also check leads table
            const existingLead = await pool.query('SELECT id FROM leads WHERE site_id = $1 AND phone = $2', [siteId, phone]);

            if (existing || existingLead.rows.length > 0) {
                failed++;
                errors.push({ row: i + 2, reason: 'Duplicate phone', data: rawRow });
                continue;
            }

            await contactModel.create({
                site_id: siteId,
                name: name || 'Unknown',
                phone,
                created_by: req.user.id,
            }, pool);
            imported++;
        } catch (err) {
            failed++;
            errors.push({ row: i + 2, reason: err.message, data: rawRow });
        }
    }

    await pool.query(
        `UPDATE contact_import_jobs SET status = 'COMPLETED', imported = $1, failed = $2, errors = $3, updated_at = NOW() WHERE id = $4`,
        [imported, failed, JSON.stringify(errors.slice(0, 50)), job.id]
    );

    bustContactCache();

    res.json({
        success: true,
        jobId: job.id,
        totalRows: rows.length,
        imported,
        failed,
        errors: errors.slice(0, 20),
    });
});

// ============================================================
// GET BULK JOB STATUS
// ============================================================
export const getContactJobStatus = asyncHandler(async (req, res) => {
    const { jobId } = req.params;
    const result = await pool.query('SELECT * FROM contact_import_jobs WHERE id = $1', [jobId]);
    if (!result.rows[0]) return res.status(404).json({ success: false, message: 'Job not found' });
    res.json({ success: true, job: result.rows[0] });
});
