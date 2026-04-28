import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reducePunches } from '../utils/zktecoPunchReducer.js';

const SITE_A = '00000000-0000-0000-0000-00000000aaaa';
const SITE_B = '00000000-0000-0000-0000-00000000bbbb';

const LOC = { id: 1, site_id: SITE_A, office_start_time: '10:00:00' };
const LOC_OTHER = { id: 2, site_id: SITE_B, office_start_time: '10:00:00' };

const u = (zktecoId, primarySite = SITE_A) =>
  [zktecoId, { id: `user-${zktecoId}`, primary_site_id: primarySite }];

const at = (h, m = 0, s = 0) => {
  const d = new Date('2026-04-27T00:00:00');
  d.setHours(h, m, s, 0);
  return d;
};

test('single punch becomes an open check-in (no checkOut)', () => {
  const userMap = new Map([u(101)]);
  const { upserts, unmapped } = reducePunches(
    [{ zktecoUserId: 101, time: at(9, 55), raw: { logId: 1 } }],
    LOC,
    userMap,
  );
  assert.equal(unmapped.length, 0);
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].userId, 'user-101');
  assert.equal(upserts[0].checkOut, null);
  assert.equal(upserts[0].status, 'PRESENT');
  assert.equal(upserts[0].isSecondary, false);
  assert.equal(upserts[0].source, 'BIOMETRIC');
});

test('two punches → checkIn = first, checkOut = second', () => {
  const userMap = new Map([u(101)]);
  const { upserts } = reducePunches(
    [
      { zktecoUserId: 101, time: at(9, 50) },
      { zktecoUserId: 101, time: at(18, 10) },
    ],
    LOC,
    userMap,
  );
  assert.equal(upserts.length, 1);
  assert.deepEqual(upserts[0].checkIn, at(9, 50));
  assert.deepEqual(upserts[0].checkOut, at(18, 10));
});

test('debounce: punches within 10s collapse to first', () => {
  const userMap = new Map([u(101)]);
  const { upserts } = reducePunches(
    [
      { zktecoUserId: 101, time: at(9, 0, 0) },
      { zktecoUserId: 101, time: at(9, 0, 5) },  // dup, dropped
      { zktecoUserId: 101, time: at(9, 0, 9) },  // dup, dropped
    ],
    LOC,
    userMap,
  );
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].checkOut, null, 'all 3 collapsed → still single open punch');
});

test('debounce does not collapse beyond the threshold', () => {
  const userMap = new Map([u(101)]);
  const { upserts } = reducePunches(
    [
      { zktecoUserId: 101, time: at(9, 0, 0) },
      { zktecoUserId: 101, time: at(9, 0, 11) }, // 11s later → kept
    ],
    LOC,
    userMap,
  );
  assert.equal(upserts.length, 1);
  assert.deepEqual(upserts[0].checkIn, at(9, 0, 0));
  assert.deepEqual(upserts[0].checkOut, at(9, 0, 11));
});

test('LATE detection: check-in after office_start_time', () => {
  const userMap = new Map([u(101)]);
  const { upserts } = reducePunches(
    [{ zktecoUserId: 101, time: at(10, 30) }],
    LOC,
    userMap,
  );
  assert.equal(upserts[0].status, 'LATE');
});

test('PRESENT when on time', () => {
  const userMap = new Map([u(101)]);
  const { upserts } = reducePunches(
    [{ zktecoUserId: 101, time: at(9, 59) }],
    LOC,
    userMap,
  );
  assert.equal(upserts[0].status, 'PRESENT');
});

test('secondary: punch at a site other than the user\'s primary site is flagged', () => {
  const userMap = new Map([u(101, SITE_A)]); // user's primary = site A
  const { upserts } = reducePunches(
    [{ zktecoUserId: 101, time: at(14, 0) }],
    LOC_OTHER,                                  // location at site B
    userMap,
  );
  assert.equal(upserts[0].isSecondary, true);
  assert.equal(upserts[0].locationId, LOC_OTHER.id);
});

test('primary: punch at primary site (any of its locations) is NOT secondary', () => {
  const userMap = new Map([u(101, SITE_A)]);
  const { upserts } = reducePunches(
    [{ zktecoUserId: 101, time: at(9, 0) }],
    LOC,                                        // location at site A
    userMap,
  );
  assert.equal(upserts[0].isSecondary, false);
});

test('user with no primary site set: never secondary', () => {
  const userMap = new Map([[101, { id: 'user-101', primary_site_id: null }]]);
  const { upserts } = reducePunches(
    [{ zktecoUserId: 101, time: at(9, 0) }],
    LOC_OTHER,
    userMap,
  );
  assert.equal(upserts[0].isSecondary, false);
});

test('location with no site_id: never secondary (avoid false positives during rollout)', () => {
  const userMap = new Map([u(101, SITE_A)]);
  const looseLoc = { id: 99, site_id: null, office_start_time: '10:00:00' };
  const { upserts } = reducePunches(
    [{ zktecoUserId: 101, time: at(9, 0) }],
    looseLoc,
    userMap,
  );
  assert.equal(upserts[0].isSecondary, false);
});

test('unmapped zkteco user → routed to unmapped, no upsert', () => {
  const userMap = new Map(); // empty
  const { upserts, unmapped } = reducePunches(
    [{ zktecoUserId: 999, time: at(9, 0), type: 0, raw: { logId: 7 } }],
    LOC,
    userMap,
  );
  assert.equal(upserts.length, 0);
  assert.equal(unmapped.length, 1);
  assert.equal(unmapped[0].zktecoUserId, 999);
  assert.equal(unmapped[0].locationId, LOC.id);
});

test('multiple users in same batch reduce independently', () => {
  const userMap = new Map([u(101), u(102)]);
  const { upserts } = reducePunches(
    [
      { zktecoUserId: 101, time: at(9, 0) },
      { zktecoUserId: 102, time: at(9, 5) },
      { zktecoUserId: 101, time: at(18, 0) },
      { zktecoUserId: 102, time: at(18, 30) },
    ],
    LOC,
    userMap,
  );
  assert.equal(upserts.length, 2);
  const u101 = upserts.find(r => r.userId === 'user-101');
  const u102 = upserts.find(r => r.userId === 'user-102');
  assert.deepEqual(u101.checkIn, at(9, 0));
  assert.deepEqual(u101.checkOut, at(18, 0));
  assert.deepEqual(u102.checkIn, at(9, 5));
  assert.deepEqual(u102.checkOut, at(18, 30));
});

test('punches across two days produce two upserts', () => {
  const userMap = new Map([u(101)]);
  const day1 = new Date('2026-04-27T09:00:00');
  const day2 = new Date('2026-04-28T09:30:00');
  const { upserts } = reducePunches(
    [
      { zktecoUserId: 101, time: day1 },
      { zktecoUserId: 101, time: day2 },
    ],
    LOC,
    userMap,
  );
  assert.equal(upserts.length, 2);
  assert.notEqual(upserts[0].dateKey, upserts[1].dateKey);
});

test('three punches: checkIn = earliest, checkOut = latest, raw.punchCount tracks all', () => {
  const userMap = new Map([u(101)]);
  const { upserts } = reducePunches(
    [
      { zktecoUserId: 101, time: at(9, 0), raw: { logId: 1 } },
      { zktecoUserId: 101, time: at(13, 0), raw: { logId: 2 } },
      { zktecoUserId: 101, time: at(18, 0), raw: { logId: 3 } },
    ],
    LOC,
    userMap,
  );
  assert.equal(upserts.length, 1);
  assert.deepEqual(upserts[0].checkIn, at(9, 0));
  assert.deepEqual(upserts[0].checkOut, at(18, 0));
  assert.equal(upserts[0].raw.punchCount, 3);
});
