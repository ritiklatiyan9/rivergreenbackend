import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import checkRole from '../middlewares/role.middleware.js';
import { cacheMiddleware } from '../middlewares/cache.middleware.js';
import {
  getSettings,
  updateSettings,
  listSalaries,
  getUserSalary,
  updateUserSalary,
  getAttendanceCalendar,
  upsertLeave,
  deleteLeave,
  suggestPayrollAll,
  suggestPayrollUser,
  recordPayment,
  listPayments,
  getPayment,
  updatePaymentStatus,
} from '../controllers/hr.controller.js';

const router = express.Router();

router.use(authMiddleware);
const adminOnly = checkRole(['ADMIN', 'OWNER']);

// Settings
router.get('/settings',  adminOnly, cacheMiddleware(60),  getSettings);
router.put('/settings',  adminOnly, updateSettings);

// Salaries
router.get('/salaries',          adminOnly, cacheMiddleware(30), listSalaries);
router.get('/salaries/:userId',  adminOnly, getUserSalary);
router.put('/salaries/:userId',  adminOnly, updateUserSalary);

// Calendar + leaves
router.get('/attendance-calendar/:userId', adminOnly, getAttendanceCalendar);
router.post('/leaves',                     adminOnly, upsertLeave);
router.delete('/leaves',                   adminOnly, deleteLeave);

// Payroll suggestion
router.get('/payroll/suggest',          adminOnly, suggestPayrollAll);
router.get('/payroll/suggest/:userId',  adminOnly, suggestPayrollUser);

// Payments
router.post('/payments',           adminOnly, recordPayment);
router.get('/payments',            adminOnly, cacheMiddleware(30), listPayments);
router.get('/payments/:id',        adminOnly, getPayment);
router.patch('/payments/:id',      adminOnly, updatePaymentStatus);

export default router;
