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
} from '../controllers/plotBooking.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import checkRole from '../middlewares/role.middleware.js';

// All booking routes require auth
router.use(authMiddleware);

// Agent booking via shared link (AGENT, TEAM_HEAD, ADMIN)
router.post('/agent-book/:plotId', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN']), agentBookPlot);

// Admin approval workflow
router.get('/pending-approvals', checkRole(['ADMIN', 'OWNER']), getPendingApprovals);
router.put('/:id/approve', checkRole(['ADMIN', 'OWNER']), approveBooking);
router.put('/:id/reject', checkRole(['ADMIN', 'OWNER']), rejectBooking);

// Stats
router.get('/stats', checkRole(['AGENT', 'ADMIN', 'OWNER', 'TEAM_HEAD']), getBookingStats);

// CRUD
router.post('/', checkRole(['ADMIN', 'OWNER', 'TEAM_HEAD', 'AGENT']), createBooking);
router.get('/', getBookings);
router.get('/:id', getBooking);
router.put('/:id/status', checkRole(['ADMIN', 'OWNER']), updateBookingStatus);

export default router;
