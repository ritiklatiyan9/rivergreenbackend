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
 * @param {{debounceMs?:number, punchType?:number}} [opts]
 *   punchType — ZKTeco ATTLOG status: 0=check-in, 1=check-out, 4=OT-in, 5=OT-out.
 *   When punchType is 1 or 5 the open session is closed directly (no alternation).
 *   When punchType is absent or 0/4, temporal alternation is used (backward compat).
 * @returns {{sessions: Array<{in:string,out:string|null}>, changed: boolean}}
 */
export function appendPunchToSessions(sessions, punchTime, opts = {}) {
  const { debounceMs = DEFAULT_DEBOUNCE_MS, punchType } = opts;
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

  // Explicit check-out from the device — close the last open session directly.
  if (punchType === 1 || punchType === 5) {
    const openIdx = next.map((s, i) => ({ s, i })).reverse().find(({ s }) => !s.out)?.i;
    if (openIdx != null && punchMs > toMs(next[openIdx].in)) {
      next[openIdx].out = punchIso;
    } else {
      // No open session to close (e.g. double check-out scan) — record as new open session.
      next.push({ in: punchIso, out: null });
    }
    return { sessions: next, changed: true };
  }

  // Untyped or explicit check-in (type 0/4): temporal alternation.
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
