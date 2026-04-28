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
  publicBookByLabel,
  getPublicBookingStatus,
  publicUploadScreenshots,
  getBookingReceiptToken,
  getPublicBookingReceiptToken,
} from '../controllers/plotBooking.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import checkRole from '../middlewares/role.middleware.js';
import upload from '../middlewares/multer.middleware.js';
import { cacheMiddleware } from '../middlewares/cache.middleware.js';

// ── PUBLIC routes (no auth) ─────────────────────────────
router.post('/public-book/:plotId', upload.array('screenshots', 5), publicBookPlot);
router.post('/public-book-by-label', upload.array('screenshots', 5), publicBookByLabel);
router.get('/track/:id', getPublicBookingStatus);
router.post('/track/:id/screenshots', upload.array('screenshots', 5), publicUploadScreenshots);
router.get('/track/:id/receipt-token', getPublicBookingReceiptToken);

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
router.get('/:id/receipt-token', getBookingReceiptToken);
router.put('/:id/status', checkRole(['ADMIN', 'OWNER']), updateBookingStatus);

export default router;
