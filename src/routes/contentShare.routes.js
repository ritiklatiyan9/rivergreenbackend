import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import upload from '../middlewares/multer.middleware.js';
import { cacheMiddleware } from '../middlewares/cache.middleware.js';
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
router.get('/', cacheMiddleware(120), getMyContents);
router.delete('/:id', deleteContent);

// Get agent's leads (lightweight — for share UI)
router.get('/leads', cacheMiddleware(60), getMyLeadsForShare);

export default router;
