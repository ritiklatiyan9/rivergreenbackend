import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import checkRole from '../middlewares/role.middleware.js';
import { cacheMiddleware } from '../middlewares/cache.middleware.js';
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
router.get('/locations/active', cacheMiddleware(300), getActiveLocations);
router.post('/check-in', checkIn);
router.post('/check-out', checkOut);
router.get('/my-today', cacheMiddleware(30), getMyToday);
router.get('/my-history', cacheMiddleware(120), getMyHistory);
router.get('/my-monthly', cacheMiddleware(120), getMyMonthlySummary);

// ── Admin-only routes ──
router.get('/locations', checkRole(['ADMIN', 'OWNER']), cacheMiddleware(300), getLocations);
router.post('/locations', checkRole(['ADMIN', 'OWNER']), createLocation);
router.put('/locations/:id', checkRole(['ADMIN', 'OWNER']), updateLocation);
router.delete('/locations/:id', checkRole(['ADMIN', 'OWNER']), deleteLocation);
router.get('/records', checkRole(['ADMIN', 'OWNER']), cacheMiddleware(60), getAllRecords);
router.get('/stats', checkRole(['ADMIN', 'OWNER']), cacheMiddleware(60), getDailyStats);
router.get('/users', checkRole(['ADMIN', 'OWNER']), cacheMiddleware(300), getAttendanceUsers);
router.get('/user/:userId', checkRole(['ADMIN', 'OWNER']), cacheMiddleware(120), getUserAttendance);

export default router;
