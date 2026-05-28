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
  getAttendanceCalendarBulk,
  upsertLeave,
  deleteLeave,
  suggestPayrollAll,
  suggestPayrollUser,
  recordPayment,
  listPayments,
  getPayment,
  updatePaymentStatus,
  listUserOverrides,
  getUserOverride,
  upsertUserOverride,
  deleteUserOverride,
} from '../controllers/hr.controller.js';

const router = express.Router();

router.use(authMiddleware);
const adminOnly = checkRole(['ADMIN', 'OWNER']);

// Settings
router.get('/settings',  adminOnly, cacheMiddleware(60),  getSettings);
router.put('/settings',  adminOnly, updateSettings);

// Per-user overrides (working_days, working_hours, work_*_time, etc.)
router.get('/user-overrides',          adminOnly, cacheMiddleware(30), listUserOverrides);
router.get('/user-overrides/:userId',  adminOnly, getUserOverride);
router.put('/user-overrides/:userId',  adminOnly, upsertUserOverride);
router.delete('/user-overrides/:userId', adminOnly, deleteUserOverride);

// Salaries
router.get('/salaries',          adminOnly, cacheMiddleware(30), listSalaries);
router.get('/salaries/:userId',  adminOnly, getUserSalary);
router.put('/salaries/:userId',  adminOnly, updateUserSalary);

// Calendar + leaves
router.get('/attendance-calendar/all',     adminOnly, getAttendanceCalendarBulk);
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
