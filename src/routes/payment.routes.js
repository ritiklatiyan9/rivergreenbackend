import express from 'express';
const router = express.Router();

import {
  recordPayment,
  updatePayment,
  getPayments,
  getPaymentsByBooking,
  getOverduePayments,
  getPaymentStats,
  deletePayment,
} from '../controllers/payment.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import checkRole from '../middlewares/role.middleware.js';
import { cacheMiddleware } from '../middlewares/cache.middleware.js';

// All payment routes require auth
router.use(authMiddleware);

// Stats
router.get('/stats', checkRole(['AGENT', 'ADMIN', 'OWNER', 'TEAM_HEAD']), cacheMiddleware(120), getPaymentStats);

// Overdue
router.get('/overdue', checkRole(['ADMIN', 'OWNER', 'TEAM_HEAD']), cacheMiddleware(120), getOverduePayments);

// By booking
router.get('/booking/:bookingId', cacheMiddleware(120), getPaymentsByBooking);

// CRUD
router.post('/', checkRole(['ADMIN', 'OWNER', 'TEAM_HEAD']), recordPayment);
router.get('/', cacheMiddleware(120), getPayments);
router.put('/:id', checkRole(['ADMIN', 'OWNER']), updatePayment);
router.delete('/:id', checkRole(['ADMIN', 'OWNER']), deletePayment);

export default router;
