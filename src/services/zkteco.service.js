// Thin wrapper around `node-zklib` for ZKTeco K40 Pro devices.
//
// Why a wrapper:
//  - the upstream lib leaks sockets if you don't carefully createSocket /
//    disconnect around every call. We always pair them.
//  - we want each call wrapped in an explicit timeout so a flaky device
//    can never block the poller indefinitely.
//  - we serialize calls per location so the poller and an admin manual-sync
//    cannot stomp on the same socket.

import ZKLib from 'node-zklib';

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_INPORT = 4000;

const locks = new Map();   // locationId → Promise (in-flight op)

const withLock = (locationId, fn) => {
  const prev = locks.get(locationId) || Promise.resolve();
  const next = prev.catch(() => null).then(fn);
  locks.set(locationId, next.finally(() => {
    if (locks.get(locationId) === next) locks.delete(locationId);
  }));
  return next;
};

const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);

const buildClient = (location, opts = {}) => {
  const { zkteco_ip, zkteco_port } = location;
  if (!zkteco_ip) throw new Error('Device IP not configured');
  return new ZKLib(zkteco_ip, zkteco_port || 4370, opts.timeout || DEFAULT_TIMEOUT_MS, opts.inport || DEFAULT_INPORT);
};

const safeDisconnect = async (client) => {
  try { await client.disconnect(); } catch { /* ignore */ }
};

const connect = async (client) => {
  // node-zklib exposes createSocket(); failure usually means unreachable.
  await client.createSocket();
};

/**
 * Test connectivity to a single device. Returns a small status payload —
 * never throws (resolves with { ok:false, error } on failure).
 */
export const testConnection = async (location) => {
  return withLock(location.id, async () => {
    let client;
    try {
      client = buildClient(location);
      await withTimeout(connect(client), DEFAULT_TIMEOUT_MS, 'connect');
      const info = await withTimeout(client.getInfo(), DEFAULT_TIMEOUT_MS, 'getInfo').catch(() => null);
      const users = await withTimeout(client.getUsers(), DEFAULT_TIMEOUT_MS, 'getUsers').catch(() => ({ data: [] }));
      return {
        ok: true,
        info,
        userCount: Array.isArray(users?.data) ? users.data.length : 0,
      };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    } finally {
      if (client) await safeDisconnect(client);
    }
  });
};

/**
 * Pull all attendance logs from the device. Returns the lib's raw rows
 * normalized to { uid, userId, time, type, raw }.
 *
 * The K40 Pro returns the device's full ring buffer; the caller is
 * responsible for filtering against zkteco_last_log_id.
 */
export const fetchAttendances = async (location, { timeoutMs } = {}) => {
  return withLock(location.id, async () => {
    let client;
    try {
      client = buildClient(location, { timeout: timeoutMs || DEFAULT_TIMEOUT_MS });
      await withTimeout(connect(client), timeoutMs || DEFAULT_TIMEOUT_MS, 'connect');
      const res = await withTimeout(client.getAttendances(), 30_000, 'getAttendances');
      const rows = Array.isArray(res?.data) ? res.data : [];
      return rows.map((r, idx) => ({
        uid: r.userSn ?? r.uid ?? null,
        zktecoUserId: Number(r.deviceUserId ?? r.userId ?? r.id),
        time: r.recordTime ? new Date(r.recordTime) : (r.timestamp ? new Date(r.timestamp) : new Date()),
        type: r.type ?? r.state ?? null,
        // logId: prefer the lib's monotonically increasing index; fall back
        // to (epoch-millis * 1000 + index) so we can still ratchet
        // `zkteco_last_log_id` even when the lib doesn't expose one.
        logId: r.logId ?? r.recordTime
          ? new Date(r.recordTime).getTime() * 1000 + idx
          : Date.now() * 1000 + idx,
        raw: r,
      }));
    } finally {
      if (client) await safeDisconnect(client);
    }
  });
};

/**
 * Pull users defined on the device — used by the admin mapping UI.
 */
export const fetchDeviceUsers = async (location) => {
  return withLock(location.id, async () => {
    let client;
    try {
      client = buildClient(location);
      await withTimeout(connect(client), DEFAULT_TIMEOUT_MS, 'connect');
      const res = await withTimeout(client.getUsers(), 10_000, 'getUsers');
      const rows = Array.isArray(res?.data) ? res.data : [];
      return rows.map((r) => ({
        zktecoUserId: Number(r.userId ?? r.uid),
        name: r.name || '',
        cardNo: r.cardno ?? r.cardNo ?? null,
        role: r.role ?? null,
        raw: r,
      }));
    } finally {
      if (client) await safeDisconnect(client);
    }
  });
};

/**
 * Optional: clear the device's on-board log buffer after we've persisted it.
 * Not used in v1 — the K40 buffer is large and we filter by log id, so
 * leaving punches on the device is safer (re-sync after data corruption).
 */
export const clearAttendanceLog = async (location) => {
  return withLock(location.id, async () => {
    let client;
    try {
      client = buildClient(location);
      await withTimeout(connect(client), DEFAULT_TIMEOUT_MS, 'connect');
      await withTimeout(client.clearAttendanceLog(), 10_000, 'clearAttendanceLog');
      return { ok: true };
    } finally {
      if (client) await safeDisconnect(client);
    }
  });
};
