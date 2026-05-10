// Pure parsers for ZKTeco ADMS (Push SDK) payloads.
//
// Why pure: the device IO is best tested separately from parsing — the
// parser is the part most likely to misinterpret a row and silently lose a
// punch.

// Configurable so non-IST deployments don't have to fork the code.
const TZ_OFFSET = process.env.ZKTECO_TZ_OFFSET || '+05:30';

const parseDeviceTime = (s) => {
  // Device emits "YYYY-MM-DD HH:MM:SS" in its own local time. We treat that
  // as the configured TZ_OFFSET so we store a correct UTC instant.
  const t = String(s || '').trim();
  if (!t) return null;
  const iso = t.replace(' ', 'T') + TZ_OFFSET;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
};

/**
 * Parse an ATTLOG body (one record per line, tab-separated):
 *   <userId>\t<YYYY-MM-DD HH:MM:SS>\t<status>\t<verify>\t<workcode>\t<reserved>\t<reserved>
 *
 * status: 0=check-in, 1=check-out, 2=break-out, 3=break-in, 4=ot-in, 5=ot-out
 * verify: 0=password, 1=fingerprint, 2=card, 15=face
 *
 * Returns { rows, skipped } so we can log how many lines were unparseable.
 * Each row matches the shape `reducePunches` already expects.
 */
export function parseAttLog(body) {
  if (!body || typeof body !== 'string') return { rows: [], skipped: 0 };
  const rows = [];
  let skipped = 0;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 2) { skipped++; continue; }
    const userId = parseInt(parts[0], 10);
    const time = parseDeviceTime(parts[1]);
    if (!Number.isFinite(userId) || !time) { skipped++; continue; }
    const status = parts[2] != null && parts[2] !== '' ? parseInt(parts[2], 10) : null;
    const verify = parts[3] != null && parts[3] !== '' ? parseInt(parts[3], 10) : null;
    const workcode = parts[4] != null && parts[4] !== '' ? parseInt(parts[4], 10) : null;
    rows.push({
      zktecoUserId: userId,
      time,
      type: Number.isFinite(status) ? status : null,
      verify: Number.isFinite(verify) ? verify : null,
      workcode: Number.isFinite(workcode) ? workcode : null,
      raw: { line, status, verify, workcode },
    });
  }
  return { rows, skipped };
}

/**
 * Parse the device's INFO query string from getrequest heartbeats.
 *
 * Two formats observed in the wild:
 *   1) Old: "Ver=6.60.1.0,Push=2.4.1.10,UserCount=12,FPCount=24"
 *   2) Newer (K40 Pro fw 8.x): "Ver 8.0.4.3-20230515,2,2,19,192.168.31.216,..."
 *      — positional CSV, with firmware prefixed by "Ver " (space, not =).
 *
 * For format 2 the only stable field is the firmware in slot 0; the
 * remaining slots vary by firmware family so we don't attempt to interpret
 * them.
 */
export function parseDeviceInfo(infoStr) {
  if (!infoStr) return {};
  const out = {};
  const parts = String(infoStr).split(/[,;]/);
  for (let i = 0; i < parts.length; i++) {
    const pair = parts[i];
    const eq = pair.indexOf('=');
    if (eq > 0) {
      const k = pair.slice(0, eq).trim();
      const v = pair.slice(eq + 1).trim();
      if (k) out[k] = v;
      continue;
    }
    // Positional fallback: slot 0 may be "Ver X.Y.Z" — recover the firmware.
    if (i === 0) {
      const m = pair.trim().match(/^Ver\s+(.+)$/i);
      if (m) out.Ver = m[1].trim();
    }
  }
  return out;
}

export const __test__ = { parseDeviceTime, TZ_OFFSET };
