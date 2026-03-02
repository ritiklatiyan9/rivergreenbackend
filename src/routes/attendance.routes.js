import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import checkRole from '../middlewares/role.middleware.js';
import {
  getLocations,
  getActiveLocations,
  createLocation,
  updateLocation,
  deleteLocation,
  checkIn,
  checkOut,
  getMyToday,
  getMyHistory,
  getMyMonthlySummary,
  getAllRecords,
  getDailyStats,
  getAttendanceUsers,
  getUserAttendance,
} from '../controllers/attendance.controller.js';

const router = express.Router();

// All routes require authentication
router.use(authMiddleware);

// ── Agent / Team Head routes ──
router.get('/locations/active', getActiveLocations);
router.post('/check-in', checkIn);
router.post('/check-out', checkOut);
router.get('/my-today', getMyToday);
router.get('/my-history', getMyHistory);
router.get('/my-monthly', getMyMonthlySummary);

// ── Admin-only routes ──
router.get('/locations', checkRole(['ADMIN', 'OWNER']), getLocations);
router.post('/locations', checkRole(['ADMIN', 'OWNER']), createLocation);
router.put('/locations/:id', checkRole(['ADMIN', 'OWNER']), updateLocation);
router.delete('/locations/:id', checkRole(['ADMIN', 'OWNER']), deleteLocation);
router.get('/records', checkRole(['ADMIN', 'OWNER']), getAllRecords);
router.get('/stats', checkRole(['ADMIN', 'OWNER']), getDailyStats);
router.get('/users', checkRole(['ADMIN', 'OWNER']), getAttendanceUsers);
router.get('/user/:userId', checkRole(['ADMIN', 'OWNER']), getUserAttendance);

export default router;
