-- ============================================================
-- HR Management Module
-- Site-scoped policy + per-user salary + leaves + payouts.
-- Reads existing attendance_records for monthly salary suggestion.
-- ============================================================

-- 1) Site-scoped HR policy. One row per site (mirrors site_financial_settings).
CREATE TABLE IF NOT EXISTS site_hr_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL UNIQUE REFERENCES sites(id) ON DELETE CASCADE,

  -- ISO day-of-week: 1=Mon..7=Sun. Default Mon-Sat working.
  working_days     INT[]   NOT NULL DEFAULT '{1,2,3,4,5,6}',
  working_hours    NUMERIC(4,2) NOT NULL DEFAULT 9.00,
  work_start_time  TIME    NOT NULL DEFAULT '10:00',
  work_end_time    TIME    NOT NULL DEFAULT '19:00',

  paid_leaves_per_month     INT NOT NULL DEFAULT 2,
  half_day_threshold_hours  NUMERIC(4,2) NOT NULL DEFAULT 4.00,
  late_grace_minutes        INT NOT NULL DEFAULT 15,

  -- [{ "date": "YYYY-MM-DD", "name": "Diwali" }, ...]
  holidays JSONB NOT NULL DEFAULT '[]'::jsonb,

  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2) Per-user salary. ONE active row per user (effective_to IS NULL); old
--    rows preserved with effective_to set so admin can see history.
CREATE TABLE IF NOT EXISTS user_salaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  monthly_salary NUMERIC(12,2) NOT NULL CHECK (monthly_salary >= 0),
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to   DATE,
  joined_at      DATE,
  notes TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Partial unique index: only ONE active salary row per user.
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_salaries_one_active
  ON user_salaries(user_id) WHERE effective_to IS NULL;

CREATE INDEX IF NOT EXISTS idx_user_salaries_user ON user_salaries(user_id);

-- 3) Per-user leave overrides. Admin marks paid/unpaid/half via the
--    HR Attendance Calendar. One leave row per user per date.
CREATE TABLE IF NOT EXISTS hr_leave_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  leave_date DATE NOT NULL,
  leave_type VARCHAR(20) NOT NULL CHECK (leave_type IN ('PAID','UNPAID','HALF_PAID')),
  reason TEXT,
  marked_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, leave_date)
);

CREATE INDEX IF NOT EXISTS idx_hr_leave_user_date ON hr_leave_records(user_id, leave_date);

-- 4) Salary payment history. UNIQUE(user, year, month) keeps one payout
--    row per user per month — re-posting the same period returns 409.
CREATE TABLE IF NOT EXISTS salary_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,

  period_year   INT NOT NULL CHECK (period_year BETWEEN 2000 AND 2100),
  period_month  INT NOT NULL CHECK (period_month BETWEEN 1 AND 12),

  amount             NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  suggested_amount   NUMERIC(12,2),
  monthly_salary_snapshot NUMERIC(12,2),
  payable_days       NUMERIC(5,2),
  total_working_days NUMERIC(5,2),
  present_days       NUMERIC(5,2),
  absent_days        NUMERIC(5,2),
  half_days          NUMERIC(5,2),
  paid_leaves_used   NUMERIC(5,2),

  payment_method VARCHAR(20) NOT NULL DEFAULT 'BANK_TRANSFER'
    CHECK (payment_method IN ('CASH','BANK_TRANSFER','CHEQUE','UPI','CARD','OTHER')),
  payment_date   DATE NOT NULL DEFAULT CURRENT_DATE,
  status         VARCHAR(20) NOT NULL DEFAULT 'COMPLETED'
    CHECK (status IN ('PENDING','COMPLETED','FAILED','CANCELLED')),

  transaction_ref VARCHAR(100),
  notes TEXT,
  paid_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(user_id, period_year, period_month)
);

CREATE INDEX IF NOT EXISTS idx_salary_payments_user   ON salary_payments(user_id);
CREATE INDEX IF NOT EXISTS idx_salary_payments_period ON salary_payments(period_year, period_month);
CREATE INDEX IF NOT EXISTS idx_salary_payments_site   ON salary_payments(site_id);
