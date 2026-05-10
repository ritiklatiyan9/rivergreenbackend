import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendPunchToSessions, denormalizeSessions } from '../utils/sessionAppend.js';

const at = (h, m = 0, s = 0) => {
  const d = new Date('2026-05-10T00:00:00Z');
  d.setUTCHours(h, m, s, 0);
  return d;
};

test('first punch starts session 1 with in only', () => {
  const { sessions, changed } = appendPunchToSessions([], at(9));
  assert.equal(changed, true);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].in, at(9).toISOString());
  assert.equal(sessions[0].out, null);
});

test('second punch closes the open session', () => {
  const initial = [{ in: at(9).toISOString(), out: null }];
  const { sessions, changed } = appendPunchToSessions(initial, at(13));
  assert.equal(changed, true);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].in, at(9).toISOString());
  assert.equal(sessions[0].out, at(13).toISOString());
});

test('third punch starts session 2 (back from lunch)', () => {
  const initial = [{ in: at(9).toISOString(), out: at(13).toISOString() }];
  const { sessions, changed } = appendPunchToSessions(initial, at(14, 30));
  assert.equal(changed, true);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[1].in, at(14, 30).toISOString());
  assert.equal(sessions[1].out, null);
});

test('fourth punch closes session 2 (end of day)', () => {
  const initial = [
    { in: at(9).toISOString(), out: at(13).toISOString() },
    { in: at(14, 30).toISOString(), out: null },
  ];
  const { sessions, changed } = appendPunchToSessions(initial, at(19));
  assert.equal(changed, true);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[1].out, at(19).toISOString());
});

test('full day with three visits in/out/in/out/in/out', () => {
  let sessions = [];
  for (const t of [at(9), at(13), at(14, 30), at(17), at(17, 30), at(19)]) {
    ({ sessions } = appendPunchToSessions(sessions, t));
  }
  assert.equal(sessions.length, 3);
  assert.deepEqual(sessions.map((s) => [s.in, s.out]), [
    [at(9).toISOString(),     at(13).toISOString()],
    [at(14, 30).toISOString(), at(17).toISOString()],
    [at(17, 30).toISOString(), at(19).toISOString()],
  ]);
});

test('duplicate punch within debounce is ignored (idempotent)', () => {
  const initial = [{ in: at(9, 0, 0).toISOString(), out: null }];
  const { sessions, changed } = appendPunchToSessions(initial, at(9, 0, 5));
  assert.equal(changed, false);
  assert.deepEqual(sessions, initial);
});

test('out-of-order earlier punch creates new earlier session and re-sorts', () => {
  // Open session at 10:00; a delayed punch from 8:00 arrives.
  const initial = [{ in: at(10).toISOString(), out: null }];
  const { sessions, changed } = appendPunchToSessions(initial, at(8));
  assert.equal(changed, true);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].in, at(8).toISOString());
  assert.equal(sessions[1].in, at(10).toISOString());
});

test('denormalizeSessions returns first-in and last-completed-out', () => {
  const sessions = [
    { in: at(9).toISOString(),  out: at(13).toISOString() },
    { in: at(14).toISOString(), out: at(19).toISOString() },
  ];
  const { firstIn, lastOut } = denormalizeSessions(sessions);
  assert.equal(firstIn, at(9).toISOString());
  assert.equal(lastOut, at(19).toISOString());
});

test('denormalizeSessions returns null lastOut when last session is open', () => {
  const sessions = [
    { in: at(9).toISOString(),  out: at(13).toISOString() },
    { in: at(14).toISOString(), out: null },
  ];
  const { firstIn, lastOut } = denormalizeSessions(sessions);
  assert.equal(firstIn, at(9).toISOString());
  assert.equal(lastOut, at(13).toISOString()); // last *completed* out
});

test('denormalizeSessions handles empty/undefined', () => {
  assert.deepEqual(denormalizeSessions([]), { firstIn: null, lastOut: null });
  assert.deepEqual(denormalizeSessions(null), { firstIn: null, lastOut: null });
  assert.deepEqual(denormalizeSessions(undefined), { firstIn: null, lastOut: null });
});
