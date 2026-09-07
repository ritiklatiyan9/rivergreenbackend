const isDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
export function validateSalaryInput(body, today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())) {
  const { monthly_salary: amount, effective_from: effective, joined_at: joined, notes } = body;
  if (!['string', 'number'].includes(typeof amount) || String(amount).trim() === '' || !Number.isFinite(Number(amount)) || Number(amount) < 0 || Number(amount) > 9999999999.99) return 'Monthly salary must be a valid amount between 0 and 9,999,999,999.99';
  if (effective && (!isDate(effective) || effective > today)) return 'Effective date must be a valid date on or before today';
  if (joined && (!isDate(joined) || joined > (effective || today))) return 'Joining date must be on or before the salary effective date';
  if (notes != null && (typeof notes !== 'string' || notes.length > 1000)) return 'Notes must be no longer than 1,000 characters';
  return null;
}
