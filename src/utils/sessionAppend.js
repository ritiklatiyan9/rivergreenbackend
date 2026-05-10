// Pure session-alternation reducer.
//
// Takes the existing day's `sessions` array and one new punch, returns the
// updated array (or a no-op if the punch is a duplicate within the
// debounce window). Pure: no DB, no I/O — DB-touching code lives in
// AttendanceRecordModel.appendBiometricPunch.

const DEFAULT_DEBOUNCE_MS = 10_000;

const toMs = (iso) => (iso ? new Date(iso).getTime() : null);

/**
 * @param {Array<{in:string, out:string|null}>} sessions  current array
 * @param {Date} punchTime
 * @param {{debounceMs?:number}} [opts]
 * @returns {{sessions: Array<{in:string,out:string|null}>, changed: boolean}}
 */
export function appendPunchToSessions(sessions, punchTime, opts = {}) {
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const punchMs = punchTime.getTime();
  const punchIso = punchTime.toISOString();
  const cur = Array.isArray(sessions) ? sessions : [];

  for (const s of cur) {
    const inMs = toMs(s.in);
    const outMs = toMs(s.out);
    if ((inMs != null && Math.abs(inMs - punchMs) < debounceMs)
      || (outMs != null && Math.abs(outMs - punchMs) < debounceMs)) {
      return { sessions: cur, changed: false };
    }
  }

  const next = cur.map((s) => ({ ...s }));
  const last = next.length > 0 ? next[next.length - 1] : null;
  if (!last || last.out) {
    next.push({ in: punchIso, out: null });
  } else if (punchMs > toMs(last.in)) {
    last.out = punchIso;
  } else {
    // Out-of-order earlier punch: insert as its own session and re-sort.
    next.push({ in: punchIso, out: null });
    next.sort((a, b) => toMs(a.in) - toMs(b.in));
  }
  return { sessions: next, changed: true };
}

/** Convenience: extract the denormalized first-in / last-completed-out. */
export function denormalizeSessions(sessions) {
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return { firstIn: null, lastOut: null };
  }
  const firstIn = sessions[0].in || null;
  const completed = sessions.filter((s) => s.out);
  const lastOut = completed.length > 0 ? completed[completed.length - 1].out : null;
  return { firstIn, lastOut };
}
