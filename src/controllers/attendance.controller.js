import asyncHandler from '../utils/asyncHandler.js';
import { attendanceLocationModel, attendanceRecordModel } from '../models/Attendance.model.js';
import pool from '../config/db.js';
import { bustCache } from '../middlewares/cache.middleware.js';

// ═══════════════════════════════════════════════════════
// LOCATION (Admin CRUD)
// ═══════════════════════════════════════════════════════

/** GET /api/attendance/locations — list all locations */
export const getLocations = asyncHandler(async (req, res) => {
  const locations = await attendanceLocationModel.findAllWithCreator(pool);
  res.json({ success: true, locations });
});

/** GET /api/attendance/locations/active — active locations only (for agents) */
export const getActiveLocations = asyncHandler(async (req, res) => {
  const locations = await attendanceLocationModel.findAllActive(pool);
  res.json({ success: true, locations });
});

/** POST /api/attendance/locations — create location */
export const createLocation = asyncHandler(async (req, res) => {
  const {
    name, latitude, longitude, radius_meters, office_start_time, office_end_time,
    zkteco_enabled, zkteco_ip, zkteco_port, zkteco_device_id, zkteco_serial,
  } = req.body;
  if (!name || latitude == null || longitude == null) {
    return res.status(400).json({ success: false, message: 'Name, latitude, and longitude are required' });
  }
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return res.status(400).json({ success: false, message: 'Invalid coordinates' });
  }
  const payload = {
    name,
    latitude: parseFloat(latitude),
    longitude: parseFloat(longitude),
    radius_meters: parseInt(radius_meters) || 100,
    created_by: req.user.id,
    site_id: req.user.site_id || null,
  };
  if (office_start_time) payload.office_start_time = office_start_time;
  if (office_end_time) payload.office_end_time = office_end_time;
  if (zkteco_enabled !== undefined) payload.zkteco_enabled = !!zkteco_enabled;
  if (zkteco_ip) payload.zkteco_ip = zkteco_ip;
  if (zkteco_port) payload.zkteco_port = parseInt(zkteco_port, 10) || 4370;
  if (zkteco_device_id) payload.zkteco_device_id = parseInt(zkteco_device_id, 10);
  if (zkteco_serial) payload.zkteco_serial = zkteco_serial;
  const location = await attendanceLocationModel.create(payload, pool);
  bustCache('cache:*:/api/attendance*');
  res.status(201).json({ success: true, location });
});

/** PUT /api/attendance/locations/:id — update location */
export const updateLocation = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const {
    name, latitude, longitude, radius_meters, is_active, office_start_time, office_end_time,
    zkteco_enabled, zkteco_ip, zkteco_port, zkteco_device_id, zkteco_serial,
  } = req.body;

  const existing = await attendanceLocationModel.findById(id, pool);
  if (!existing) return res.status(404).json({ success: false, message: 'Location not found' });

  const updates = {};
  if (name !== undefined) updates.name = name;
  if (latitude !== undefined) {
    if (latitude < -90 || latitude > 90) return res.status(400).json({ success: false, message: 'Invalid latitude' });
    updates.latitude = parseFloat(latitude);
  }
  if (longitude !== undefined) {
    if (longitude < -180 || longitude > 180) return res.status(400).json({ success: false, message: 'Invalid longitude' });
    updates.longitude = parseFloat(longitude);
  }
  if (radius_meters !== undefined) updates.radius_meters = parseInt(radius_meters);
  if (is_active !== undefined) updates.is_active = is_active;
  if (office_start_time !== undefined) updates.office_start_time = office_start_time;
  if (office_end_time !== undefined) updates.office_end_time = office_end_time;
  if (zkteco_enabled !== undefined) updates.zkteco_enabled = !!zkteco_enabled;
  if (zkteco_ip !== undefined) updates.zkteco_ip = zkteco_ip || null;
  if (zkteco_port !== undefined) updates.zkteco_port = parseInt(zkteco_port, 10) || 4370;
  if (zkteco_device_id !== undefined) updates.zkteco_device_id = zkteco_device_id ? parseInt(zkteco_device_id, 10) : null;
  if (zkteco_serial !== undefined) updates.zkteco_serial = zkteco_serial || null;
  updates.updated_at = new Date();

  const location = await attendanceLocationModel.update(id, updates, pool);
  bustCache('cache:*:/api/attendance*');
  res.json({ success: true, location });
});

/** DELETE /api/attendance/locations/:id */
export const deleteLocation = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const existing = await attendanceLocationModel.findById(id, pool);
  if (!existing) return res.status(404).json({ success: false, message: 'Location not found' });
  await attendanceLocationModel.delete(id, pool);
  bustCache('cache:*:/api/attendance*');
  res.json({ success: true, message: 'Location deleted' });
});

// ═══════════════════════════════════════════════════════
// CHECK-IN / CHECK-OUT (Agent)
// ═══════════════════════════════════════════════════════

/**
 * POST /api/attendance/check-in — DEPRECATED (GPS self check-in)
 * Replaced by ZKTeco biometric devices. Old mobile clients still calling
 * this endpoint receive 410 Gone with a clear message.
 */
export const checkIn = asyncHandler(async (req, res) => {
  return res.status(410).json({
    success: false,
    message: 'GPS check-in has been retired. Please use the biometric device at your location.',
    deprecated: true,
  });
});

/** POST /api/attendance/check-out — DEPRECATED (GPS self check-out) */
export const checkOut = asyncHandler(async (req, res) => {
  return res.status(410).json({
    success: false,
    message: 'GPS check-out has been retired. Please use the biometric device at your location.',
    deprecated: true,
  });
});

/** GET /api/attendance/my-today — agent's today status */
export const getMyToday = asyncHandler(async (req, res) => {
  const records = await attendanceRecordModel.findTodayRecordsByUser(req.user.id, pool);
  res.json({ success: true, records });
});

/** GET /api/attendance/my-history — agent's attendance history */
export const getMyHistory = asyncHandler(async (req, res) => {
  const { page, limit, startDate, endDate } = req.query;
  const data = await attendanceRecordModel.findByUser(req.user.id, {
    page: parseInt(page) || 1,
    limit: parseInt(limit) || 20,
    startDate,
    endDate,
  }, pool);
  res.json({ success: true, ...data });
});

/** GET /api/attendance/my-monthly — agent's monthly summary */
export const getMyMonthlySummary = asyncHandler(async (req, res) => {
  const now = new Date();
  const year = parseInt(req.query.year) || now.getFullYear();
  const month = parseInt(req.query.month) || (now.getMonth() + 1);
  const summary = await attendanceRecordModel.getMonthlySummary(req.user.id, year, month, pool);
  res.json({ success: true, summary, year, month });
});

// ═══════════════════════════════════════════════════════
// ADMIN — Records & Stats
// ═══════════════════════════════════════════════════════

/** GET /api/attendance/records — all records with filters */
export const getAllRecords = asyncHandler(async (req, res) => {
  const { page, limit, date, startDate, endDate, userId, locationId, status } = req.query;
  const data = await attendanceRecordModel.findAllRecords({
    page: parseInt(page) || 1,
    limit: parseInt(limit) || 20,
    date,
    startDate,
    endDate,
    userId,
    locationId,
    status,
  }, pool);
  res.json({ success: true, ...data });
});

/** GET /api/attendance/stats — daily attendance stats */
export const getDailyStats = asyncHandler(async (req, res) => {
  const date = req.query.date || new Date().toISOString().split('T')[0];

  // Count total active users (agents/team heads)
  const totalUsersResult = await pool.query(
    `SELECT COUNT(*) FROM users WHERE role IN ('AGENT', 'TEAM_HEAD') AND is_active = true`
  );
  const totalUsers = parseInt(totalUsersResult.rows[0].count);

  const stats = await attendanceRecordModel.getDailyStats(date, pool);

  res.json({
    success: true,
    stats: {
      ...stats,
      total_users: totalUsers,
      total_absent: totalUsers - parseInt(stats.total_present || 0),
      date,
    },
  });
});

/** GET /api/attendance/users — list of agents/team_heads for filter dropdowns */
export const getAttendanceUsers = asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT id, name, email, phone, role, profile_photo FROM users WHERE role IN ('AGENT', 'TEAM_HEAD') AND is_active = true ORDER BY name ASC`
  );
  res.json({ success: true, users: result.rows });
});

/** GET /api/attendance/user/:userId — a specific user's attendance (admin) */
export const getUserAttendance = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { year, month } = req.query;
  const now = new Date();
  const y = parseInt(year) || now.getFullYear();
  const m = parseInt(month) || (now.getMonth() + 1);
  const summary = await attendanceRecordModel.getMonthlySummary(userId, y, m, pool);
  res.json({ success: true, summary, year: y, month: m });
});

/** GET /api/attendance/user-movement/:userId — cross-location timeline for one date */
export const getUserMovement = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const date = req.query.date || new Date().toISOString().split('T')[0];
  const movements = await attendanceRecordModel.findUserMovementByDate(userId, date, pool);
  res.json({ success: true, date, movements });
});

// ═══════════════════════════════════════════════════════
// ANALYTICS — per-user and per-team rollups for the
// Analytics admin page. Date inputs are inclusive ISO
// dates (YYYY-MM-DD); the controller refuses ranges
// longer than 366 days to keep query cost bounded.
// ═══════════════════════════════════════════════════════

const validateRange = (startDate, endDate) => {
  if (!startDate || !endDate) return 'startDate and endDate are required (YYYY-MM-DD)';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return 'startDate / endDate must be ISO dates (YYYY-MM-DD)';
  }
  const a = new Date(startDate), b = new Date(endDate);
  if (b < a) return 'endDate must be on or after startDate';
  if ((b - a) / 86_400_000 > 366) return 'date range cannot exceed 366 days';
  return null;
};

/** GET /api/attendance/analytics/user?user_id=&start_date=&end_date= */
export const getUserAnalytics = asyncHandler(async (req, res) => {
  const userId = req.query.user_id;
  const { start_date: startDate, end_date: endDate } = req.query;
  if (!userId) return res.status(400).json({ success: false, message: 'user_id is required' });
  const err = validateRange(startDate, endDate);
  if (err) return res.status(400).json({ success: false, message: err });

  const userRow = await pool.query(
    `SELECT id, name, email, phone, role, profile_photo, team_id, primary_site_id
     FROM users WHERE id = $1`,
    [userId],
  );
  if (!userRow.rows[0]) return res.status(404).json({ success: false, message: 'User not found' });

  const data = await attendanceRecordModel.getUserAnalytics(userId, startDate, endDate, pool);
  res.json({ success: true, user: userRow.rows[0], startDate, endDate, ...data });
});

/**
 * GET /api/attendance/analytics/team
 *   ?team_id=&site_id=&role=&start_date=&end_date=
 *
 * If neither team_id nor site_id is supplied, falls back to the caller's
 * site (from the auth middleware's effective site_id).
 */
export const getTeamAnalytics = asyncHandler(async (req, res) => {
  const { start_date: startDate, end_date: endDate, team_id: teamId, role } = req.query;
  let siteId = req.query.site_id;
  const err = validateRange(startDate, endDate);
  if (err) return res.status(400).json({ success: false, message: err });
  if (!teamId && !siteId) siteId = req.user?.site_id || null;

  const members = await attendanceRecordModel.getTeamAnalytics(
    { teamId: teamId || null, siteId: siteId || null, role: role || null, startDate, endDate },
    pool,
  );

  // Fold the per-member rows into a small headline summary so the page
  // can render its KPI cards without re-summing on the client.
  const totals = members.reduce((acc, m) => {
    acc.members += 1;
    acc.totalPresentDays += parseInt(m.present_days, 10) || 0;
    acc.totalLateDays += parseInt(m.late_days, 10) || 0;
    acc.totalHours += parseFloat(m.total_hours) || 0;
    if (parseInt(m.present_days, 10) > 0) acc.activeMembers += 1;
    return acc;
  }, { members: 0, activeMembers: 0, totalPresentDays: 0, totalLateDays: 0, totalHours: 0 });

  res.json({ success: true, startDate, endDate, totals, members });
});

/** GET /api/attendance/analytics/teams — picker source for the team filter */
export const listTeamsForAnalytics = asyncHandler(async (req, res) => {
  const siteId = req.user?.site_id || null;
  const params = [];
  let where = `is_active = true`;
  if (siteId) { where += ` AND site_id = $1`; params.push(siteId); }
  const result = await pool.query(
    `SELECT id, name, site_id FROM teams WHERE ${where} ORDER BY name ASC`,
    params,
  );
  res.json({ success: true, teams: result.rows });
});
