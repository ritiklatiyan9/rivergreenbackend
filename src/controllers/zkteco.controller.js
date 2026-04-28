import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { bustCache } from '../middlewares/cache.middleware.js';
import { attendanceLocationModel } from '../models/Attendance.model.js';
import userModel from '../models/User.model.js';
import { testConnection, fetchDeviceUsers } from '../services/zkteco.service.js';
import * as poller from '../workers/zktecoPoller.worker.js';

/** GET /api/attendance/zkteco/devices — status of every configured device */
export const listDevices = asyncHandler(async (req, res) => {
  const locations = await attendanceLocationModel.findAllWithCreator(pool);
  const devices = locations
    .filter((l) => l.zkteco_enabled || l.zkteco_ip)
    .map((l) => ({
      location_id: l.id,
      name: l.name,
      enabled: !!l.zkteco_enabled,
      ip: l.zkteco_ip,
      port: l.zkteco_port,
      device_id: l.zkteco_device_id,
      serial: l.zkteco_serial,
      last_synced_at: l.zkteco_last_synced_at,
      last_log_id: l.zkteco_last_log_id,
      last_error: l.zkteco_last_error,
    }));
  res.json({ success: true, devices, poller: poller.status() });
});

/** POST /api/attendance/zkteco/test/:locationId — try to reach a device now */
export const testDevice = asyncHandler(async (req, res) => {
  const { locationId } = req.params;
  const location = await attendanceLocationModel.findById(locationId, pool);
  if (!location) return res.status(404).json({ success: false, message: 'Location not found' });
  const result = await testConnection(location);
  res.json({ success: result.ok, ...result });
});

/** POST /api/attendance/zkteco/sync/:locationId — manual poll */
export const syncDevice = asyncHandler(async (req, res) => {
  const { locationId } = req.params;
  try {
    const result = await poller.syncNow(locationId);
    bustCache('cache:*:/api/attendance*');
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

/** GET /api/attendance/zkteco/device-users/:locationId — read users defined on the device */
export const getDeviceUsers = asyncHandler(async (req, res) => {
  const { locationId } = req.params;
  const location = await attendanceLocationModel.findById(locationId, pool);
  if (!location) return res.status(404).json({ success: false, message: 'Location not found' });
  if (!location.zkteco_ip) return res.status(400).json({ success: false, message: 'Device not configured' });
  try {
    const users = await fetchDeviceUsers(location);
    // Mark which device-users are already mapped to an app user
    const ids = users.map((u) => u.zktecoUserId).filter((n) => Number.isFinite(n));
    let mapped = new Map();
    if (ids.length > 0) {
      const result = await pool.query(
        `SELECT id, name, zkteco_user_id FROM users WHERE zkteco_user_id = ANY($1::int[])`,
        [ids],
      );
      mapped = new Map(result.rows.map((r) => [Number(r.zkteco_user_id), { id: r.id, name: r.name }]));
    }
    res.json({
      success: true,
      users: users.map((u) => ({ ...u, mapped_user: mapped.get(u.zktecoUserId) || null })),
    });
  } catch (err) {
    res.status(502).json({ success: false, message: err.message });
  }
});

/** GET /api/attendance/zkteco/unmapped — punches we couldn't resolve to a user */
export const listUnmapped = asyncHandler(async (req, res) => {
  const { locationId, resolved } = req.query;
  const params = [];
  let where = '1=1';
  let i = 1;
  if (locationId) { where += ` AND location_id = $${i++}`; params.push(locationId); }
  if (resolved !== undefined) { where += ` AND resolved = $${i++}`; params.push(resolved === 'true'); }
  else { where += ' AND resolved = false'; }
  const result = await pool.query(
    `SELECT u.*, al.name as location_name
     FROM zkteco_unmapped_punches u
     JOIN attendance_locations al ON u.location_id = al.id
     WHERE ${where}
     ORDER BY punch_time DESC
     LIMIT 200`,
    params,
  );
  res.json({ success: true, punches: result.rows });
});

/** POST /api/attendance/zkteco/unmapped/:id/resolve — mark a row reviewed */
export const resolveUnmapped = asyncHandler(async (req, res) => {
  const { id } = req.params;
  await pool.query(`UPDATE zkteco_unmapped_punches SET resolved = true WHERE id = $1`, [id]);
  res.json({ success: true });
});

/**
 * POST /api/attendance/zkteco/map-user
 * Body: { user_id, zkteco_user_id, primary_site_id }
 * Sets the biometric mapping and primary site for one user.
 */
export const mapUser = asyncHandler(async (req, res) => {
  const { user_id, zkteco_user_id, primary_site_id } = req.body;
  if (!user_id) return res.status(400).json({ success: false, message: 'user_id is required' });
  const updated = await userModel.setZktecoMapping(
    user_id,
    {
      zktecoUserId: zkteco_user_id != null ? parseInt(zkteco_user_id, 10) : null,
      primarySiteId: primary_site_id || null,
    },
    pool,
  );
  if (!updated) return res.status(404).json({ success: false, message: 'User not found' });
  bustCache('cache:*:/api/attendance*');
  res.json({ success: true, user: updated });
});

/** GET /api/attendance/zkteco/mapping — table for the BiometricMapping page */
export const listMapping = asyncHandler(async (req, res) => {
  const siteId = req.user?.site_id || null;
  const users = await userModel.listForBiometricMapping(siteId, pool);
  res.json({ success: true, users });
});
