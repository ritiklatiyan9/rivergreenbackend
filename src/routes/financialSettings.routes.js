import express from 'express';
const router = express.Router();

import {
  getFinancialSettings,
  listFinancialSettings,
  updateFinancialSettings,
  getPublicFinancialSettings,
} from '../controllers/financialSettings.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import checkRole from '../middlewares/role.middleware.js';
import upload from '../middlewares/multer.middleware.js';
import { cacheMiddleware } from '../middlewares/cache.middleware.js';

// Public route — used by SharedPlot booking page and per-colony website maps
router.get('/public/:siteId', cacheMiddleware(1800), getPublicFinancialSettings);

// Admin routes
router.use(authMiddleware, checkRole(['ADMIN']));
router.get('/list', cacheMiddleware(120), listFinancialSettings);
router.get('/', cacheMiddleware(120), getFinancialSettings);
// PUT accepts two image fields: the existing UPI scanner, plus a per-colony
// hero image saved as `site_financial_settings.colony_image_url`.
router.put(
  '/',
  upload.fields([
    { name: 'upi_scanner', maxCount: 1 },
    { name: 'colony_image', maxCount: 1 },
  ]),
  updateFinancialSettings,
);

export default router;
