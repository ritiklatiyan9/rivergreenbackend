import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSalaryInput } from '../utils/salaryValidation.js';
const validate = body => validateSalaryInput(body, '2026-09-08');
test('accepts zero and decimal salary', () => {
  assert.equal(validate({ monthly_salary: 0 }), null);
  assert.equal(validate({ monthly_salary: '25000.50', effective_from: '2026-09-01', joined_at: '2026-01-01' }), null);
});
test('rejects non-numeric, blank, negative and overflowing salary', () => {
  for (const amount of [undefined, null, '', ' ', 'abc', NaN, Infinity, -1, 10000000000, [], true]) assert.ok(validate({ monthly_salary: amount }), String(amount));
});
test('rejects invalid dates, future effective dates and joining after effective date', () => {
  for (const effective_from of ['2026-02-30', 'bad', '2026-09-09']) assert.ok(validate({ monthly_salary: 10, effective_from }));
  assert.ok(validate({ monthly_salary: 10, joined_at: '2026-09-08', effective_from: '2026-09-01' }));
});
