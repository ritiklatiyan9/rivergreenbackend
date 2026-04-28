// Pure reducer: ZKTeco punches → attendance record upserts.
//
// Why pure: the device IO is flaky and the DB write logic is the part that
// most often goes wrong (off-by-one in/out, dup scans, midnight crossings).
// Keeping reduction logic free of pool/socket/config makes it cheap to test.
//
// Input punches must be already filtered to *new* punches (by log id) before
// being passed in. The reducer does not deduplicate against the database.

const DEFAULT_DEBOUNCE_MS = 10_000;

const toDateKey = (d) => {
  // Local-date key (YYYY-MM-DD) — attendance is bucketed per local day.
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

const isLate = (punchTime, officeStart) => {
  if (!officeStart) return false;
  const [h, m] = String(officeStart).split(':').map(Number);
  const cutoff = new Date(punchTime);
  cutoff.setHours(h, m || 0, 0, 0);
  return punchTime > cutoff;
};

/**
 * Reduce raw ZKTeco punches into attendance record upserts.
 *
 * @param {Array<{zktecoUserId:number, time:Date, type?:number, raw?:object}>} punches
 * @param {{id:number, site_id?:string|null, office_start_time?:string}} location
 * @param {Map<number, {id:string, primary_site_id:string|null}>} userMap
 *        keyed by zkteco_user_id → app user
 * @param {{debounceMs?:number}} [opts]
 * @returns {{
 *   upserts: Array<{userId:string, locationId:number, dateKey:string, checkIn:Date, checkOut:Date|null, status:string, isSecondary:boolean, source:'BIOMETRIC', raw:object}>,
 *   unmapped: Array<{zktecoUserId:number, locationId:number, time:Date, type?:number, raw?:object}>
 * }}
 */
export function reducePunches(punches, location, userMap, opts = {}) {
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const upserts = [];
  const unmapped = [];

  // Group punches by (userId, dateKey) so each bucket reduces independently.
  const buckets = new Map();
  for (const p of punches) {
    const user = userMap.get(p.zktecoUserId);
    if (!user) {
      unmapped.push({
        zktecoUserId: p.zktecoUserId,
        locationId: location.id,
        time: p.time,
        type: p.type,
        raw: p.raw,
      });
      continue;
    }
    const key = `${user.id}::${toDateKey(p.time)}`;
    if (!buckets.has(key)) buckets.set(key, { user, items: [] });
    buckets.get(key).items.push(p);
  }

  for (const [, { user, items }] of buckets) {
    items.sort((a, b) => a.time - b.time);

    // Debounce: drop any punch within debounceMs of the previous accepted one.
    const accepted = [];
    for (const p of items) {
      const prev = accepted[accepted.length - 1];
      if (prev && p.time - prev.time < debounceMs) continue;
      accepted.push(p);
    }
    if (accepted.length === 0) continue;

    // Even index = check-in, odd = check-out. With an even count, the last
    // pair completes a record. With an odd count, the trailing in is open.
    // We collapse into a single record per (user, location, date), where
    // checkIn = earliest accepted, checkOut = latest accepted (or null when
    // there's only one punch for the day so far).
    const first = accepted[0];
    const last = accepted[accepted.length - 1];
    const checkIn = first.time;
    const checkOut = accepted.length > 1 ? last.time : null;

    const status = isLate(checkIn, location.office_start_time) ? 'LATE' : 'PRESENT';
    // Secondary = punch is at a site other than the user's primary site.
    // If either side is null we don't have enough info to call it secondary,
    // so it stays primary (safer default — admins can fix mappings later).
    const isSecondary = !!(user.primary_site_id
      && location.site_id
      && String(user.primary_site_id) !== String(location.site_id));

    upserts.push({
      userId: user.id,
      locationId: location.id,
      dateKey: toDateKey(checkIn),
      checkIn,
      checkOut,
      status,
      isSecondary,
      source: 'BIOMETRIC',
      raw: {
        first: first.raw ?? null,
        last: last.raw ?? null,
        punchCount: accepted.length,
      },
    });
  }

  return { upserts, unmapped };
}

export const __test__ = { toDateKey, isLate };
