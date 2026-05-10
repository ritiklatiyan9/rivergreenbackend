import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAttLog, parseDeviceInfo } from '../services/admsParser.js';

test('parseAttLog handles a typical ATTLOG body', () => {
  const body = [
    '101\t2026-05-10 09:30:45\t0\t1\t0\t0\t0',
    '102\t2026-05-10 09:31:12\t0\t15\t0\t0\t0',
    '101\t2026-05-10 18:05:01\t1\t1\t0\t0\t0',
  ].join('\n');
  const { rows, skipped } = parseAttLog(body);
  assert.equal(rows.length, 3);
  assert.equal(skipped, 0);
  assert.equal(rows[0].zktecoUserId, 101);
  assert.equal(rows[0].type, 0);
  assert.equal(rows[0].verify, 1);
  assert.ok(rows[0].time instanceof Date);
  assert.ok(!Number.isNaN(rows[0].time.getTime()));
});

test('parseAttLog skips malformed lines but keeps good ones', () => {
  const body = [
    '101\t2026-05-10 09:30:45\t0\t1',
    '',
    'garbage line without tabs',
    'abc\t2026-05-10 09:30:45',         // non-numeric userId
    '102\tnot-a-date\t0\t1',            // bad date
    '103\t2026-05-10 09:31:12\t0\t1',
  ].join('\n');
  const { rows, skipped } = parseAttLog(body);
  assert.equal(rows.length, 2);
  assert.equal(skipped, 3);
  assert.deepEqual(rows.map((r) => r.zktecoUserId), [101, 103]);
});

test('parseAttLog tolerates CRLF line endings (Windows-style devices)', () => {
  const body = '101\t2026-05-10 09:30:45\t0\t1\r\n102\t2026-05-10 09:31:12\t0\t1\r\n';
  const { rows } = parseAttLog(body);
  assert.equal(rows.length, 2);
});

test('parseAttLog returns empty for empty/null body', () => {
  assert.deepEqual(parseAttLog('').rows, []);
  assert.deepEqual(parseAttLog(null).rows, []);
  assert.deepEqual(parseAttLog(undefined).rows, []);
});

test('parseDeviceInfo handles the K40 Pro INFO format', () => {
  const info = parseDeviceInfo('Ver=Ver 6.60.1.0,Push=2.4.1.10,UserCount=12,FPCount=24,TransactionCount=345');
  assert.equal(info.Ver, 'Ver 6.60.1.0');
  assert.equal(info.Push, '2.4.1.10');
  assert.equal(info.UserCount, '12');
  assert.equal(info.TransactionCount, '345');
});

test('parseDeviceInfo handles empty/missing input', () => {
  assert.deepEqual(parseDeviceInfo(''), {});
  assert.deepEqual(parseDeviceInfo(null), {});
  assert.deepEqual(parseDeviceInfo('justastring'), {});
});
