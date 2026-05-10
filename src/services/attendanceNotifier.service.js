// ─────────────────────────────────────────────────────────────────────────
// attendanceNotifier.service.js
//
// Sends a detailed FCM push to admins/owners every time an attendance punch
// is recorded — biometric ADMS push, biometric pull-poller, or end-of-day
// auto-close. Fails softly so a missing FCM config never blocks the punch
// from being saved.
//
// Recipients: ADMIN + OWNER role users in the same site as the location
// (or unscoped admins with site_id IS NULL — typically platform owners).
// ─────────────────────────────────────────────────────────────────────────

import pool from '../config/db.js';
import fcmService from './fcm.service.js';

// In-memory caches (5-minute TTL) so a busy device pushing 50 punches/minute
// doesn't fan out into 50 user/location SELECTs.
const _userCache = new Map();      // user_id    -> { id, name, role, email }
const _locCache = new Map();       // location_id -> { id, name, site_id }
const _adminCache = new Map();     // site_id|'GLOBAL' -> [user_id...]
const CACHE_TTL_MS = 5 * 60 * 1000;

setInterval(() => {
  _userCache.clear();
  _locCache.clear();
  _adminCache.clear();
}, CACHE_TTL_MS).unref?.();

const fmtTime12 = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
};

const getUser = async (userId) => {
  if (_userCache.has(userId)) return _userCache.get(userId);
  const r = await pool.query(
    `SELECT id, name, email, role FROM users WHERE id = $1`,
    [userId],
  );
  const u = r.rows[0] || null;
  if (u) _userCache.set(userId, u);
  return u;
};

const getLocation = async (locationId) => {
  if (_locCache.has(locationId)) return _locCache.get(locationId);
  // Pull the parent site name in the same query so notifications can show
  // both the punch location ("Front Gate") and the site it belongs to
  // ("Defence Garden Phase 2") without an extra round-trip per push.
  const r = await pool.query(
    `SELECT al.id, al.name, al.site_id, s.name AS site_name
       FROM attendance_locations al
       LEFT JOIN sites s ON s.id = al.site_id
      WHERE al.id = $1`,
    [locationId],
  );
  const l = r.rows[0] || null;
  if (l) _locCache.set(locationId, l);
  return l;
};

const getAdminRecipients = async (siteId) => {
  const cacheKey = siteId ? String(siteId) : 'GLOBAL';
  if (_adminCache.has(cacheKey)) return _adminCache.get(cacheKey);

  // Notify any active admin/owner whose site matches the punch location, plus
  // any admin/owner without a site (platform-wide). Keeps multi-tenant
  // installations from leaking notifications across tenants.
  const params = [];
  let where = `is_active = true AND role IN ('ADMIN','OWNER')`;
  if (siteId) {
    where += ` AND (site_id = $1 OR site_id IS NULL)`;
    params.push(siteId);
  }
  const r = await pool.query(`SELECT id FROM users WHERE ${where}`, params);
  const ids = r.rows.map((x) => x.id);
  _adminCache.set(cacheKey, ids);
  return ids;
};

/**
 * Determine whether the just-saved record represents a fresh check-in or a
 * check-out. Caller can pass `action` explicitly when known (poller path
 * passes it from the punch reducer). Otherwise we infer from the sessions
 * JSONB — if the last session is open (out IS NULL) it was a check-in,
 * otherwise it was a check-out.
 */
const inferAction = (record, hint) => {
  if (hint === 'CHECK_IN' || hint === 'CHECK_OUT') return hint;
  let sessions = record?.sessions;
  if (typeof sessions === 'string') {
    try { sessions = JSON.parse(sessions); } catch { sessions = null; }
  }
  if (Array.isArray(sessions) && sessions.length > 0) {
    const last = sessions[sessions.length - 1];
    if (last && last.in && !last.out) return 'CHECK_IN';
    return 'CHECK_OUT';
  }
  return record?.check_out_time ? 'CHECK_OUT' : 'CHECK_IN';
};

/**
 * Send a per-punch attendance notification.
 *
 * @param {object} record       the attendance_records row after the upsert
 * @param {object} [opts]
 * @param {'CHECK_IN'|'CHECK_OUT'} [opts.action]  explicit action hint
 * @param {'BIOMETRIC_PUSH'|'BIOMETRIC_POLL'|'AUTO_EOD'} [opts.channel]
 *        helps distinguish ADMS push vs poller in admin dashboards
 */
export const notifyAttendancePunch = async (record, opts = {}) => {
  if (!record || !record.user_id || !record.location_id) return;
  try {
    const [user, location] = await Promise.all([
      getUser(record.user_id),
      getLocation(record.location_id),
    ]);
    if (!user) return;

    const action = inferAction(record, opts.action);
    const punchTime = action === 'CHECK_IN'
      ? record.check_in_time
      : (record.check_out_time || record.check_in_time);

    const recipients = await getAdminRecipients(location?.site_id);
    if (!recipients.length) return;

    const verb = action === 'CHECK_IN' ? 'checked in' : 'checked out';
    const lateTag = (record.status === 'LATE' && action === 'CHECK_IN') ? ' · LATE' : '';
    const secondaryTag = record.is_secondary ? ' · Secondary' : '';
    const channel = opts.channel || (record.source === 'BIOMETRIC' ? 'BIOMETRIC' : record.source || 'BIOMETRIC');

    const siteName = location?.site_name || '';
    const locName = location?.name || 'Unknown site';
    // Show site + sub-location when both exist ("Defence Garden · Front Gate"),
    // collapse to just one when they're missing or identical.
    const where = siteName && siteName !== locName
      ? `${siteName} · ${locName}`
      : locName;

    const title = `${user.name} ${verb}${lateTag}`;
    const body = `${fmtTime12(punchTime)} · ${where}${secondaryTag}`;

    // Fire-and-forget — never block the punch path on FCM latency.
    fcmService.sendToUsers(recipients, {
      title,
      body,
      data: {
        type: 'attendance',
        action,                         // CHECK_IN | CHECK_OUT
        channel,                        // BIOMETRIC_PUSH | BIOMETRIC_POLL | AUTO_EOD
        user_id: record.user_id,
        user_name: user.name,
        user_role: user.role,
        location_id: record.location_id,
        location_name: locName,
        site_id: location?.site_id || '',
        site_name: siteName,
        date: record.date,
        time: punchTime,
        status: record.status,
        is_secondary: record.is_secondary,
        route: '/attendance/records',
      },
    }).catch((e) => console.error('[attendance-notify] send failed:', e?.message || e));
  } catch (e) {
    console.error('[attendance-notify] failed:', e?.message || e);
  }
};

/**
 * Send a single end-of-day summary push when the auto-closer runs.
 * Saves admins from getting one notification per closed record at midnight.
 */
export const notifyEodSummary = async ({ date, closedCount, samples = [] }) => {
  try {
    if (!closedCount) return;
    const recipients = await getAdminRecipients(null);
    if (!recipients.length) return;
    const sample = samples.slice(0, 3).map((s) => s.name).filter(Boolean).join(', ');
    const more = closedCount - Math.min(samples.length, 3);
    const tail = more > 0 ? ` +${more} more` : '';
    const body = sample
      ? `${sample}${tail} were auto-closed at end of day.`
      : `${closedCount} open attendance${closedCount > 1 ? 's were' : ' was'} auto-closed at end of day.`;
    fcmService.sendToUsers(recipients, {
      title: `Attendance: ${closedCount} record${closedCount > 1 ? 's' : ''} auto-closed`,
      body,
      data: {
        type: 'attendance_eod',
        action: 'AUTO_EOD_CLOSE',
        channel: 'AUTO_EOD',
        date: date || '',
        closed_count: closedCount,
        route: '/attendance/records',
      },
    }).catch((e) => console.error('[attendance-notify] eod send failed:', e?.message || e));
  } catch (e) {
    console.error('[attendance-notify] eod failed:', e?.message || e);
  }
};

export default { notifyAttendancePunch, notifyEodSummary };
