import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDeviceDateTime, shouldSyncClock, buildSetTimeCommand, __test__ } from '../services/admsClockSync.js';

test('formatDeviceDateTime shifts to IST and pads digits', () => {
  // 2026-05-10T08:00:00Z = 13:30 IST
  const utc = new Date('2026-05-10T08:00:00Z');
  assert.equal(formatDeviceDateTime(utc, 330), '2026-05-10 13:30:00');
});

test('formatDeviceDateTime handles midnight rollover correctly', () => {
  // 2026-05-09T20:00:00Z = 2026-05-10 01:30 IST (next day)
  const utc = new Date('2026-05-09T20:00:00Z');
  assert.equal(formatDeviceDateTime(utc, 330), '2026-05-10 01:30:00');
});

test('formatDeviceDateTime supports non-IST offsets', () => {
  const utc = new Date('2026-05-10T08:00:00Z');
  assert.equal(formatDeviceDateTime(utc, 0), '2026-05-10 08:00:00');     // UTC
  assert.equal(formatDeviceDateTime(utc, -300), '2026-05-10 03:00:00');  // EST (UTC-5)
});

test('shouldSyncClock returns true if never synced', () => {
  assert.equal(shouldSyncClock(null), true);
  assert.equal(shouldSyncClock(undefined), true);
});

test('shouldSyncClock returns true if last sync was > 6h ago', () => {
  const now = new Date('2026-05-10T12:00:00Z');
  const sevenHoursAgo = new Date(now.getTime() - 7 * 3600 * 1000);
  assert.equal(shouldSyncClock(sevenHoursAgo, now), true);
});

test('shouldSyncClock returns false if last sync was recent', () => {
  const now = new Date('2026-05-10T12:00:00Z');
  const oneHourAgo = new Date(now.getTime() - 1 * 3600 * 1000);
  assert.equal(shouldSyncClock(oneHourAgo, now), false);
});

test('shouldSyncClock returns true on garbage input (defensive)', () => {
  assert.equal(shouldSyncClock('not-a-date'), true);
});

test('buildSetTimeCommand returns the K40 Pro SET DateTime format', () => {
  const fixed = new Date('2026-05-10T08:00:00Z');
  const cmd = buildSetTimeCommand(fixed, 330);
  assert.equal(cmd, 'C:1:SET OPTION DateTime=2026-05-10 13:30:00');
});

test('default sync interval is 6 hours', () => {
  assert.equal(__test__.SYNC_INTERVAL_MS, 6 * 60 * 60 * 1000);
});
