// Salary computation: pure function over (settings, salary, attendance, leaves).
// Reads-only — DB queries happen in the controller; this service is testable
// without a database. Returns the day-by-day breakdown the UI uses for the
// calendar, plus the aggregate suggestion the salary table consumes.

const HOLIDAY_KEY = 'HOLIDAY';
const WEEKOFF_KEY = 'WEEK_OFF';
const PAID_LEAVE  = 'PAID_LEAVE';
const HALF_LEAVE  = 'HALF_PAID_LEAVE';
const UNPAID_LEAVE = 'UNPAID_LEAVE';
const PRESENT     = 'PRESENT';
const LATE        = 'LATE';
const HALF_DAY    = 'HALF_DAY';
const ABSENT      = 'ABSENT';

// JS getDay(): 0=Sun..6=Sat. We use ISO 1=Mon..7=Sun in working_days.
const isoDow = (d) => {
  const js = d.getDay();
  return js === 0 ? 7 : js;
};

const ymd = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
};

// pg returns DATE columns as JS Date objects representing local-midnight in
// the server's tz; plain `String(date)` produces "Sat May 10 2026 …" which
// breaks YYYY-MM-DD matching. Use the local components instead — those
// preserve the actual stored calendar date regardless of server tz.
const toDateKey = (v) => {
  if (!v) return null;
  if (v instanceof Date) return ymd(v);
  const s = String(v);
  // ISO-ish string: take the YYYY-MM-DD prefix verbatim.
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // Fall back to parsing.
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) return ymd(parsed);
  return s.slice(0, 10);
};

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * @param {Object} args
 * @param {string} args.userId
 * @param {number} args.year                 - 4-digit
 * @param {number} args.month                - 1..12
 * @param {Object} args.hrSettings           - row from site_hr_settings
 * @param {number} args.monthlySalary        - active monthly_salary or 0
 * @param {Array}  args.attendance           - rows from attendance_records (date, status, check_in_time, check_out_time, is_secondary)
 * @param {Array}  args.leaves               - rows from hr_leave_records (leave_date, leave_type, reason)
 * @param {string} [args.joinedAt]           - YYYY-MM-DD; days before this don't count as working
 */
export function computeMonthlySalary({
  userId,
  year,
  month,
  hrSettings,
  monthlySalary,
  attendance = [],
  leaves = [],
  joinedAt = null,
}) {
  if (!hrSettings) {
    throw new Error('hrSettings is required');
  }

  const workingDays = Array.isArray(hrSettings.working_days) ? hrSettings.working_days : [1, 2, 3, 4, 5, 6];
  const paidLeaveAllowance = Number(hrSettings.paid_leaves_per_month ?? 2);

  const holidaysList = Array.isArray(hrSettings.holidays) ? hrSettings.holidays : [];
  const holidayMap = new Map();
  for (const h of holidaysList) {
    if (h && h.date) holidayMap.set(String(h.date).slice(0, 10), h.name || 'Holiday');
  }

  // Index attendance by date string. Prefer the primary (is_secondary=false)
  // record; fall back to a secondary one only if no primary exists.
  const attMap = new Map();
  for (const r of attendance) {
    const key = toDateKey(r.date);
    if (!key) continue;
    const existing = attMap.get(key);
    if (!existing || (existing.is_secondary && !r.is_secondary)) {
      attMap.set(key, r);
    }
  }

  // Index leaves by date.
  const leaveMap = new Map();
  for (const l of leaves) {
    const key = toDateKey(l.leave_date);
    if (key) leaveMap.set(key, l);
  }

  const joinDate = joinedAt ? new Date(`${String(joinedAt).slice(0, 10)}T00:00:00`) : null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const daysInMonth = new Date(year, month, 0).getDate();
  const breakdown = [];

  let totalWorkingDays = 0;
  let presentDays = 0;
  let lateDays = 0;
  let halfDays = 0;
  let absentDays = 0;
  let holidaysCount = 0;
  let weekoffCount = 0;
  let paidLeavesUsed = 0;        // capped at allowance for the calc
  let paidLeavesRequested = 0;   // raw count (UI shows "X over allowance")
  let halfPaidLeaves = 0;
  let unpaidLeaves = 0;
  let payableDays = 0;

  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(year, month - 1, day);
    const key = ymd(date);
    const dow = isoDow(date);
    const isFutureDay = date > today;
    const beforeJoin = joinDate ? date < joinDate : false;

    const isHoliday = holidayMap.has(key);
    const isWorkingDow = workingDays.includes(dow);
    const isWeekOff = !isWorkingDow;
    const att = attMap.get(key) || null;
    const lv = leaveMap.get(key) || null;

    let status = null;
    let payable = 0;          // 0 | 0.5 | 1
    let counts = true;        // does this day affect totalWorkingDays?

    if (beforeJoin) {
      status = 'BEFORE_JOIN';
      counts = false;
    } else if (isHoliday || isWeekOff) {
      // Paid regardless of attendance. Holidays falling on a working DOW
      // reduce the divisor (employee shouldn't be paid less because the
      // company gave a holiday).
      payable = 1;
      counts = false;
      if (isHoliday) holidaysCount += 1; else weekoffCount += 1;

      // If the user actually came in on a week-off / holiday, surface that
      // in the present/late/half counters AND mark the cell with a distinct
      // status so the calendar can show the extra-effort visually.
      if (att && att.status !== 'ABSENT') {
        if (att.status === 'HALF_DAY') halfDays += 1;
        else if (att.status === 'LATE') { lateDays += 1; presentDays += 1; }
        else presentDays += 1;
        status = isHoliday ? 'HOLIDAY_WORKED' : 'WEEK_OFF_WORKED';
      } else {
        status = isHoliday ? HOLIDAY_KEY : WEEKOFF_KEY;
      }
    } else {
      // Working day. Decide via leave override > attendance.
      totalWorkingDays += 1;
      counts = true;

      if (lv) {
        if (lv.leave_type === 'PAID') {
          paidLeavesRequested += 1;
          if (paidLeavesUsed < paidLeaveAllowance) {
            paidLeavesUsed += 1;
            status = PAID_LEAVE;
            payable = 1;
          } else {
            // Allowance exhausted — auto-treat as unpaid for the calc.
            status = `${PAID_LEAVE}_OVER`;
            unpaidLeaves += 1;
            payable = 0;
          }
        } else if (lv.leave_type === 'HALF_PAID') {
          halfPaidLeaves += 1;
          status = HALF_LEAVE;
          payable = 0.5;
        } else {
          unpaidLeaves += 1;
          status = UNPAID_LEAVE;
          payable = 0;
        }
      } else if (att) {
        if (att.status === 'HALF_DAY') {
          halfDays += 1;
          status = HALF_DAY;
          payable = 0.5;
        } else if (att.status === 'LATE') {
          lateDays += 1;
          presentDays += 1;
          status = LATE;
          payable = 1;
        } else if (att.status === 'PRESENT') {
          presentDays += 1;
          status = PRESENT;
          payable = 1;
        } else if (att.status === 'ABSENT') {
          absentDays += 1;
          status = ABSENT;
          payable = 0;
        } else {
          presentDays += 1;
          status = PRESENT;
          payable = 1;
        }
      } else {
        // No record on a working day:
        //   future day → not absent, just upcoming.
        //   past/today → absent.
        if (isFutureDay) {
          status = 'UPCOMING';
          payable = 0;
          // Don't count future days towards absent — but still in working days
          // so the divisor reflects the full month policy.
        } else {
          absentDays += 1;
          status = ABSENT;
          payable = 0;
        }
      }
    }

    payableDays += payable;

    breakdown.push({
      date: key,
      dow,                          // ISO 1..7
      status,                       // PRESENT | LATE | HALF_DAY | ABSENT | HOLIDAY | WEEK_OFF | PAID_LEAVE | HALF_PAID_LEAVE | UNPAID_LEAVE | PAID_LEAVE_OVER | UPCOMING | BEFORE_JOIN
      payable,
      counts_in_working: counts,
      check_in: att?.check_in_time || null,
      check_out: att?.check_out_time || null,
      hours: (att?.check_in_time && att?.check_out_time)
        ? round2((new Date(att.check_out_time) - new Date(att.check_in_time)) / 36e5)
        : null,
      holiday_name: isHoliday ? holidayMap.get(key) : null,
      leave_id: lv?.id || null,
      leave_type: lv?.leave_type || null,
      leave_reason: lv?.reason || null,
    });
  }

  const perDayRate = totalWorkingDays > 0 ? Number(monthlySalary) / totalWorkingDays : 0;
  const suggestedAmount = round2(perDayRate * payableDays);

  return {
    user_id: userId,
    year,
    month,
    monthly_salary: Number(monthlySalary) || 0,
    paid_leaves_allowance: paidLeaveAllowance,
    paid_leaves_requested: paidLeavesRequested,
    paid_leaves_used: paidLeavesUsed,
    paid_leaves_over_allowance: Math.max(0, paidLeavesRequested - paidLeavesUsed),
    half_paid_leaves: halfPaidLeaves,
    unpaid_leaves: unpaidLeaves,
    holidays_count: holidaysCount,
    weekoff_count: weekoffCount,
    total_working_days: totalWorkingDays,
    present_days: presentDays,
    late_days: lateDays,
    half_days: halfDays,
    absent_days: absentDays,
    payable_days: round2(payableDays),
    per_day_rate: round2(perDayRate),
    suggested_amount: suggestedAmount,
    breakdown,
  };
}
