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

// All payment routes require auth
router.use(authMiddleware);

// Stats
router.get('/stats', checkRole(['AGENT', 'ADMIN', 'OWNER', 'TEAM_HEAD']), getPaymentStats);

// Overdue
router.get('/overdue', checkRole(['ADMIN', 'OWNER', 'TEAM_HEAD']), getOverduePayments);

// By booking
router.get('/booking/:bookingId', getPaymentsByBooking);

// CRUD
router.post('/', checkRole(['ADMIN', 'OWNER', 'TEAM_HEAD']), recordPayment);
router.get('/', getPayments);
router.put('/:id', checkRole(['ADMIN', 'OWNER']), updatePayment);
router.delete('/:id', checkRole(['ADMIN', 'OWNER']), deletePayment);

export default router;
