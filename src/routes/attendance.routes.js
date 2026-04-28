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
  getUserMovement,
  getUserAnalytics,
  getTeamAnalytics,
  listTeamsForAnalytics,
} from '../controllers/attendance.controller.js';
import {
  listDevices,
  testDevice,
  syncDevice,
  getDeviceUsers,
  listUnmapped,
  resolveUnmapped,
  mapUser,
  listMapping,
} from '../controllers/zkteco.controller.js';
import { getLiveLocations } from '../controllers/location.controller.js';

const router = express.Router();

// All routes require authentication
router.use(authMiddleware);

// ── Agent / Team Head routes ──
router.get('/locations/active', cacheMiddleware(300), getActiveLocations);
// Deprecated: GPS self-service. Returns 410.
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
router.get('/user-movement/:userId', checkRole(['ADMIN', 'OWNER']), cacheMiddleware(30), getUserMovement);
router.get('/live-locations', checkRole(['ADMIN', 'OWNER']), getLiveLocations);

// ── Analytics ──
router.get('/analytics/user',  checkRole(['ADMIN', 'OWNER']), cacheMiddleware(60), getUserAnalytics);
router.get('/analytics/team',  checkRole(['ADMIN', 'OWNER']), cacheMiddleware(60), getTeamAnalytics);
router.get('/analytics/teams', checkRole(['ADMIN', 'OWNER']), cacheMiddleware(300), listTeamsForAnalytics);

// ── ZKTeco biometric admin routes ──
router.get('/zkteco/devices', checkRole(['ADMIN', 'OWNER']), listDevices);
router.post('/zkteco/test/:locationId', checkRole(['ADMIN', 'OWNER']), testDevice);
router.post('/zkteco/sync/:locationId', checkRole(['ADMIN', 'OWNER']), syncDevice);
router.get('/zkteco/device-users/:locationId', checkRole(['ADMIN', 'OWNER']), getDeviceUsers);
router.get('/zkteco/unmapped', checkRole(['ADMIN', 'OWNER']), listUnmapped);
router.post('/zkteco/unmapped/:id/resolve', checkRole(['ADMIN', 'OWNER']), resolveUnmapped);
router.post('/zkteco/map-user', checkRole(['ADMIN', 'OWNER']), mapUser);
router.get('/zkteco/mapping', checkRole(['ADMIN', 'OWNER']), listMapping);

export default router;
