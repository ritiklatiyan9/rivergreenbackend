import express from 'express';
const router = express.Router();

import {
  getFinancialSettings,
  updateFinancialSettings,
  getPublicFinancialSettings,
} from '../controllers/financialSettings.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import checkRole from '../middlewares/role.middleware.js';
import upload from '../middlewares/multer.middleware.js';
import { cacheMiddleware } from '../middlewares/cache.middleware.js';

// Public route — used by SharedPlot booking page
router.get('/public/:siteId', cacheMiddleware(1800), getPublicFinancialSettings);

// Admin routes
router.use(authMiddleware, checkRole(['ADMIN']));
router.get('/', cacheMiddleware(1800), getFinancialSettings);
router.put('/', upload.single('upi_scanner'), updateFinancialSettings);

export default router;
