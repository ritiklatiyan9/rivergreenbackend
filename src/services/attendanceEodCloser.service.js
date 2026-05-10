// ─────────────────────────────────────────────────────────────────────────
// attendanceEodCloser.service.js
//
// Once a day at the configured cutoff (default 23:59 server-local), find
// every open attendance row for *today* — `check_in_time IS NOT NULL` and
// `check_out_time IS NULL` — and auto-close it.
//
// Close time picked, in order of preference:
//   1. The location's office_end_time on today's date
//   2. The configured cutoff (23:59 local)
// (Whichever is later than the user's check-in — never a 0-or-negative shift.)
//
// The session JSONB is patched so the day timeline reflects the close. A
// marker `auto_closed_eod=true` is written into raw_zkteco so the UI can
// distinguish auto-closed days from real check-outs if needed.
//
// After the run we send ONE consolidated FCM to admins (not one per closed
// row) so midnight doesn't spam everyone.
// ─────────────────────────────────────────────────────────────────────────

import pool from '../config/db.js';
import { bustCache } from '../middlewares/cache.middleware.js';
import { notifyEodSummary } from './attendanceNotifier.service.js';

const TICK_MS = 60 * 1000;
const CUTOFF_HOUR = parseInt(process.env.ATTENDANCE_EOD_HOUR || '23', 10);
const CUTOFF_MIN  = parseInt(process.env.ATTENDANCE_EOD_MIN  || '59', 10);

let _intervalHandle = null;
let _lastFiredDate = null;
let _running = false;

const fmtDay = (d) => {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

const log = (...args) => console.log('[eod-close]', ...args);
const errlog = (...args) => console.error('[eod-close]', ...args);

/**
 * Build the cutoff Date for the given calendar date string. Prefers the
 * location's configured office_end_time when available, else falls back to
 * the global cutoff (CUTOFF_HOUR:CUTOFF_MIN).
 */
const buildCloseTime = (dateStr, officeEnd) => {
  const [y, m, d] = dateStr.split('-').map(Number);
  let hh = CUTOFF_HOUR, mm = CUTOFF_MIN, ss = 0;
  if (officeEnd && /^\d{1,2}:\d{2}/.test(officeEnd)) {
    const parts = String(officeEnd).split(':').map(Number);
    if (Number.isFinite(parts[0])) hh = parts[0];
    if (Number.isFinite(parts[1])) mm = parts[1];
    if (Number.isFinite(parts[2])) ss = parts[2];
  }
  return new Date(y, m - 1, d, hh, mm, ss, 0);
};

const closeOpenForDay = async (dateStr) => {
  const r = await pool.query(`
    SELECT ar.id, ar.user_id, ar.location_id, ar.date, ar.check_in_time, ar.sessions,
           u.name AS user_name,
           al.name AS location_name, al.office_end_time
      FROM attendance_records ar
      JOIN users u ON u.id = ar.user_id
      JOIN attendance_locations al ON al.id = ar.location_id
     WHERE ar.date = $1::date
       AND ar.check_out_time IS NULL
       AND ar.check_in_time IS NOT NULL
  `, [dateStr]);

  if (r.rows.length === 0) return { closed: 0, skipped: 0, total: 0, samples: [] };

  let closed = 0, skipped = 0;
  const samples = [];

  for (const row of r.rows) {
    try {
      const closeAt = buildCloseTime(dateStr, row.office_end_time);
      const checkIn = new Date(row.check_in_time);
      // Guard: if for any reason check-in is already past the cutoff (e.g.
      // late-night shift, clock skew), bump the close to check-in + 1 minute
      // so we never write a non-positive shift.
      const finalClose = closeAt > checkIn ? closeAt : new Date(checkIn.getTime() + 60_000);

      // Patch sessions JSONB: close the last open session, or insert one if
      // there's no sessions array yet (older rows pre-sessions migration).
      let sessions = row.sessions;
      if (typeof sessions === 'string') {
        try { sessions = JSON.parse(sessions); } catch { sessions = []; }
      }
      if (!Array.isArray(sessions)) sessions = [];
      if (sessions.length === 0) {
        sessions = [{ in: checkIn.toISOString(), out: finalClose.toISOString(), auto_closed: true }];
      } else {
        const last = sessions[sessions.length - 1];
        if (last && !last.out) {
          last.out = finalClose.toISOString();
          last.auto_closed = true;
        } else {
          // Extremely rare — sessions all closed but check_out_time was NULL
          // (data drift). Append a synthetic close so totals are non-zero.
          sessions.push({ in: checkIn.toISOString(), out: finalClose.toISOString(), auto_closed: true });
        }
      }

      await pool.query(`
        UPDATE attendance_records
           SET check_out_time = $2,
               sessions       = $3::jsonb,
               raw_zkteco     = COALESCE(raw_zkteco, '{}'::jsonb)
                                 || jsonb_build_object(
                                      'auto_closed_eod', true,
                                      'auto_closed_at', to_char($2::timestamptz, 'YYYY-MM-DD"T"HH24:MI:SSOF')
                                    ),
               updated_at     = NOW()
         WHERE id = $1
      `, [row.id, finalClose, JSON.stringify(sessions)]);

      closed += 1;
      if (samples.length < 5) {
        samples.push({ name: row.user_name, location: row.location_name, time: finalClose });
      }
    } catch (e) {
      skipped += 1;
      errlog(`row ${row.id} (user=${row.user_id}): ${e?.message || e}`);
    }
  }

  return { closed, skipped, total: r.rows.length, samples };
};

const fireEodClose = async () => {
  if (_running) return { skipped: 'already-running' };
  _running = true;
  const today = fmtDay(new Date());
  log(`running for ${today}`);
  try {
    const result = await closeOpenForDay(today);
    log(`closed=${result.closed} skipped=${result.skipped} total=${result.total}`);

    if (result.closed > 0) {
      bustCache('cache:*:/api/attendance*').catch(() => null);
      try {
        await notifyEodSummary({
          date: today,
          closedCount: result.closed,
          samples: result.samples,
        });
      } catch (e) {
        errlog('eod summary push failed:', e?.message || e);
      }
    }
    return result;
  } finally {
    _running = false;
  }
};

const tick = async () => {
  const now = new Date();
  if (now.getHours() !== CUTOFF_HOUR || now.getMinutes() < CUTOFF_MIN) return;
  const today = fmtDay(now);
  if (_lastFiredDate === today) return;
  _lastFiredDate = today;
  await fireEodClose();
};

export const startEodCloser = () => {
  if (_intervalHandle) return;
  _intervalHandle = setInterval(() => {
    tick().catch((e) => errlog('tick failed:', e?.message || e));
  }, TICK_MS);
  log(`scheduler started — fires daily at ${String(CUTOFF_HOUR).padStart(2, '0')}:${String(CUTOFF_MIN).padStart(2, '0')} server-local`);
};

export const stopEodCloser = () => {
  if (!_intervalHandle) return;
  clearInterval(_intervalHandle);
  _intervalHandle = null;
};

// Exposed for ops/manual debugging via a route or REPL.
export const fireEodCloseNow = fireEodClose;
