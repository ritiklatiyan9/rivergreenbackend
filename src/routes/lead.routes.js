import express from 'express';
const router = express.Router();

import {
    createLead,
    getLeads,
    updateLead,
    deleteLead,
    getLead,
    bulkUploadLeads,
    getBulkJobStatus,
} from '../controllers/lead.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import checkRole from '../middlewares/role.middleware.js';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsDir = path.join(__dirname, '..', 'uploads');

// Ensure uploads directory exists
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// ── Excel upload multer ──────────────────────────────────────────────────────
const excelStorage = multer.diskStorage({
    destination: uploadsDir,
    filename: (req, file, cb) => cb(null, `bulk-leads-${Date.now()}${path.extname(file.originalname)}`),
});

const excelFilter = (req, file, cb) => {
    const allowed = /xlsx|xls|csv/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = /spreadsheet|excel|csv|text\/csv|officedocument/.test(file.mimetype);
    if (ext || mime) return cb(null, true);
    cb(new Error('Only Excel (.xlsx, .xls) and CSV files are allowed'));
};

const excelUpload = multer({
    storage: excelStorage,
    limits: { fileSize: 10 * 1024 * 1024 },   // 10 MB
    fileFilter: excelFilter,
});

// ── All routes require auth ──────────────────────────────────────────────────
router.use(authMiddleware);

// CRUD
router.post('/', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN', 'OWNER']), createLead);
router.get('/', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN', 'OWNER']), getLeads);
router.get('/:id', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN', 'OWNER']), getLead);
router.put('/:id', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN', 'OWNER']), updateLead);
router.delete('/:id', checkRole(['TEAM_HEAD', 'ADMIN', 'OWNER']), deleteLead);

// Bulk import
router.post(
    '/bulk/upload',
    checkRole(['TEAM_HEAD', 'ADMIN', 'OWNER']),
    excelUpload.single('file'),
    bulkUploadLeads
);
router.get(
    '/bulk/status/:jobId',
    checkRole(['TEAM_HEAD', 'ADMIN', 'OWNER']),
    getBulkJobStatus
);

export default router;

