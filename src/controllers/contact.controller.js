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

const ensureShiftToCallTable = async (db) => {
    await db.query(`
        CREATE TABLE IF NOT EXISTS shift_to_call_queue (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
            contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
            lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
            queued_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'CALLED', 'REMOVED')),
            queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            called_at TIMESTAMPTZ,
            last_call_id UUID REFERENCES calls(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT uq_shift_to_call UNIQUE (site_id, contact_id, queued_by)
        );
    `);

    await db.query('CREATE INDEX IF NOT EXISTS idx_shift_to_call_site_status ON shift_to_call_queue(site_id, status, queued_by)');
    await db.query('CREATE INDEX IF NOT EXISTS idx_shift_to_call_contact ON shift_to_call_queue(contact_id)');
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
// GET CONTACTS — paginated list (includes converted and non-converted)
// ============================================================
export const getContacts = asyncHandler(async (req, res) => {
    const siteId = await getSiteId(req.user.id);
    if (!siteId) return res.status(404).json({ success: false, message: 'No site assigned' });

    const { page = 1, limit = 25, search, status, lead_category } = req.query;
    const role = req.user.role;
    const scopedToUser = role === 'AGENT' || role === 'TEAM_HEAD';

    const result = await contactModel.findWithDetails(
        {
            site_id: siteId,
            search,
            created_by: scopedToUser ? req.user.id : undefined,
            status: status || undefined,
            lead_category: lead_category || undefined,
        },
        parseInt(page),
        parseInt(limit),
        pool
    );

    res.json({ success: true, contacts: result.items, pagination: result.pagination });
});

// ============================================================
// DELETE CONTACT
// ============================================================
// ============================================================
// UPDATE CONTACT — edit name / phone
// ============================================================
export const updateContact = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { name, phone, status, lead_category } = req.body;

    if (!name?.trim() || !phone?.trim()) {
        return res.status(400).json({ success: false, message: 'Name and phone are required' });
    }

    const contact = await contactModel.findById(id, pool);
    if (!contact) return res.status(404).json({ success: false, message: 'Contact not found' });

    const role = req.user.role;
    if ((role === 'AGENT' || role === 'TEAM_HEAD') && contact.created_by !== req.user.id) {
        return res.status(403).json({ success: false, message: 'You can only edit your own contacts' });
    }

    // Check duplicate phone on a different contact
    if (phone.trim() !== contact.phone) {
        const duplicate = await contactModel.findByPhone(contact.site_id, phone.trim(), pool);
        if (duplicate && duplicate.id !== id) {
            return res.status(409).json({ success: false, message: 'A contact with this phone already exists' });
        }
    }

    const updateData = { name: name.trim(), phone: phone.trim() };
    if (status !== undefined) updateData.status = status;
    if (lead_category !== undefined) updateData.lead_category = lead_category;

    const updated = await contactModel.update(id, updateData, pool);

    // Sync name/phone to the linked lead (if contact was converted)
    if (contact.converted_lead_id) {
        const leadSync = { name: name.trim(), phone: phone.trim() };
        if (status !== undefined) leadSync.status = status;
        if (lead_category !== undefined) leadSync.lead_category = lead_category;
        const setCols = Object.keys(leadSync).map((k, i) => `${k} = $${i + 1}`).join(', ');
        const vals = [...Object.values(leadSync), contact.converted_lead_id];
        await pool.query(
            `UPDATE leads SET ${setCols}, updated_at = NOW() WHERE id = $${vals.length}`,
            vals
        );
        bustCache('cache:*:/api/followups*');
        bustCache('cache:*:/api/leads*');
    }

    bustContactCache();
    res.json({ success: true, contact: updated });
});

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
        return res.json({ success: true, lead_id: contact.converted_lead_id, message: 'Contact already converted to lead' });
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

    // Mark as converted and set initial status from lead
    const leadForStatus = existingLead.rows.length > 0
        ? (await pool.query('SELECT status, lead_category FROM leads WHERE id = $1', [leadId])).rows[0]
        : null;
    await contactModel.update(id, {
        is_converted: true,
        converted_lead_id: leadId,
        status: leadForStatus?.status || 'NEW',
        lead_category: leadForStatus?.lead_category || null,
    }, pool);

    bustContactCache();
    bustCache('cache:*:/api/leads*');

    res.json({ success: true, lead_id: leadId, message: 'Contact converted to lead' });
});

// ============================================================
// SHIFT CONTACTS TO CALL QUEUE
// ============================================================
export const shiftContactsToCall = asyncHandler(async (req, res) => {
    const siteId = await getSiteId(req.user.id);
    if (!siteId) return res.status(404).json({ success: false, message: 'No site assigned' });

    const { contact_ids = [], select_all = false, search = '' } = req.body || {};

    if (!select_all && (!Array.isArray(contact_ids) || contact_ids.length === 0)) {
        return res.status(400).json({ success: false, message: 'Select at least one contact' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await ensureShiftToCallTable(client);

        const role = req.user.role;
        const scopedToUser = role === 'AGENT' || role === 'TEAM_HEAD';

        const baseParams = [siteId];
        let where = 'WHERE c.site_id = $1';
        let idx = 2;

        if (scopedToUser) {
            where += ` AND c.created_by = $${idx++}`;
            baseParams.push(req.user.id);
        }

        if (select_all) {
            if (search && String(search).trim()) {
                where += ` AND (c.name ILIKE $${idx} OR c.phone ILIKE $${idx})`;
                baseParams.push(`%${String(search).trim()}%`);
                idx++;
            }
        } else {
            where += ` AND c.id = ANY($${idx}::uuid[])`;
            baseParams.push(contact_ids);
            idx++;
        }

        const contactsResult = await client.query(
            `SELECT c.id, c.name, c.phone, c.is_converted, c.converted_lead_id
             FROM contacts c
             ${where}
             ORDER BY c.created_at DESC`,
            baseParams
        );

        if (contactsResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'No contacts found for shift' });
        }

        // Keep queue scoped to the latest shift action: any previously pending
        // entries not in current selection are marked removed.
        const selectedIds = contactsResult.rows.map((c) => c.id);
        await client.query(
            `UPDATE shift_to_call_queue
             SET status = 'REMOVED', updated_at = NOW()
             WHERE site_id = $1
               AND queued_by = $2
               AND status = 'PENDING'
               AND NOT (contact_id = ANY($3::uuid[]))`,
            [siteId, req.user.id, selectedIds]
        );

        let shiftedCount = 0;
        const shiftedItems = [];

        for (const contact of contactsResult.rows) {
            let leadId = contact.converted_lead_id;

            if (!leadId) {
                const existingLead = await client.query(
                    'SELECT id FROM leads WHERE site_id = $1 AND phone = $2 LIMIT 1',
                    [siteId, contact.phone]
                );

                if (existingLead.rows[0]) {
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
                    }, client);
                    leadId = lead.id;
                }
            }

            const queueResult = await client.query(
                `INSERT INTO shift_to_call_queue (site_id, contact_id, lead_id, queued_by, status, queued_at, called_at, last_call_id, updated_at)
                 VALUES ($1, $2, $3, $4, 'PENDING', NOW(), NULL, NULL, NOW())
                 ON CONFLICT (site_id, contact_id, queued_by)
                 DO UPDATE SET
                    lead_id = EXCLUDED.lead_id,
                    status = 'PENDING',
                    queued_at = NOW(),
                    called_at = NULL,
                    last_call_id = NULL,
                    updated_at = NOW()
                 RETURNING id`,
                [siteId, contact.id, leadId, req.user.id]
            );

            shiftedCount++;
            shiftedItems.push({
                queue_id: queueResult.rows[0].id,
                contact_id: contact.id,
                lead_id: leadId,
                name: contact.name,
                phone: contact.phone,
            });
        }

        await client.query('COMMIT');

        bustContactCache();
        bustCache('cache:*:/api/leads*');
        bustCache('cache:*:/api/calls*');

        res.json({
            success: true,
            shifted_count: shiftedCount,
            items: shiftedItems,
            message: `${shiftedCount} contact${shiftedCount > 1 ? 's' : ''} shifted to call queue`,
        });
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
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
