import express from 'express';
const router = express.Router();

import { uploadSingle, uploadMany } from '../utils/upload.js';
import upload from '../middlewares/multer.middleware.js';

router.post('/single', upload.single('file'), async (req, res) => {
  try {
    const { provider = 's3' } = req.query;
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
    const result = await uploadSingle(req.file, provider);
    res.json({ success: true, url: result.secure_url, public_id: result.public_id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Upload failed', error: err.message });
  }
});

router.post('/many', upload.array('files'), async (req, res) => {
  try {
    const { provider = 's3' } = req.query;
    if (!req.files || req.files.length === 0) return res.status(400).json({ success: false, message: 'No files uploaded' });
    const results = await uploadMany(req.files, provider);
    const urls = results.map(r => r.secure_url);
    const public_ids = results.map(r => r.public_id);
    res.json({ success: true, urls, public_ids });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Upload failed', error: err.message });
  }
});

export default router;