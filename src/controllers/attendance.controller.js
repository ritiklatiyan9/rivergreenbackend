import asyncHandler from '../utils/asyncHandler.js';
import { attendanceLocationModel, attendanceRecordModel } from '../models/Attendance.model.js';
import pool from '../config/db.js';
import { bustCache } from '../middlewares/cache.middleware.js';

// ─── Haversine formula — returns distance in meters ───
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Earth's radius in meters
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

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
  const { name, latitude, longitude, radius_meters, office_start_time, office_end_time } = req.body;
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
  };
  if (office_start_time) payload.office_start_time = office_start_time;
  if (office_end_time) payload.office_end_time = office_end_time;
  const location = await attendanceLocationModel.create(payload, pool);
  bustCache('cache:*:/api/attendance*');
  res.status(201).json({ success: true, location });
});

/** PUT /api/attendance/locations/:id — update location */
export const updateLocation = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, latitude, longitude, radius_meters, is_active, office_start_time, office_end_time } = req.body;

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

/** POST /api/attendance/check-in — mark attendance check-in */
export const checkIn = asyncHandler(async (req, res) => {
  const { location_id, latitude, longitude } = req.body;
  const userId = req.user.id;

  if (!location_id || latitude == null || longitude == null) {
    return res.status(400).json({ success: false, message: 'location_id, latitude, and longitude are required' });
  }

  // Get the office location
  const location = await attendanceLocationModel.findById(location_id, pool);
  if (!location || !location.is_active) {
    return res.status(404).json({ success: false, message: 'Location not found or inactive' });
  }

  // Check if already checked in today
  const existing = await attendanceRecordModel.findTodayRecord(userId, location_id, pool);
  if (existing) {
    return res.status(400).json({ success: false, message: 'Already checked in today at this location', record: existing });
  }

  // Calculate distance using Haversine
  const distance = haversineDistance(
    parseFloat(latitude), parseFloat(longitude),
    parseFloat(location.latitude), parseFloat(location.longitude)
  );

  // Check if within allowed radius
  if (distance > location.radius_meters) {
    return res.status(403).json({
      success: false,
      message: `You are ${Math.round(distance)}m away. Must be within ${location.radius_meters}m of ${location.name}.`,
      distance: Math.round(distance),
      allowed_radius: location.radius_meters,
    });
  }

  // Determine status — check if late (after office_start_time)
  const now = new Date();
  const officeStart = location.office_start_time || '10:00:00';
  const [startH, startM] = officeStart.split(':').map(Number);
  const nowH = now.getHours();
  const nowM = now.getMinutes();
  const status = (nowH > startH || (nowH === startH && nowM > startM)) ? 'LATE' : 'PRESENT';

  const record = await attendanceRecordModel.create({
    user_id: userId,
    location_id: parseInt(location_id),
    check_in_time: now,
    check_in_lat: parseFloat(latitude),
    check_in_lng: parseFloat(longitude),
    check_in_distance_m: Math.round(distance * 100) / 100,
    status,
    date: now.toISOString().split('T')[0],
  }, pool);

  res.status(201).json({
    success: true,
    message: `Checked in successfully at ${location.name}${status === 'LATE' ? ' (Late)' : ''}`,
    record,
    distance: Math.round(distance),
  });
  bustCache('cache:*:/api/attendance*');
});

/** POST /api/attendance/check-out — mark attendance check-out */
export const checkOut = asyncHandler(async (req, res) => {
  const { location_id, latitude, longitude } = req.body;
  const userId = req.user.id;

  if (!location_id || latitude == null || longitude == null) {
    return res.status(400).json({ success: false, message: 'location_id, latitude, and longitude are required' });
  }

  const location = await attendanceLocationModel.findById(location_id, pool);
  if (!location) {
    return res.status(404).json({ success: false, message: 'Location not found' });
  }

  // Find today's check-in record
  const record = await attendanceRecordModel.findTodayRecord(userId, location_id, pool);
  if (!record) {
    return res.status(400).json({ success: false, message: 'No check-in found for today at this location' });
  }
  if (record.check_out_time) {
    return res.status(400).json({ success: false, message: 'Already checked out today', record });
  }

  // Calculate distance
  const distance = haversineDistance(
    parseFloat(latitude), parseFloat(longitude),
    parseFloat(location.latitude), parseFloat(location.longitude)
  );

  // Check if within allowed radius for checkout
  if (distance > location.radius_meters) {
    return res.status(403).json({
      success: false,
      message: `You are ${Math.round(distance)}m away. Must be within ${location.radius_meters}m of ${location.name} to check out.`,
      distance: Math.round(distance),
      allowed_radius: location.radius_meters,
    });
  }

  const now = new Date();
  const updated = await attendanceRecordModel.update(record.id, {
    check_out_time: now,
    check_out_lat: parseFloat(latitude),
    check_out_lng: parseFloat(longitude),
    check_out_distance_m: Math.round(distance * 100) / 100,
    updated_at: now,
  }, pool);

  res.json({
    success: true,
    message: `Checked out successfully from ${location.name}`,
    record: updated,
    distance: Math.round(distance),
  });
  bustCache('cache:*:/api/attendance*');
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
