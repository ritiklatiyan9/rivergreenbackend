import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import upload from '../middlewares/multer.middleware.js';
import {
  createContent,
  getMyContents,
  deleteContent,
  getMyLeadsForShare,
} from '../controllers/contentShare.controller.js';

const router = express.Router();

router.use(authMiddleware);

// Content CRUD
router.post('/', upload.single('file'), createContent);
router.get('/', getMyContents);
router.delete('/:id', deleteContent);

// Get agent's leads (lightweight — for share UI)
router.get('/leads', getMyLeadsForShare);

export default router;
