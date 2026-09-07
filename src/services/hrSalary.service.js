// One calculation for HR calendars, payroll review and immutable payment snapshots.
const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const dateKey = value => value instanceof Date
  ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
  : String(value || '').slice(0, 10);
const istDate = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));

export function confirmedWork(records, now = Date.now()) {
  const intervals = [];
  let review = false;
  for (const record of records) {
    const sessions = Array.isArray(record.sessions) && record.sessions.length ? record.sessions
      : record.check_in_time ? [{ in: record.check_in_time, out: record.check_out_time }] : [];
    for (const s of sessions) {
      const start = s.in ? Date.parse(s.in) : NaN;
      const end = s.out ? Date.parse(s.out) : NaN;
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end > now || s.auto_closed) { review = true; continue; }
      intervals.push([Math.floor(start / 60000), Math.floor(end / 60000)]);
    }
  }
  intervals.sort((a, b) => a[0] - b[0]);
  let minutes = 0, lastEnd = -Infinity;
  for (const [start, end] of intervals) {
    // Visits at overlapping locations count once.
    minutes += Math.max(0, end - Math.max(start, lastEnd));
    lastEnd = Math.max(lastEnd, end);
  }
  return { hours: minutes / 60, review };
}

export function computeMonthlySalary({ userId, year, month, hrSettings, monthlySalary, attendance = [], leaves = [], joinedAt = null, salaryHistory = [], now = Date.now() }) {
  if (!hrSettings) throw new Error('hrSettings is required');
  const mode = hrSettings.salary_basis === 'ATTENDANCE' ? 'ATTENDANCE' : 'TIME';
  const workingDays = hrSettings.working_days ?? [1, 2, 3, 4, 5, 6];
  const workingHours = Number(hrSettings.working_hours) > 0 ? Number(hrSettings.working_hours) : 9;
  const allowance = Math.max(0, Number(hrSettings.paid_leaves_per_month ?? 2));
  const holidays = new Map((hrSettings.holidays || []).map(h => [dateKey(h.date), h.name]));
  const today = istDate(now);
  const joined = joinedAt ? dateKey(joinedAt) : null;
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const attByDate = new Map();
  for (const r of attendance) { const key = dateKey(r.date); if (!attByDate.has(key)) attByDate.set(key, []); attByDate.get(key).push(r); }
  const leaveByDate = new Map(leaves.map(l => [dateKey(l.leave_date), l]));
  const history = [...salaryHistory].sort((a, b) => dateKey(b.effective_from).localeCompare(dateKey(a.effective_from)));
  let working = 0, present = 0, late = 0, half = 0, absent = 0, paidUsed = 0, paidRequested = 0, halfPaid = 0, unpaid = 0, weekoffs = 0, holidayCount = 0;
  let payableDays = 0, workedHours = 0, expectedHours = 0, reviewDays = 0, suggested = 0, gross = 0;
  const breakdown = [];
  for (let day = 1; day <= days; day++) {
    const key = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const dow = new Date(`${key}T12:00:00Z`).getUTCDay() || 7;
    const isHoliday = holidays.has(key), isWeekOff = !workingDays.includes(dow);
    const isWork = !isHoliday && !isWeekOff;
    const beforeJoin = joined && key < joined;
    const future = key > today;
    const rates = history.find(h => dateKey(h.effective_from) <= key && (!h.effective_to || dateKey(h.effective_to) >= key));
    const salary = history.length ? Number(rates?.monthly_salary || 0) : Number(monthlySalary || 0);
    const rate = salary / days;
    const records = attByDate.get(key) || [];
    const att = records.find(r => !r.is_secondary) || records[0];
    const work = confirmedWork(records, now);
    const lv = leaveByDate.get(key);
    let status, payable = 0;
    if (isWork && !beforeJoin) working++;
    if (beforeJoin) status = 'BEFORE_JOIN';
    else if (future) status = 'UPCOMING';
    else {
      gross += rate;
      workedHours += work.hours;
      if (work.review) reviewDays++;
      if (isWork) expectedHours += workingHours;
      if (!isWork) {
        payable = 1;
        if (isHoliday) holidayCount++; else weekoffs++;
        status = isHoliday ? 'HOLIDAY' : 'WEEK_OFF';
        if (work.hours > 0) status += '_WORKED';
      } else if (lv) {
        if (lv.leave_type === 'PAID' || lv.leave_type === 'HALF_PAID') {
          const requested = lv.leave_type === 'HALF_PAID' ? 0.5 : 1;
          paidRequested += requested;
          const granted = Math.min(requested, Math.max(0, allowance - paidUsed));
          paidUsed += granted; unpaid += requested - granted;
          if (requested === 0.5) halfPaid++;
          payable = granted;
          status = granted === 0 ? 'PAID_LEAVE_OVER' : requested === 0.5 ? 'HALF_PAID_LEAVE' : 'PAID_LEAVE';
          // A half-paid leave may accompany a worked half-day, capped at a day.
          if (requested === 0.5) payable += Math.min(0.5, work.hours / workingHours);
        } else { status = 'UNPAID_LEAVE'; unpaid++; }
      } else if (att && att.status !== 'ABSENT') {
        payable = mode === 'TIME' ? Math.min(1, work.hours / workingHours) : att.status === 'HALF_DAY' ? 0.5 : 1;
        // Unknown or incomplete scans never earn a full day by default.
        if (!['PRESENT', 'LATE', 'HALF_DAY'].includes(att.status)) payable = 0;
        status = payable === 0 ? 'INCOMPLETE' : payable < 1 ? 'HALF_DAY' : att.status === 'LATE' ? 'LATE' : 'PRESENT';
        if (att.status === 'LATE') late++;
        if (payable >= 1) present++; else if (payable > 0) half++;
      } else { status = 'ABSENT'; absent++; }
    }
    payable = Math.min(1, payable);
    const earned = rate * payable;
    suggested += earned; payableDays += payable;
    const starts = records.flatMap(r => Array.isArray(r.sessions) && r.sessions.length ? r.sessions.map(s => s.in).filter(Boolean) : [r.check_in_time].filter(Boolean)).sort();
    const ends = records.flatMap(r => Array.isArray(r.sessions) && r.sessions.length ? r.sessions.map(s => s.out).filter(Boolean) : [r.check_out_time].filter(Boolean)).sort();
    breakdown.push({ date: key, dow, status, payable: round2(payable), counts_in_working: isWork && !beforeJoin,
      check_in: starts[0] || null, check_out: ends.at(-1) || null, hours: round2(work.hours), needs_review: work.review,
      expected_hours: isWork && !beforeJoin && !future ? workingHours : 0,
      monthly_salary: salary, day_rate: round2(rate), earned_amount: round2(earned),
      deduction: round2(!beforeJoin && !future ? rate - earned : 0),
      holiday_name: holidays.get(key) || null, leave_id: lv?.id || null, leave_type: lv?.leave_type || null, leave_reason: lv?.reason || null });
  }
  return { user_id: userId, year, month, monthly_salary: Number(monthlySalary) || 0,
    calculation_version: 2, calculation_basis: mode, as_of: today, days_in_month: days, working_hours_per_day: workingHours,
    paid_leaves_allowance: allowance, paid_leaves_requested: paidRequested, paid_leaves_used: paidUsed,
    paid_leaves_over_allowance: round2(Math.max(0, paidRequested - paidUsed)), half_paid_leaves: halfPaid, unpaid_leaves: unpaid,
    holidays_count: holidayCount, weekoff_count: weekoffs, total_working_days: working,
    present_days: present, late_days: late, half_days: half, absent_days: absent,
    payable_days: round2(payableDays), per_day_rate: round2(Number(monthlySalary || 0) / days),
    worked_hours: round2(workedHours), expected_hours: round2(expectedHours), review_days: reviewDays,
    gross_amount: round2(gross), deduction_amount: round2(gross - suggested), suggested_amount: round2(suggested), breakdown };
}
