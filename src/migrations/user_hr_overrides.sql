-- ============================================================
-- Per-user HR overrides
-- A user-level override row for the same policy fields stored in
-- site_hr_settings. NULL columns mean "fall back to site default",
-- so a row can override just one field if needed.
-- ============================================================

CREATE TABLE IF NOT EXISTS user_hr_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  site_id UUID REFERENCES sites(id) ON DELETE CASCADE,

  -- ISO day-of-week: 1=Mon..7=Sun. NULL = inherit site working_days.
  working_days     INT[],
  working_hours    NUMERIC(4,2),
  work_start_time  TIME,
  work_end_time    TIME,

  -- Optional finer-grained overrides. Leave NULL to inherit.
  paid_leaves_per_month     INT,
  half_day_threshold_hours  NUMERIC(4,2),
  late_grace_minutes        INT,

  notes TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_hr_overrides_site ON user_hr_overrides(site_id);
