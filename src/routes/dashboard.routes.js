import express from 'express';
const router = express.Router();

import {
  getDashboardStats,
  getConversionFunnel,
  getTeamPerformance,
} from '../controllers/dashboard.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import checkRole from '../middlewares/role.middleware.js';
import { cacheMiddleware } from '../middlewares/cache.middleware.js';

// All dashboard routes require authentication
router.use(authMiddleware);

// Main dashboard stats (consolidated)
router.get('/stats', cacheMiddleware(60), getDashboardStats);

// Conversion funnel analytics
router.get('/funnel', cacheMiddleware(60), getConversionFunnel);

// Team performance breakdown
router.get('/teams-performance', cacheMiddleware(60), checkRole(['ADMIN', 'OWNER']), getTeamPerformance);

export default router;
