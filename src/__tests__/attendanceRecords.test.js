import test from 'node:test';
import assert from 'node:assert/strict';
import { attendanceRecordModel } from '../models/Attendance.model.js';
import { userSalaryModel } from '../models/HR.model.js';

test('record search uses matching joined filters for summary and every page', async () => {
  const calls = [];
  const pool = { query: async (sql, values) => {
    calls.push({ sql, values });
    return calls.length === 1 ? { rows: [{ count: '26', present: '20', late: '6', active: '2' }] } : { rows: [{ id: 26 }] };
  } };
  const result = await attendanceRecordModel.findAllRecords({ page: 2, limit: 25, date: '2026-09-08', status: 'LATE', userId: 'u1', locationId: '2', search: 'A_100%' }, pool);
  assert.equal(result.total, 26); assert.equal(result.totalPages, 2); assert.equal(result.summary.active, '2');
  assert.deepEqual(calls[1].values.slice(0, -2), calls[0].values);
  assert.deepEqual(calls[1].values.slice(-2), [25, 25]);
  assert.equal(calls[0].values.at(-1), '%A\\_100\\%%');
  for (const c of calls) { assert.match(c.sql, /JOIN users u/); assert.match(c.sql, /JOIN attendance_locations al/); assert.match(c.sql, /u.name ILIKE/); assert.match(c.sql, /ar.status =/); }
  assert.match(calls[0].sql, /sessions -> -1 ->> 'out'/);
});

function salaryPool(current) {
  const calls = [];
  const client = { query: async (sql, values) => { calls.push({ sql, values }); if (sql.includes('effective_from::text')) return { rows: current ? [current] : [] }; return { rows: [{ id: 'salary', monthly_salary: 30000 }] }; }, release() { calls.push({ sql: 'RELEASE' }); } };
  return { calls, connect: async () => client };
}
const change = { userId: 'u', siteId: 's', monthlySalary: 30000, effectiveFrom: '2026-09-08' };
test('same-day salary correction does not create an inverted history interval', async () => {
  const pool = salaryPool({ id: 'salary', start_date: '2026-09-08' });
  await userSalaryModel.upsertActive(change, pool);
  assert.ok(pool.calls.some(c => c.sql.includes('SELECT id FROM users') && c.sql.includes('FOR UPDATE')));
  assert.ok(pool.calls.some(c => c.sql.includes('SET monthly_salary')));
  assert.ok(!pool.calls.some(c => c.sql.includes('SET effective_to') || c.sql.includes('INSERT INTO')));
  assert.ok(pool.calls.some(c => c.sql === 'COMMIT'));
});
test('salary revision before current effective date rolls back', async () => {
  const pool = salaryPool({ id: 'salary', start_date: '2026-09-09' });
  await assert.rejects(userSalaryModel.upsertActive(change, pool), e => e.statusCode === 409);
  assert.ok(pool.calls.some(c => c.sql === 'ROLLBACK'));
  assert.equal(pool.calls.at(-1).sql, 'RELEASE');
});
test('later salary revision closes old salary and inserts new salary atomically', async () => {
  const pool = salaryPool({ id: 'salary', start_date: '2026-09-01' });
  await userSalaryModel.upsertActive(change, pool);
  assert.ok(pool.calls.some(c => c.sql.includes('SET effective_to')));
  assert.ok(pool.calls.some(c => c.sql.includes('INSERT INTO')));
  assert.ok(pool.calls.some(c => c.sql === 'COMMIT'));
});
test('first biometric punch locks the attendance bucket before reading or inserting', async () => {
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    return sql.includes('SELECT id, sessions') ? { rows: [] } : { rows: [{ id: 1 }] };
  }, release() {} };
  const result = await attendanceRecordModel.appendBiometricPunch({ userId: 'u', locationId: 1, dateKey: '2026-09-08', punchTime: new Date('2026-09-08T09:00:00+05:30'), status: 'PRESENT', isSecondary: false, source: 'BIOMETRIC', raw: {} }, { connect: async () => client });
  assert.equal(result.id, 1);
  const lock = calls.findIndex(c => c.sql.includes('pg_advisory_xact_lock'));
  const read = calls.findIndex(c => c.sql.includes('SELECT id, sessions'));
  assert.ok(lock > 0 && lock < read);
  assert.deepEqual(calls[lock].values, ['["u","1","2026-09-08"]']);
  assert.equal(calls.at(-1).sql, 'COMMIT');
});
