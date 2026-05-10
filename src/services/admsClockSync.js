// Pure helpers for the ADMS clock-sync feature.
//
// We piggy-back on /iclock/getrequest: when a device's
// adms_last_time_sync_at is older than SYNC_INTERVAL_MS, the controller
// returns a `C:1:SET OPTION DateTime=...` command instead of an empty body.
// The device parses, executes, and ACKs via /iclock/devicecmd.

const SYNC_INTERVAL_MS = parseInt(process.env.ZKTECO_CLOCK_SYNC_INTERVAL_MS || '21600000', 10); // 6 hours
const TZ_OFFSET_MIN = parseInt(process.env.ZKTECO_TZ_OFFSET_MINUTES || '330', 10); // IST default

const pad = (n) => String(n).padStart(2, '0');

/**
 * Format a JS Date as "YYYY-MM-DD HH:MM:SS" in the device's local time.
 * The device displays whatever string we send — it doesn't apply a TZ shift —
 * so we pre-shift to its configured offset before formatting.
 */
export const formatDeviceDateTime = (d, offsetMinutes = TZ_OFFSET_MIN) => {
  const shifted = new Date(d.getTime() + offsetMinutes * 60_000);
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ` +
    `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`
  );
};

/** Decide whether to push a time-sync command on this heartbeat. */
export const shouldSyncClock = (lastSyncAt, now = new Date()) => {
  if (!lastSyncAt) return true;
  const last = new Date(lastSyncAt).getTime();
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= SYNC_INTERVAL_MS;
};

/** Build the SET DATETIME command body the device expects. */
export const buildSetTimeCommand = (now = new Date(), offsetMinutes = TZ_OFFSET_MIN) =>
  `C:1:SET OPTION DateTime=${formatDeviceDateTime(now, offsetMinutes)}`;

export const __test__ = { SYNC_INTERVAL_MS, TZ_OFFSET_MIN };
