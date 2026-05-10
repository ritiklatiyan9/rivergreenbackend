import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { bustCache } from '../middlewares/cache.middleware.js';
import {
  hrSettingsModel,
  userSalaryModel,
  hrLeaveModel,
  salaryPaymentModel,
} from '../models/HR.model.js';
import { computeMonthlySalary } from '../services/hrSalary.service.js';

// ── shared helpers ───────────────────────────────────────────

// Resolve the site the request operates on. Admin/Owner can pass x-site-id
// (honored by auth middleware → req.user.site_id). Block calls with no site.
const requireSiteId = (req, res) => {
  const siteId = req.user?.site_id || null;
  if (!siteId) {
    res.status(400).json({ success: false, message: 'No site context. Set x-site-id header or assign user to a site.' });
    return null;
  }
  return siteId;
};

const validYearMonth = (y, m) => {
  const yy = parseInt(y, 10);
  const mm = parseInt(m, 10);
  if (!yy || !mm || yy < 2000 || yy > 2100 || mm < 1 || mm > 12) return null;
  return { year: yy, month: mm };
};

// Bracket a (year, month) so we can fetch attendance & leaves in one go.
const monthBounds = (year, month) => {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const end = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { start, end };
};

const fetchAttendanceForUserMonth = async (userId, year, month, pool_) => {
  const { start, end } = monthBounds(year, month);
  const r = await pool_.query(
    `SELECT date, status, check_in_time, check_out_time, is_secondary
     FROM attendance_records
     WHERE user_id = $1 AND date BETWEEN $2 AND $3`,
    [userId, start, end],
  );
  return r.rows;
};

const fetchLeavesForUserMonth = async (userId, year, month, pool_) => {
  const { start, end } = monthBounds(year, month);
  return hrLeaveModel.findInRange({ userId, startDate: start, endDate: end }, pool_);
};

// ═══════════════════════════════════════════════════════
// HR SETTINGS
// ═══════════════════════════════════════════════════════

export const getSettings = asyncHandler(async (req, res) => {
  const siteId = requireSiteId(req, res);
  if (!siteId) return;
  const settings = await hrSettingsModel.findOrCreateBySite(siteId, req.user.id, pool);
  res.json({ success: true, settings });
});

export const updateSettings = asyncHandler(async (req, res) => {
  const siteId = requireSiteId(req, res);
  if (!siteId) return;
  const {
    working_days, working_hours, work_start_time, work_end_time,
    paid_leaves_per_month, half_day_threshold_hours, late_grace_minutes,
    holidays,
  } = req.body;

  const updates = { updated_by: req.user.id };
  if (working_days !== undefined) {
    if (!Array.isArray(working_days) || working_days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
      return res.status(400).json({ success: false, message: 'working_days must be integers 1..7 (Mon..Sun)' });
    }
    updates.working_days = working_days;
  }
  if (working_hours !== undefined) updates.working_hours = Number(working_hours);
  if (work_start_time !== undefined) updates.work_start_time = work_start_time;
  if (work_end_time !== undefined) updates.work_end_time = work_end_time;
  if (paid_leaves_per_month !== undefined) updates.paid_leaves_per_month = parseInt(paid_leaves_per_month, 10);
  if (half_day_threshold_hours !== undefined) updates.half_day_threshold_hours = Number(half_day_threshold_hours);
  if (late_grace_minutes !== undefined) updates.late_grace_minutes = parseInt(late_grace_minutes, 10);
  if (holidays !== undefined) {
    if (!Array.isArray(holidays)) {
      return res.status(400).json({ success: false, message: 'holidays must be an array of {date, name}' });
    }
    updates.holidays = JSON.stringify(holidays);
  }

  const settings = await hrSettingsModel.upsertBySite(siteId, updates, pool);
  bustCache('cache:*:/api/hr*');
  res.json({ success: true, settings });
});

// ═══════════════════════════════════════════════════════
// USER SALARIES
// ═══════════════════════════════════════════════════════

export const listSalaries = asyncHandler(async (req, res) => {
  const siteId = req.user?.site_id || null;
  const { search } = req.query;
  const rows = await userSalaryModel.listAllWithActiveSalary({ siteId, search }, pool);
  res.json({ success: true, users: rows });
});

export const getUserSalary = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const u = await pool.query(`SELECT id, name, email, role, profile_photo, site_id FROM users WHERE id = $1`, [userId]);
  if (!u.rows[0]) return res.status(404).json({ success: false, message: 'User not found' });
  const active = await userSalaryModel.findActive(userId, pool);
  const history = await userSalaryModel.findHistory(userId, pool);
  res.json({ success: true, user: u.rows[0], active, history });
});

export const updateUserSalary = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { monthly_salary, effective_from, joined_at, notes } = req.body;
  if (monthly_salary === undefined || monthly_salary === null || Number(monthly_salary) < 0) {
    return res.status(400).json({ success: false, message: 'monthly_salary is required and must be >= 0' });
  }
  const u = await pool.query(`SELECT id, site_id FROM users WHERE id = $1`, [userId]);
  if (!u.rows[0]) return res.status(404).json({ success: false, message: 'User not found' });
  const siteId = u.rows[0].site_id || req.user.site_id;
  if (!siteId) return res.status(400).json({ success: false, message: 'User has no site assignment' });

  const row = await userSalaryModel.upsertActive({
    userId,
    siteId,
    monthlySalary: Number(monthly_salary),
    effectiveFrom: effective_from || null,
    joinedAt: joined_at || null,
    notes: notes || null,
    createdBy: req.user.id,
  }, pool);
  bustCache('cache:*:/api/hr*');
  res.json({ success: true, salary: row });
});

// ═══════════════════════════════════════════════════════
// HR ATTENDANCE CALENDAR + LEAVES
// ═══════════════════════════════════════════════════════

export const getAttendanceCalendar = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const yYm = validYearMonth(req.query.year, req.query.month);
  if (!yYm) return res.status(400).json({ success: false, message: 'year and month are required' });

  const u = await pool.query(`SELECT id, name, email, role, profile_photo, site_id FROM users WHERE id = $1`, [userId]);
  if (!u.rows[0]) return res.status(404).json({ success: false, message: 'User not found' });
  const siteId = u.rows[0].site_id || req.user.site_id;

  const settings = await hrSettingsModel.findOrCreateBySite(siteId, req.user.id, pool);
  const active = await userSalaryModel.findActive(userId, pool);
  const attendance = await fetchAttendanceForUserMonth(userId, yYm.year, yYm.month, pool);
  const leaves = await fetchLeavesForUserMonth(userId, yYm.year, yYm.month, pool);

  const result = computeMonthlySalary({
    userId,
    year: yYm.year,
    month: yYm.month,
    hrSettings: settings,
    monthlySalary: active?.monthly_salary || 0,
    attendance,
    leaves,
    joinedAt: active?.joined_at || null,
  });

  res.json({
    success: true,
    user: u.rows[0],
    settings,
    active_salary: active,
    ...result,
  });
});

export const upsertLeave = asyncHandler(async (req, res) => {
  const { user_id, leave_date, leave_type, reason } = req.body;
  if (!user_id || !leave_date || !leave_type) {
    return res.status(400).json({ success: false, message: 'user_id, leave_date and leave_type are required' });
  }
  if (!['PAID', 'UNPAID', 'HALF_PAID'].includes(leave_type)) {
    return res.status(400).json({ success: false, message: 'leave_type must be PAID, UNPAID or HALF_PAID' });
  }
  const u = await pool.query(`SELECT id, site_id FROM users WHERE id = $1`, [user_id]);
  if (!u.rows[0]) return res.status(404).json({ success: false, message: 'User not found' });
  const siteId = u.rows[0].site_id || req.user.site_id;

  const row = await hrLeaveModel.upsert({
    userId: user_id,
    siteId,
    leaveDate: leave_date,
    leaveType: leave_type,
    reason,
    markedBy: req.user.id,
  }, pool);
  bustCache('cache:*:/api/hr*');
  res.status(201).json({ success: true, leave: row });
});

export const deleteLeave = asyncHandler(async (req, res) => {
  const { user_id, leave_date } = req.query;
  if (!user_id || !leave_date) {
    return res.status(400).json({ success: false, message: 'user_id and leave_date are required' });
  }
  const removed = await hrLeaveModel.deleteByUserDate({ userId: user_id, leaveDate: leave_date }, pool);
  if (!removed) return res.status(404).json({ success: false, message: 'Leave not found' });
  bustCache('cache:*:/api/hr*');
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════
// PAYROLL SUGGESTION
// ═══════════════════════════════════════════════════════

export const suggestPayrollAll = asyncHandler(async (req, res) => {
  const yYm = validYearMonth(req.query.year, req.query.month);
  if (!yYm) return res.status(400).json({ success: false, message: 'year and month are required' });
  const siteId = req.user?.site_id || null;

  const settings = siteId ? await hrSettingsModel.findOrCreateBySite(siteId, req.user.id, pool) : null;
  if (!settings) return res.status(400).json({ success: false, message: 'Site HR settings missing' });

  // Pull every active user with a salary set (and any user with attendance
  // in the month — but those without a salary will show monthly_salary=0).
  const usersRes = await pool.query(
    `SELECT u.id, u.name, u.email, u.role, u.profile_photo,
            us.monthly_salary, us.joined_at
     FROM users u
     LEFT JOIN user_salaries us ON us.user_id = u.id AND us.effective_to IS NULL
     WHERE u.is_active = true
       AND u.role IN ('ADMIN','SUPERVISOR','TEAM_HEAD','AGENT')
       ${siteId ? `AND u.site_id = $1` : ``}
     ORDER BY u.name ASC`,
    siteId ? [siteId] : [],
  );

  const userIds = usersRes.rows.map((u) => u.id);
  const { start, end } = monthBounds(yYm.year, yYm.month);

  // One round-trip for attendance + leaves across all users in the month.
  const [attRes, lvRes, payRes] = await Promise.all([
    pool.query(
      `SELECT user_id, date, status, check_in_time, check_out_time, is_secondary
       FROM attendance_records
       WHERE date BETWEEN $1 AND $2 AND user_id = ANY($3::uuid[])`,
      [start, end, userIds],
    ),
    pool.query(
      `SELECT user_id, id, leave_date, leave_type, reason
       FROM hr_leave_records
       WHERE leave_date BETWEEN $1 AND $2 AND user_id = ANY($3::uuid[])`,
      [start, end, userIds],
    ),
    pool.query(
      `SELECT * FROM salary_payments
       WHERE period_year = $1 AND period_month = $2 AND user_id = ANY($3::uuid[])`,
      [yYm.year, yYm.month, userIds],
    ),
  ]);

  const attByUser = new Map();
  for (const r of attRes.rows) {
    if (!attByUser.has(r.user_id)) attByUser.set(r.user_id, []);
    attByUser.get(r.user_id).push(r);
  }
  const lvByUser = new Map();
  for (const r of lvRes.rows) {
    if (!lvByUser.has(r.user_id)) lvByUser.set(r.user_id, []);
    lvByUser.get(r.user_id).push(r);
  }
  const payByUser = new Map();
  for (const r of payRes.rows) payByUser.set(r.user_id, r);

  const rows = usersRes.rows.map((u) => {
    const calc = computeMonthlySalary({
      userId: u.id,
      year: yYm.year,
      month: yYm.month,
      hrSettings: settings,
      monthlySalary: u.monthly_salary || 0,
      attendance: attByUser.get(u.id) || [],
      leaves: lvByUser.get(u.id) || [],
      joinedAt: u.joined_at,
    });
    const payment = payByUser.get(u.id) || null;
    return {
      user: { id: u.id, name: u.name, email: u.email, role: u.role, profile_photo: u.profile_photo },
      monthly_salary: u.monthly_salary,
      summary: {
        total_working_days: calc.total_working_days,
        present_days: calc.present_days,
        late_days: calc.late_days,
        half_days: calc.half_days,
        absent_days: calc.absent_days,
        paid_leaves_used: calc.paid_leaves_used,
        unpaid_leaves: calc.unpaid_leaves,
        payable_days: calc.payable_days,
        per_day_rate: calc.per_day_rate,
        suggested_amount: calc.suggested_amount,
      },
      payment,
    };
  });

  res.json({ success: true, year: yYm.year, month: yYm.month, settings, rows });
});

export const suggestPayrollUser = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const yYm = validYearMonth(req.query.year, req.query.month);
  if (!yYm) return res.status(400).json({ success: false, message: 'year and month are required' });

  const u = await pool.query(`SELECT id, name, email, role, profile_photo, site_id FROM users WHERE id = $1`, [userId]);
  if (!u.rows[0]) return res.status(404).json({ success: false, message: 'User not found' });
  const siteId = u.rows[0].site_id || req.user.site_id;
  const settings = await hrSettingsModel.findOrCreateBySite(siteId, req.user.id, pool);
  const active = await userSalaryModel.findActive(userId, pool);
  const attendance = await fetchAttendanceForUserMonth(userId, yYm.year, yYm.month, pool);
  const leaves = await fetchLeavesForUserMonth(userId, yYm.year, yYm.month, pool);

  const calc = computeMonthlySalary({
    userId,
    year: yYm.year,
    month: yYm.month,
    hrSettings: settings,
    monthlySalary: active?.monthly_salary || 0,
    attendance,
    leaves,
    joinedAt: active?.joined_at || null,
  });

  const payment = await salaryPaymentModel.findByPeriod({ userId, year: yYm.year, month: yYm.month }, pool);
  res.json({ success: true, user: u.rows[0], settings, active_salary: active, payment, ...calc });
});

// ═══════════════════════════════════════════════════════
// SALARY PAYMENTS
// ═══════════════════════════════════════════════════════

export const recordPayment = asyncHandler(async (req, res) => {
  const {
    user_id, period_year, period_month,
    amount, payment_method, payment_date,
    transaction_ref, notes, status,
  } = req.body;

  if (!user_id || !period_year || !period_month || amount == null) {
    return res.status(400).json({ success: false, message: 'user_id, period_year, period_month and amount are required' });
  }
  if (Number(amount) < 0) {
    return res.status(400).json({ success: false, message: 'amount must be >= 0' });
  }
  const yYm = validYearMonth(period_year, period_month);
  if (!yYm) return res.status(400).json({ success: false, message: 'invalid period_year/period_month' });

  const u = await pool.query(`SELECT id, site_id FROM users WHERE id = $1`, [user_id]);
  if (!u.rows[0]) return res.status(404).json({ success: false, message: 'User not found' });
  const siteId = u.rows[0].site_id || req.user.site_id;

  const dup = await salaryPaymentModel.findByPeriod({ userId: user_id, year: yYm.year, month: yYm.month }, pool);
  if (dup) {
    return res.status(409).json({ success: false, message: 'A payment already exists for this user and period', payment: dup });
  }

  // Snapshot the calculation at the moment of payment so history doesn't
  // drift if attendance/leaves are edited later.
  const settings = await hrSettingsModel.findOrCreateBySite(siteId, req.user.id, pool);
  const active = await userSalaryModel.findActive(user_id, pool);
  const attendance = await fetchAttendanceForUserMonth(user_id, yYm.year, yYm.month, pool);
  const leaves = await fetchLeavesForUserMonth(user_id, yYm.year, yYm.month, pool);
  const calc = computeMonthlySalary({
    userId: user_id, year: yYm.year, month: yYm.month,
    hrSettings: settings, monthlySalary: active?.monthly_salary || 0,
    attendance, leaves, joinedAt: active?.joined_at || null,
  });

  const row = await salaryPaymentModel.create({
    user_id,
    site_id: siteId,
    period_year: yYm.year,
    period_month: yYm.month,
    amount: Number(amount),
    suggested_amount: calc.suggested_amount,
    monthly_salary_snapshot: active?.monthly_salary || 0,
    payable_days: calc.payable_days,
    total_working_days: calc.total_working_days,
    present_days: calc.present_days,
    absent_days: calc.absent_days,
    half_days: calc.half_days,
    paid_leaves_used: calc.paid_leaves_used,
    payment_method: payment_method || 'BANK_TRANSFER',
    payment_date: payment_date || new Date().toISOString().slice(0, 10),
    status: status || 'COMPLETED',
    transaction_ref: transaction_ref || null,
    notes: notes || null,
    paid_by: req.user.id,
  }, pool);

  bustCache('cache:*:/api/hr*');
  res.status(201).json({ success: true, payment: row });
});

export const listPayments = asyncHandler(async (req, res) => {
  const { page, limit, userId, year, month, status } = req.query;
  const siteId = req.user?.site_id || null;
  const data = await salaryPaymentModel.list({
    page: parseInt(page) || 1,
    limit: parseInt(limit) || 20,
    userId: userId || null,
    year: year ? parseInt(year, 10) : null,
    month: month ? parseInt(month, 10) : null,
    status: status || null,
    siteId,
  }, pool);
  res.json({ success: true, ...data });
});

export const getPayment = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const r = await pool.query(
    `SELECT sp.*, u.name AS user_name, u.email AS user_email, u.role AS user_role, u.profile_photo,
            pb.name AS paid_by_name
     FROM salary_payments sp
     JOIN users u ON u.id = sp.user_id
     LEFT JOIN users pb ON pb.id = sp.paid_by
     WHERE sp.id = $1`,
    [id],
  );
  if (!r.rows[0]) return res.status(404).json({ success: false, message: 'Payment not found' });
  res.json({ success: true, payment: r.rows[0] });
});

export const updatePaymentStatus = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status, notes } = req.body;
  if (!['PENDING', 'COMPLETED', 'FAILED', 'CANCELLED'].includes(status)) {
    return res.status(400).json({ success: false, message: 'invalid status' });
  }
  const updates = { status, updated_at: new Date() };
  if (notes !== undefined) updates.notes = notes;
  const row = await salaryPaymentModel.update(id, updates, pool);
  if (!row) return res.status(404).json({ success: false, message: 'Payment not found' });
  bustCache('cache:*:/api/hr*');
  res.json({ success: true, payment: row });
});
