import express from 'express';
const router = express.Router();

import {
    createLead,
    getLeads,
    getLeadStatusCounts,
    getMatterLeadsList,
    updateLead,
    deleteLead,
    getLead,
    getLeadFullDetails,
    bulkUploadLeads,
    getBulkJobStatus,
    listImportBatches,
    renameImportBatch,
    assignLead,
    bulkAssignLeads,
    getLeadAssignmentHistory,
    getAllAssignmentHistory,
    getAssignableUsers,
    shiftLeadsToCall,
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

import upload from '../middlewares/multer.middleware.js';
import { cacheMiddleware } from '../middlewares/cache.middleware.js';

// ── All routes require auth ──────────────────────────────────────────────────
router.use(authMiddleware);

// CRUD
router.post('/', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN', 'OWNER']), upload.single('photo'), createLead);
router.get('/', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN', 'OWNER']), cacheMiddleware(120), getLeads);

// Static routes BEFORE :id
router.get('/counts', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN', 'OWNER']), cacheMiddleware(60), getLeadStatusCounts);
router.get('/matter', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN', 'OWNER']), cacheMiddleware(60), getMatterLeadsList);
router.get('/assignable-users', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN', 'OWNER']), cacheMiddleware(300), getAssignableUsers);
router.get('/assignment-history', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN', 'OWNER']), cacheMiddleware(120), getAllAssignmentHistory);
router.post('/bulk-assign', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN', 'OWNER']), bulkAssignLeads);
router.post('/shift-to-call', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN', 'OWNER']), shiftLeadsToCall);

// Import batches — list + rename (used by Fresh Leads stage dropdown)
router.get(
    '/import-batches',
    checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN', 'OWNER']),
    cacheMiddleware(30),
    listImportBatches
);
router.patch(
    '/import-batches/:id',
    checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN', 'OWNER']),
    renameImportBatch
);

// Single lead routes
router.get('/:id/full', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN', 'OWNER']), cacheMiddleware(120), getLeadFullDetails);
router.get('/:id', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN', 'OWNER']), cacheMiddleware(120), getLead);
router.put('/:id', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN', 'OWNER']), upload.single('photo'), updateLead);
router.delete('/:id', checkRole(['TEAM_HEAD', 'ADMIN', 'OWNER']), deleteLead);
router.post('/:id/assign', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN', 'OWNER']), assignLead);
router.get('/:id/assignment-history', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN', 'OWNER']), cacheMiddleware(120), getLeadAssignmentHistory);

// Bulk import
router.post(
    '/bulk/upload',
    checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN', 'OWNER']),
    excelUpload.single('file'),
    bulkUploadLeads
);
router.get(
    '/bulk/status/:jobId',
    checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN', 'OWNER']),
    cacheMiddleware(15),
    getBulkJobStatus
);

export default router;

