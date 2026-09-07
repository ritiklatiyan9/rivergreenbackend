import { pendingPunches } from '../utils/pendingPunches.js';
// ZKTeco poller — runs in-process on the API server.
//
// Loop: every 30s, for each location with zkteco_enabled, pull
// attendance logs newer than zkteco_last_log_id, run them through the
// pure reducer, upsert into attendance_records, persist the new
// watermark, and broadcast a socket event for each record.
//
// Errors per device are isolated — one bad device does not stop the
// others. The error message is persisted on the location row so admins
// can see what's broken in /attendance/zkteco/devices.

import pool from '../config/db.js';
import { emitAttendancePunch } from '../config/socket.js';
import { fetchAttendances } from '../services/zkteco.service.js';
import { reducePunches, __test__ as punchDates } from '../utils/zktecoPunchReducer.js';
import { attendanceLocationModel, attendanceRecordModel } from '../models/Attendance.model.js';
import userModel from '../models/User.model.js';
import { bustCache } from '../middlewares/cache.middleware.js';
import { notifyAttendancePunch } from '../services/attendanceNotifier.service.js';

const POLL_INTERVAL_MS = parseInt(process.env.ZKTECO_POLL_INTERVAL_MS || '30000', 10);

let timer = null;
let isPolling = false;
let lastRunAt = null;

const log = (...args) => console.log('[zkteco-poller]', ...args);
const errlog = (...args) => console.error('[zkteco-poller]', ...args);

const pendingLocations = new Map();
const pollLocation = (location) => {
  if (pendingLocations.has(location.id)) return pendingLocations.get(location.id);
  const task = processLocation(location).finally(() => pendingLocations.delete(location.id));
  pendingLocations.set(location.id, task);
  return task;
};
const processLocation = async (location) => {
  const lastLogId = location.zkteco_last_log_id != null ? Number(location.zkteco_last_log_id) : 0;
  let punches;
  try {
    punches = await fetchAttendances(location);
  } catch (err) {
    await attendanceLocationModel.setZktecoSyncStatus(
      location.id,
      { lastError: err.message || String(err), syncedAt: new Date() },
      pool,
    );
    errlog(`location ${location.id} (${location.name}): fetch failed — ${err.message}`);
    return { ok: false, error: err.message };
  }

  const userMap = await userModel.buildZktecoUserMapForLocation(location.id, pool);
  const times = punches.map(p => p.time.getTime());
  let newPunches = punches;
  if (times.length) {
    const bounds = [location.id, new Date(times.reduce((a, b) => Math.min(a, b), Infinity)), new Date(times.reduce((a, b) => Math.max(a, b), -Infinity))];
    const [journal, pending] = await Promise.all([
      pool.query('SELECT user_id, punch_time FROM attendance_punch_events WHERE location_id = $1 AND punch_time BETWEEN $2 AND $3', bounds),
      pool.query('SELECT zkteco_user_id, punch_time FROM zkteco_unmapped_punches WHERE location_id = $1 AND punch_time BETWEEN $2 AND $3', bounds),
    ]);
    newPunches = pendingPunches(punches, userMap, journal.rows, pending.rows);
  }
  if (!newPunches.length) {
    await attendanceLocationModel.setZktecoSyncStatus(location.id, { lastError: null, syncedAt: new Date() }, pool);
    return { ok: true, fetched: punches.length, applied: 0 };
  }
  const { upserts, unmapped } = reducePunches(newPunches, location, userMap);

  // Persist unmapped first so we never lose them if upserts later fail.
  if (unmapped.length > 0) {
    const values = [];
    const placeholders = [];
    let i = 1;
    for (const u of unmapped) {
      placeholders.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++})`);
      values.push(u.locationId, u.zktecoUserId, u.time, u.type ?? null, u.raw ?? null);
    }
    await pool.query(
      `INSERT INTO zkteco_unmapped_punches (location_id, zkteco_user_id, punch_time, punch_type, raw)
       VALUES ${placeholders.join(', ')}`,
      values,
    );
  }

  let applied = 0;
  for (const punch of [...newPunches].sort((a, b) => a.time - b.time)) {
    const user = userMap.get(punch.zktecoUserId);
    if (!user) continue;
    try {
      const record = await attendanceRecordModel.appendBiometricPunch({
        userId: user.id, locationId: location.id, dateKey: punchDates.toDateKey(punch.time, location),
        punchTime: punch.time, punchType: punch.type,
        status: punchDates.isLate(punch.time, location.office_start_time) ? 'LATE' : 'PRESENT',
        isSecondary: !!(user.primary_site_id && location.site_id && String(user.primary_site_id) !== String(location.site_id)),
        source: 'BIOMETRIC', raw: punch.raw || {},
      }, pool);
      if (record) { applied++; emitAttendancePunch(record); notifyAttendancePunch(record, { channel: 'BIOMETRIC_POLL' }); }
    } catch (err) {
      await attendanceLocationModel.setZktecoSyncStatus(location.id, { lastError: `Retry pending: ${err.message}`, syncedAt: new Date() }, pool);
      bustCache('cache:*:/api/attendance*').catch(() => null);
      bustCache('cache:*:/api/hr*').catch(() => null);
      return { ok: false, applied, error: err.message };
    }
  }

  // Advance the watermark to the highest logId we successfully processed.
  const newWatermark = newPunches.reduce((m, p) => Math.max(m, Number(p.logId)), lastLogId);
  await attendanceLocationModel.setZktecoSyncStatus(
    location.id,
    { lastLogId: newWatermark, lastError: null, syncedAt: new Date() },
    pool,
  );

  if (upserts.length > 0) {
    bustCache('cache:*:/api/attendance*').catch(() => null);
    bustCache('cache:*:/api/hr*').catch(() => null);
  }

  return { ok: true, fetched: punches.length, applied, unmapped: unmapped.length };
};

const tick = async () => {
  if (isPolling) return;        // overlapping cycles guard
  isPolling = true;
  lastRunAt = new Date();
  try {
    const locations = await attendanceLocationModel.findZktecoEnabled(pool);
    if (locations.length === 0) return;
    // Sequential — keeps DB churn low and avoids hammering all devices at once.
    // A slow/offline machine must not hold up every other device.
    for (let i = 0; i < locations.length; i += 4) {
      await Promise.allSettled(locations.slice(i, i + 4).map(pollLocation));
    }
  } finally {
    isPolling = false;
  }
};

export const start = () => {
  if (timer) return;
  log(`starting (interval ${POLL_INTERVAL_MS}ms)`);
  // Kick off one cycle on boot so the dashboard shows fresh status without a wait.
  tick().catch((err) => errlog('initial tick failed:', err));
  timer = setInterval(() => {
    tick().catch((err) => errlog('tick failed:', err));
  }, POLL_INTERVAL_MS);
};

export const stop = () => {
  if (!timer) return;
  log('stopping');
  clearInterval(timer);
  timer = null;
};

/** Manual trigger used by the admin sync endpoint. */
export const syncNow = async (locationId) => {
  const loc = await attendanceLocationModel.findById(locationId, pool);
  if (!loc) throw new Error('Location not found');
  if (!loc.zkteco_enabled || !loc.zkteco_ip) throw new Error('Location has no ZKTeco device configured');
  return pollLocation(loc);
};

export const status = () => ({
  running: !!timer,
  isPolling,
  lastRunAt,
  intervalMs: POLL_INTERVAL_MS,
});
