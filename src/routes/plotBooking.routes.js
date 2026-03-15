import express from 'express';
const router = express.Router();

import {
  createBooking,
  getBookings,
  getBooking,
  updateBookingStatus,
  getBookingStats,
  agentBookPlot,
  approveBooking,
  rejectBooking,
  getPendingApprovals,
  publicBookPlot,
} from '../controllers/plotBooking.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import checkRole from '../middlewares/role.middleware.js';
import upload from '../middlewares/multer.middleware.js';
import { cacheMiddleware } from '../middlewares/cache.middleware.js';

// ── PUBLIC route (no auth) ─────────────────────────────
// Accept up to 5 screenshots
router.post('/public-book/:plotId', upload.array('screenshots', 5), publicBookPlot);

// All other booking routes require auth
router.use(authMiddleware);

// Agent booking via shared link (AGENT, TEAM_HEAD, ADMIN)
router.post('/agent-book/:plotId', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN']), agentBookPlot);

// Admin approval workflow
router.get('/pending-approvals', checkRole(['ADMIN', 'OWNER']), cacheMiddleware(60), getPendingApprovals);
router.put('/:id/approve', checkRole(['ADMIN', 'OWNER']), approveBooking);
router.put('/:id/reject', checkRole(['ADMIN', 'OWNER']), rejectBooking);

// Stats
router.get('/stats', checkRole(['AGENT', 'ADMIN', 'OWNER', 'TEAM_HEAD']), cacheMiddleware(120), getBookingStats);

// CRUD
router.post('/', checkRole(['ADMIN', 'OWNER', 'TEAM_HEAD', 'AGENT']), createBooking);
router.get('/', cacheMiddleware(120), getBookings);
router.get('/:id', cacheMiddleware(120), getBooking);
router.put('/:id/status', checkRole(['ADMIN', 'OWNER']), updateBookingStatus);

export default router;
