// End-to-end test: spawn the mock ZKTeco device, drive the real
// services/zkteco.service.js against it, and assert that users +
// punches make it through the binary wire format intact, and that
// runtime-injected punches show up on the next fetch.
//
// Why this is in src/__tests__ rather than scripts/: it gets picked up
// by the existing `npm test` glob, so CI runs it alongside the reducer
// unit tests with no extra configuration.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, '..', '..');
const MOCK_SCRIPT = path.join(BACKEND_ROOT, 'scripts', 'zkteco-mock-server.js');

// Use ports that are unlikely to clash with a developer's running mock.
const TCP_PORT = 14370;
const HTTP_BASE = 'http://127.0.0.1:14371';

const LOC = { id: 1, zkteco_ip: '127.0.0.1', zkteco_port: TCP_PORT };

let mockProc;

const waitForHealthz = async (timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${HTTP_BASE}/healthz`);
      if (r.ok) return;
    } catch { /* not ready yet */ }
    await sleep(100);
  }
  throw new Error('mock server failed to come up within timeout');
};

before(async () => {
  mockProc = spawn(process.execPath, [MOCK_SCRIPT], {
    cwd: BACKEND_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      MOCK_TCP_PORT: String(TCP_PORT),
      MOCK_HTTP_PORT: '14371',
    },
  });
  // Surface mock crashes via stderr — silence stdout chatter unless DEBUG.
  if (process.env.DEBUG_MOCK) mockProc.stdout.on('data', (d) => process.stdout.write(d));
  mockProc.stderr.on('data', (d) => process.stderr.write(d));
  await waitForHealthz();
});

after(async () => {
  if (mockProc && !mockProc.killed) {
    mockProc.kill('SIGTERM');
    // Best-effort wait for the child to fully exit so Windows doesn't
    // leave the port pinned for the next test run.
    await new Promise((res) => mockProc.once('exit', res).unref());
  }
});

test('testConnection returns ok with the fixture user count', async () => {
  const { testConnection } = await import('../services/zkteco.service.js');
  const res = await testConnection(LOC);
  assert.equal(res.ok, true);
  assert.equal(res.userCount, 5);
  assert.equal(res.info.userCounts, 5);
  assert.equal(res.info.logCounts, 20);
});

test('fetchDeviceUsers decodes all 5 fixture users', async () => {
  const { fetchDeviceUsers } = await import('../services/zkteco.service.js');
  const users = await fetchDeviceUsers(LOC);
  assert.equal(users.length, 5);
  const ids = users.map((u) => u.zktecoUserId).sort((a, b) => a - b);
  assert.deepEqual(ids, [1001, 1002, 1003, 1004, 1005]);
  // Spot-check name decoding survived the binary round-trip.
  const alice = users.find((u) => u.zktecoUserId === 1001);
  assert.equal(alice.name, 'Alice Sharma');
});

test('fetchAttendances returns the 20 fixture punches with sane timestamps', async () => {
  const { fetchAttendances } = await import('../services/zkteco.service.js');
  const punches = await fetchAttendances(LOC);
  assert.equal(punches.length, 20);
  // Every punch should have a parseable Date and a known user id.
  const knownIds = new Set([1001, 1002, 1003, 1004, 1005]);
  for (const p of punches) {
    assert.ok(p.time instanceof Date && !isNaN(p.time.getTime()), 'time is a Date');
    assert.ok(knownIds.has(p.zktecoUserId), `user ${p.zktecoUserId} is in fixture`);
  }
});

test('runtime injection: a new punch appears on the next fetch', async () => {
  const { fetchAttendances } = await import('../services/zkteco.service.js');
  const before = await fetchAttendances(LOC);

  const r = await fetch(`${HTTP_BASE}/inject-punch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ zktecoUserId: 1001, type: 0 }),
  });
  assert.equal(r.status, 201);

  const after = await fetchAttendances(LOC);
  assert.equal(after.length, before.length + 1);
  // Newest punch is the one we just injected.
  const injected = after[after.length - 1];
  assert.equal(injected.zktecoUserId, 1001);
});

test('reset endpoint restores the original fixture', async () => {
  const { fetchAttendances } = await import('../services/zkteco.service.js');
  const r = await fetch(`${HTTP_BASE}/reset`, { method: 'POST' });
  assert.equal(r.status, 200);
  const punches = await fetchAttendances(LOC);
  assert.equal(punches.length, 20);
});

test('clearAttendanceLog empties the device buffer', async () => {
  const { clearAttendanceLog, fetchAttendances } = await import('../services/zkteco.service.js');
  await clearAttendanceLog(LOC);
  const punches = await fetchAttendances(LOC);
  assert.equal(punches.length, 0);
  // Restore for any later tests that import this file in the same run.
  await fetch(`${HTTP_BASE}/reset`, { method: 'POST' });
});
