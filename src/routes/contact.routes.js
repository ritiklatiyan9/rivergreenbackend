import express from 'express';
const router = express.Router();

import {
    createContact,
    getContacts,
    deleteContact,
    convertContactToLead,
    bulkUploadContacts,
    getContactJobStatus,
} from '../controllers/contact.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import checkRole from '../middlewares/role.middleware.js';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

const excelStorage = multer.diskStorage({
    destination: uploadsDir,
    filename: (req, file, cb) => cb(null, `bulk-contacts-${Date.now()}${path.extname(file.originalname)}`),
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
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: excelFilter,
});

router.use(authMiddleware);

router.post('/', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN', 'OWNER']), createContact);
router.get('/', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN', 'OWNER']), getContacts);
router.delete('/:id', checkRole(['TEAM_HEAD', 'ADMIN', 'OWNER']), deleteContact);
router.post('/:id/convert', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN', 'OWNER']), convertContactToLead);
router.post('/bulk/upload', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN', 'OWNER']), excelUpload.single('file'), bulkUploadContacts);
router.get('/bulk/status/:jobId', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN', 'OWNER']), getContactJobStatus);

export default router;
