import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMonthlySalary, confirmedWork } from '../services/hrSalary.service.js';
import { rebuildSessions } from '../utils/sessionAppend.js';
import { __test__ as punchDates } from '../utils/zktecoPunchReducer.js';
const policy = { working_days: [1,2,3,4,5,6,7], working_hours: 9, paid_leaves_per_month: 2 };
const now = Date.parse('2026-10-01T12:00:00+05:30');
const attendance = Array.from({ length: 30 }, (_, i) => { const date = `2026-09-${String(i + 1).padStart(2,'0')}`; return { date, status: 'PRESENT', sessions: [{ in: `${date}T09:00:00+05:30`, out: `${date}T18:00:00+05:30` }] }; });
const calc = extra => computeMonthlySalary({ userId: 'u', year: 2026, month: 9, monthlySalary: 30000, hrSettings: policy, attendance, now, ...extra });

test('full attendance pays exactly base salary, including paid weekoffs without double counting', () => {
  assert.equal(calc().suggested_amount, 30000);
  assert.equal(calc({ hrSettings: { ...policy, working_days: [1,2,3,4,5,6] } }).suggested_amount, 30000);
});
test('confirmed hours prorate pay and break time is excluded', () => {
  const record = { date: '2026-09-01', status: 'PRESENT', sessions: [{ in: '2026-09-01T09:00:00+05:30', out: '2026-09-01T11:00:00+05:30' }, { in: '2026-09-01T13:00:00+05:30', out: '2026-09-01T15:30:00+05:30' }] };
  const result = calc({ attendance: [record] });
  assert.equal(result.worked_hours, 4.5); assert.equal(result.suggested_amount, 500);
});
test('duplicate overlapping locations never double count time', () => {
  assert.equal(confirmedWork([attendance[0], { ...attendance[0], is_secondary: true }], now).hours, 9);
});
test('open and auto-closed sessions are flagged and do not earn time pay', () => {
  const rows = [{ ...attendance[0], sessions: [{ in: attendance[0].sessions[0].in, out: null }] }, { ...attendance[1], sessions: [{ ...attendance[1].sessions[0], auto_closed: true }] }];
  const result = calc({ attendance: rows }); assert.equal(result.suggested_amount, 0); assert.equal(result.review_days, 2);
});
test('future holidays and working dates do not accrue salary', () => {
  const result = calc({ now: Date.parse('2026-09-01T23:00:00+05:30'), hrSettings: { ...policy, working_days: [1,2,3,4,5], holidays: [{ date: '2026-09-02', name: 'Holiday' }] } });
  assert.equal(result.suggested_amount, 1000); assert.equal(result.breakdown[1].status, 'UPCOMING');
});
test('salary effective dates apply daily instead of repricing past attendance', () => {
  const result = calc({ salaryHistory: [{ monthly_salary: 12000, effective_from: '2026-09-01', effective_to: '2026-09-15' }, { monthly_salary: 30000, effective_from: '2026-09-16', effective_to: null }] });
  assert.equal(result.suggested_amount, 21000);
});
test('paid and half paid leave share one allowance', () => {
  const result = calc({ attendance: [], leaves: [{ leave_date: '2026-09-01', leave_type: 'PAID' }, { leave_date: '2026-09-02', leave_type: 'HALF_PAID' }, { leave_date: '2026-09-03', leave_type: 'PAID' }] });
  assert.equal(result.paid_leaves_used, 2); assert.equal(result.suggested_amount, 2000); assert.equal(result.paid_leaves_over_allowance, 0.5);
});
test('attendance mode remains configurable and hour-based overtime is capped', () => {
  const short = { ...attendance[0], sessions: [{ in: '2026-09-01T09:00:00+05:30', out: '2026-09-01T10:00:00+05:30' }] };
  assert.equal(calc({ attendance: [short], hrSettings: { ...policy, salary_basis: 'ATTENDANCE' } }).suggested_amount, 1000);
  assert.equal(calc({ attendance: [{ ...short, sessions: [{ in: '2026-09-01T06:00:00+05:30', out: '2026-09-01T22:00:00+05:30' }] }] }).suggested_amount, 1000);
});
const event = (hour, type = 0) => ({ punch_time: `2026-09-01T${String(hour).padStart(2,'0')}:00:00+05:30`, punch_type: type });
test('offline uploads and replayed duplicates rebuild the same sessions', () => {
  const ordered = [event(9), event(12), event(13), event(18)];
  assert.deepEqual(rebuildSessions([ordered[3], ordered[0], ordered[2], ordered[1], ordered[0]]), rebuildSessions(ordered));
  assert.equal(rebuildSessions(ordered).length, 2);
});
test('device direction ignores repeated IN and OUT, and preserves orphan checkout for review', () => {
  const sessions = rebuildSessions([event(9,0), event(10,0), event(12,1), event(13,1), event(14,0), event(18,1)], { mode: 'DEVICE' });
  assert.equal(sessions.length, 2); assert.equal(sessions[0].out, new Date(event(12).punch_time).toISOString());
  assert.equal(rebuildSessions([event(8,1)], { mode: 'DEVICE' })[0].needs_review, true);
  assert.equal(rebuildSessions([event(18,1), event(9,0)], { mode: 'DEVICE' })[0].in, new Date(event(9).punch_time).toISOString());
});
test('configured overnight shift keeps early checkout in the previous workday', () => {
  assert.equal(punchDates.toDateKey(new Date('2026-09-02T05:30:00+05:30'), { office_start_time: '20:00', office_end_time: '06:00' }), '2026-09-01');
  assert.equal(punchDates.toDateKey(new Date('2026-09-02T09:00:00+05:30')), '2026-09-02');
});

test('polling finds delayed punches even after the device counter resets', async () => {
  const { pendingPunches } = await import('../utils/pendingPunches.js');
  const userMap = new Map([[1, { id: 'u' }]]);
  const old = { zktecoUserId: 1, time: new Date('2026-09-01T09:00:00Z'), logId: 100 };
  const delayed = { zktecoUserId: 1, time: new Date('2026-08-31T09:00:00Z'), logId: 1 };
  const unknown = { zktecoUserId: 2, time: old.time, logId: 2 };
  assert.deepEqual(pendingPunches([old, delayed, unknown], userMap, [{ user_id: 'u', punch_time: old.time }], [{ zkteco_user_id: 2, punch_time: old.time }]), [delayed]);
});
