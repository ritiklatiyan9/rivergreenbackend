// ZKTeco ADMS / Push SDK endpoints.
//
// The device speaks plain HTTP:
//   GET  /iclock/cdata?SN=...&options=all   → handshake on boot
//   POST /iclock/cdata?SN=...&table=ATTLOG  → attendance push
//   POST /iclock/cdata?SN=...&table=OPERLOG → operation log push
//   GET  /iclock/getrequest?SN=...&INFO=... → heartbeat / command poll
//   POST /iclock/devicecmd?SN=...           → command result ack
//
// Responses are plain text (NOT JSON). Mounted publicly at /iclock with no
// auth middleware because the device has no JWT — authentication is "the
// SN query parameter must match an attendance_locations row".

import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { bustCache } from '../middlewares/cache.middleware.js';
import { emitAttendancePunch } from '../config/socket.js';
import userModel from '../models/User.model.js';
import { attendanceRecordModel } from '../models/Attendance.model.js';
import { parseAttLog, parseDeviceInfo } from '../services/admsParser.js';
import { shouldSyncClock, buildSetTimeCommand } from '../services/admsClockSync.js';
import { notifyAttendancePunch } from '../services/attendanceNotifier.service.js';

const log = (...a) => console.log('[adms]', ...a);
const errlog = (...a) => console.error('[adms]', ...a);

// When true (default), pushes from a serial we've never seen are 401'd.
// Flip to false during initial commissioning if you want to inspect raw
// payloads from a device whose serial isn't in the DB yet.
const REQUIRE_REGISTERED = process.env.ZKTECO_ADMS_REQUIRE_REGISTERED !== 'false';

const findLocationBySerial = async (sn) => {
  if (!sn) return null;
  const r = await pool.query(
    `SELECT * FROM attendance_locations
     WHERE zkteco_serial = $1 AND is_active = true
     LIMIT 1`,
    [String(sn).trim()],
  );
  return r.rows[0] || null;
};

const updateHeartbeat = async (locationId, { firmware, userCount, punchCount, error } = {}) => {
  const sets = ['adms_last_heartbeat = NOW()'];
  const vals = [locationId];
  let i = 2;
  if (firmware) { sets.push(`adms_firmware = $${i++}`); vals.push(firmware); }
  if (Number.isFinite(userCount)) { sets.push(`adms_user_count = $${i++}`); vals.push(userCount); }
  if (Number.isFinite(punchCount)) { sets.push(`adms_punch_count = $${i++}`); vals.push(punchCount); }
  sets.push(`adms_last_error = $${i++}`); vals.push(error || null);
  await pool.query(
    `UPDATE attendance_locations SET ${sets.join(', ')} WHERE id = $1`,
    vals,
  );
};

const sendText = (res, status, body) => {
  res.status(status).type('text/plain').send(body);
};

/**
 * GET /iclock/cdata?SN=xxx&options=all&pushver=2.4.1.10
 *
 * First handshake when the device boots or is reconfigured. Response is a
 * plain-text key=value config block. The device parses it line by line.
 */
export const handshake = asyncHandler(async (req, res) => {
  const sn = req.query.SN;
  log(`handshake SN=${sn} pushver=${req.query.pushver || ''} options=${req.query.options || ''}`);
  const location = await findLocationBySerial(sn);
  if (!location && REQUIRE_REGISTERED) {
    errlog(`unknown serial ${sn} — refusing handshake. Register the device in Attendance Settings.`);
    return sendText(res, 401, 'Unregistered device');
  }
  if (location) await updateHeartbeat(location.id, {});

  // ATTLOGStamp=9999  → forward-only push (don't replay history). For initial
  //                     bulk import, change to 0 once.
  // Realtime=1        → push each scan immediately (don't batch).
  // TransInterval=1   → 1-minute heartbeat via getrequest.
  const cfg = [
    `GET OPTION FROM: ${sn}`,
    'Stamp=9999',
    'ATTLOGStamp=9999',
    'OPERLOGStamp=9999',
    'ATTPHOTOStamp=None',
    'ErrorDelay=30',
    'Delay=10',
    'TransTimes=00:00;14:05',
    'TransInterval=1',
    'TransFlag=TransData AttLog OpLog',
    'TimeZone=5.5',
    'Realtime=1',
    'Encrypt=None',
    '',
  ].join('\n');
  sendText(res, 200, cfg);
});

/**
 * POST /iclock/cdata?SN=xxx&table=ATTLOG  → attendance log push
 * POST /iclock/cdata?SN=xxx&table=OPERLOG → operation log push
 *
 * Body is tab-separated plain text (one record per line). We acknowledge
 * with `OK: <count>` so the device knows it can purge from its buffer.
 */
export const pushData = asyncHandler(async (req, res) => {
  const sn = req.query.SN;
  const table = String(req.query.table || '').toUpperCase();
  const location = await findLocationBySerial(sn);
  if (!location) {
    errlog(`pushData: unknown serial ${sn}, table=${table}`);
    // Always 200 even when unregistered, so the device doesn't enter retry
    // storm. We just don't process the payload.
    return sendText(res, 200, 'OK');
  }

  if (table !== 'ATTLOG') {
    // OPERLOG (user enrollments, settings changes) and others — we just ack.
    log(`pushData SN=${sn} table=${table} bytes=${(req.body || '').length}`);
    await updateHeartbeat(location.id, {});
    return sendText(res, 200, 'OK');
  }

  const body = typeof req.body === 'string' ? req.body : '';
  const { rows, skipped } = parseAttLog(body);
  log(`ATTLOG SN=${sn} parsed=${rows.length} skipped=${skipped}`);

  if (rows.length === 0) {
    await updateHeartbeat(location.id, { error: skipped > 0 ? `parsed 0 of ${skipped} lines` : null });
    return sendText(res, 200, 'OK: 0');
  }

  // Build the device→app user map once per request.
  const userMap = await userModel.buildZktecoUserMapForLocation(location.id, pool);

  // We bypass the legacy reducer here: each ADMS push delivers one punch,
  // and appendBiometricPunch knows how to fold it into the sessions array
  // for that day (open new session vs close current). Pull-mode poller
  // continues to use the old reducer path.
  const toDateKey = (d) => {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  };
  const isLate = (d, officeStart) => {
    if (!officeStart) return false;
    const [h, m] = String(officeStart).split(':').map(Number);
    const cutoff = new Date(d);
    cutoff.setHours(h, m || 0, 0, 0);
    return d > cutoff;
  };

  let applied = 0;
  const unmappedToInsert = [];
  for (const punch of rows) {
    const user = userMap.get(punch.zktecoUserId);
    if (!user) {
      unmappedToInsert.push(punch);
      continue;
    }
    const isSecondary = !!(user.primary_site_id
      && location.site_id
      && String(user.primary_site_id) !== String(location.site_id));
    try {
      const record = await attendanceRecordModel.appendBiometricPunch(
        {
          userId: user.id,
          locationId: location.id,
          dateKey: toDateKey(punch.time),
          punchTime: punch.time,
          status: isLate(punch.time, location.office_start_time) ? 'LATE' : 'PRESENT',
          isSecondary,
          source: 'BIOMETRIC',
          raw: { line: punch.raw?.line, status: punch.type, verify: punch.verify, workcode: punch.workcode },
        },
        pool,
      );
      if (record) {
        applied++;
        try { emitAttendancePunch(record); } catch { /* socket.io optional */ }
        // Detailed FCM to admins for this single push punch (fire-and-forget).
        notifyAttendancePunch(record, { channel: 'BIOMETRIC_PUSH' });
      }
    } catch (err) {
      errlog(`append failed user=${user.id} punch=${punch.time?.toISOString()}: ${err.message}`);
    }
  }

  if (unmappedToInsert.length > 0) {
    const values = [];
    const placeholders = [];
    let i = 1;
    for (const u of unmappedToInsert) {
      placeholders.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++})`);
      values.push(location.id, u.zktecoUserId, u.time, u.type ?? null, u.raw ?? null);
    }
    try {
      await pool.query(
        `INSERT INTO zkteco_unmapped_punches (location_id, zkteco_user_id, punch_time, punch_type, raw)
         VALUES ${placeholders.join(', ')}`,
        values,
      );
    } catch (err) {
      errlog(`unmapped insert failed: ${err.message}`);
    }
  }

  await updateHeartbeat(location.id, { error: null });
  if (applied > 0) bustCache('cache:*:/api/attendance*').catch(() => null);

  sendText(res, 200, `OK: ${applied}`);
});

/**
 * GET /iclock/getrequest?SN=xxx&INFO=Ver=...,UserCount=...
 *
 * Heartbeat + command-poll. We have no commands to issue, so respond 200
 * with an empty body. We do scrape INFO for firmware + user count to
 * surface in the admin UI.
 */
export const getRequest = asyncHandler(async (req, res) => {
  const sn = req.query.SN;
  const info = parseDeviceInfo(req.query.INFO);
  const location = await findLocationBySerial(sn);
  if (!location) {
    return sendText(res, 200, 'OK');
  }

  await updateHeartbeat(location.id, {
    firmware: info.Ver || info.FWVer || null,
    userCount: info.UserCount != null ? parseInt(info.UserCount, 10) : undefined,
    punchCount: info.TransactionCount != null ? parseInt(info.TransactionCount, 10) : undefined,
  });

  // Time-sync: piggy-back on the heartbeat. We push a SET DateTime command
  // when last sync was > 6h ago (or never). Mark sync as sent immediately
  // (optimistic) so a chain of heartbeats during a slow ack can't repeat
  // it. If the device fails the command, the next 6h cycle re-issues.
  if (shouldSyncClock(location.adms_last_time_sync_at)) {
    await pool.query(
      `UPDATE attendance_locations SET adms_last_time_sync_at = NOW() WHERE id = $1`,
      [location.id],
    );
    const cmd = buildSetTimeCommand();
    log(`clock-sync → SN=${sn}: ${cmd}`);
    return sendText(res, 200, cmd);
  }

  // No commands queued. Device retries on TransInterval.
  sendText(res, 200, 'OK');
});

/**
 * POST /iclock/devicecmd?SN=xxx
 * Device returns command execution results. We don't issue commands but
 * the device protocol expects this endpoint to exist.
 */
export const deviceCmd = asyncHandler(async (req, res) => {
  sendText(res, 200, 'OK');
});

/** GET /iclock/ping — sanity check from a browser. */
export const ping = (req, res) => sendText(res, 200, 'iclock-ok');
